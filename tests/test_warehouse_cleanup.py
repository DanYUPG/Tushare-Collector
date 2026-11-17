import fcntl
import hashlib
import json
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import test_warehouse
from test_collector import CollectorFixture

from collector.archive_delete import cleanup_deletion
from collector.datasets import RECIPES, DatasetPlanRequest, DatasetService, DatasetSettings, scope_for
from collector.models import CollectorError
from collector.store import Store
from collector.warehouse import WAREHOUSE_ADAPTERS, DailyWarehouse, SnapshotWarehouse
from collector.warehouse_cleanup import dependency_sources, execute_cleanup, preview_cleanup


class WarehouseCleanupTests(CollectorFixture):
    sample = test_warehouse.WarehouseTests.sample
    daily = test_warehouse.WarehouseTests.daily
    register = test_warehouse.WarehouseTests.register
    request_source = test_warehouse.WarehouseTests.request_source
    request_warehouse = test_warehouse.WarehouseTests.request_warehouse
    stock_snapshot = test_warehouse.WarehouseTests.stock_snapshot

    def setUp(self):
        # Keep test artifacts inside the project, never in the system temporary directory.
        with patch.object(tempfile, "tempdir", str(Path.cwd())):
            super().setUp()
        self.service = DatasetService(self.store, self.root / "raw")
        self.warehouse = DailyWarehouse(self.store, self.service, self.root / "warehouse")

    def records(self, *, evidence=False):
        with self.store.connect() as db:
            return self.service.records(
                db, "daily", scope_for(RECIPES["daily"], DatasetSettings(raw_root=str(self.root / "raw"))),
                evidence=evidence,
            )

    def test_exact_published_lineage_only_preserves_coverage_metadata_and_warehouse(self):
        older = self.daily("20260105", 1)
        published = self.daily("20260105", 9)
        snapshot = self.warehouse.refresh()
        newer = self.daily("20260105", 9)
        raw = Path(published["slices"][0]["raw_path"])
        extra = raw.with_name("keep-unregistered.txt")
        extra.write_text("keep")
        metadata = json.loads(Path(published["slices"][0]["meta_path"]).read_text())
        before = self.warehouse.rows()
        preview = preview_cleanup(self.warehouse)
        self.assertEqual(preview["count"], 1)
        self.assertEqual(preview["files"], 2)
        self.assertEqual(preview["candidates"][0]["run_id"], published["id"])
        self.assertEqual(preview_cleanup(self.warehouse)["fingerprint"], preview["fingerprint"])
        self.assertTrue(raw.exists())
        with self.assertRaisesRegex(CollectorError, "重新预览"):
            execute_cleanup(self.warehouse, "0" * 64)
        result = execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertEqual((result["state"], result["count"], result["files"]), ("deleted", 1, 2))
        self.assertFalse(raw.exists())
        self.assertTrue(raw.parent.is_dir())
        self.assertTrue(extra.exists())
        for run in (older, newer):
            self.assertTrue(Path(run["slices"][0]["raw_path"]).exists())
        self.assertEqual(self.warehouse.rows(), before)
        self.assertFalse(self.warehouse.refresh()["changed"])
        self.assertEqual(self.warehouse.status()["snapshot_id"], snapshot["snapshot_id"])
        with self.store.connect() as db:
            lineage = db.execute("SELECT * FROM warehouse_cleanups").fetchone()
            self.assertEqual(json.loads(lineage["metadata_json"]), metadata)
            self.assertEqual(json.loads(lineage["slice_json"])["raw_path"], str(raw))
            self.assertEqual(lineage["fingerprint"], preview["fingerprint"])
            self.assertEqual(lineage["snapshot_id"], snapshot["snapshot_id"])
        self.assertEqual(execute_cleanup(self.warehouse, preview["fingerprint"])["state"], "deleted")

    def test_cleaned_coverage_is_not_raw_evidence_and_later_failure_stays_latest(self):
        self.daily("20260105", 1)
        run = self.daily("20260105", 9)
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        execute_cleanup(self.warehouse, preview["fingerprint"])
        latest, successful = self.records()
        self.assertEqual(successful["20260105"]["id"], run["slices"][0]["id"])
        self.assertEqual(latest["20260105"]["state"], "succeeded")
        self.assertTrue(latest["20260105"]["warehouse_cleaned"])
        self.assertFalse(latest["20260105"]["has_data"])
        _, raw_success = self.records(evidence=True)
        self.assertNotEqual(raw_success["20260105"]["id"], run["slices"][0]["id"])
        self.assertEqual(self.warehouse.status()["available_source_days"], 1)
        self.assertFalse(self.warehouse.refresh()["changed"])
        failed = self.daily("20260105", 12)
        with self.store.connect() as db:
            db.execute(
                "UPDATE slices SET state='failed',error='fixture failure',error_kind='supplier_error' "
                "WHERE run_id=?", (failed["id"],),
            )
        latest, successful = self.records()
        self.assertEqual(latest["20260105"]["error"], "fixture failure")
        self.assertEqual(latest["20260105"]["state"], "failed")
        self.assertEqual(successful["20260105"]["id"], run["slices"][0]["id"])

    def test_incremental_plan_does_not_refetch_cleaned_dates_outside_lookback(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertFalse(Path(run["slices"][0]["raw_path"]).exists())
        settings = DatasetSettings(
            raw_root=str(self.root / "raw"), start_date="2026-01-05", lookback_days=1,
        )
        with patch.object(
            self.service, "_calendar", return_value=(["20260105", "20260106"], [], []),
        ):
            plan = self.service.create_plan(
                "daily", DatasetPlanRequest(
                    settings=settings, expected_revision=0, mode="incremental", end_date="2026-01-06",
                ), 30,
            )
        self.assertEqual(plan["covered_partitions"], 1)
        self.assertEqual([(item["key"], item["reason"]) for item in plan["partitions"]],
                         [("20260106", "missing")])
        self.assertEqual(plan["counts"]["retry"], 0)

    def test_retention_uses_observation_not_business_date_and_rejects_nonintegers(self):
        old = self.daily("19990104")
        recent = self.daily("19990105")
        observed = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
        with self.store.connect() as db:
            db.execute(
                "UPDATE attempts SET finished_at=? WHERE slice_id IN "
                "(SELECT id FROM slices WHERE run_id=?)", (observed, old["id"]),
            )
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse, retention_days=30)
        self.assertEqual(preview["count"], 1)
        self.assertEqual(preview["candidates"][0]["run_id"], old["id"])
        self.assertEqual(preview["excluded"][0]["run_id"], recent["id"])
        self.assertIn("保留天数", preview["excluded"][0]["reason"])
        with self.assertRaisesRegex(CollectorError, "重新预览"):
            execute_cleanup(self.warehouse, preview["fingerprint"], retention_days=0)
        for invalid in (-1, 36501, 1.0, True, "1", None):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(CollectorError, "整数"):
                preview_cleanup(self.warehouse, invalid)
        self.assertEqual(preview_cleanup(self.warehouse, 36500)["count"], 0)

    def test_request_partition_cleanup_and_real_dependency_exclusions(self):
        run = self.request_source("income", {
            "ts_code": "600000.SH", "start_date": "20260101", "end_date": "20260131",
        }, "income-window")
        warehouse = self.request_warehouse("income")
        warehouse.refresh()
        preview = preview_cleanup(warehouse)
        self.assertEqual(preview["count"], 1)
        execute_cleanup(warehouse, preview["fingerprint"])
        self.assertFalse(Path(run["slices"][0]["raw_path"]).exists())
        self.assertEqual(warehouse.rows()["matching_rows"], 1)
        self.assertFalse(warehouse.refresh()["changed"])
        self.request_source("trade_cal", {
            "exchange": "SSE", "start_date": "20260105", "end_date": "20260105",
        }, "calendar", overrides={"is_open": [1]})
        calendar = self.request_warehouse("trade_cal")
        calendar.refresh()
        preview = preview_cleanup(calendar)
        self.assertEqual((preview["count"], preview["excluded_count"]), (0, 1))
        self.assertIn("Raw 依赖", preview["excluded"][0]["reason"])
        self.stock_snapshot("dependency")
        stock = SnapshotWarehouse(
            self.store, self.service, self.root / "stock_basic", WAREHOUSE_ADAPTERS["stock_basic"],
        )
        stock.refresh()
        preview = preview_cleanup(stock)
        self.assertEqual((preview["count"], preview["excluded_count"]), (0, 15))
        self.assertTrue({"stock_basic", "trade_cal", "ths_index", "dc_index", "tdx_index"}
                        <= dependency_sources())

    def test_snapshot_confirmation_hash_corruption_and_unknown_lineage_refuse(self):
        first = self.daily("20260105")
        original = self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        self.daily("20260106")
        self.warehouse.refresh()
        with self.assertRaisesRegex(CollectorError, "快照已变化"):
            execute_cleanup(self.warehouse, preview["fingerprint"], snapshot_id=original["snapshot_id"])
        self.assertTrue(Path(first["slices"][0]["raw_path"]).exists())
        status = self.warehouse.status()
        parquet = Path(status["months"][0]["file"])
        content = parquet.read_bytes()
        parquet.write_bytes(content + b"bad")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            preview_cleanup(self.warehouse, check_mode="deep")
        parquet.write_bytes(content)
        with self.store.connect() as db:
            db.execute(
                "UPDATE slices SET raw_sha256=? WHERE run_id=?", ("0" * 64, first["id"]),
            )
        excluded = preview_cleanup(self.warehouse)
        self.assertEqual(excluded["count"], 1)
        self.assertIn("不一致", excluded["excluded"][0]["reason"])

    def test_active_runs_and_both_publication_locks_prevent_cleanup(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        self.warehouse.lock.acquire()
        try:
            with self.assertRaisesRegex(CollectorError, "正在整理"):
                execute_cleanup(self.warehouse, preview["fingerprint"])
        finally:
            self.warehouse.lock.release()
        root = self.warehouse.context()[0]
        with (root / ".publish.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(CollectorError, "其他进程"):
                preview_cleanup(self.warehouse)
        active = self.store.create_run(self.store.save_config(self.config(name="queued"))["id"])
        with self.assertRaisesRegex(CollectorError, "排队或执行"):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        self.store.cancel(active["id"])
        self.assertTrue(Path(run["slices"][0]["raw_path"]).exists())
        self.assertEqual(preview_cleanup(self.warehouse)["count"], 1)

    def test_partial_cleanup_survives_restart_and_retries_original_confirmation(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        item = run["slices"][0]
        unlink = Path.unlink

        def denied(path, *args, **kwargs):
            if str(path) == item["meta_path"]:
                raise PermissionError("fixture permission denied")
            return unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", denied):
            failed = execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertEqual(failed["state"], "cleanup_failed")
        self.assertEqual(failed["failed"], 1)
        self.assertFalse(Path(item["raw_path"]).exists())
        self.assertTrue(Path(item["meta_path"]).exists())
        self.store = Store(self.store.path)
        self.service = DatasetService(self.store, self.root / "raw")
        self.warehouse = DailyWarehouse(self.store, self.service, self.root / "warehouse")
        self.assertEqual(self.records()[1]["20260105"]["state"], "succeeded")
        self.assertNotIn("20260105", self.records(evidence=True)[1])
        fresh_preview = preview_cleanup(self.warehouse)
        pending = fresh_preview["pending_cleanups"][0]
        self.assertEqual(pending["fingerprint"], preview["fingerprint"])
        self.assertEqual((fresh_preview["count"], pending["remaining"]), (0, 1))
        self.assertNotEqual(fresh_preview["fingerprint"], pending["fingerprint"])
        local = self.store.local_data()["pending_deletions"][0]
        self.assertEqual(local["reason"], "warehoused")
        with self.assertRaisesRegex(CollectorError, "原确认指纹"):
            cleanup_deletion(self.store, local["id"])
        self.daily("20260106")
        self.warehouse.refresh()
        result = execute_cleanup(
            self.warehouse, pending["fingerprint"], snapshot_id=pending["snapshot_id"],
        )
        self.assertEqual((result["state"], result["deleted"]), ("deleted", 1))
        self.assertFalse(Path(item["meta_path"]).exists())
        self.assertEqual(self.warehouse.rows()["matching_rows"], 4)
        self.assertEqual(self.store.local_data()["pending_deletion_count"], 0)

    def test_confirmation_is_durable_and_collection_writes_block_during_unlink(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        unlink = Path.unlink
        verified = []

        def verify_before_unlink(path, *args, **kwargs):
            with self.store.connect() as db:
                # Another connection sees the durable audit before data is removed.
                self.assertEqual(db.execute("SELECT COUNT(*) FROM warehouse_cleanups").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT state FROM archive_deletions").fetchone()[0], "pending")
            db = sqlite3.connect(self.store.path, timeout=0.01)
            try:
                with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                    db.execute("BEGIN IMMEDIATE")
            finally:
                db.close()
            verified.append(str(path))
            return unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", verify_before_unlink):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertEqual(set(verified), {
            run["slices"][0]["raw_path"], run["slices"][0]["meta_path"],
        })

    def test_retry_rejects_changed_registered_manifest_even_with_same_source(self):
        run = self.daily("20260105")
        status = self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        with patch.object(Path, "unlink", side_effect=PermissionError("fixture")):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        path = Path(status["snapshot_manifest_path"])
        manifest = json.loads(path.read_text())
        manifest["coverage"] = "changed-after-confirmation"
        path.write_text(json.dumps(manifest))
        with self.store.connect() as db:
            db.execute(
                "UPDATE warehouse_snapshots SET manifest_sha256=? WHERE id=?",
                (hashlib.sha256(path.read_bytes()).hexdigest(), status["snapshot_id"]),
            )
        with self.assertRaisesRegex(CollectorError, "清理身份或仓库清单发生变化"):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertTrue(Path(run["slices"][0]["raw_path"]).exists())

    def test_path_alias_shared_files_and_dependency_sources_are_excluded(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        # A dependency remains usable as Raw; do not silently substitute warehouse evidence.
        with patch("collector.warehouse_cleanup.dependency_sources", return_value={"daily"}):
            preview = preview_cleanup(self.warehouse)
        self.assertEqual(preview["count"], 0)
        self.assertIn("Raw 依赖", preview["excluded"][0]["reason"])
        other = self.daily("20260106")
        raw = Path(run["slices"][0]["raw_path"])
        with self.store.connect() as db:
            db.execute("UPDATE slices SET meta_path=? WHERE run_id=?", (str(raw), other["id"]))
        preview = preview_cleanup(self.warehouse)
        self.assertEqual(preview["count"], 0)
        self.assertIn("共享", preview["excluded"][0]["reason"])
        self.assertTrue(raw.exists())

    def test_metadata_tampering_is_excluded_and_display_is_bounded(self):
        self.daily("20260105")
        self.warehouse.refresh()
        root, repository_id, _, _, _ = self.warehouse.context()
        snapshot = self.warehouse.snapshot(root, repository_id)
        source = snapshot["dates"]["20260105"]
        meta = Path(source["meta_path"])
        content = meta.read_bytes()
        meta.write_bytes(content + b" ")
        preview = preview_cleanup(self.warehouse, check_mode="deep")
        self.assertEqual(preview["count"], 0)
        self.assertIn("哈希", preview["excluded"][0]["reason"])
        meta.write_bytes(content)
        with patch("collector.warehouse_cleanup.DISPLAY_LIMIT", 0):
            preview = preview_cleanup(self.warehouse)
        self.assertEqual(preview["count"], 1)
        self.assertEqual(preview["files"], 2)
        self.assertEqual(preview["candidates"], [])
        self.assertTrue(preview["candidates_truncated"])
        self.assertEqual(len(preview["fingerprint"]), hashlib.sha256().digest_size * 2)

    def test_fast_default_never_hashes_raw_or_warehouse_parquet_even_during_execution(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        digest = hashlib.file_digest

        def metadata_only(stream, *args, **kwargs):
            self.assertFalse(str(stream.name).endswith(".parquet"), "Fast mode must not hash data files")
            return digest(stream, *args, **kwargs)

        with patch("collector.artifacts.hashlib.file_digest", side_effect=metadata_only):
            preview = preview_cleanup(self.warehouse)
            self.assertEqual(preview["check_mode"], "fast")
            self.assertEqual(preview["count"], 1)
            self.assertIn("identity", preview["candidates"][0]["files"][0])
            result = execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertEqual(result["state"], "deleted")
        self.assertFalse(Path(run["slices"][0]["raw_path"]).exists())

    def test_fast_confirmation_rejects_replaced_or_changed_files(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        raw = Path(run["slices"][0]["raw_path"])
        raw.write_bytes(raw.read_bytes() + b"changed")
        with self.assertRaisesRegex(CollectorError, "重新预览"):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertTrue(raw.exists())
        self.assertTrue(Path(run["slices"][0]["meta_path"]).exists())
        self.assertEqual(preview_cleanup(self.warehouse, check_mode="deep")["count"], 0)
        # Fast mode detects changes since confirmation, not content corruption since collection.
        self.assertEqual(preview_cleanup(self.warehouse)["count"], 1)

    def test_fast_preview_defers_metadata_read_but_execution_rejects_tampering_before_commit(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        raw = Path(run["slices"][0]["raw_path"])
        meta = Path(run["slices"][0]["meta_path"])
        meta.write_bytes(meta.read_bytes() + b" ")
        with patch(
            "collector.warehouse_cleanup.source_paths", side_effect=AssertionError("Preview read metadata"),
        ):
            preview = preview_cleanup(self.warehouse)
        self.assertEqual(preview["count"], 1)
        with self.assertRaisesRegex(CollectorError, "哈希"):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertTrue(raw.exists())
        self.assertTrue(meta.exists())
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM warehouse_cleanups").fetchone()[0], 0)

    def test_fast_confirmation_rejects_directory_replaced_by_symlink(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        raw = Path(run["slices"][0]["raw_path"])
        moved = raw.parent.with_name("moved")
        raw.parent.rename(moved)
        raw.parent.symlink_to(moved, target_is_directory=True)
        self.assertEqual(preview_cleanup(self.warehouse)["count"], 0)
        with self.assertRaisesRegex(CollectorError, "重新预览"):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        self.assertTrue((moved / "data.parquet").exists())
        self.assertTrue((moved / "meta.json").exists())

    def test_fast_pending_retry_refuses_changed_remaining_file(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse)
        with patch.object(Path, "unlink", side_effect=PermissionError("fixture")):
            execute_cleanup(self.warehouse, preview["fingerprint"])
        pending = preview_cleanup(self.warehouse)["pending_cleanups"][0]
        self.assertEqual(pending["check_mode"], "fast")
        raw = Path(run["slices"][0]["raw_path"])
        raw.write_bytes(raw.read_bytes() + b"changed")
        result = execute_cleanup(self.warehouse, pending["fingerprint"])
        self.assertEqual(result["state"], "cleanup_failed")
        self.assertIn("已变化", result["failures"][0]["error"])
        self.assertTrue(raw.exists())
        self.assertTrue(Path(run["slices"][0]["meta_path"]).exists())

    def test_deep_retry_retains_legacy_hash_based_confirmation_and_cannot_downgrade(self):
        run = self.daily("20260105")
        self.warehouse.refresh()
        preview = preview_cleanup(self.warehouse, check_mode="deep")
        self.assertNotIn("identity", preview["candidates"][0]["files"][0])
        self.assertNotEqual(preview["fingerprint"], preview_cleanup(self.warehouse)["fingerprint"])
        with patch.object(Path, "unlink", side_effect=PermissionError("fixture")):
            execute_cleanup(self.warehouse, preview["fingerprint"], check_mode="deep")
        pending = preview_cleanup(self.warehouse)["pending_cleanups"][0]
        self.assertEqual(pending["check_mode"], "deep")
        with self.assertRaisesRegex(CollectorError, "检查模式"):
            execute_cleanup(self.warehouse, pending["fingerprint"])
        self.assertTrue(Path(run["slices"][0]["raw_path"]).exists())
        result = execute_cleanup(self.warehouse, pending["fingerprint"], check_mode="deep")
        self.assertEqual(result["state"], "deleted")
