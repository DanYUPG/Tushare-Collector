import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from fastapi.testclient import TestClient
from test_collector import CollectorFixture, response

from collector.app import create_app
from collector.archive_delete import check_deletion, delete_archive
from collector.artifacts import preview_slice
from collector.client import Response
from collector.models import CollectorError


class LocalDataTests(CollectorFixture):
    def test_business_navigation_summaries_filters_and_deleted_evidence(self):
        first, _ = self.run_config(self.config(), [response(3)])
        self.run_config(self.config(name="重复请求范围"), [response(2)])
        self.run_config(
            self.config(name="疑似截断", raw_root=str(self.root / "other"), row_limit=2),
            [response(2)],
        )
        pending = self.store.create_run(self.store.save_config(self.config(name="尚无文件"))["id"])
        directory = self.store.local_data_navigation()
        self.assertEqual(len(directory["domains"]), 9)
        self.assertEqual(directory["defined_entries"], 102)
        self.assertEqual(directory["local_entries"], 1)
        self.assertEqual(directory["archives"], 3)
        self.assertEqual(directory["successful_archives"], 2)
        self.assertEqual(directory["failed_archives"], 1)
        self.assertEqual(directory["other_archives"], 0)
        self.assertEqual(directory["successful_rows"], 5)
        self.assertEqual(directory["summary_basis"], "registered_archives")
        self.assertFalse(directory["hash_verified"])
        self.assertFalse(directory["coverage_verified"])
        item = directory["entries"][0]
        self.assertEqual(item["business_domain"], "prices")
        self.assertEqual(item["entry_id"], "27")
        self.assertTrue(item["has_data"])
        self.assertIsNotNone(item["last_collected_at"])
        all_entries = self.store.local_data_navigation(include_empty=True)["entries"]
        self.assertEqual(len({entry["entry_id"] for entry in all_entries}), 102)
        self.assertEqual(
            {entry["entry_id"] for entry in all_entries if entry["api_name"] == "pro_bar"},
            {"109", "146"},
        )
        financial = self.store.local_data_navigation(business_domain="financial", include_empty=True)
        self.assertEqual(financial["archives"], 0)
        self.assertGreater(len(financial["entries"]), 0)
        self.assertEqual(
            next(domain for domain in financial["domains"] if domain["id"] == "prices")["archives"], 3
        )
        other = self.store.local_data_navigation(raw_root=str(self.root / "other"), query="DAILY")
        self.assertEqual(other["archives"], 1)
        self.assertEqual(other["successful_rows"], 0)
        self.assertEqual(len(other["entries"]), 1)
        self.assertEqual(self.store.local_data_navigation(query="' OR 1=1 --")["archives"], 0)
        self.assertEqual(self.store.local_data_navigation(query="不存在的接口")["entries"], [])
        with self.assertRaisesRegex(CollectorError, "业务分类"):
            self.store.local_data_navigation(business_domain="unknown")

        # Missing files remain registered evidence, not an empty or verified table.
        path = Path(first["slices"][0]["raw_path"])
        body = path.read_bytes()
        path.unlink()
        self.assertEqual(self.store.local_data_navigation()["archives"], 3)
        path.write_bytes(body)
        self.store.cancel(pending["id"])
        info = check_deletion(self.store, first["id"], first["slices"][0]["id"])
        delete_archive(self.store, first["id"], first["slices"][0]["id"], info["fingerprint"])
        self.assertEqual(self.store.local_data_navigation()["archives"], 2)
        self.assertEqual(self.store.local_data_navigation()["successful_rows"], 2)

    def test_business_file_filters_preserve_pagination_and_source_distinctions(self):
        task, _ = self.run_config(self.config(), [response()])
        preview = self.store.create_preview(self.config(name="单次查询", max_attempts=1))
        runner, _ = self.runner([response()])
        runner.execute(self.store.claim())
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO dataset_plans VALUES(?,?,?,?,?,?,?)",
                ("fixture-plan", "daily", 1, "{}", "20261115", "20261116", task["id"]),
            )
            db.execute(
                "INSERT INTO dataset_runs VALUES(?,?,?,?,?,?)",
                (task["id"], "daily", "full", "fixture", "{}", "fixture-plan"),
            )
        page = self.store.local_data(business_domain="prices", limit=1)
        self.assertEqual(page["archives"], 2)
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(page["next_offset"], 1)
        self.assertEqual(page["items"][0]["business_domain_name"], "量价与复权")
        self.assertEqual(
            self.store.local_data(source_type="preview")["items"][0]["run_id"], preview["id"]
        )
        self.assertEqual(
            self.store.local_data(source_type="dataset")["items"][0]["run_id"], task["id"]
        )
        self.assertEqual(self.store.local_data(source_type="task")["archives"], 0)
        self.assertEqual(self.store.local_data(business_domain="financial")["archives"], 0)
        self.assertEqual(
            self.store.local_data(business_domain="prices", state="succeeded", entry_id="33")["archives"], 0
        )
        with self.assertRaisesRegex(CollectorError, "来源"):
            self.store.local_data(source_type="unknown")
        with self.assertRaisesRegex(CollectorError, "业务分类"):
            self.store.local_data(business_domain="unknown")

    def test_navigation_api_is_offline_read_only_and_validates_filters(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        self.run_config(self.config(), [response()])
        with self.store.connect() as db:
            before = db.iterdump()
            baseline = list(before)
        with (
            TestClient(app, base_url="http://127.0.0.1") as client,
            patch("collector.client.make_client", side_effect=AssertionError("No supplier")),
        ):
            app.state.runner.set_token("")
            directory = client.get("/api/local-data/navigation")
            self.assertEqual(directory.status_code, 200)
            self.assertEqual(directory.json()["archives"], 1)
            self.assertEqual(
                len(client.get("/api/local-data/navigation?include_empty=true").json()["entries"]), 102
            )
            self.assertEqual(
                client.get("/api/local-data?business_domain=prices&source_type=task").json()["archives"], 1
            )
            for endpoint in (
                "/api/local-data/navigation?business_domain=unknown",
                "/api/local-data?business_domain=unknown",
            ):
                self.assertEqual(client.get(endpoint).status_code, 409)
            self.assertEqual(client.get("/api/local-data?source_type=unknown").status_code, 422)
            self.assertEqual(
                client.get("/api/local-data/navigation", params={"q": "x" * 201}).status_code, 422
            )
        with self.store.connect() as db:
            self.assertEqual(list(db.iterdump()), baseline)

    def test_archive_library_filters_paginates_and_includes_old_or_failed_archives(self):
        run, calls = self.run_config(self.config(name="本地日线 100%_"), [response(3)])
        failed, _ = self.run_config(
            self.config(name="截断文件", raw_root=str(self.root / "other"), row_limit=2),
            [response(2)],
        )
        self.store.create_run(self.store.save_config(self.config(name="尚未采集"))["id"])
        original = run["slices"][0]
        with self.store.connect() as db:
            for index in range(102):
                copy = self.store.create_run(
                    self.store.save_config(self.config(name=f"历史归档 {index}"))["id"]
                )
                with self.store.connect() as update:
                    update.execute(
                        "UPDATE slices SET raw_path=?,meta_path=?,raw_sha256=?,meta_sha256=?,"
                        "state='succeeded',rows=3 "
                        "WHERE run_id=?",
                        (
                            original["raw_path"],
                            original["meta_path"],
                            original["raw_sha256"],
                            original["meta_sha256"],
                            copy["id"],
                        ),
                    )
            total_before = db.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        page = self.store.local_data(limit=100)
        self.assertEqual(page["archives"], 104)
        self.assertEqual(page["runs"], 104)
        self.assertEqual(page["successful_rows"], 309)
        self.assertEqual(len(page["items"]), 100)
        self.assertEqual(len(self.store.local_data(offset=100, limit=100)["items"]), 4)
        self.assertIsNone(self.store.local_data(offset=104)["next_offset"])
        self.assertEqual(
            {item["run_id"] for item in self.store.local_data(query=run["id"])["items"]}, {run["id"]}
        )
        self.assertEqual(self.store.local_data(query="100%_")["archives"], 1)
        self.assertEqual(self.store.local_data(query="100___")["archives"], 0)
        self.assertEqual(self.store.local_data(query="' OR 1=1 --")["archives"], 0)
        self.assertEqual(self.store.local_data(category="financial")["archives"], 0)
        self.assertEqual(self.store.local_data(entry_id="27", query="600000.SH")["archives"], 0)
        self.assertEqual(self.store.local_data(query="20261112 历史归档")["archives"], 102)
        self.assertEqual(
            self.store.local_data(raw_root=str(self.root / "other"))["items"][0]["run_id"], failed["id"]
        )
        self.assertEqual(self.store.local_data(state="failed")["archives"], 1)
        self.assertEqual(page["catalog"][0]["archives"], 104)
        self.assertEqual(len(page["raw_roots"]), 2)
        self.assertEqual(len(calls), 1)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM runs").fetchone()[0], total_before)
        for kwargs in ({"offset": -1}, {"limit": 201}, {"state": "unknown"}, {"query": "x" * 201}):
            with self.subTest(kwargs=kwargs), self.assertRaises(CollectorError):
                self.store.local_data(**kwargs)

    def test_preview_searches_actual_rows_across_parquet_batches_without_changing_files(self):
        frame = pd.DataFrame(
            {
                "ts_code": ["600000.SH" if index % 2 == 0 else "000001.SZ" for index in range(620)],
                "remark": ["100%_测试" if index == 510 else f"row-{index}" for index in range(620)],
                "amount": [9007199254740993] * 620,
            }
        )
        run, calls = self.run_config(
            self.config(transport="sdk", fields="", allow_empty=True),
            [Response(None, None, "sdk_dataframe_parquet", frame=frame)],
        )
        item = run["slices"][0]
        path = Path(item["raw_path"])
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        page = preview_slice(self.store, run["id"], item["id"], 250, 50, "600000.sh", "ts_code")
        self.assertEqual(page["total_rows"], 620)
        self.assertEqual(page["matching_rows"], 310)
        self.assertEqual(len(page["rows"]), 50)
        self.assertEqual(page["rows"][0], ["600000.SH", "row-500", "9007199254740993"])
        self.assertEqual(page["next_offset"], 300)
        self.assertEqual(
            len(preview_slice(self.store, run["id"], item["id"], 300, 50, "600000.SH")["rows"]), 10
        )
        exact = preview_slice(self.store, run["id"], item["id"], query="100%_")
        self.assertEqual(exact["matching_rows"], 1)
        self.assertEqual(exact["rows"][0][1], "100%_测试")
        empty = preview_slice(self.store, run["id"], item["id"], query="does-not-exist")
        self.assertEqual(empty["matching_rows"], 0)
        self.assertEqual(empty["rows"], [])
        self.assertIsNone(empty["next_offset"])
        for kwargs in ({"query": "x", "column": "unknown"}, {"column": "ts_code"}, {"query": "x" * 201}):
            with self.subTest(kwargs=kwargs), self.assertRaises(CollectorError):
                preview_slice(self.store, run["id"], item["id"], **kwargs)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertEqual(len(calls), 1)
        path.write_bytes(path.read_bytes() + b"test-tampered")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            preview_slice(self.store, run["id"], item["id"], query="600000.SH")

    def test_json_search_and_failed_archive_remain_explicit(self):
        payload = json.loads(response(3).body)
        payload["data"]["items"][1][0] = "000001.SZ"
        run, _ = self.run_config(self.config(row_limit=2), [Response(json.dumps(payload).encode(), 200)])
        item = run["slices"][0]
        page = preview_slice(self.store, run["id"], item["id"], query="000001", column="ts_code")
        self.assertEqual(page["matching_rows"], 1)
        self.assertEqual(page["total_rows"], 3)
        self.assertEqual(page["source_state"], "failed")
        self.assertEqual(page["rows"][0][0], "000001.SZ")
        with self.assertRaisesRegex(CollectorError, "筛选字段不存在"):
            preview_slice(self.store, run["id"], item["id"], query="x", column="missing")

    def test_read_only_api_needs_no_token_and_reports_missing_files_not_empty_success(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        run, _ = self.run_config(self.config(), [response()])
        item = run["slices"][0]
        endpoint = f"/api/runs/{run['id']}/slices/{item['id']}/preview"
        with (
            TestClient(app, base_url="http://127.0.0.1") as client,
            patch("collector.client.make_client", side_effect=AssertionError("No supplier")),
        ):
            app.state.runner.set_token("")
            page = client.get("/api/local-data")
            self.assertEqual(page.status_code, 200)
            self.assertEqual(page.json()["items"][0]["slice_id"], item["id"])
            self.assertEqual(
                client.get(endpoint, params={"q": "600000", "column": "ts_code"}).json()["matching_rows"], 1
            )
            self.assertEqual(client.get("/api/local-data", params={"limit": 201}).status_code, 422)
            self.assertEqual(client.get(endpoint, params={"q": "x" * 201}).status_code, 422)
            Path(item["raw_path"]).unlink()
            self.assertEqual(client.get("/api/local-data").json()["archives"], 1)
            missing = client.get(endpoint)
            self.assertEqual(missing.status_code, 409)
            self.assertIn("不存在", missing.json()["detail"])
            self.assertEqual(client.get("/api/local-data", params={"q": "no-match"}).json()["archives"], 0)
