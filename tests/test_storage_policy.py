import json
import sqlite3
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import test_warehouse
from fastapi.testclient import TestClient
from test_collector import CollectorFixture

from collector.app import create_app
from collector.datasets import DatasetSettings
from collector.models import CollectorError
from collector.storage_policy import StoragePolicy, StoragePolicySave
from collector.store import Store
from collector.warehouse_cleanup import execute_cleanup


class StoragePolicyTests(CollectorFixture):
    sample = test_warehouse.WarehouseTests.sample
    daily = test_warehouse.WarehouseTests.daily
    register = test_warehouse.WarehouseTests.register

    def setUp(self):
        with patch.object(tempfile, "tempdir", str(Path.cwd())):
            super().setUp()
        self.app = create_app(self.root, start_worker=False)
        self.store = self.app.state.store
        self.worker = self.app.state.runner
        self.policy = self.app.state.storage_policy
        self.service = self.app.state.data_needs.datasets
        self.warehouse = self.app.state.warehouses["daily"]

    def age(self, run, days=30):
        with self.store.connect() as db:
            db.execute(
                "UPDATE attempts SET finished_at=? WHERE slice_id IN "
                "(SELECT id FROM slices WHERE run_id=?)",
                ((datetime.now(timezone.utc) - timedelta(days=days)).isoformat(), run["id"]),
            )
        return Path(run["slices"][0]["raw_path"])

    def enable(self, **changes):
        return self.policy.save(StoragePolicySave(
            enabled=True, authorize_delete=True, expected_revision=self.policy.status()["revision"],
            **changes,
        ))

    def tick(self):
        self.policy.next_tick = 0
        self.policy.tick()

    def pump(self):
        for _ in range(30):
            self.tick()
            status = self.policy.status()
            if status["jobs"] and status["jobs"][0]["state"] != "running":
                return status["jobs"][0]
        self.fail("Storage policy did not finish its bounded steps")

    def test_api_is_read_only_until_explicit_authorization_and_rejects_stale_saves(self):
        headers = {"X-Collector-Request": "1"}
        with TestClient(self.app, base_url="http://127.0.0.1") as client:
            with patch("collector.storage_policy.preview_cleanup", side_effect=AssertionError("scan")):
                status = client.get("/api/storage-policy").json()
                self.assertFalse(status["enabled"])
                self.assertEqual(status["revision"], 0)
                self.assertEqual(status["jobs"], [])
                self.tick()
                response = client.put("/api/storage-policy", headers=headers, json={"retention_days": 14})
                self.assertEqual(response.status_code, 200, response.text)
                self.tick()
            self.assertEqual(client.put("/api/storage-policy", json={}).status_code, 403)
            for invalid in (0, True, 1.5, "7"):
                self.assertEqual(client.put("/api/storage-policy", headers=headers, json={
                    "retention_days": invalid, "expected_revision": 1,
                }).status_code, 422)
            self.assertEqual(client.put("/api/storage-policy", headers=headers, json={
                "enabled": True, "expected_revision": 1,
            }).status_code, 409)
            self.assertEqual(client.put("/api/storage-policy", headers=headers, json={
                "enabled": True, "authorize_delete": "true", "expected_revision": 1,
            }).status_code, 422)
            self.assertEqual(client.put("/api/storage-policy", headers=headers, json={}).status_code, 409)
        self.assertEqual(self.policy.status()["jobs"], [])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)

    def test_verified_sources_only_preserve_warehouse_and_unregistered_or_superseded_files(self):
        older = self.daily("20260105", 1)
        selected = self.daily("20260105", 9)
        older_raw, selected_raw = self.age(older), self.age(selected)
        extra = selected_raw.with_name("not-registered.txt")
        extra.write_text("keep")
        self.warehouse.refresh(verify_content=True)
        before = self.warehouse.rows()
        self.enable()
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual(result["steps"][0]["deleted"], 1)
        self.assertFalse(selected_raw.exists())
        self.assertTrue(older_raw.exists())
        self.assertTrue(extra.exists())
        self.assertTrue(selected_raw.parent.is_dir())
        self.assertEqual(self.warehouse.rows(), before)
        self.assertFalse(self.warehouse.refresh()["changed"])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM warehouse_cleanups").fetchone()[0], 1)

    def test_retention_uses_observation_and_keeps_recent_capture_of_old_business_date(self):
        old = self.daily("19990104")
        recent = self.daily("19990105")
        old_raw = self.age(old)
        recent_raw = Path(recent["slices"][0]["raw_path"])
        self.warehouse.refresh(verify_content=True)
        self.enable(retention_days=14)
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertFalse(old_raw.exists())
        self.assertTrue(recent_raw.exists())
        self.assertIn("保留天数", result["steps"][0]["reason"])

    def test_new_month_readback_does_not_certify_legacy_source_fields(self):
        legacy = self.age(self.daily("20260105"))
        self.warehouse.refresh()
        verified = self.age(self.daily("20260106"))
        self.warehouse.refresh(verify_content=True)
        self.enable()
        result = self.pump()
        self.assertTrue(legacy.exists())
        self.assertFalse(verified.exists())
        self.assertEqual(result["steps"][0]["skipped"], 1)
        self.assertIn("全字段", result["steps"][0]["reason"])

    def test_source_field_proof_without_current_month_readback_is_not_sufficient(self):
        verified = self.age(self.daily("20260105"))
        self.warehouse.refresh(verify_content=True)
        unverified = self.age(self.daily("20260106"))
        self.warehouse.refresh()
        self.enable()
        result = self.pump()
        self.assertTrue(verified.exists())
        self.assertTrue(unverified.exists())
        self.assertEqual(result["steps"][0]["deleted"], 0)
        self.assertIn("回读", result["steps"][0]["reason"])

    def test_batches_are_bounded_and_pause_revokes_prepared_batch_before_any_unlink(self):
        paths = [self.age(self.daily(day)) for day in ("20260105", "20260106", "20260107")]
        self.warehouse.refresh(verify_content=True)
        enabled = self.enable()
        with patch("collector.storage_policy.BATCH_SIZE", 1):
            self.tick()
            self.assertTrue(all(path.exists() for path in paths))
            self.tick()
            self.assertEqual([path.exists() for path in paths], [False, True, True])
            self.tick()
            with self.store.connect() as db:
                job = db.execute("SELECT * FROM storage_policy_jobs").fetchone()
            prepared = json.loads(job["steps_json"])[0]
            self.assertEqual(prepared["state"], "prepared")
            paused = self.policy.pause(enabled["revision"])
            self.assertFalse(paused["enabled"])
            with self.assertRaisesRegex(CollectorError, "授权已失效"):
                execute_cleanup(
                    self.warehouse, prepared["batch"]["fingerprint"], retention_days=7,
                    snapshot_id=prepared["snapshot_id"], automatic=True, limit=1,
                    after_key=prepared["cursor"], guard=lambda db: self.policy.guard(db, job),
                )
            self.policy = StoragePolicy(self.store, self.service, self.app.state.warehouses, self.worker)
            self.tick()
        self.assertEqual([path.exists() for path in paths], [False, True, True])
        self.assertEqual(self.policy.status()["jobs"][0]["state"], "paused")

    def test_restart_recovers_exact_authorized_batch_even_after_unlink_before_receipt(self):
        raw = self.age(self.daily("20260105"))
        self.warehouse.refresh(verify_content=True)
        self.enable()
        self.tick()
        with patch.object(self.policy, "persist", side_effect=SystemExit("fixture abrupt exit")):
            with self.assertRaises(SystemExit):
                self.tick()
        self.assertFalse(raw.exists())
        self.policy = StoragePolicy(
            Store(self.store.path), self.service, self.app.state.warehouses, self.worker,
        )
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual(result["steps"][0]["deleted"], 1)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 1)
            job = db.execute("SELECT * FROM storage_policy_jobs").fetchone()
            receipt = json.loads(job["steps_json"])[0]["receipts"]
            self.assertEqual(len(receipt), 1)
            self.assertEqual(
                receipt[0]["fingerprint"],
                db.execute("SELECT fingerprint FROM warehouse_cleanups").fetchone()[0],
            )
        self.assertEqual(self.policy.status()["jobs"][0]["steps"][0]["completed_batches"], 1)

    def test_queued_collection_defers_prepared_batch_instead_of_failing_or_deleting(self):
        raw = self.age(self.daily("20260105"))
        self.warehouse.refresh(verify_content=True)
        self.enable()
        self.tick()
        queued = self.store.create_run(self.store.save_config(self.config(name="queued"))["id"])
        self.tick()
        self.assertTrue(raw.exists())
        self.assertEqual(self.policy.status()["jobs"][0]["state"], "running")
        self.store.cancel(queued["id"])
        self.assertEqual(self.pump()["state"], "succeeded")
        self.assertFalse(raw.exists())

    def test_publication_lock_and_sqlite_contention_wait_without_blocking_policy(self):
        raw = self.age(self.daily("20260105"))
        self.warehouse.refresh(verify_content=True)
        self.enable()
        self.warehouse.lock.acquire()
        try:
            self.tick()
        finally:
            self.warehouse.lock.release()
        self.assertEqual(self.policy.status()["jobs"][0]["state"], "running")
        busy = sqlite3.OperationalError("fixture locked")
        busy.sqlite_errorcode = sqlite3.SQLITE_BUSY
        with patch("collector.storage_policy.preview_cleanup", side_effect=busy):
            self.tick()
        self.assertEqual(self.policy.status()["jobs"][0]["state"], "running")
        self.assertTrue(raw.exists())
        self.assertEqual(self.pump()["state"], "succeeded")

    def test_partial_failure_is_visible_durable_and_not_automatically_retried(self):
        first = self.daily("20260105")
        second = self.daily("20260106")
        first_raw, second_raw = self.age(first), self.age(second)
        second_meta = Path(second["slices"][0]["meta_path"])
        self.warehouse.refresh(verify_content=True)
        self.enable()
        self.tick()
        unlink = Path.unlink

        def denied(path, *args, **kwargs):
            if path == second_meta:
                raise PermissionError("fixture storage denial")
            return unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", denied):
            self.tick()
        status = self.policy.status()
        self.assertEqual(status["jobs"][0]["state"], "blocked")
        self.assertIn("fixture storage denial", status["last_error"])
        self.assertEqual(status["jobs"][0]["steps"][0]["batch"]["partial_deleted"], 1)
        self.assertFalse(first_raw.exists())
        self.assertFalse(second_raw.exists())
        self.assertTrue(second_meta.exists())
        self.tick()
        self.assertTrue(second_meta.exists())
        step = status["jobs"][0]["steps"][0]
        manual = execute_cleanup(
            self.warehouse, step["batch"]["fingerprint"], retention_days=7,
            snapshot_id=step["snapshot_id"],
        )
        self.assertEqual(manual["state"], "deleted")
        self.assertFalse(second_meta.exists())

    def test_directory_change_and_snapshot_change_revoke_automatic_admission(self):
        raw = self.age(self.daily("20260105"))
        self.warehouse.refresh(verify_content=True)
        self.enable()
        self.tick()
        self.service.save_settings("daily", DatasetSettings(raw_root=str(self.root / "other")), 0)
        self.tick()
        self.assertTrue(raw.exists())
        self.assertIn("目录", self.policy.status()["last_error"])
        self.service.save_settings("daily", DatasetSettings(raw_root=str(self.root / "raw")), 1)
        self.enable()
        self.tick()
        self.age(self.daily("20260106"))
        self.warehouse.refresh(verify_content=True)
        self.tick()
        self.assertTrue(raw.exists())
        self.assertIn("快照已变化", self.policy.status()["last_error"])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)

    def test_metadata_tampering_blocks_before_intents_are_committed(self):
        run = self.daily("20260105")
        raw = self.age(run)
        self.warehouse.refresh(verify_content=True)
        self.enable()
        self.tick()
        meta = Path(run["slices"][0]["meta_path"])
        meta.write_bytes(meta.read_bytes() + b" ")
        self.tick()
        self.assertTrue(raw.exists())
        self.assertTrue(meta.exists())
        self.assertEqual(self.policy.status()["jobs"][0]["state"], "blocked")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)

    def test_running_worker_executes_local_policy_without_supplier_credential(self):
        raw = self.age(self.daily("20260105"))
        self.warehouse.refresh(verify_content=True)
        self.enable()
        self.worker.set_token("")
        with self.store.connect() as db:
            request_count = db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0]
        original = self.worker.idle_callback

        def immediate():
            self.policy.next_tick = 0
            original()

        self.worker.idle_callback = immediate
        self.worker.start()
        try:
            deadline = time.perf_counter() + 10
            while time.perf_counter() < deadline:
                jobs = self.policy.status()["jobs"]
                if jobs and jobs[0]["state"] != "running":
                    break
                time.sleep(0.02)
            else:
                self.fail("Credential-free local storage maintenance did not complete")
            self.assertEqual(jobs[0]["state"], "succeeded", jobs[0]["error"])
            self.assertFalse(raw.exists())
        finally:
            self.worker.close()
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], request_count)
