import json
import runpy
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from fastapi.testclient import TestClient
from test_collector import CollectorFixture, response

from collector.app import create_app
from collector.client import CollectionFailure, SDKClient
from collector.models import ENTRIES, CollectorError
from collector.permissions import ACCESS, API_ACCESS, effective_rpm
from collector.runner import Runner
from collector.store import Store


class PermissionTests(CollectorFixture):
    def advance_clock(self, runner):
        clock = [1000000.0]
        waits = []

        def wait(run_id, seconds):
            runner.check_stop(run_id)
            waits.append(seconds)
            clock[0] += seconds

        runner.wait = wait
        wall = patch("collector.store.time.time", side_effect=lambda: clock[0])
        monotonic = patch("collector.runner.time.monotonic", side_effect=lambda: clock[0])
        wall.start()
        monotonic.start()
        self.addCleanup(wall.stop)
        self.addCleanup(monotonic.stop)
        return clock, waits

    def test_shared_global_task_and_per_api_intervals_are_measurable(self):
        runner, calls = self.runner([response(), response(), response(), response()])
        runner.global_rpm = 500
        clock, waits = self.advance_clock(runner)
        config = self.config(
            entry_id="25",
            params={},
            split_param="exchange",
            split_values=["SSE", "SZSE"],
            requests_per_minute=500,
        )
        saved = self.store.save_config(config)
        run = self.store.create_run(saved["id"])
        runner.execute(self.store.claim())
        self.assertEqual(self.store.run(run["id"])["state"], "succeeded")
        with self.store.connect() as db:
            times = [row[0] for row in db.execute("SELECT requested_at FROM api_requests ORDER BY seq")]
        self.assertAlmostEqual(times[1] - times[0], 1.2)
        self.assertAlmostEqual(waits[-1], 1.2)
        self.assertEqual(len(calls), 2)
        runner.global_rpm = 30
        saved = self.store.save_config(self.config(name="slower", requests_per_minute=10))
        self.store.create_run(saved["id"])
        runner.execute(self.store.claim())
        self.assertAlmostEqual(runner.next_request_at - clock[0], 6)
        runner.global_rpm = 10
        saved = self.store.save_config(self.config(name="global slower", requests_per_minute=500))
        self.store.create_run(saved["id"])
        runner.execute(self.store.claim())
        self.assertAlmostEqual(runner.next_request_at - clock[0], 6)
        self.assertEqual(effective_rpm("25", 500, 500), 50)
        self.assertEqual(effective_rpm("261", 500, 500), 200)
        self.assertEqual(effective_rpm("292", 500, 500), 30)

    def test_api_intervals_survive_service_reopening_and_request_switches(self):
        with patch("collector.store.time.time", return_value=1000000):
            self.store.reserve_api_request("stock_basic")
            self.store.reserve_api_request("daily")
        reopened = Store(self.store.path)
        with patch("collector.store.time.time", return_value=1000000.2):
            self.assertAlmostEqual(reopened.api_request_delay("stock_basic", 50), 1)
            self.assertEqual(reopened.api_request_delay("daily", 500), 0)
            self.assertEqual(reopened.api_request_delay("monthly", 500), 0)

    def test_daily_quota_is_durable_and_expiration_is_rolling_not_midnight(self):
        access = {**API_ACCESS["cyq_chips"], "daily_limit": 2}
        with patch.dict(API_ACCESS, {"cyq_chips": access}):
            with patch("collector.store.time.time", return_value=1000000):
                self.store.reserve_api_request("cyq_chips")
                self.store.reserve_api_request("cyq_chips")
                self.store.reserve_api_request("daily")
            reopened = Store(self.store.path)
            with patch("collector.store.time.time", return_value=1000001):
                with self.assertRaisesRegex(CollectorError, "24小时额度 2"):
                    reopened.reserve_api_request("cyq_chips")
            with reopened.connect() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 3)
            with patch("collector.store.time.time", return_value=1000000 + 86400):
                reopened.reserve_api_request("cyq_chips")
            with reopened.connect() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 1)

    def test_exhausted_quota_stops_before_supplier_call_and_is_not_retried(self):
        access = {**API_ACCESS["cyq_chips"], "daily_limit": 1}
        with patch.dict(API_ACCESS, {"cyq_chips": access}):
            self.store.reserve_api_request("cyq_chips")
            runner, calls = self.runner([])
            saved = self.store.save_config(
                self.config(entry_id="294", params={"ts_code": "600000.SH", "trade_date": "20261112"})
            )
            run = self.store.create_run(saved["id"])
            runner.execute(self.store.claim())
        result = self.store.run(run["id"], detail=True)
        self.assertEqual(result["state"], "failed")
        self.assertIn("24小时额度", result["error"])
        self.assertEqual(result["slices"][0]["error_kind"], "quota")
        self.assertEqual(len(result["attempts"]), 1)
        self.assertEqual(calls, [])
        events = self.store.activity(run_id=run["id"])["events"]
        self.assertEqual(events[-2]["kind"], "slice_failed")
        self.assertEqual(events[-2]["error_kind"], "quota")
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 1)

    def test_retries_consume_quota_and_insufficient_points_do_not_send(self):
        runner, calls = self.runner([CollectionFailure("retry", retryable=True), response()])
        self.advance_clock(runner)
        saved = self.store.save_config(self.config(max_attempts=2))
        self.store.create_run(saved["id"])
        runner.execute(self.store.claim())
        self.assertEqual(len(calls), 2)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 2)
        saved = self.store.save_config(self.config(entry_id="312"))
        run = self.store.create_run(saved["id"])
        runner.execute(self.store.claim())
        self.assertIn("10000", self.store.run(run["id"])["error"])
        self.assertEqual(len(calls), 2)
        with self.store.connect() as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM api_requests WHERE api_name='hm_detail'").fetchone()[0], 0
            )

    def test_sdk_derived_subrequests_reserve_actual_api_not_pro_bar(self):
        calls = []

        class FakeAPI:
            def query(self, api_name, fields="", **params):
                calls.append(api_name)
                return pd.DataFrame({"ts_code": ["600000.SH"], "trade_date": ["20261112"], "close": [7.0]})

        runner = Runner(
            self.store,
            "fake-sdk-credential",
            client_factory=lambda token, timeout, transport, before_request: SDKClient(
                token, timeout, before_request, api=FakeAPI()
            ),
        )
        self.advance_clock(runner)
        config = self.config(
            entry_id="109",
            transport="sdk",
            params={"ts_code": "600000.SH", "start_date": "20261112", "end_date": "20261112", "adj": "hfq"},
        )
        saved = self.store.save_config(config)
        run = self.store.create_run(saved["id"])

        def derived(api, **kwargs):
            frame = api.daily(ts_code="600000.SH")
            api.adj_factor(ts_code="600000.SH")
            return frame

        with patch("tushare.pro_bar", side_effect=derived):
            runner.execute(self.store.claim())
        self.assertEqual(self.store.run(run["id"])["state"], "succeeded")
        self.assertEqual(calls, ["daily", "adj_factor"])
        with self.store.connect() as db:
            self.assertEqual(
                [row[0] for row in db.execute("SELECT api_name FROM api_requests ORDER BY seq")],
                ["daily", "adj_factor"],
            )

    def test_sdk_swallowed_pre_request_failure_remains_visible(self):
        client = SDKClient(
            "fake",
            10,
            api=object(),
            before_request=lambda: self.fail("callback must be patched"),
        )

        def denied():
            raise CollectionFailure("local quota exhausted", kind="quota")

        client.before_request = denied

        def swallowed(api, **kwargs):
            try:
                api.daily()
            except CollectionFailure:
                return None

        with patch("tushare.pro_bar", side_effect=swallowed):
            with self.assertRaisesRegex(CollectionFailure, "local quota exhausted"):
                client.request("pro_bar", {}, "")

    def test_permission_api_exposes_all_links_and_unverified_independent_grants(self):
        app = create_app(self.root / "control", start_worker=False)
        with TestClient(app, base_url="http://127.0.0.1") as client:
            result = client.get("/api/permissions")
            self.assertEqual(result.status_code, 200)
            payload = result.json()
            self.assertEqual(payload["account_points"], 8000)
            self.assertEqual({item["id"] for item in payload["entries"]}, set(ENTRIES))
            for item in payload["entries"]:
                self.assertEqual(item["doc_url"], ENTRIES[item["id"]]["doc_url"])
                self.assertEqual(len(item["document_sha256"]), 64)
                self.assertFalse(item["permission_verified"])
            catalog = client.get("/api/catalog").json()
            for item in catalog["entries"]:
                self.assertEqual(item["access"], ACCESS[item["id"]])
                self.assertTrue(item["permission"])
            self.assertEqual(sum(item["permission_kind"] == "independent" for item in payload["entries"]), 8)
            self.assertEqual(ACCESS["370"]["daily_limit"], 300000)
            self.assertEqual(ACCESS["293"]["daily_limit"], 20000)
            checked = client.post(
                "/api/plan",
                json=self.config(entry_id="25", params={}).model_dump(),
                headers={"x-collector-request": "1"},
            ).json()
            self.assertEqual(checked["effective_rpm"], 50)
            self.assertEqual(checked["access"]["minimum_points"], 2000)
            datasets = client.get("/api/datasets").json()
            self.assertTrue(all(item["access"] == ACCESS[item["entry_id"]] for item in datasets))
            self.assertTrue(all(item["doc_url"] == ENTRIES[item["entry_id"]]["doc_url"] for item in datasets))
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 0)

    def test_audit_does_not_parse_row_counts_or_dates_as_point_requirements(self):
        build = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/build_permissions.py"))[
            "build"
        ]
        audit = {
            "verified_at": "2026-11-15",
            "sources": [],
            "entries": [
                {
                    "id": "110",
                    "api_name": "pledge_stat",
                    "name": "fixture",
                    "introduction": "限量：单次最大1000 积分：用户需要至少2000积分才可以调取",
                    "permission_evidence": [],
                    "url": ENTRIES["110"]["doc_url"],
                    "sha256": "0" * 64,
                },
                {
                    "id": "348",
                    "api_name": "moneyflow_ths",
                    "name": "fixture",
                    "introduction": "开始于2019-07-26 积分：6000积分可调取",
                    "permission_evidence": [],
                    "url": ENTRIES["348"]["doc_url"],
                    "sha256": "0" * 64,
                },
            ],
        }
        result = build(audit)
        self.assertEqual([item["minimum_points"] for item in result["entries"]], [2000, 6000])
        self.assertNotIn("token", json.dumps(result).lower())
