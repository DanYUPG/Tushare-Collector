import hashlib
import json
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

import pandas as pd
import portalocker
import pyarrow as pa
import pyarrow.parquet as pq
from fastapi.testclient import TestClient
from test_collector import CollectorFixture
from tushare_warehouse import Warehouse

from collector.app import create_app
from collector.archive_delete import check_deletion, delete_archive
from collector.client import CollectionFailure, Response
from collector.datasets import (
    RECIPES,
    DatasetPlanRequest,
    DatasetService,
    DatasetSettings,
    scope_for,
    validate_dataset_response,
)
from collector.models import ENTRIES, CollectorError
from collector.permissions import API_ACCESS
from collector.store import encode
from collector.warehouse import (
    REQUEST_WAREHOUSE_DATASETS,
    WAREHOUSE_ADAPTERS,
    DailyWarehouse,
    DateWarehouse,
    SnapshotWarehouse,
    warehouse_catalog,
)
from collector.warehouse_export import reorganize_export
from collector.warehouse_metadata import prepare_warehouse, register_repository
from collector.warehouse_requests import RequestWarehouse


class WarehouseTests(CollectorFixture):
    def setUp(self):
        super().setUp()
        self.service = DatasetService(self.store, self.root / "raw")
        self.warehouse = DailyWarehouse(self.store, self.service, self.root / "warehouse")

    def daily(self, day, value=1.0, codes=("600000.SH", "000001.SZ"), missing=None):
        return self.sample("daily", day, value, codes, missing)

    def sample(
        self, dataset_id, day, value=1.0, codes=("600000.SH", "000001.SZ"), missing=None, overrides=None,
    ):
        adapter = WAREHOUSE_ADAPTERS[dataset_id]
        frame = pd.DataFrame({
            name: list(codes) if name == "ts_code" else [day] * len(codes) if name == adapter.date_column
            else [value] * len(codes)
            for name in adapter.schema.names
        })
        for key, values in (overrides or {}).items():
            frame[key] = values
        if missing:
            frame = frame.drop(columns=[missing])
        run, _ = self.run_config(
            self.config(
                entry_id=adapter.entry_id, params={adapter.date_param or adapter.date_column: day},
                transport="sdk", fields=",".join(frame.columns), allow_empty=adapter.allow_empty,
            ),
            [Response(None, None, "sdk_dataframe_parquet", frame=frame)],
        )
        self.register(run, day, dataset_id)
        return run

    def register(self, run, day, dataset_id="daily", partition_key=None):
        plan_id = run["id"]
        settings = DatasetSettings(raw_root=str(self.root / "raw"))
        frozen = {
            "recipe": RECIPES[dataset_id], "mode": "full", "settings": settings.model_dump(mode="json"),
            "start_date": day, "end_date": day, "counts": {}, "total_slices": 1, "warnings": [],
        }
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO dataset_plans VALUES(?,?,?,?,?,?,?)",
                (plan_id, dataset_id, 0, encode(frozen), "20260101", "20270101", run["id"]),
            )
            db.execute(
                "INSERT INTO dataset_runs VALUES(?,?,?,?,?,?)",
                (run["id"], dataset_id, "full", scope_for(RECIPES[dataset_id], settings),
                 encode(RECIPES[dataset_id]), plan_id),
            )
            key = partition_key or (day + "|{}" if "rule" in RECIPES[dataset_id] else day)
            db.execute("INSERT INTO dataset_partitions VALUES(?,?)", (run["slices"][0]["id"], key))

    def test_overlapping_runs_publish_current_months_and_reuse_identical_content(self):
        self.daily("20151231")
        self.daily("20160104", 2)
        first = self.warehouse.refresh()
        self.assertEqual(first["days"], 2)
        self.assertEqual(first["rows"], 4)
        unchanged_month = first["months"][1]["file"]
        self.daily("20151231", 9)
        self.daily("20151230", 3)
        second = self.warehouse.refresh()
        self.assertNotEqual(first["snapshot_id"], second["snapshot_id"])
        self.assertEqual(second["days"], 3)
        self.assertEqual(second["rows"], 6)
        self.assertEqual(second["months"][1]["file"], unchanged_month)
        rows = self.warehouse.rows(ts_code="600000.SH")
        close = rows["columns"].index("close")
        self.assertEqual([row[close] for row in rows["rows"]], [3, 9, 2])
        old = self.warehouse.rows(snapshot_id=first["snapshot_id"], ts_code="600000.SH")
        self.assertEqual([row[close] for row in old["rows"]], [1, 2])
        self.daily("20151231", 9)
        repeated = self.warehouse.refresh()
        self.assertFalse(repeated["changed"])
        self.assertEqual(repeated["snapshot_id"], second["snapshot_id"])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM warehouse_snapshots").fetchone()[0], 2)

    def test_sdk_reads_real_published_snapshots_and_reused_files_without_sqlite(self):
        self.daily("20151231")
        self.daily("20160104", 2)
        first = self.warehouse.refresh()
        reader = Warehouse(self.root)
        batches = reader.read_batches("daily", cols=["close"], batch_size=1)
        self.daily("20151231", 9)
        self.warehouse.refresh()
        with patch.object(self.store, "connect", side_effect=AssertionError("SDK must not access SQLite")):
            with batches:
                self.assertEqual(batches.read_all()["close"].to_pylist(), [1, 1, 2, 2])
            latest = reader.read_file("daily", cols=["close"])
            self.assertEqual(latest["close"].tolist(), [9, 9, 2, 2])
            old = reader.read_file("daily", snapshot_id=first["snapshot_id"], cols=["close"])
            self.assertEqual(old["close"].tolist(), [1, 1, 2, 2])

    def test_sdk_metadata_backfill_uses_registered_hashes_without_rewriting_data(self):
        data_dir = self.store.path.parent
        self.warehouse = DailyWarehouse(self.store, self.service, data_dir / "warehouse" / "daily")
        self.daily("20260105")
        first = self.warehouse.refresh()
        self.daily("20260202", 2)
        second = self.warehouse.refresh()
        root = Path(second["repository_root"])
        files = {
            path: path.read_bytes() for path in root.rglob("*")
            if path.name == "manifest.json" or path.suffix == ".parquet"
        }
        for path in root.rglob("manifest.sha256"):
            path.unlink()
        (data_dir / "warehouse" / "catalog.json").unlink()
        current = root / "current.json"
        value = json.loads(current.read_bytes())
        value.pop("manifest_sha256")
        current.write_text(encode(value), encoding="utf-8")
        self.assertEqual(prepare_warehouse(data_dir), {"snapshots": 2, "repositories": 1})
        self.assertEqual(prepare_warehouse(data_dir), {"snapshots": 2, "repositories": 1})
        self.assertTrue(all(path.read_bytes() == original for path, original in files.items()))
        reader = Warehouse(data_dir / "warehouse")
        self.assertEqual(len(reader.read_file("daily")), 4)
        self.assertEqual(len(reader.read_file("daily", snapshot_id=first["snapshot_id"])), 2)

    def test_sdk_catalog_registration_keeps_other_tables_during_concurrent_publication(self):
        from concurrent.futures import ThreadPoolExecutor

        root = self.root / "warehouse"
        repositories = [(f"table_{index}", root / f"table_{index}" / f"{index:064x}") for index in range(8)]
        for _, repository in repositories:
            repository.mkdir(parents=True)
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(lambda item: register_repository(item[1], item[0]), repositories))
        reader = Warehouse(root)
        self.assertEqual(reader.list_tables(), sorted(table for table, _ in repositories))

    def test_sdk_metadata_backfill_refuses_active_collector_and_damaged_snapshot(self):
        data_dir = self.store.path.parent
        self.warehouse = DailyWarehouse(self.store, self.service, data_dir / "warehouse" / "daily")
        self.daily("20260105")
        snapshot = self.warehouse.refresh()
        catalog = data_dir / "warehouse" / "catalog.json"
        original_catalog = catalog.read_bytes()
        with portalocker.Lock(data_dir / ".collector-worker.lock", mode="a+b", timeout=0):
            with self.assertRaisesRegex(CollectorError, "停止采集服务"):
                prepare_warehouse(data_dir)
        path = Path(snapshot["snapshot_manifest_path"])
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            prepare_warehouse(data_dir)
        self.assertEqual(catalog.read_bytes(), original_catalog)

    def test_raw_deletion_does_not_delete_published_copy(self):
        self.daily("20260105", 1)
        run = self.daily("20260105", 9)
        before = self.warehouse.refresh()
        slice_id = run["slices"][0]["id"]
        info = check_deletion(self.store, run["id"], slice_id)
        delete_archive(self.store, run["id"], slice_id, info["fingerprint"])
        after = self.warehouse.refresh()
        self.assertEqual(after["snapshot_id"], before["snapshot_id"])
        self.assertEqual(after["available_source_days"], 1)
        self.assertEqual(self.warehouse.rows()["matching_rows"], 2)
        rows = self.warehouse.rows()
        self.assertEqual(rows["rows"][0][rows["columns"].index("close")], 9)

    def test_identical_revision_watermark_prevents_raw_cleanup_from_downgrading_data(self):
        self.daily("20260105", 1)
        snapshot = self.warehouse.refresh()
        self.daily("20260105", 9)
        newest = self.daily("20260105", 1)
        self.assertFalse(self.warehouse.refresh()["changed"])
        slice_id = newest["slices"][0]["id"]
        check = check_deletion(self.store, newest["id"], slice_id)
        delete_archive(self.store, newest["id"], slice_id, check["fingerprint"])
        self.assertFalse(self.warehouse.refresh()["changed"])
        self.assertEqual(self.warehouse.status()["snapshot_id"], snapshot["snapshot_id"])
        rows = self.warehouse.rows()
        self.assertEqual(rows["rows"][0][rows["columns"].index("close")], 1)

    def test_projected_bundles_span_runs_and_remain_fixed_after_refresh(self):
        self.daily("20151231", 1)
        self.daily("20160104", 2)
        snapshot = self.warehouse.refresh()
        exported = self.warehouse.export(
            str(self.root / "output"), "20100101", "20260101", ["close"], ["600000.SH"],
        )
        self.assertEqual(exported["columns"], ["ts_code", "trade_date", "close"])
        self.assertEqual(exported["rows"], 2)
        self.assertEqual(exported["files"], 2)
        manifest_path = Path(exported["manifest_path"])
        original = manifest_path.read_bytes()
        manifest = json.loads(original)
        copy = json.loads((Path(exported["directory"]) / manifest["snapshot_file"]).read_bytes())
        self.assertEqual(copy["snapshot_id"], snapshot["snapshot_id"])
        for item in manifest["files"]:
            table = pq.ParquetFile(Path(exported["directory"]) / item["file"]).read()
            self.assertEqual(table.column_names, exported["columns"])
            self.assertEqual(table["ts_code"].to_pylist(), ["600000.SH"])
        alternative = self.warehouse.export(str(self.root / "output"), "20100101", "20260101", ["open"])
        self.assertNotEqual(alternative["directory"], exported["directory"])
        self.assertEqual(alternative["columns"], ["ts_code", "trade_date", "open"])
        self.daily("20151231", 9)
        self.warehouse.refresh()
        self.assertEqual(manifest_path.read_bytes(), original)
        first_file = Path(exported["directory"]) / manifest["files"][0]["file"]
        self.assertEqual(pq.ParquetFile(first_file).read()["close"].to_pylist(), [1])

    def test_single_file_export_global_typed_sort_nulls_and_snapshot_lineage(self):
        self.sample("daily", "20151231", overrides={"close": [10.0, None]})
        self.sample("daily", "20160104", overrides={"close": [2.0, 10.0]})
        snapshot = self.warehouse.refresh()
        for layout in ("single", "partitioned"):
            result = self.warehouse.export(
                str(self.root / "output"), "20100101", "20260101", ["close"],
                file_layout=layout,
                sort_by=[{"column": "close", "direction": "asc"},
                         {"column": "ts_code", "direction": "desc"}],
            )
            manifest = json.loads(Path(result["manifest_path"]).read_text())
            tables = [
                pq.read_table(Path(result["directory"]) / name) for name in manifest["file_order"]
            ]
            table = pa.concat_tables(tables)
            self.assertEqual(table["close"].to_pylist(), [2.0, 10.0, 10.0, None])
            self.assertEqual(table["ts_code"].to_pylist()[:3], ["600000.SH", "600000.SH", "000001.SZ"])
            self.assertEqual(manifest["snapshot_id"], snapshot["snapshot_id"])
            self.assertEqual(len(manifest["source_files"]), 2)
            self.assertEqual(result["file_layout"], layout)
            self.assertFalse((Path(result["directory"]) / ".sort-temp").exists())
            if layout == "single":
                self.assertEqual(manifest["file_order"], ["data/data.parquet"])
        unsorted = self.warehouse.export(
            str(self.root / "output"), "20100101", "20260101", file_layout="single",
        )
        self.assertEqual(unsorted["files"], 1)
        self.assertEqual(unsorted["rows"], 4)

    def test_export_rejects_bad_sort_and_layout_without_publishing(self):
        self.daily("20260105")
        self.warehouse.refresh()
        for options in (
            {"file_layout": "bad"},
            {"sort_by": [{"column": "unknown", "direction": "asc"}]},
            {"sort_by": [{"column": "close", "direction": "sideways"}]},
            {"sort_by": [{"column": "close", "direction": "asc"}] * 2},
            {"file_layout": "grouped"},
            {"file_layout": "grouped", "split_by": "unknown"},
            {"file_layout": "grouped", "split_by": "close", "columns": ["open"]},
            {"file_layout": "single", "split_by": "ts_code"},
            {"file_layout": "partitioned", "split_by": "ts_code"},
        ):
            with self.subTest(options=options), self.assertRaises(CollectorError):
                self.warehouse.export(str(self.root / "output"), "20260101", "20260131", **options)
        self.assertFalse((self.root / "output").exists())

    def test_grouped_export_combines_source_months_and_records_split_values(self):
        self.daily("20151231", 1)
        self.daily("20160104", 2)
        snapshot = self.warehouse.refresh()
        for split_by in ("ts_code", "trade_date"):
            result = self.warehouse.export(
                str(self.root / "output"), "20100101", "20260101", ["close"],
                file_layout="grouped", split_by=split_by,
                sort_by=[{"column": "trade_date", "direction": "desc"}],
            )
            manifest = json.loads(Path(result["manifest_path"]).read_text())
            self.assertEqual(result["split_by"], split_by)
            self.assertEqual(result["files"], 2)
            self.assertEqual(result["rows"], 4)
            self.assertEqual(manifest["sort_scope"], "within_group")
            self.assertEqual(manifest["split_by"], split_by)
            self.assertEqual(manifest["snapshot_id"], snapshot["snapshot_id"])
            self.assertEqual(len(manifest["source_files"]), 2)
            self.assertEqual(manifest["file_order"], [
                "data/group-000000.parquet", "data/group-000001.parquet",
            ])
            for item in manifest["files"]:
                path = Path(result["directory"]) / item["file"]
                table = pq.read_table(path)
                self.assertEqual(table.num_rows, 2)
                self.assertEqual(set(table[split_by].to_pylist()), {item["split_value"]})
                self.assertEqual(table.column_names, ["ts_code", "trade_date", "close"])
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item["sha256"])
                dates = table["trade_date"].to_pylist()
                self.assertEqual(dates, sorted(dates, reverse=True))
            self.assertEqual(
                [item["split_value"] for item in manifest["files"]],
                ["000001.SZ", "600000.SH"] if split_by == "ts_code" else ["20160104", "20151231"],
            )

    def test_grouped_export_preserves_bigint_nulls_and_duplicate_rows(self):
        staging = self.root / "group-test"
        (staging / "data").mkdir(parents=True)
        large = 9_007_199_254_740_993
        table = pa.table({
            "dimension": pa.array([large, None, 10, 2, large, None, 2], type=pa.int64()),
            "value": [1.0, None, 5.0, 7.0, 1.0, 3.0, 4.0],
        })
        pq.write_table(table, staging / "data/source.parquet")
        results = reorganize_export(
            staging, [{"file": "data/source.parquet"}], table.schema, "grouped",
            [{"column": "value", "direction": "desc"}], "dimension",
        )
        self.assertEqual([item["split_value"] for item in results], [2, 10, str(large), None])
        values = []
        for item in results:
            output = pq.read_table(staging / item["file"])
            self.assertEqual(output.schema, table.schema)
            self.assertEqual(len(set(output["dimension"].to_pylist())), 1)
            values.append(output["value"].to_pylist())
        self.assertEqual(values, [[7.0, 4.0], [5.0], [1.0, 1.0], [3.0, None]])
        self.assertEqual(sum(item["rows"] for item in results), table.num_rows)

    def test_grouped_export_keeps_large_groups_across_batches_in_one_file(self):
        staging = self.root / "large-group-test"
        (staging / "data").mkdir(parents=True)
        count = 1_100_000
        table = pa.table({
            "dimension": pa.chunked_array([
                pa.repeat("../same/value", count), pa.array([None, None], type=pa.string()),
            ]),
        })
        pq.write_table(table, staging / "data/source.parquet")
        results = reorganize_export(
            staging, [{"file": "data/source.parquet"}], table.schema, "grouped", [], "dimension",
        )
        self.assertEqual([item["split_value"] for item in results], ["../same/value", None])
        self.assertEqual([item["rows"] for item in results], [count, 2])
        self.assertEqual(pq.ParquetFile(staging / results[0]["file"]).metadata.num_rows, count)
        self.assertEqual([item["file"] for item in results], [
            "data/group-000000.parquet", "data/group-000001.parquet",
        ])

    def test_grouped_export_rejects_excessive_file_count_without_publishing(self):
        self.daily("20260105")
        self.warehouse.refresh()
        with patch("collector.warehouse_export.MAX_SPLIT_FILES", 1):
            with self.assertRaisesRegex(CollectorError, "2 个文件"):
                self.warehouse.export(
                    str(self.root / "output"), "20260101", "20260131",
                    file_layout="grouped", split_by="ts_code",
                )
        self.assertEqual(list((self.root / "output/tushare_warehouse_bundles").iterdir()), [])

    def test_sorted_multifile_export_preserves_bigint_duplicates_and_file_order(self):
        staging = self.root / "sort-test"
        (staging / "data").mkdir(parents=True)
        count = 1_100_000
        base = 9_007_199_254_740_993
        values = [base + value // 2 for value in range(count, 0, -1)]
        table = pa.table({"value": pa.array(values, type=pa.int64())})
        pq.write_table(table, staging / "data/source.parquet")
        results = reorganize_export(
            staging, [{"file": "data/source.parquet"}], table.schema, "partitioned",
            [{"column": "value", "direction": "asc"}],
        )
        self.assertEqual(len(results), 2)
        output = pa.concat_tables([pq.read_table(staging / item["file"]) for item in results])
        self.assertEqual(output.num_rows, count)
        self.assertEqual(output["value"].to_pylist(), sorted(values))
        self.assertFalse((staging / "data/source.parquet").exists())

    def test_invalid_new_sources_do_not_replace_existing_snapshot(self):
        self.daily("20260105")
        first = self.warehouse.refresh()
        broken = self.daily("20260105", 9)
        raw = Path(broken["slices"][0]["raw_path"])
        original = raw.read_bytes()
        raw.write_bytes(original + b"tampered")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            self.warehouse.refresh()
        raw.write_bytes(original)
        self.assertEqual(self.warehouse.status()["snapshot_id"], first["snapshot_id"])
        self.daily("20260105", 10, missing="ah_amount")
        with self.assertRaisesRegex(CollectorError, "缺少仓库字段"):
            self.warehouse.refresh()
        self.assertEqual(self.warehouse.status()["snapshot_id"], first["snapshot_id"])
        self.daily("20260105", 11, codes=("600000.SH", "600000.SH"))
        with self.assertRaisesRegex(CollectorError, "重复股票"):
            self.warehouse.refresh()
        self.assertEqual(self.warehouse.status()["snapshot_id"], first["snapshot_id"])
        self.assertEqual(list(self.root.rglob(".t-*")), [])

    def test_failed_pointer_publication_preserves_old_current_and_releases_lock(self):
        self.daily("20260105")
        old = self.warehouse.refresh()
        self.daily("20260106")
        from collector.warehouse import write_json

        def fail_pointer(path, value):
            if path.name.startswith(".c-"):
                raise PermissionError("fixture publication denied")
            return write_json(path, value)

        with patch("collector.warehouse.write_json", side_effect=fail_pointer):
            with self.assertRaisesRegex(PermissionError, "publication denied"):
                self.warehouse.refresh()
        self.assertFalse(self.warehouse.lock.locked())
        self.assertEqual(self.warehouse.status()["snapshot_id"], old["snapshot_id"])
        self.assertTrue(self.warehouse.refresh()["changed"])

    def test_month_memory_limit_rejects_publication_without_replacing_current(self):
        self.daily("20260105")
        old = self.warehouse.refresh()
        self.daily("20260106")
        with patch("collector.warehouse.MAX_MONTH_ROWS", 3):
            with self.assertRaisesRegex(CollectorError, "单月安全上限"):
                self.warehouse.refresh()
        self.assertEqual(self.warehouse.status()["snapshot_id"], old["snapshot_id"])

    def test_queries_pin_snapshot_validate_selection_and_detect_corrupt_month(self):
        self.daily("20260105")
        self.daily("20260202")
        snapshot = self.warehouse.refresh()
        page = self.warehouse.rows(ts_code="600000.SH", offset=1, limit=1)
        self.assertEqual(page["matching_rows"], 2)
        self.assertEqual(page["rows"][0][1], "20260202")
        self.assertIsNone(page["next_offset"])
        self.assertEqual(self.warehouse.rows(offset=100)["rows"], [])
        self.assertEqual(self.warehouse.rows(start_date="20260301", end_date="20260331")["matching_rows"], 0)
        with self.assertRaisesRegex(CollectorError, "开始日期"):
            self.warehouse.rows(start_date="20260105", end_date="20260101")
        with self.assertRaisesRegex(CollectorError, "代码"):
            self.warehouse.rows(ts_code="invalid")
        with self.assertRaisesRegex(CollectorError, "字段"):
            self.warehouse.export(str(self.root / "output"), "20260101", "20261231", ["unknown"])
        month = Path(snapshot["months"][0]["file"])
        month.write_bytes(month.read_bytes() + b"corrupt")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            self.warehouse.rows()
        with self.assertRaisesRegex(CollectorError, "哈希"):
            self.warehouse.export(str(self.root / "output"), "20260101", "20261231")
        self.assertEqual(list((self.root / "output/tushare_warehouse_bundles").iterdir()), [])

    def test_empty_busy_and_active_collection_are_not_success_shaped(self):
        self.assertEqual(self.warehouse.status()["state"], "empty")
        with self.assertRaisesRegex(CollectorError, "没有可整理"):
            self.warehouse.refresh()
        self.warehouse.lock.acquire()
        try:
            with self.assertRaisesRegex(CollectorError, "正在整理"):
                self.warehouse.refresh()
        finally:
            self.warehouse.lock.release()
        saved = self.store.save_config(self.config(params={"trade_date": "20260105"}))
        run = self.store.create_run(saved["id"])
        detail = self.store.run(run["id"], detail=True)
        self.register(detail, "20260105")
        self.assertTrue(self.warehouse.status()["collection_active"])
        with self.assertRaisesRegex(CollectorError, "日线采集"):
            self.warehouse.refresh()

    def test_offline_api_projection_guard_and_read_only_queries(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        self.service = DatasetService(self.store, self.root / "raw")
        app.state.warehouse.datasets = self.service
        self.warehouse = app.state.warehouse
        self.daily("20260105")
        with TestClient(app, base_url="http://127.0.0.1") as client, patch(
            "collector.client.make_client", side_effect=AssertionError("No supplier request"),
        ):
            headers = {"X-Collector-Request": "1"}
            base = "/api/warehouse/daily"
            self.assertEqual(client.get(base).json()["state"], "empty")
            self.assertEqual(client.post(base + "/refresh", json={}).status_code, 403)
            result = client.post(base + "/refresh", json={}, headers=headers)
            self.assertEqual(result.status_code, 200)
            snapshot_id = result.json()["snapshot_id"]
            with self.store.connect() as db:
                before = list(db.iterdump())
            rows = client.get(base + "/rows", params={"snapshot_id": snapshot_id, "limit": 1})
            self.assertEqual(rows.status_code, 200)
            self.assertEqual(rows.json()["next_offset"], 1)
            client.get(base)
            with self.store.connect() as db:
                self.assertEqual(list(db.iterdump()), before)
            self.assertEqual(client.get(base + "/rows?limit=201").status_code, 422)
            self.assertEqual(client.post(
                base + "/refresh", json={"unexpected": True}, headers=headers,
            ).status_code, 422)
            body = {
                "destination": str(self.root / "output"), "start_date": "20260101",
                "end_date": "20261231", "columns": ["close"], "snapshot_id": snapshot_id,
            }
            self.assertEqual(client.post(base + "/export", json=body).status_code, 403)
            exported = client.post(base + "/export", json=body, headers=headers)
            self.assertEqual(exported.status_code, 201)
            self.assertEqual(exported.json()["columns"], ["ts_code", "trade_date", "close"])

    def test_new_adapters_publish_independent_typed_warehouses_and_exports(self):
        for dataset_id, metric in (
            ("daily_basic", "turnover_rate"), ("adj_factor", "adj_factor"), ("moneyflow", "buy_sm_amount"),
        ):
            with self.subTest(dataset_id=dataset_id):
                adapter = WAREHOUSE_ADAPTERS[dataset_id]
                warehouse = DateWarehouse(
                    self.store, self.service, self.root / "warehouse" / dataset_id, adapter,
                )
                self.sample(dataset_id, "20260105", 2)
                self.sample(dataset_id, "20260202", 3)
                first = warehouse.refresh()
                self.assertEqual(first["dataset_id"], dataset_id)
                self.assertEqual(first["rows"], 4)
                self.sample(dataset_id, "20260105", 9)
                second = warehouse.refresh()
                self.assertEqual(second["days"], 2)
                self.assertEqual(second["rows"], 4)
                self.assertEqual(first["months"][1]["file"], second["months"][1]["file"])
                rows = warehouse.rows(ts_code="600000.SH")
                self.assertEqual([row[rows["columns"].index(metric)] for row in rows["rows"]], [9, 3])
                exported = warehouse.export(str(self.root / "output"), "20260101", "20261231", [metric])
                self.assertEqual(exported["dataset_id"], dataset_id)
                self.assertEqual(exported["columns"], ["ts_code", "trade_date", metric])
                self.assertTrue(Path(exported["directory"]).name.startswith(dataset_id + "-"))
                self.assertEqual(self.warehouse.status()["state"], "empty")

    def test_integer_metrics_preserve_large_values_and_reject_fractional_cast(self):
        adapter = WAREHOUSE_ADAPTERS["moneyflow"]
        warehouse = DateWarehouse(self.store, self.service, self.root / "moneyflow", adapter)
        large = 9007199254740993
        self.sample("moneyflow", "20260105", overrides={"buy_sm_vol": [large, 2]})
        published = warehouse.refresh()
        table = pq.ParquetFile(published["months"][0]["file"]).read()
        self.assertEqual(table.schema.field("buy_sm_vol").type, pa.int64())
        self.assertIn(large, table["buy_sm_vol"].to_pylist())
        rows = warehouse.rows(ts_code="600000.SH")
        self.assertEqual(rows["rows"][0][rows["columns"].index("buy_sm_vol")], str(large))
        self.sample("moneyflow", "20260105", overrides={"buy_sm_vol": [0.5, 2]})
        with self.assertRaises(pa.ArrowException):
            warehouse.refresh()
        self.assertEqual(warehouse.status()["snapshot_id"], published["snapshot_id"])

    def test_catalog_marks_only_supported_shapes_and_legacy_daily_snapshot_stays_readable(self):
        catalog = warehouse_catalog()
        self.assertEqual(len(catalog["entries"]), 102)
        self.assertTrue(
            {"daily", "daily_basic", "adj_factor", "moneyflow", "stock_basic", "dividend"}
            <= {item["dataset_id"] for item in catalog["entries"] if item["warehouse_supported"]},
        )
        derived = next(item for item in catalog["entries"] if item["dataset_id"] == "pro_bar")
        self.assertEqual(derived["warehouse_status"], "supported")
        self.assertTrue(derived["atomic_full_run"])
        self.assertEqual(derived["fields"][0]["name"], "ts_code")
        account = next(item for item in catalog["entries"] if item["dataset_id"] == "stk_account_old")
        self.assertEqual(account["warehouse_status"], "supported")
        self.assertEqual(account["date_semantics"], "week_interval")
        moneyflow = next(item for item in catalog["entries"] if item["dataset_id"] == "moneyflow")
        volume = next(field for field in moneyflow["fields"] if field["name"] == "buy_sm_vol")
        self.assertEqual(volume["arrow_type"], "int64")
        self.daily("20260105")
        snapshot = self.warehouse.refresh()
        path = Path(snapshot["snapshot_manifest_path"])
        legacy = json.loads(path.read_bytes())
        legacy.pop("dataset_id")
        legacy.pop("schema")
        content = encode(legacy).encode()
        path.write_bytes(content)
        with self.store.connect() as db:
            db.execute(
                "UPDATE warehouse_snapshots SET manifest_sha256=? WHERE id=?",
                (hashlib.sha256(content).hexdigest(), snapshot["snapshot_id"]),
            )
            row = db.execute(
                "SELECT repository_id FROM warehouse_snapshots WHERE id=?", (snapshot["snapshot_id"],),
            ).fetchone()
        self.assertEqual(row["repository_id"], hashlib.sha256(str(self.root / "raw").encode()).hexdigest())
        self.assertEqual(self.warehouse.rows()["matching_rows"], 2)
        self.assertFalse(self.warehouse.refresh()["changed"])

    def test_generic_api_dataset_routes_reject_cross_dataset_snapshots_and_raw_only(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        self.service = DatasetService(self.store, self.root / "raw")
        for warehouse in app.state.warehouses.values():
            warehouse.datasets = self.service
        self.warehouse = app.state.warehouse
        for dataset_id in ("daily", "daily_basic", "adj_factor", "moneyflow"):
            self.sample(dataset_id, "20260105")
        snapshots = {}
        with TestClient(app, base_url="http://127.0.0.1") as client, patch(
            "collector.client.make_client", side_effect=AssertionError("No supplier request"),
        ):
            catalog = client.get("/api/warehouse/catalog")
            self.assertEqual(catalog.status_code, 200)
            self.assertEqual(len(catalog.json()["entries"]), 102)
            headers = {"X-Collector-Request": "1"}
            for dataset_id in ("daily", "daily_basic", "adj_factor", "moneyflow"):
                base = f"/api/warehouse/{dataset_id}"
                self.assertEqual(client.get(base).json()["dataset_id"], dataset_id)
                result = client.post(base + "/refresh", json={}, headers=headers)
                self.assertEqual(result.status_code, 200)
                snapshots[dataset_id] = result.json()["snapshot_id"]
                page = client.get(base + "/rows")
                self.assertEqual(page.json()["dataset_id"], dataset_id)
                self.assertEqual(page.json()["matching_rows"], 2)
            response = client.get("/api/warehouse/moneyflow/rows", params={"snapshot_id": snapshots["daily"]})
            self.assertEqual(response.status_code, 409)
            self.assertEqual(client.get("/api/warehouse/pro_bar").status_code, 200)
            self.assertEqual(client.get("/api/warehouse/unknown").status_code, 409)
            self.assertEqual(
                client.post("/api/warehouse/pro_bar/refresh", json={}, headers=headers).status_code, 409
            )
            result = client.post("/api/warehouse/adj_factor/export", headers=headers, json={
                "destination": str(self.root / "output"), "start_date": "20260101", "end_date": "20261231",
                "columns": ["adj_factor"], "snapshot_id": snapshots["adj_factor"],
                "file_layout": "single",
                "sort_by": [{"column": "adj_factor", "direction": "desc"}],
            })
            self.assertEqual(result.status_code, 201)
            self.assertEqual(result.json()["dataset_id"], "adj_factor")
            self.assertEqual(result.json()["file_layout"], "single")
            self.assertEqual(result.json()["files"], 1)
            self.assertEqual(result.json()["sort_by"], [{"column": "adj_factor", "direction": "desc"}])
            result = client.post("/api/warehouse/adj_factor/export", headers=headers, json={
                "destination": str(self.root / "output"), "start_date": "20260101", "end_date": "20261231",
                "columns": ["adj_factor"], "snapshot_id": snapshots["adj_factor"],
                "file_layout": "grouped", "split_by": "ts_code",
                "sort_by": [{"column": "adj_factor", "direction": "desc"}],
            })
            self.assertEqual(result.status_code, 201)
            self.assertEqual(result.json()["file_layout"], "grouped")
            self.assertEqual(result.json()["split_by"], "ts_code")
            self.assertEqual(result.json()["files"], 2)

    def test_cleanup_api_requires_fresh_fingerprint_and_preserves_queryable_snapshot(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        self.service = DatasetService(self.store, self.root / "raw")
        for warehouse in app.state.warehouses.values():
            warehouse.datasets = self.service
        self.warehouse = app.state.warehouse
        run = self.daily("20260105")
        snapshot = self.warehouse.refresh()
        raw = Path(run["slices"][0]["raw_path"])
        base = "/api/warehouse/daily/cleanup"
        with TestClient(app, base_url="http://127.0.0.1") as client:
            response = client.get(base, params={"snapshot_id": snapshot["snapshot_id"]})
            self.assertEqual(response.status_code, 200, response.text)
            preview = response.json()
            self.assertEqual(preview["count"], 1)
            self.assertEqual(preview["files"], 2)
            self.assertTrue(raw.exists())
            body = {
                "snapshot_id": snapshot["snapshot_id"], "retention_days": 0,
                "fingerprint": preview["fingerprint"],
            }
            self.assertEqual(client.post(base, json=body).status_code, 403)
            headers = {"X-Collector-Request": "1"}
            self.assertEqual(client.post(
                base, json={**body, "fingerprint": "0" * 64}, headers=headers,
            ).status_code, 409)
            self.assertTrue(raw.exists())
            result = client.post(base, json=body, headers=headers)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["count"], 1)
            self.assertFalse(raw.exists())
            self.assertEqual(client.get("/api/warehouse/daily/rows").json()["matching_rows"], 2)
            self.assertEqual(self.warehouse.refresh()["snapshot_id"], snapshot["snapshot_id"])

    def test_collection_activity_is_scoped_to_selected_dataset(self):
        self.sample("adj_factor", "20260105")
        saved = self.store.save_config(self.config(entry_id="170", params={"trade_date": "20260105"}))
        run = self.store.create_run(saved["id"])
        self.register(self.store.run(run["id"], detail=True), "20260105", "moneyflow")
        moneyflow = DateWarehouse(
            self.store, self.service, self.root / "moneyflow", WAREHOUSE_ADAPTERS["moneyflow"],
        )
        with self.assertRaisesRegex(CollectorError, "采集正在"):
            moneyflow.refresh()
        factor = DateWarehouse(
            self.store, self.service, self.root / "factor", WAREHOUSE_ADAPTERS["adj_factor"],
        )
        self.assertEqual(factor.refresh()["days"], 1)

    def event(self, day, values=(1.0, 2.0), actual_day=None, code="600000.SH"):
        adapter = WAREHOUSE_ADAPTERS["dividend"]
        frame = pd.DataFrame({
            field.name: [
                code if field.name == "ts_code"
                else actual_day or day if field.name == "ann_date"
                else "20251231" if field.name == "end_date"
                else "实施" if field.name == "div_proc"
                else None if pa.types.is_string(field.type) else value
                for value in values
            ]
            for field in adapter.schema
        })
        run, _ = self.run_config(
            self.config(
                entry_id="103", params={"ann_date": day}, transport="sdk", allow_empty=True,
                fields=",".join(adapter.schema.names),
            ),
            [Response(None, None, "sdk_dataframe_parquet", frame=frame)],
        )
        self.register(run, day, "dividend")
        return run

    def stock_snapshot(self, label, *, historical=False):
        adapter = WAREHOUSE_ADAPTERS["stock_basic"]
        settings = DatasetSettings(raw_root=str(self.root / "raw"))
        with self.store.connect() as db:
            _, revision = self.service.checked_settings(db, "stock_basic")
        plan = self.service.create_plan(
            "stock_basic", DatasetPlanRequest(
                settings=settings, expected_revision=revision, mode="full", end_date="2026-01-05",
            ), 500,
        )
        run = self.service.launch("stock_basic", plan["id"], 500)
        outputs = []
        for partition in plan["partitions"]:
            params = partition["params"]
            codes = {
                "SSE": "600000.SH", "SZSE": "000001.SZ", "BSE": "430001.BJ",
            }
            values = [codes[params["exchange"]]] if params["list_status"] == "L" else []
            if historical and params == {"exchange": "SSE", "list_status": "D"}:
                values = ["T600018.SH"]
            frame = pd.DataFrame({
                field.name: [
                    code if field.name == "ts_code"
                    else params["exchange"] if field.name == "exchange"
                    else params["list_status"] if field.name == "list_status"
                    else label for code in values
                ]
                for field in adapter.schema
            })
            outputs.append(Response(None, None, "sdk_dataframe_parquet", frame=frame))
        runner, _ = self.runner(outputs)
        runner.execute(self.store.claim())
        result = self.store.run(run["id"], detail=True)
        self.assertEqual(result["state"], "succeeded")
        return result

    def test_event_preserves_repeated_business_keys_and_replaces_whole_announcement_day(self):
        warehouse = DateWarehouse(
            self.store, self.service, self.root / "dividend", WAREHOUSE_ADAPTERS["dividend"],
        )
        self.event("20260103")
        self.event("20260104", ())
        first = warehouse.refresh()
        self.assertEqual((first["days"], first["rows"]), (2, 2))
        self.assertEqual(first["date_column"], "ann_date")
        self.assertTrue(first["preserves_duplicate_rows"])
        rows = warehouse.rows(start_date="20260103", end_date="20260103")
        self.assertEqual(rows["matching_rows"], 2)
        self.assertEqual([row[rows["columns"].index("cash_div")] for row in rows["rows"]], [1, 2])
        self.event("20260103", (9.0,))
        second = warehouse.refresh()
        self.assertEqual((second["days"], second["rows"]), (2, 1))
        self.assertEqual(warehouse.rows(snapshot_id=first["snapshot_id"])["matching_rows"], 2)
        bundle = warehouse.export(str(self.root / "output"), "20260103", "20260104", ["cash_div"])
        self.assertEqual(bundle["columns"], ["ts_code", "ann_date", "end_date", "div_proc", "cash_div"])
        self.assertEqual((bundle["days"], bundle["rows"]), (1, 1))
        with self.assertRaisesRegex(CollectorError, "没有数据"):
            warehouse.export(str(self.root / "output"), "20260104", "20260104")
        self.event("20260103", ())
        empty = warehouse.refresh()
        self.assertEqual((empty["days"], empty["rows"]), (2, 0))
        self.assertEqual(warehouse.rows()["matching_rows"], 0)
        self.assertEqual(warehouse.rows(snapshot_id=second["snapshot_id"])["matching_rows"], 1)

    def test_event_wrong_announcement_date_does_not_replace_current(self):
        warehouse = DateWarehouse(
            self.store, self.service, self.root / "dividend", WAREHOUSE_ADAPTERS["dividend"],
        )
        self.event("20260103")
        snapshot = warehouse.refresh()
        self.event("20260103", actual_day="20260104")
        with self.assertRaisesRegex(CollectorError, "错误日期"):
            warehouse.refresh()
        self.assertEqual(warehouse.status()["snapshot_id"], snapshot["snapshot_id"])

    def test_stock_snapshot_is_one_complete_run_and_has_no_historical_date_filter(self):
        warehouse = SnapshotWarehouse(
            self.store, self.service, self.root / "stock_basic", WAREHOUSE_ADAPTERS["stock_basic"],
        )
        self.stock_snapshot("first")
        first = warehouse.refresh()
        self.assertEqual((first["partitions"], first["rows"], first["days"]), (15, 3, 0))
        sdk = Warehouse(self.root)
        self.assertEqual(len(sdk.read_file("stock_basic")), 3)
        self.assertEqual(sdk.describe("stock_basic")["storage_layout"], "current_snapshot")
        self.assertIsNone(first["first_date"])
        self.assertEqual(first["months"][0]["month"], "current")
        self.stock_snapshot("second")
        second = warehouse.refresh()
        self.assertNotEqual(first["snapshot_id"], second["snapshot_id"])
        rows = warehouse.rows(ts_code="600000.SH")
        self.assertEqual(rows["rows"][0][rows["columns"].index("name")], "second")
        old = warehouse.rows(snapshot_id=first["snapshot_id"])
        self.assertTrue(all(row[old["columns"].index("name")] == "first" for row in old["rows"]))
        with self.assertRaisesRegex(CollectorError, "不支持历史"):
            warehouse.rows(start_date="20260101")
        bundle = warehouse.export(str(self.root / "output"), None, None, ["name"], ["600000.SH"])
        self.assertEqual(bundle["columns"], ["ts_code", "name"])
        self.assertEqual((bundle["days"], bundle["rows"]), (0, 1))
        self.assertIsNone(bundle["start_date"])
        grouped = warehouse.export(
            str(self.root / "output"), None, None, ["name"],
            file_layout="grouped", split_by="name",
        )
        self.assertEqual((grouped["files"], grouped["rows"], grouped["days"]), (1, 3, 0))
        manifest = json.loads(Path(grouped["manifest_path"]).read_text())
        self.assertEqual(manifest["files"][0]["split_value"], "second")

    def test_stock_snapshot_excludes_partial_runs_and_does_not_downgrade_after_raw_deletion(self):
        warehouse = SnapshotWarehouse(
            self.store, self.service, self.root / "stock_basic", WAREHOUSE_ADAPTERS["stock_basic"],
        )
        self.stock_snapshot("old")
        newest = self.stock_snapshot("new")
        snapshot = warehouse.refresh()
        adapter = WAREHOUSE_ADAPTERS["stock_basic"]
        partial_frame = pd.DataFrame({
            name: ["600000.SH" if name == "ts_code" else "SSE" if name == "exchange"
                   else "L" if name == "list_status" else "partial"]
            for name in adapter.schema.names
        })
        partial, _ = self.run_config(
            self.config(
                entry_id="25", params={"exchange": "SSE", "list_status": "L"}, transport="sdk",
                fields=",".join(adapter.schema.names),
            ),
            [Response(None, None, "sdk_dataframe_parquet", frame=partial_frame)],
        )
        self.register(partial, "SSE:L", "stock_basic")
        self.assertFalse(warehouse.refresh()["changed"])
        with self.store.connect() as db:
            db.execute("UPDATE runs SET state='failed' WHERE id=?", (newest["id"],))
        self.assertFalse(warehouse.refresh()["changed"])
        self.assertEqual(warehouse.status()["snapshot_id"], snapshot["snapshot_id"])
        with self.store.connect() as db:
            db.execute("UPDATE runs SET state='succeeded' WHERE id=?", (newest["id"],))
        slice_id = newest["slices"][0]["id"]
        info = check_deletion(self.store, newest["id"], slice_id)
        delete_archive(self.store, newest["id"], slice_id, info["fingerprint"])
        self.assertFalse(warehouse.refresh()["changed"])
        rows = warehouse.rows()
        self.assertTrue(all(row[rows["columns"].index("name")] == "new" for row in rows["rows"]))

    def test_shape_routes_export_without_fake_snapshot_dates_and_preserve_event_identity_fields(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        self.service = DatasetService(self.store, self.root / "raw")
        for warehouse in app.state.warehouses.values():
            warehouse.datasets = self.service
        self.stock_snapshot("current")
        self.event("20260103")
        headers = {"X-Collector-Request": "1"}
        with TestClient(app, base_url="http://127.0.0.1") as client, patch(
            "collector.client.make_client", side_effect=AssertionError("No supplier request"),
        ):
            for dataset in ("stock_basic", "dividend"):
                response = client.post(f"/api/warehouse/{dataset}/refresh", headers=headers, json={})
                self.assertEqual(response.status_code, 200)
            stock = client.get("/api/warehouse/stock_basic").json()
            self.assertEqual(stock["grain"], "current_snapshot")
            self.assertEqual(stock["key_columns"], ["ts_code"])
            self.assertEqual(stock["days"], 0)
            self.assertEqual(client.get(
                "/api/warehouse/stock_basic/rows", params={"start_date": "20260101"},
            ).status_code, 409)
            bundle = client.post("/api/warehouse/stock_basic/export", headers=headers, json={
                "destination": str(self.root / "output"), "columns": ["name"], "ts_codes": ["600000.SH"],
                "snapshot_id": stock["snapshot_id"],
            })
            self.assertEqual(bundle.status_code, 201)
            self.assertEqual(bundle.json()["columns"], ["ts_code", "name"])
            self.assertIsNone(bundle.json()["start_date"])
            event = client.post("/api/warehouse/dividend/export", headers=headers, json={
                "destination": str(self.root / "output"), "start_date": "20260103", "end_date": "20260103",
                "columns": ["cash_div"],
            })
            self.assertEqual(event.status_code, 201)
            self.assertEqual(event.json()["rows"], 2)
            self.assertEqual(
                event.json()["columns"], ["ts_code", "ann_date", "end_date", "div_proc", "cash_div"],
            )
            self.assertEqual(client.post("/api/warehouse/dividend/export", headers=headers, json={
                "destination": str(self.root / "output"),
            }).status_code, 409)

    def test_historical_stock_identifiers_remain_exact_in_snapshot_events_and_exports(self):
        self.stock_snapshot("legacy", historical=True)
        stock = SnapshotWarehouse(
            self.store, self.service, self.root / "stock_basic", WAREHOUSE_ADAPTERS["stock_basic"],
        )
        self.assertEqual(stock.refresh()["rows"], 4)
        page = stock.rows(ts_code="T600018.SH")
        self.assertEqual(page["rows"][0][0], "T600018.SH")
        self.event("20010215", code="T00018.SH")
        event = DateWarehouse(
            self.store, self.service, self.root / "dividend", WAREHOUSE_ADAPTERS["dividend"],
        )
        event.refresh()
        page = event.rows(ts_code="T00018.SH")
        self.assertEqual(page["matching_rows"], 2)
        self.assertTrue(all(row[0] == "T00018.SH" for row in page["rows"]))
        bundle = event.export(
            str(self.root / "output"), "20010215", "20010215", ts_codes=["T00018.SH"],
        )
        manifest = json.loads(Path(bundle["manifest_path"]).read_text())
        path = Path(bundle["directory"]) / manifest["files"][0]["file"]
        self.assertEqual(pq.read_table(path)["ts_code"].to_pylist(), ["T00018.SH", "T00018.SH"])
        frame = pd.DataFrame({"ts_code": ["T00018.SH"], "ann_date": ["20010215"]})
        validate_dataset_response(
            RECIPES["dividend"], Response(None, None, frame=frame), {"ann_date": "20010215"},
        )
        for invalid in ("T00018.SZ", "T00018.BJ", "X600018.SH", "T0018.SH"):
            with self.subTest(invalid=invalid):
                frame["ts_code"] = [invalid]
                with self.assertRaises(CollectionFailure):
                    validate_dataset_response(
                        RECIPES["dividend"], Response(None, None, frame=frame), {"ann_date": "20010215"},
                    )
                with self.assertRaises(CollectorError):
                    event.rows(ts_code=invalid)
        frame = pd.DataFrame({"ts_code": ["T600018.SH"], "trade_date": ["20010215"]})
        with self.assertRaises(CollectionFailure):
            validate_dataset_response(
                RECIPES["daily"], Response(None, None, frame=frame), {"trade_date": "20010215"},
            )
        with self.assertRaises(CollectorError):
            self.warehouse.rows(ts_code="T600018.SH")

    def test_expanded_date_adapters_publish_read_and_project_all_declared_shapes(self):
        baseline = {"daily", "daily_basic", "adj_factor", "moneyflow", "stock_basic", "dividend"}
        with (
            patch("collector.client.make_client", side_effect=AssertionError("No supplier request")),
            patch.dict("collector.runner.API_ACCESS", {
                "hm_detail": {**API_ACCESS["hm_detail"], "account_access": "points_satisfied"},
            }),
        ):
            for dataset_id in {
                key for key, adapter in WAREHOUSE_ADAPTERS.items() if adapter.engine == "date"
            } - baseline:
                with self.subTest(dataset_id=dataset_id):
                    adapter = WAREHOUSE_ADAPTERS[dataset_id]
                    code = "885001.TI" if adapter.code_filter == "board" else "600000.SH"
                    self.sample(dataset_id, "20260105", codes=(code,))
                    warehouse = DateWarehouse(
                        self.store, self.service, self.root / "warehouse" / dataset_id, adapter,
                    )
                    published = warehouse.refresh()
                    self.assertEqual((published["days"], published["rows"]), (1, 1))
                    self.assertEqual(published["code_filter"], adapter.code_filter)
                    rows = warehouse.rows(ts_code=code if adapter.code_filter != "none" else "")
                    self.assertEqual(rows["matching_rows"], 1)
                    projection = [adapter.schema.names[-1]]
                    result = warehouse.export(
                        str(self.root / "output"), "20260101", "20260131", projection,
                        [code] if adapter.code_filter != "none" else [],
                    )
                    expected = list(adapter.key_columns) + [
                        column for column in projection if column not in adapter.key_columns
                    ]
                    self.assertEqual(result["columns"], expected)
                    self.assertEqual(result["rows"], 1)

    def test_multiple_records_keep_identical_rows_and_replace_only_the_changed_date(self):
        adapter = WAREHOUSE_ADAPTERS["top_inst"]
        warehouse = DateWarehouse(self.store, self.service, self.root / "top_inst", adapter)
        self.sample("top_inst", "20260105", codes=("600000.SH", "600000.SH"))
        self.sample("top_inst", "20260202", codes=("600000.SH",))
        first = warehouse.refresh()
        self.assertEqual((first["rows"], first["days_with_rows"]), (3, 2))
        rows = warehouse.rows(ts_code="600000.SH", start_date="20260105", end_date="20260105")
        self.assertEqual(rows["matching_rows"], 2)
        self.assertEqual(rows["rows"][0], rows["rows"][1])
        self.sample("top_inst", "20260105", codes=())
        second = warehouse.refresh()
        self.assertEqual((second["days"], second["days_with_rows"], second["rows"]), (2, 1, 1))
        self.assertEqual(first["months"][1]["file"], second["months"][1]["file"])
        self.assertEqual(warehouse.rows(snapshot_id=first["snapshot_id"])["matching_rows"], 3)

    def test_period_bars_distinguish_checked_days_from_days_with_rows(self):
        adapter = WAREHOUSE_ADAPTERS["weekly"]
        warehouse = DateWarehouse(self.store, self.service, self.root / "weekly", adapter)
        self.sample("weekly", "20260105", codes=())
        self.sample("weekly", "20260109", codes=("600000.SH",))
        status = warehouse.refresh()
        self.assertEqual((status["days"], status["days_with_rows"], status["rows"]), (2, 1, 1))
        self.assertEqual(status["grain"], "period_bar")
        bundle = warehouse.export(str(self.root / "output"), "20260105", "20260109", ["close"])
        self.assertEqual(bundle["days"], 1)
        self.sample("weekly", "20260109", codes=("600000.SH", "600000.SH"))
        with self.assertRaisesRegex(CollectorError, "重复"):
            warehouse.refresh()
        self.assertEqual(warehouse.status()["snapshot_id"], status["snapshot_id"])

    def test_board_and_aggregate_filters_never_apply_stock_code_assumptions(self):
        board = DateWarehouse(
            self.store, self.service, self.root / "board", WAREHOUSE_ADAPTERS["ths_daily"],
        )
        self.sample("ths_daily", "20260105", codes=("885001.TI", "885002.TI"))
        board.refresh()
        rows = board.rows(ts_code="885001.TI")
        self.assertEqual(rows["matching_rows"], 1)
        self.assertIn("885001.TI", rows["rows"][0])
        with self.assertRaisesRegex(CollectorError, "板块代码"):
            board.rows(ts_code="885001.TI/../../")
        aggregate = DateWarehouse(
            self.store, self.service, self.root / "aggregate", WAREHOUSE_ADAPTERS["moneyflow_mkt_dc"],
        )
        self.sample("moneyflow_mkt_dc", "20260105", codes=("unused",))
        aggregate.refresh()
        rows = aggregate.rows()
        self.assertNotIn("ts_code", rows["columns"])
        self.assertEqual(rows["matching_rows"], 1)
        with self.assertRaisesRegex(CollectorError, "市场汇总"):
            aggregate.rows(ts_code="600000.SH")
        with self.assertRaisesRegex(CollectorError, "市场汇总"):
            aggregate.export(str(self.root / "output"), "20260101", "20260131", ts_codes=["600000.SH"])
        self.sample("moneyflow_mkt_dc", "20260105", overrides={"trade_date": ["20260106", "20260106"]})
        with self.assertRaisesRegex(CollectorError, "错误日期"):
            aggregate.refresh()

    def test_request_date_parameter_can_differ_from_output_date_and_split_sources_are_rejected(self):
        adapter = WAREHOUSE_ADAPTERS["stk_alert"]
        warehouse = DateWarehouse(self.store, self.service, self.root / "alert", adapter)
        run = self.sample("stk_alert", "20260105")
        status = warehouse.refresh()
        self.assertEqual(status["date_column"], "start_date")
        rows = warehouse.rows(start_date="20260105", end_date="20260105")
        self.assertEqual(rows["matching_rows"], 2)
        with self.store.connect() as db:
            db.execute(
                "UPDATE dataset_partitions SET partition_key=? WHERE slice_id=?",
                ('20260105|{"ts_code":"600000.SH"}', run["slices"][0]["id"]),
            )
        with self.assertRaisesRegex(CollectorError, "拆分"):
            warehouse.refresh()

    def test_wide_table_projection_and_aggregate_api_shape(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        self.service = DatasetService(self.store, self.root / "raw")
        for warehouse in app.state.warehouses.values():
            warehouse.datasets = self.service
        self.sample("stk_seasoned", "20260105", codes=("600000.SH",))
        self.sample("moneyflow_mkt_dc", "20260105", codes=("unused",))
        headers = {"X-Collector-Request": "1"}
        with TestClient(app, base_url="http://127.0.0.1") as client:
            for dataset in ("stk_seasoned", "moneyflow_mkt_dc"):
                result = client.post(f"/api/warehouse/{dataset}/refresh", json={}, headers=headers)
                self.assertEqual(result.status_code, 200)
            columns = WAREHOUSE_ADAPTERS["stk_seasoned"].schema.names[:60]
            result = client.post("/api/warehouse/stk_seasoned/export", headers=headers, json={
                "destination": str(self.root / "output"), "start_date": "20260101", "end_date": "20260131",
                "columns": columns,
            })
            self.assertEqual(result.status_code, 201)
            self.assertEqual(len(result.json()["columns"]), 60)
            result = client.post("/api/warehouse/moneyflow_mkt_dc/export", headers=headers, json={
                "destination": str(self.root / "output"), "start_date": "20260101", "end_date": "20260131",
                "columns": ["net_amount"],
            })
            self.assertEqual(result.status_code, 201)
            self.assertEqual(result.json()["columns"], ["trade_date", "net_amount"])
            self.assertEqual(client.get("/api/warehouse/moneyflow_mkt_dc/rows", params={
                "ts_code": "600000.SH",
            }).status_code, 409)

    def request_source(self, dataset, params, key, *, dates=("20260105",), value=1, overrides=None):
        adapter = WAREHOUSE_ADAPTERS[dataset]
        spec = RECIPES[dataset].get("rule", {})
        code = params.get(
            "ts_code", "885001.TI" if spec.get("domain") in {"board", "membership"} else "600000.SH",
        )
        frame = pd.DataFrame({
            field.name: [
                day if field.name == adapter.date_column
                else code if field.name == "ts_code"
                else params.get("con_code", "600000.SH") if field.name == "con_code"
                else params[field.name] if field.name in params
                else day if field.name in {"ann_date", "f_ann_date", "end_date"}
                else "sample" if pa.types.is_string(field.type) else value
                for day in dates
            ]
            for field in adapter.schema
        })
        for column, values in (overrides or {}).items():
            frame[column] = values
        api_name = ENTRIES[adapter.entry_id]["api_name"]
        with patch.dict("collector.runner.API_ACCESS", {
            api_name: {**API_ACCESS[api_name], "account_access": "points_satisfied"},
        }):
            run, _ = self.run_config(
                self.config(
                    entry_id=adapter.entry_id, params=params, transport="sdk", allow_empty=True,
                    fields=",".join(adapter.schema.names),
                ),
                [Response(None, None, "sdk_dataframe_parquet", frame=frame)],
            )
        self.assertEqual(run["state"], "succeeded", run.get("error"))
        self.register(run, "20260105", dataset, partition_key=key)
        return run

    def request_warehouse(self, dataset):
        return RequestWarehouse(
            self.store, self.service, self.root / "warehouse" / dataset, WAREHOUSE_ADAPTERS[dataset],
        )

    def test_request_adapters_validate_every_approved_recipe_and_export_exact_rows(self):
        for dataset in REQUEST_WAREHOUSE_DATASETS:
            with self.subTest(dataset=dataset):
                recipe = RECIPES[dataset]
                spec = recipe.get("rule", {})
                params = dict(spec.get("fixed", {}))
                params.update({
                    name: option["default"][0] for name, option in spec.get("options", {}).items()
                })
                strategy = spec.get("strategy")
                if recipe["kind"] == "calendar":
                    params.update(exchange="SSE", start_date="20260105", end_date="20260105")
                elif recipe["kind"] == "financial" or strategy == "stock_window":
                    params.update(ts_code="600000.SH", start_date="20260101", end_date="20260131")
                else:
                    if strategy in {"stock_day", "stock_quarter"}:
                        params[spec.get("code_param", "ts_code")] = "600000.SH"
                    if strategy == "board_day":
                        params["ts_code"] = "885001.TI"
                    date_param = spec["date_param"]
                    if date_param == "range":
                        params.update(start_date="20260105", end_date="20260105")
                    else:
                        params[date_param] = "20260105"
                overrides = {"is_open": [1]} if dataset == "trade_cal" else None
                self.request_source(dataset, params, "source-one", overrides=overrides)
                warehouse = self.request_warehouse(dataset)
                status = warehouse.refresh()
                self.assertEqual((status["partitions"], status["rows"], status["days"]), (1, 1, 1))
                sdk = Warehouse(self.root / "warehouse")
                self.assertEqual(len(sdk.read_file(dataset)), 1)
                self.assertEqual(
                    sdk.read_file(dataset, snapshot_id=status["snapshot_id"]).attrs["snapshot_id"],
                    status["snapshot_id"],
                )
                self.assertEqual(status["storage_layout"], "request_partitions")
                self.assertEqual(warehouse.rows()["matching_rows"], 1)
                bundle = warehouse.export(str(self.root / "output"), "20260101", "20260131")
                self.assertEqual(bundle["rows"], 1)
                manifest = json.loads(Path(bundle["manifest_path"]).read_text())
                self.assertEqual(manifest["variant_id"], status["variants"][0]["id"])

    def test_financial_windows_preserve_report_variants_reuse_files_and_pin_old_snapshots(self):
        first_params = {"ts_code": "600000.SH", "start_date": "20250101", "end_date": "20251231"}
        self.request_source(
            "income", first_params, "stock:2025", dates=("20250401", "20250401"),
            overrides={"report_type": ["1", "4"], "update_flag": ["0", "1"]},
        )
        self.request_source("income", {
            "ts_code": "600000.SH", "start_date": "20260101", "end_date": "20261231",
        }, "stock:2026")
        warehouse = self.request_warehouse("income")
        first = warehouse.refresh()
        self.assertEqual((first["partitions"], first["rows"]), (2, 3))
        page = warehouse.rows(start_date="20250401", end_date="20250401", limit=1)
        self.assertEqual((page["matching_rows"], len(page["rows"]), page["next_offset"]), (2, 1, 1))
        self.assertEqual(warehouse.rows(
            start_date="20250401", end_date="20250401", offset=1,
        )["matching_rows"], 2)
        self.request_source("income", first_params, "stock:2025", dates=("20250401",), value=9)
        second = warehouse.refresh()
        self.assertEqual(second["rows"], 2)
        reused = (
            {item["file"] for item in first["months"]} & {item["file"] for item in second["months"]}
        )
        self.assertEqual(len(reused), 1)
        self.assertEqual(warehouse.rows(snapshot_id=first["snapshot_id"])["matching_rows"], 3)

    def test_compact_request_files_still_read_legacy_paths_and_keep_old_snapshots(self):
        params = {"ts_code": "600000.SH", "start_date": "20260101", "end_date": "20260131"}
        self.request_source("income", params, "legacy")
        warehouse = self.request_warehouse("income")
        first = warehouse.refresh()
        root = Path(first["repository_root"])
        path = Path(first["snapshot_manifest_path"])
        manifest = json.loads(path.read_bytes())
        item = manifest["months"][0]
        original = root / item["file"]
        legacy = root / "snapshots" / first["snapshot_id"] / "partitions" / f"{item['month']}.parquet"
        legacy.parent.mkdir()
        original.rename(legacy)
        item["file"] = legacy.relative_to(root).as_posix()
        content = (encode(manifest) + "\n").encode()
        path.write_bytes(content)
        with self.store.connect() as db:
            db.execute(
                "UPDATE warehouse_snapshots SET manifest_sha256=? WHERE id=?",
                (hashlib.sha256(content).hexdigest(), first["snapshot_id"]),
            )
        old_rows = warehouse.rows()
        self.request_source("income", {**params, "ts_code": "000001.SZ"}, "additional", value=9)
        second = warehouse.refresh()
        self.assertEqual(warehouse.rows(snapshot_id=first["snapshot_id"]), old_rows)
        self.assertTrue(legacy.is_file())
        self.assertNotEqual(warehouse.rows()["rows"], old_rows["rows"])
        second_manifest = json.loads(Path(second["snapshot_manifest_path"]).read_bytes())
        self.assertIn(
            legacy.relative_to(root).as_posix(), [item["file"] for item in second_manifest["months"]],
        )
        relative = next(item["file"] for item in second_manifest["months"] if "/p/" in item["file"])
        self.assertEqual(len(Path(relative).stem), 52)
        windows_root = (
            PureWindowsPath(r"C:\Users\Researcher\Documents\Tushare-Collector\data")
            / "warehouse" / "income" / root.name
        )
        self.assertLess(len(str(windows_root / PureWindowsPath(relative))), 260)

    def test_request_windows_reject_overlap_and_narrowing_without_losing_current_data(self):
        params = {"ts_code": "600000.SH", "start_date": "20260101", "end_date": "20260131"}
        self.request_source("income", params, "one")
        warehouse = self.request_warehouse("income")
        snapshot = warehouse.refresh()
        self.request_source("income", {
            "ts_code": "600000.SH", "start_date": "20260102", "end_date": "20260130",
        }, "one", value=2)
        with self.assertRaisesRegex(CollectorError, "范围收窄"):
            warehouse.refresh()
        self.assertEqual(warehouse.status()["snapshot_id"], snapshot["snapshot_id"])
        self.assertEqual(warehouse.rows()["matching_rows"], 1)
        self.request_source("income", params, "one", value=3)
        self.request_source("income", {
            "ts_code": "600000.SH", "start_date": "20260120", "end_date": "20260228",
        }, "overlap", dates=("20260201",))
        with self.assertRaisesRegex(CollectorError, "重叠"):
            warehouse.refresh()
        self.assertEqual(warehouse.rows(snapshot_id=snapshot["snapshot_id"])["matching_rows"], 1)

    def test_request_variants_are_mandatory_when_multiple_and_never_merged(self):
        for kind, value in (("P", 1), ("D", 2)):
            self.request_source("fina_mainbz", {
                "ts_code": "600000.SH", "start_date": "20260101", "end_date": "20260131", "type": kind,
            }, kind, value=value)
        warehouse = self.request_warehouse("fina_mainbz")
        snapshot = warehouse.refresh()
        self.assertEqual(len(snapshot["variants"]), 2)
        with self.assertRaisesRegex(CollectorError, "variant_id"):
            warehouse.rows()
        with self.assertRaisesRegex(CollectorError, "variant_id"):
            warehouse.export(str(self.root / "output"), "20260101", "20260131")
        for variant in snapshot["variants"]:
            rows = warehouse.rows(variant_id=variant["id"])
            self.assertEqual(rows["matching_rows"], 1)
            bundle = warehouse.export(
                str(self.root / "output"), "20260101", "20260131", variant_id=variant["id"],
                file_layout="grouped", split_by="ts_code",
            )
            self.assertEqual(bundle["rows"], 1)
            manifest = json.loads(Path(bundle["manifest_path"]).read_text())
            self.assertEqual(manifest["variant_id"], variant["id"])
            self.assertEqual(manifest["files"][0]["split_value"], "600000.SH")
        with self.assertRaisesRegex(CollectorError, "不属于"):
            warehouse.rows(variant_id="a" * 64)

    def test_calendar_and_membership_partitions_use_their_own_keys_and_date_columns(self):
        self.request_source("trade_cal", {
            "exchange": "SSE", "start_date": "20260101", "end_date": "20260102",
        }, "SSE:2026", dates=("20260101", "20260102"), overrides={"is_open": [0, 1]})
        calendar = self.request_warehouse("trade_cal")
        self.assertEqual(calendar.refresh()["days"], 2)
        self.assertEqual(calendar.rows(start_date="20260102", end_date="20260102")["matching_rows"], 1)
        with self.assertRaises(CollectorError):
            calendar.rows(ts_code="600000.SH")
        self.request_source("dc_member", {"ts_code": "885001.TI", "trade_date": "20260105"}, "board-one")
        membership = self.request_warehouse("dc_member")
        membership.refresh()
        self.assertEqual(membership.rows(ts_code="600000.SH")["matching_rows"], 1)
        with self.assertRaises(CollectorError):
            membership.rows(ts_code="885001.TI")

    def test_split_definition_blocks_publication_but_keeps_published_reads_available(self):
        self.request_source("income", {
            "ts_code": "600000.SH", "start_date": "20260101", "end_date": "20260131",
        }, "one")
        warehouse = self.request_warehouse("income")
        snapshot = warehouse.refresh()
        with self.store.connect() as db:
            settings, _ = self.service.checked_settings(db, "income")
            db.execute("INSERT INTO dataset_splits VALUES(?,?,?,?,?)", (
                "income", scope_for(RECIPES["income"], settings), "one", "{}", "2026-01-01",
            ))
        with self.assertRaisesRegex(CollectorError, "拆分"):
            warehouse.refresh()
        self.assertEqual(warehouse.rows(snapshot_id=snapshot["snapshot_id"])["matching_rows"], 1)

    def test_request_api_requires_variant_and_keeps_non_request_warehouses_strict(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        self.service = DatasetService(self.store, self.root / "raw")
        for warehouse in app.state.warehouses.values():
            warehouse.datasets = self.service
        for kind in ("S", "R"):
            self.request_source("suspend_d", {"trade_date": "20260105", "suspend_type": kind}, kind)
        headers = {"X-Collector-Request": "1"}
        with TestClient(app, base_url="http://127.0.0.1") as client:
            response = client.post("/api/warehouse/suspend_d/refresh", json={}, headers=headers)
            self.assertEqual(response.status_code, 200)
            snapshot = response.json()
            self.assertEqual(len(snapshot["variants"]), 2)
            self.assertEqual(client.get("/api/warehouse/suspend_d/rows").status_code, 409)
            variant = snapshot["variants"][0]["id"]
            rows = client.get("/api/warehouse/suspend_d/rows", params={
                "variant_id": variant, "snapshot_id": snapshot["snapshot_id"],
            })
            self.assertEqual(rows.status_code, 200)
            self.assertEqual(rows.json()["matching_rows"], 1)
            body = {
                "destination": str(self.root / "output"),
                "start_date": "20260101", "end_date": "20260131",
            }
            self.assertEqual(client.post(
                "/api/warehouse/suspend_d/export", json=body, headers=headers,
            ).status_code, 409)
            exported = client.post("/api/warehouse/suspend_d/export", headers=headers, json={
                **body, "variant_id": variant,
            })
            self.assertEqual(exported.status_code, 201)
            self.assertEqual(exported.json()["variant_id"], variant)
            self.assertEqual(client.get("/api/warehouse/suspend_d/rows", params={
                "variant_id": "a" * 64,
            }).status_code, 409)
            self.assertEqual(client.get("/api/warehouse/daily/rows", params={
                "variant_id": variant,
            }).status_code, 409)

    def test_request_empty_revisions_and_deleted_raw_preserve_published_evidence(self):
        params = {"ts_code": "600000.SH", "start_date": "20260101", "end_date": "20260131"}
        self.request_source("income", params, "one")
        newest = self.request_source("income", params, "one", value=9)
        warehouse = self.request_warehouse("income")
        snapshot = warehouse.refresh()
        slice_id = newest["slices"][0]["id"]
        info = check_deletion(self.store, newest["id"], slice_id)
        delete_archive(self.store, newest["id"], slice_id, info["fingerprint"])
        self.assertFalse(warehouse.refresh()["changed"])
        self.assertEqual(warehouse.status()["snapshot_id"], snapshot["snapshot_id"])
        self.request_source("income", params, "one", dates=())
        empty = warehouse.refresh()
        self.assertEqual((empty["partitions"], empty["rows"], empty["days"]), (1, 0, 0))
        self.assertEqual(warehouse.rows()["matching_rows"], 0)
        self.assertEqual(warehouse.rows(snapshot_id=snapshot["snapshot_id"])["matching_rows"], 1)
        with self.assertRaisesRegex(CollectorError, "没有数据"):
            warehouse.export(str(self.root / "output"), "20260101", "20260131")
