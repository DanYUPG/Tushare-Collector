import json
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd
from fastapi.testclient import TestClient
from test_collector import fast_forward_wait

from collector.app import create_app
from collector.archive_delete import check_deletion, delete_archive
from collector.client import CollectionFailure, Response, SDKClient
from collector.datasets import (
    RECIPES,
    DatasetBundleRequest,
    DatasetGroupRequest,
    DatasetPlanRequest,
    DatasetService,
    DatasetSettings,
    calendar_rows,
    validate_dataset_response,
)
from collector.models import CollectorError, TaskConfig
from collector.runner import Runner
from collector.store import Store

TOKEN = "dataset-tests-not-a-real-credential"


def frame_for(api_name, fields, params):
    names = fields.split(",")
    if api_name == "trade_cal":
        start = datetime.strptime(params["start_date"], "%Y%m%d").date()
        end = datetime.strptime(params["end_date"], "%Y%m%d").date()
        days = [start + timedelta(days=n) for n in range((end - start).days + 1)]
        return pd.DataFrame(
            {
                "exchange": [params["exchange"]] * len(days),
                "cal_date": [day.strftime("%Y%m%d") for day in days],
                "is_open": [int(day.weekday() < 5) for day in days],
                "pretrade_date": [(day - timedelta(days=1)).strftime("%Y%m%d") for day in days],
            }
        )[names]
    if api_name == "stock_basic":
        if params["list_status"] != "L":
            return pd.DataFrame(columns=names)
        code = {"SSE": "600000.SH", "SZSE": "000001.SZ", "BSE": "430047.BJ"}[params["exchange"]]
        row = dict.fromkeys(names, "fixture")
        row.update(ts_code=code, list_status=params["list_status"], exchange=params["exchange"])
    else:
        row = dict.fromkeys(names, 1.0)
        row.update(ts_code=params.get("ts_code", "600000.SH"))
        if api_name in {"income", "balancesheet", "cashflow", "fina_indicator"}:
            row.update(ann_date=params["start_date"], end_date=params["start_date"])
        elif api_name == "dividend":
            row.update(ann_date=params["ann_date"])
        else:
            row.update(trade_date=params["trade_date"])
    return pd.DataFrame([row], columns=names)


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "control.sqlite3")
        self.service = DatasetService(self.store, self.root / "raw")
        self.clock = patch("collector.datasets.china_today", return_value=date(2026, 11, 14))
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.calls = []
        self.fault = None
        owner = self

        class FakeAPI:
            def query(self, api_name, fields="", **params):
                owner.calls.append((api_name, params))
                frame = frame_for(api_name, fields, params)
                return owner.fault(api_name, params, frame) if owner.fault else frame

        self.runner = Runner(
            self.store,
            TOKEN,
            client_factory=lambda token, timeout, transport, before_request: SDKClient(
                token, timeout, before_request, api=FakeAPI()
            ),
        )
        fast_forward_wait(self, self.runner)

    def make_plan(self, dataset="daily", mode="full", start="2026-11-02", end="2026-11-13", **settings):
        current = next(item for item in self.service.list() if item["id"] == dataset)
        return self.service.create_plan(
            dataset,
            DatasetPlanRequest(
                settings={**current["settings"], "start_date": start, **settings},
                expected_revision=current["revision"],
                mode=mode,
                end_date=end,
            ),
            30,
        )

    def execute(self, plan):
        run = self.service.launch(plan["dataset_id"], plan["id"], 30)
        self.runner.execute(self.store.claim())
        return self.store.run(run["id"], detail=True)

    def calendar(self):
        return self.execute(self.make_plan("trade_cal"))

    def test_early_calendar_uses_sse_and_reuses_evidence_despite_legacy_szse_failure(self):
        plan = self.make_plan("trade_cal", start="1990-12-19", end="1991-12-31")
        self.assertEqual(
            [part["params"]["exchange"] for part in plan["partitions"]], ["SSE", "SSE"]
        )
        self.assertEqual(plan["partitions"][0]["params"]["start_date"], "19901219")
        run = self.execute(plan)
        self.assertEqual(run["state"], "succeeded")
        original = run["slices"][0]
        with patch("collector.datasets.MARKET_CALENDAR_EXCHANGE", "SZSE"):
            self.fault = lambda api, params, frame: frame.iloc[:0]
            legacy = self.execute(self.make_plan("trade_cal", start="1990-12-19", end="1991-12-31"))
        self.fault = None
        self.assertEqual(legacy["state"], "failed")
        self.assertEqual(self.card("trade_cal")["covered_partitions"], 2)
        self.assertEqual(self.card("trade_cal")["unfinished_partitions"], 0)
        retry = self.make_plan("trade_cal", "retry", start="1990-12-19", end="1991-12-31")
        self.assertEqual(retry["total_slices"], 0)
        daily = self.make_plan(start="1990-12-19", end="1990-12-31")
        self.assertGreater(daily["total_slices"], 0)
        self.assertTrue(any("交易日基准：SSE" in warning for warning in daily["warnings"]))
        self.assertEqual(self.store.run(legacy["id"])["state"], "failed")
        with self.assertRaisesRegex(CollectorError, "旧日历"):
            self.store.resume(legacy["id"])
        self.assertEqual(self.store.run(legacy["id"])["state"], "failed")
        Path(original["raw_path"]).unlink()
        with self.assertRaisesRegex(CollectorError, "交易日历归档不可用"):
            self.make_plan(start="1990-12-19", end="1990-12-31")

    def test_old_calendar_plan_requires_reconfirmation_under_sse_baseline(self):
        with patch("collector.datasets.MARKET_CALENDAR_EXCHANGE", "SZSE"):
            old = self.make_plan("trade_cal")
        with self.assertRaisesRegex(CollectorError, "计划"):
            self.service.launch("trade_cal", old["id"], 30)
        self.assertEqual(self.store.runs(), [])

    def card(self, dataset):
        return next(item for item in self.service.list() if item["id"] == dataset)

    def test_activity_events_include_managed_dataset_identity(self):
        run = self.calendar()
        events = self.store.activity(run_id=run["id"])["events"]
        self.assertEqual(events[0]["kind"], "run_queued")
        self.assertEqual(events[-1]["kind"], "run_succeeded")
        self.assertTrue(all(item["dataset_id"] == "trade_cal" for item in events))
        self.assertTrue(all(item["api_name"] == "trade_cal" for item in events))
        self.assertEqual(sum(item["kind"] == "slice_succeeded" for item in events), run["total"])

    def test_deleted_archive_is_not_covered_and_invalidates_frozen_update_plan(self):
        self.calendar()
        run = self.execute(self.make_plan(start="2026-11-12"))
        frozen = self.make_plan(mode="incremental", start="2026-11-12", lookback_days=1)
        item = run["slices"][0]
        info = check_deletion(self.store, run["id"], item["id"])
        delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        card = self.card("daily")
        self.assertEqual(card["covered_partitions"], 1)
        self.assertEqual(card["unfinished_partitions"], 1)
        self.assertEqual(self.service.coverage("daily", query="20261112")["items"][0]["state"], "failed")
        with self.assertRaisesRegex(CollectorError, "已变化"):
            self.service.launch("daily", frozen["id"], 30)
        checked = self.make_plan(mode="incremental", start="2026-11-12", lookback_days=1)
        self.assertEqual(checked["partitions"][0]["key"], "20261112")
        self.assertEqual(checked["partitions"][0]["reason"], "retry")
        self.assertEqual(self.execute(checked)["state"], "succeeded")
        self.assertEqual(self.card("daily")["covered_partitions"], 2)

    def test_deleting_newest_archive_preserves_an_older_success_for_same_partition(self):
        self.calendar()
        self.execute(self.make_plan(start="2026-11-12"))
        run = self.execute(self.make_plan(start="2026-11-12"))
        item = run["slices"][0]
        info = check_deletion(self.store, run["id"], item["id"])
        delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        self.assertEqual(self.card("daily")["covered_partitions"], 2)
        coverage = self.service.coverage("daily", query="20261112")["items"][0]
        self.assertIsNotNone(coverage["successful_slice_id"])
        self.assertNotEqual(coverage["successful_slice_id"], item["id"])

    def test_deleting_calendar_evidence_requires_dependency_repair_before_daily_launch(self):
        run = self.calendar()
        frozen = self.make_plan(start="2026-11-12")
        item = run["slices"][0]
        info = check_deletion(self.store, run["id"], item["id"])
        delete_archive(self.store, run["id"], item["id"], info["fingerprint"])
        with self.assertRaisesRegex(CollectorError, "日历缺少"):
            self.service.launch("daily", frozen["id"], 30)
        review = self.service.review(
            "daily",
            DatasetPlanRequest(
                settings=frozen["settings"], expected_revision=0, mode="full", end_date="2026-11-13"
            ),
            30,
        )
        self.assertEqual(review["stage"], "dependencies")
        self.assertEqual(review["plan"]["dataset_id"], "trade_cal")

    def test_review_freezes_exact_calendar_dependency_without_settings_or_source_run(self):
        source = self.card("daily")
        body = DatasetPlanRequest(
            settings={**source["settings"], "start_date": "2026-11-12"},
            expected_revision=source["revision"],
            mode="full",
            end_date="2026-11-13",
        )
        reviewed = self.service.review("daily", body, 30)
        self.assertEqual(reviewed["stage"], "dependencies")
        self.assertEqual(reviewed["plan"]["dataset_id"], "trade_cal")
        self.assertEqual(reviewed["plan"]["total_slices"], 1)
        self.assertEqual(reviewed["plan"]["start_date"], "2026-11-12")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.store.runs(), [])
        self.assertEqual(self.card("daily")["revision"], 0)
        self.assertEqual(self.card("trade_cal")["revision"], 0)
        self.execute(reviewed["plan"])
        checked = self.service.review("daily", body, 30)
        self.assertEqual(checked["stage"], "data")
        self.assertEqual(checked["plan"]["total_slices"], 2)
        self.assertEqual(checked["plan"]["start_date"], "2026-11-12")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.store.runs()), 1)
        self.assertEqual(self.card("daily")["revision"], 0)
        with self.assertRaisesRegex(CollectorError, "计划"):
            self.service.launch("trade_cal", reviewed["plan"]["id"], 30)

    def test_review_stock_dependency_and_failed_calendar_do_not_start_source(self):
        for dataset, dependency, count in [("income", "stock_basic", 15), ("daily", "trade_cal", 1)]:
            source = self.card(dataset)
            body = DatasetPlanRequest(
                settings={**source["settings"], "start_date": "2026-11-12"},
                expected_revision=0,
                mode="full",
                end_date="2026-11-13",
            )
            reviewed = self.service.review(dataset, body, 30)
            self.assertEqual(reviewed["stage"], "dependencies")
            self.assertEqual(reviewed["plan"]["dataset_id"], dependency)
            self.assertEqual(reviewed["plan"]["total_slices"], count)
            if dependency == "trade_cal":

                def denied(*args):
                    raise CollectionFailure("fixture denied", retryable=False)

                self.fault = denied
                self.assertEqual(self.execute(reviewed["plan"])["state"], "failed")
                repair = self.service.review(dataset, body, 30)
                self.assertEqual(repair["stage"], "dependencies")
                self.assertEqual(repair["plan"]["total_slices"], 1)
        self.assertEqual(len(self.store.runs()), 1)
        self.assertEqual(self.card("income")["revision"], 0)
        self.assertEqual(self.card("daily")["revision"], 0)

    def test_full_uses_verified_open_days_and_persists_coverage_without_early_requests(self):
        self.calendar()
        checked = self.make_plan()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.store.runs()), 1)
        self.assertEqual(checked["total_slices"], 10)
        self.assertEqual([p["key"] for p in checked["partitions"][:2]], ["20261102", "20261103"])
        self.assertNotIn("20261107", [p["key"] for p in checked["partitions"]])
        run = self.execute(checked)
        self.assertEqual(run["state"], "succeeded")
        self.assertEqual(run["dataset_id"], "daily")
        self.assertEqual(run["dataset_plan"]["total_slices"], 10)
        self.assertEqual(self.card("daily")["covered_partitions"], 10)
        first = self.service.coverage("daily", limit=3)
        self.assertEqual(first["total"], 10)
        self.assertEqual(first["next_offset"], 3)
        self.assertEqual(self.service.coverage("daily", offset=9)["items"][0]["key"], "20261113")
        self.assertEqual(self.service.coverage("daily", offset=10)["items"], [])
        self.assertEqual(self.service.coverage("daily", query="no-such-date")["total"], 0)
        reopened = DatasetService(Store(self.store.path), self.root / "raw")
        self.assertEqual(
            next(row for row in reopened.list() if row["id"] == "daily")["last_partition"], "20261113"
        )
        self.assertEqual(self.store.configurations(), [])
        with self.assertRaisesRegex(CollectorError, "预置数据集"):
            self.store.create_run(run["config_id"])
        with self.assertRaisesRegex(CollectorError, "预置数据集"):
            self.store.save_config(TaskConfig.model_validate(run["config"]), run["config_id"], 1)

    def test_incremental_repairs_middle_failures_even_after_later_dates_succeed(self):
        self.calendar()
        self.fault = lambda api, params, frame: (
            frame.iloc[:0] if params.get("trade_date") == "20261104" else frame
        )
        failed = self.execute(self.make_plan(end="2026-11-06"))
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(failed["completed"], 2)
        self.fault = None
        self.execute(self.make_plan(start="2026-11-06", end="2026-11-06"))
        checked = self.make_plan(mode="incremental", lookback_days=1)
        keys = [item["key"] for item in checked["partitions"]]
        self.assertIn("20261104", keys)
        self.assertIn("20261105", keys)
        self.assertNotIn("20261106", keys)
        self.assertNotIn("20261102", keys)
        self.assertEqual(checked["counts"]["retry"], 2)
        self.assertEqual(self.execute(checked)["state"], "succeeded")
        self.assertEqual(self.card("daily")["covered_partitions"], 10)

    def test_failed_refresh_retains_old_archives_and_retries_outside_overlap(self):
        self.calendar()
        full = self.execute(self.make_plan())
        old = full["slices"][0]
        before = Path(old["raw_path"]).read_bytes()
        self.fault = lambda api, params, frame: (
            frame.iloc[:0] if params.get("trade_date") == "20261112" else frame
        )
        failed = self.execute(self.make_plan(mode="incremental", lookback_days=2))
        self.assertEqual(failed["state"], "failed")
        self.assertEqual(self.card("daily")["covered_partitions"], 10)
        checked = self.make_plan(mode="incremental", lookback_days=1)
        self.assertEqual([p["key"] for p in checked["partitions"]], ["20261112", "20261113"])
        self.assertEqual(checked["counts"]["retry"], 2)
        self.assertEqual(Path(old["raw_path"]).read_bytes(), before)
        ledger = self.service.coverage("daily", query="20261112", state="failed")
        self.assertEqual(ledger["total"], 1)
        row = ledger["items"][0]
        self.assertNotEqual(row["slice_id"], row["successful_slice_id"])
        self.assertTrue(row["has_data"])
        self.assertEqual(row["successful_rows"], 1)
        retry = self.make_plan(mode="retry", lookback_days=1)
        self.assertEqual(retry["total_slices"], 2)

    def test_directory_scope_does_not_claim_old_files_and_start_expansion_reuses_dates(self):
        self.calendar()
        full = self.execute(self.make_plan(start="2026-11-12"))
        expanded = self.make_plan(mode="incremental", lookback_days=1)
        self.assertEqual(expanded["covered_partitions"], 2)
        self.assertEqual(expanded["total_slices"], 9)
        new_root = self.make_plan(mode="incremental", raw_root=str(self.root / "other"), lookback_days=1)
        self.assertEqual(new_root["covered_partitions"], 0)
        self.assertEqual(new_root["total_slices"], 10)
        self.assertTrue(Path(full["slices"][0]["raw_path"]).is_file())

    def test_snapshot_queries_all_exchanges_and_statuses_and_updates_as_new_snapshots(self):
        full = self.execute(self.make_plan("stock_basic"))
        self.assertEqual(full["state"], "succeeded")
        self.assertEqual(full["total"], 15)
        self.assertEqual(full["rows"], 3)
        self.assertEqual(self.card("stock_basic")["covered_partitions"], 15)
        update = self.make_plan("stock_basic", "incremental")
        self.assertEqual(update["total_slices"], 15)
        self.assertEqual(update["counts"]["refresh"], 15)
        self.assertEqual(self.make_plan("stock_basic", "retry")["total_slices"], 0)
        second = self.execute(update)
        self.assertNotEqual(full["id"], second["id"])
        self.assertNotEqual(full["slices"][0]["raw_path"], second["slices"][0]["raw_path"])

    def test_calendar_dependency_missing_incomplete_or_tampered_is_not_silently_skipped(self):
        with self.assertRaisesRegex(CollectorError, "交易日历缺少"):
            self.make_plan()
        self.assertEqual(self.calls, [])
        self.assertEqual(self.card("daily")["revision"], 0)
        self.fault = lambda api, params, frame: frame.iloc[1:] if api == "trade_cal" else frame
        failed = self.calendar()
        self.assertEqual(failed["state"], "failed")
        self.assertIn("完整日期", failed["error"])
        self.assertEqual(self.card("trade_cal")["covered_partitions"], 0)
        self.fault = None
        full = self.calendar()
        raw = Path(full["slices"][0]["raw_path"])
        raw.write_bytes(raw.read_bytes() + b"tampered")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            self.make_plan()

    def test_plan_launch_binds_revision_coverage_and_expiry_and_is_atomic(self):
        first = self.make_plan("trade_cal")
        second = self.make_plan("trade_cal")
        run = self.service.launch("trade_cal", second["id"], 30)
        with self.assertRaises(CollectorError):
            self.service.launch("trade_cal", second["id"], 30)
        self.assertEqual(len(self.store.runs()), 1)
        self.runner.execute(self.store.claim())
        with self.assertRaisesRegex(CollectorError, "设置"):
            self.service.launch("trade_cal", first["id"], 30)
        third = self.make_plan("trade_cal", "incremental")
        with self.store.connect() as db:
            db.execute(
                "UPDATE dataset_plans SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?", (third["id"],)
            )
        with self.assertRaisesRegex(CollectorError, "30 分钟"):
            self.service.launch("trade_cal", third["id"], 30)
        fourth = self.make_plan("trade_cal")
        settings = DatasetSettings.model_validate({**fourth["settings"], "requests_per_minute": 15})
        self.service.save_settings("trade_cal", settings, fourth["settings_revision"])
        with self.assertRaisesRegex(CollectorError, "设置已修改"):
            self.service.launch("trade_cal", fourth["id"], 30)
        self.assertEqual(len(self.store.runs()), 1)
        self.assertEqual(self.store.run(run["id"])["state"], "succeeded")

    def test_calendar_changes_invalidate_daily_plan_and_active_dependencies_block_it(self):
        self.calendar()
        checked = self.make_plan()
        calendar = self.make_plan("trade_cal", "incremental")
        self.service.launch("trade_cal", calendar["id"], 30)
        with self.assertRaisesRegex(CollectorError, "交易日历正在"):
            self.service.launch("daily", checked["id"], 30)
        self.runner.execute(self.store.claim())
        with self.assertRaisesRegex(CollectorError, "日历"):
            self.service.launch("daily", checked["id"], 30)

    def test_future_dates_no_work_recovery_and_same_dataset_resume_conflicts(self):
        with self.assertRaisesRegex(CollectorError, "昨天"):
            self.make_plan("trade_cal", end="2026-11-14")
        empty = self.make_plan("trade_cal", "retry")
        self.assertEqual(empty["total_slices"], 0)
        with self.assertRaisesRegex(CollectorError, "空运行"):
            self.service.launch("trade_cal", empty["id"], 30)
        run = self.service.launch("trade_cal", self.make_plan("trade_cal")["id"], 30)
        self.store.claim()
        self.store.recover()
        self.assertEqual(self.store.run(run["id"])["state"], "interrupted")
        next_plan = self.make_plan("trade_cal", "retry")
        self.assertEqual(next_plan["total_slices"], 1)
        self.service.launch("trade_cal", next_plan["id"], 30)
        with self.assertRaisesRegex(CollectorError, "数据集已有活动"):
            self.store.resume(run["id"])

    def test_checking_plan_does_not_save_settings_and_launch_saves_only_confirmed_settings(self):
        self.calendar()
        original = self.configure("daily")
        before_calls, before_runs = len(self.calls), len(self.store.runs())
        checked = self.make_plan(start="2026-11-05", raw_root=str(self.root / "draft-root"))
        other = self.make_plan(start="2026-11-09")
        self.assertEqual(self.card("daily")["settings"], original["settings"])
        self.assertEqual(self.card("daily")["revision"], original["revision"])
        self.assertEqual(checked["settings_revision"], original["revision"])
        self.assertEqual(len(self.calls), before_calls)
        self.assertEqual(len(self.store.runs()), before_runs)
        self.assertEqual(checked["start_date"], "2026-11-05")
        run = self.execute(checked)
        self.assertEqual(run["state"], "succeeded")
        self.assertEqual(self.card("daily")["settings"]["start_date"], "2026-11-05")
        self.assertEqual(self.card("daily")["settings"]["raw_root"], str(self.root / "draft-root"))
        self.assertEqual(self.card("daily")["revision"], original["revision"] + 1)
        with self.assertRaisesRegex(CollectorError, "设置已修改"):
            self.service.launch("daily", other["id"], 30)

    def test_default_and_bundle_checks_leave_settings_unwritten_until_confirmation(self):
        checked = self.make_plan("trade_cal")
        self.assertEqual(checked["settings_revision"], 0)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dataset_settings").fetchone()[0], 0)
        self.configure("daily")
        self.service.save_settings(
            "trade_cal", DatasetSettings(raw_root=str(self.root / "raw"), start_date="2026-11-13"), 0
        )
        original = self.card("trade_cal")
        body = DatasetBundleRequest(dataset_ids=["daily"], mode="full", end_date="2026-11-13")
        bundle = self.service.create_bundle(body, 30)
        self.assertEqual(bundle["stage"], "dependencies")
        self.assertEqual(bundle["plans"][0]["settings"]["start_date"], "2026-11-12")
        self.assertEqual(self.card("trade_cal")["settings"], original["settings"])
        self.assertEqual(self.card("trade_cal")["revision"], original["revision"])
        self.assertEqual(self.calls, [])
        self.finish_batch(self.service.launch_bundle(bundle["id"], 30))
        self.assertEqual(self.card("trade_cal")["settings"]["start_date"], "2026-11-12")
        with self.assertRaisesRegex(CollectorError, "设置已修改"):
            self.service.launch("trade_cal", checked["id"], 30)

    def test_bad_directory_is_explicit_and_can_be_repaired_without_breaking_other_cards(self):
        root = self.root / "broken"
        settings = DatasetSettings(raw_root=str(root))
        self.service.save_settings("daily", settings, 0)
        root.write_text("not a directory")
        self.assertEqual(len(self.service.list()), len(RECIPES))
        self.assertIn("settings_error", self.card("daily"))
        self.assertIsNone(self.card("daily")["covered_partitions"])
        with self.assertRaisesRegex(CollectorError, "设置或目录已无效"):
            self.service.create_bundle(DatasetBundleRequest(dataset_ids=["daily"]), 30)
        repaired = self.service.save_settings("daily", DatasetSettings(raw_root=str(self.root / "new")), 1)
        self.assertEqual(repaired["revision"], 2)
        self.assertNotIn("settings_error", self.card("daily"))

    def test_dataset_schema_guards_reject_wrong_dates_duplicates_and_calendar_flags(self):
        response = Response(
            None,
            None,
            "sdk_dataframe_parquet",
            frame=pd.DataFrame({"ts_code": ["600000.SH"], "trade_date": ["20261112"]}),
        )
        validate_dataset_response(RECIPES["daily"], response, {"trade_date": "20261112"})
        for frame in [
            pd.DataFrame({"ts_code": ["600000.SH"], "trade_date": ["20261113"]}),
            pd.DataFrame({"ts_code": ["600000.SH"] * 2, "trade_date": ["20261112"] * 2}),
            pd.DataFrame({"ts_code": ["IF.CFFEX"], "trade_date": ["20261112"]}),
        ]:
            with self.assertRaises(CollectionFailure):
                validate_dataset_response(
                    RECIPES["daily"],
                    Response(None, None, "sdk_dataframe_parquet", frame=frame),
                    {"trade_date": "20261112"},
                )
        params = {"exchange": "SSE", "start_date": "20261112", "end_date": "20261113"}
        valid = frame_for("trade_cal", "exchange,cal_date,is_open,pretrade_date", params)
        self.assertEqual(len(calendar_rows(valid, params)), 2)
        for frame in [
            valid.iloc[:1],
            pd.concat([valid, valid.iloc[:1]]),
            valid.assign(is_open=2),
            valid.assign(exchange="SZSE"),
        ]:
            with self.assertRaises(CollectionFailure):
                calendar_rows(frame, params)

    def test_daily_basic_and_adjustment_recipes_collect_all_catalog_fields(self):
        self.calendar()
        for dataset in ("daily_basic", "adj_factor"):
            checked = self.make_plan(dataset, start="2026-11-12")
            run = self.execute(checked)
            self.assertEqual(run["state"], "succeeded")
            self.assertEqual(run["completed"], 2)
            self.assertEqual(self.card(dataset)["covered_partitions"], 2)
            self.assertIn("ts_code", run["config"]["fields"].split(","))

    def test_failed_calendar_refresh_retains_old_source_but_requires_new_confirmation(self):
        self.calendar()
        previous = self.make_plan()
        self.fault = lambda api, params, frame: frame.iloc[:1] if api == "trade_cal" else frame
        self.execute(self.make_plan("trade_cal", "incremental"))
        with self.assertRaisesRegex(CollectorError, "日历"):
            self.service.launch("daily", previous["id"], 30)
        checked = self.make_plan()
        self.assertTrue(any("使用此前成功" in warning for warning in checked["warnings"]))
        self.assertEqual(checked["total_slices"], 10)

    def test_financial_stock_pool_includes_delisted_codes_and_preserves_report_variants(self):
        with self.assertRaisesRegex(CollectorError, "股票池缺少"):
            self.make_plan("income")
        self.assertEqual(self.calls, [])

        def delisted(api, params, frame):
            if api == "stock_basic" and params == {"exchange": "SSE", "list_status": "D"}:
                row = dict.fromkeys(frame.columns, "fixture")
                row.update(ts_code="600001.SH", exchange="SSE", list_status="D")
                return pd.DataFrame([row], columns=frame.columns)
            return frame

        self.fault = delisted
        pool = self.execute(self.make_plan("stock_basic"))
        self.fault = lambda api, params, frame: pd.concat([frame, frame]) if api == "income" else frame
        for dataset in ("income", "balancesheet", "cashflow", "fina_indicator"):
            checked = self.make_plan(dataset)
            self.assertEqual(checked["total_slices"], 4)
            self.assertIn("600001.SH", [item["params"]["ts_code"] for item in checked["partitions"]])
            self.assertEqual(
                checked["recipe"]["date_field"], "end_date" if dataset == "fina_indicator" else "ann_date"
            )
            run = self.execute(checked)
            self.assertEqual(run["state"], "succeeded")
            self.assertEqual(run["rows"], 8 if dataset == "income" else 4)
        raw = Path(pool["slices"][0]["raw_path"])
        raw.write_bytes(raw.read_bytes() + b"tampered")
        with self.assertRaisesRegex(CollectorError, "股票池归档不可用.*哈希"):
            self.make_plan("income")

    def test_financial_filters_use_correct_date_semantics_and_bounds_expansion_is_missing(self):
        params = {"ts_code": "600000.SH", "start_date": "20261101", "end_date": "20261113"}
        frame = pd.DataFrame(
            {"ts_code": ["600000.SH"] * 2, "ann_date": ["20261112"] * 2, "end_date": ["20251231"] * 2}
        )
        validate_dataset_response(RECIPES["income"], Response(None, None, frame=frame), params)
        with self.assertRaisesRegex(CollectionFailure, "end_date.*超出"):
            validate_dataset_response(RECIPES["fina_indicator"], Response(None, None, frame=frame), params)
        for bad in ["2026111", "20260230", None, "20261114"]:
            with self.assertRaises(CollectionFailure):
                validate_dataset_response(
                    RECIPES["income"], Response(None, None, frame=frame.assign(ann_date=bad)), params
                )
        self.execute(self.make_plan("stock_basic"))
        self.execute(self.make_plan("income", start="2026-11-05", end="2026-11-06"))
        checked = self.make_plan("income", "incremental", start="2026-11-02", lookback_days=1)
        self.assertEqual(checked["counts"]["missing"], 3)
        self.assertEqual(self.execute(checked)["state"], "succeeded")
        self.assertEqual(self.make_plan("income", "retry")["total_slices"], 0)
        self.assertEqual(self.make_plan("income", "incremental", lookback_days=1)["counts"]["refresh"], 3)

    def test_dividend_uses_natural_ann_dates_with_empty_and_multiple_records_and_moneyflow_uses_calendar(
        self,
    ):
        self.fault = lambda api, params, frame: (
            frame.iloc[:0] if params.get("ann_date") == "20261107" else pd.concat([frame, frame])
        )
        checked = self.make_plan("dividend", start="2026-11-07", end="2026-11-08")
        self.assertEqual(
            [item["params"] for item in checked["partitions"]],
            [{"ann_date": "20261107"}, {"ann_date": "20261108"}],
        )
        self.assertEqual(self.execute(checked)["state"], "succeeded")
        self.assertEqual(self.card("dividend")["covered_partitions"], 2)
        self.fault = None
        with self.assertRaisesRegex(CollectorError, "交易日历"):
            self.make_plan("moneyflow")
        self.calendar()
        self.assertEqual(self.execute(self.make_plan("moneyflow", start="2026-11-12"))["completed"], 2)

    def test_capped_daily_split_requires_confirmation_binds_pool_and_preserves_parent(self):
        self.calendar()
        self.execute(self.make_plan("stock_basic"))
        self.fault = lambda api, params, frame: (
            pd.concat([frame] * 6000) if api == "daily" and not params.get("ts_code") else frame
        )
        parent = self.execute(self.make_plan(start="2026-11-12", end="2026-11-12"))
        failed = parent["slices"][0]
        self.assertEqual(failed["error_kind"], "row_limit")
        original = Path(failed["raw_path"]).read_bytes()
        calls = len(self.calls)
        checked = self.make_plan(mode="split", start="2026-11-12", end="2026-11-12")
        self.assertEqual(checked["total_slices"], 3)
        self.assertEqual(len(self.calls), calls)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dataset_splits").fetchone()[0], 0)
        self.execute(self.make_plan("stock_basic", "incremental"))
        with self.assertRaisesRegex(CollectorError, "股票池"):
            self.service.launch("daily", checked["id"], 30)
        checked = self.make_plan(mode="split", start="2026-11-12", end="2026-11-12")
        self.fault = lambda api, params, frame: (
            frame.iloc[:0] if api == "daily" and params.get("ts_code") == "430047.BJ" else frame
        )
        split = self.execute(checked)
        self.assertEqual(split["state"], "succeeded")
        self.assertEqual(split["rows"], 2)
        self.assertEqual(self.card("daily")["unfinished_partitions"], 0)
        self.assertEqual(self.card("daily")["covered_partitions"], 3)
        self.assertEqual(self.store.run(parent["id"])["state"], "failed")
        self.assertEqual(Path(failed["raw_path"]).read_bytes(), original)
        self.assertNotIn("20261112", [row["key"] for row in self.service.coverage("daily")["items"]])
        self.assertEqual(self.make_plan(mode="retry", start="2026-11-12")["total_slices"], 0)
        self.fault = lambda api, params, frame: (
            frame.iloc[:0] if api == "daily" and not params.get("ts_code") else frame
        )
        mixed = self.execute(self.make_plan(start="2026-11-12"))
        self.assertEqual(mixed["state"], "failed")
        self.assertIn("全市场开市日返回为空", mixed["error"])
        with self.assertRaisesRegex(CollectorError, "普通失败"):
            self.make_plan(mode="split", start="2026-11-12")

    def test_financial_date_splits_are_disjoint_durable_and_remove_superseded_failures(self):
        self.execute(self.make_plan("stock_basic"))
        self.fault = lambda api, params, frame: (
            pd.concat([frame] * 100) if api == "income" and params["ts_code"] == "000001.SZ" else frame
        )
        parent = self.execute(self.make_plan("income", start="2026-11-01", end="2026-11-04"))
        self.assertEqual(parent["state"], "failed")
        self.assertEqual(parent["completed"], 2)
        checked = self.make_plan("income", "split", start="2026-11-01", end="2026-11-04")
        self.assertEqual(
            [(p["params"]["start_date"], p["params"]["end_date"]) for p in checked["partitions"]],
            [("20261101", "20261102"), ("20261103", "20261104")],
        )
        self.fault = None
        self.assertEqual(self.execute(checked)["state"], "succeeded")
        retry = self.make_plan("income", "retry", start="2026-11-01", end="2026-11-04")
        self.assertEqual(retry["total_slices"], 0)
        reopened = DatasetService(Store(self.store.path), self.root / "raw")
        self.assertEqual(
            next(row for row in reopened.list() if row["id"] == "income")["covered_partitions"], 4
        )
        self.assertEqual(self.card("income")["unfinished_partitions"], 0)
        full = self.make_plan("income", start="2026-11-01", end="2026-11-04")
        self.assertEqual(full["total_slices"], 4)

    def test_recursive_financial_split_stops_explicitly_at_single_day(self):
        self.execute(self.make_plan("stock_basic"))
        self.fault = lambda api, params, frame: (
            pd.concat([frame] * 100)
            if api == "income" and params["ts_code"] == "000001.SZ" and params["start_date"] == "20261101"
            else frame
        )
        self.execute(self.make_plan("income", start="2026-11-01", end="2026-11-04"))
        for _ in range(2):
            result = self.execute(self.make_plan("income", "split", start="2026-11-01", end="2026-11-04"))
            self.assertEqual(result["state"], "failed")
        self.assertEqual(self.card("income")["row_limit_partitions"], 1)
        with self.assertRaisesRegex(CollectorError, "单日单股.*人工核对"):
            self.make_plan("income", "split", start="2026-11-01", end="2026-11-04")

    def test_financial_retry_keeps_old_failed_codes_when_the_pool_changes(self):
        self.execute(self.make_plan("stock_basic"))
        self.fault = lambda api, params, frame: frame.assign(ann_date="bad") if api == "income" else frame
        self.assertEqual(self.execute(self.make_plan("income"))["state"], "failed")
        self.fault = lambda api, params, frame: (
            frame.assign(ts_code="000002.SZ")
            if api == "stock_basic" and params == {"exchange": "SZSE", "list_status": "L"}
            else frame
        )
        self.execute(self.make_plan("stock_basic", "incremental"))
        checked = self.make_plan("income", "retry")
        codes = [item["params"]["ts_code"] for item in checked["partitions"]]
        self.assertIn("000001.SZ", codes)
        self.assertNotIn("000002.SZ", codes)
        self.assertEqual(checked["total_slices"], 3)
        self.assertTrue(any("历史股票代码" in warning for warning in checked["warnings"]))
        self.fault = None
        self.assertEqual(self.execute(checked)["state"], "succeeded")

    def configure(self, dataset):
        current = self.card(dataset)
        return self.service.save_settings(
            dataset,
            DatasetSettings.model_validate({**current["settings"], "start_date": "2026-11-12"}),
            current["revision"],
        )

    def finish_batch(self, batch):
        for _ in batch["runs"]:
            self.runner.execute(self.store.claim())
        return self.store.batch(batch["id"])

    def test_bundle_dependencies_business_and_continuation_replay_are_confirmed_separately(self):
        ids = ["daily", "income", "stock_basic", "trade_cal"]
        for dataset in ids:
            self.configure(dataset)
        body = DatasetBundleRequest(dataset_ids=ids, mode="full", end_date="2026-11-13")
        checked = self.service.create_bundle(body, 30)
        self.assertEqual(checked["stage"], "dependencies")
        self.assertEqual(checked["stage_ids"], ["stock_basic", "trade_cal"])
        self.assertEqual(checked["total_slices"], 16)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.store.runs(), [])
        dependencies = self.service.launch_bundle(checked["id"], 30)
        continuation = body.model_copy(update={"continuation_id": checked["id"]})
        with self.assertRaisesRegex(CollectorError, "仍在执行"):
            self.service.create_bundle(continuation, 30)
        self.assertEqual(self.finish_batch(dependencies)["state"], "succeeded")
        self.assertEqual(len(self.calls), 16)
        business = self.service.create_bundle(continuation, 30)
        duplicate = self.service.create_bundle(continuation, 30)
        self.assertEqual(business["stage_ids"], ["daily", "income"])
        self.assertEqual(business["total_slices"], 5)
        self.assertEqual(len(self.calls), 16)
        batch = self.service.launch_bundle(business["id"], 30)
        self.assertEqual(self.finish_batch(batch)["state"], "succeeded")
        for bundle in (business, duplicate):
            with self.assertRaises(CollectorError):
                self.service.launch_bundle(bundle["id"], 30)
        with self.assertRaisesRegex(CollectorError, "最新阶段"):
            self.service.create_bundle(continuation, 30)
        self.assertTrue(
            next(row for row in self.service.bundles() if row["id"] == checked["id"])["next_stage_created"]
        )
        finished = next(row for row in self.service.bundles() if row["id"] == business["id"])
        self.assertEqual(finished["progress"]["completed"], 5)
        self.assertEqual(finished["progress"]["failed"], 0)
        self.assertEqual(self.store.configurations(), [])
        self.assertEqual(len(self.store.runs()), 4)

    def test_failed_dependency_repair_keeps_completed_stages_and_other_runs_continue(self):
        ids = ["daily", "income", "stock_basic", "trade_cal"]
        for dataset in ids:
            self.configure(dataset)
        body = DatasetBundleRequest(dataset_ids=ids, mode="full", end_date="2026-11-13")
        first = self.service.create_bundle(body, 30)
        self.fault = lambda api, params, frame: frame.iloc[:0] if api == "stock_basic" else frame
        self.assertEqual(self.finish_batch(self.service.launch_bundle(first["id"], 30))["state"], "partial")
        self.fault = None
        repair = self.service.create_bundle(body.model_copy(update={"continuation_id": first["id"]}), 30)
        self.assertEqual(repair["stage_ids"], ["stock_basic"])
        self.finish_batch(self.service.launch_bundle(repair["id"], 30))
        data = self.service.create_bundle(body.model_copy(update={"continuation_id": repair["id"]}), 30)
        self.assertEqual(data["stage_ids"], ["daily", "income"])
        self.assertEqual(data["stage"], "data")

    def test_bundle_validation_is_atomic_and_group_definitions_survive_reopening(self):
        self.configure("trade_cal")
        body = DatasetBundleRequest(dataset_ids=["stock_basic", "trade_cal"], end_date="2026-11-13")
        checked = self.service.create_bundle(body, 30)
        current = self.card("trade_cal")
        self.service.save_settings(
            "trade_cal",
            DatasetSettings.model_validate({**current["settings"], "requests_per_minute": 15}),
            current["revision"],
        )
        with self.assertRaisesRegex(CollectorError, "设置已修改"):
            self.service.launch_bundle(checked["id"], 30)
        self.assertEqual(self.store.runs(), [])
        self.assertEqual(self.store.configurations(), [])
        self.assertEqual(self.store.batches(), [])
        self.assertEqual(self.calls, [])
        group = self.service.save_group(
            DatasetGroupRequest(name="行情及财务", dataset_ids=["daily", "income"])
        )
        reopened = DatasetService(Store(self.store.path), self.root / "raw")
        self.assertEqual(reopened.groups()[0]["dataset_ids"], ["daily", "income"])
        with self.assertRaisesRegex(CollectorError, "同名"):
            reopened.save_group(DatasetGroupRequest(name=group["name"], dataset_ids=["daily"]))
        with self.assertRaisesRegex(CollectorError, "不重复"):
            self.service.create_bundle(DatasetBundleRequest(dataset_ids=["daily", "daily"]), 30)
        expired = self.service.create_bundle(body, 30)
        with self.store.connect() as db:
            db.execute(
                "UPDATE dataset_bundles SET expires_at='2000-01-01T00:00:00+00:00' WHERE id=?",
                (expired["id"],),
            )
        with self.assertRaisesRegex(CollectorError, "30 分钟"):
            self.service.launch_bundle(expired["id"], 30)
        with patch("collector.datasets.MAX_SLICES", 15):
            with self.assertRaisesRegex(CollectorError, "组合超过"):
                self.service.create_bundle(body, 30)
        reopened.delete_group(group["id"])
        self.assertEqual(self.service.groups(), [])


class DatasetWebTests(unittest.TestCase):
    def test_bundle_and_saved_group_routes_enforce_confirmation_and_worker_readiness(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict("os.environ", {"TUSHARE_TOKEN": ""}):
            app = create_app(Path(temporary), start_worker=False)
            headers = {"X-Collector-Request": "1"}
            body = {"dataset_ids": ["daily", "income"], "mode": "incremental", "end_date": "2026-11-12"}
            with TestClient(app, base_url="http://localhost") as client:
                route = "/api/dataset-bundles/plans"
                self.assertEqual(client.post(route, json=body).status_code, 403)
                self.assertEqual(
                    client.post(route, headers=headers, json={**body, "token": TOKEN}).status_code, 422
                )
                self.assertEqual(
                    client.post(
                        route, headers=headers, json={**body, "dataset_ids": ["unknown"]}
                    ).status_code,
                    409,
                )
                group_route = "/api/dataset-groups"
                group = client.post(
                    group_route, headers=headers, json={"name": "组合", "dataset_ids": body["dataset_ids"]}
                )
                self.assertEqual(group.status_code, 201)
                self.assertEqual(client.get(group_route).json()[0]["dataset_ids"], body["dataset_ids"])
                checked = client.post(route, headers=headers, json=body)
                self.assertEqual(checked.status_code, 200)
                self.assertEqual(checked.json()["stage"], "dependencies")
                self.assertEqual(client.get("/api/runs").json(), [])
                payload = {"plan_id": checked.json()["id"]}
                launch = "/api/dataset-bundles/runs"
                self.assertEqual(client.post(launch, headers=headers, json=payload).status_code, 409)
                client.put("/api/credential", headers=headers, json={"token": TOKEN})
                self.assertEqual(client.post(launch, headers=headers, json=payload).status_code, 409)
                with patch.object(app.state.runner, "thread", SimpleNamespace(is_alive=lambda: True)):
                    created = client.post(launch, headers=headers, json=payload)
                    self.assertEqual(created.status_code, 201)
                    self.assertEqual(len(created.json()["runs"]), 2)
                    self.assertEqual(client.post(launch, headers=headers, json=payload).status_code, 409)
                self.assertIsNotNone(client.get("/api/dataset-bundles").json()[0]["batch"])
                self.assertNotIn(TOKEN, json.dumps(client.get("/api/dataset-bundles").json()))
                self.assertEqual(
                    client.delete(f"{group_route}/{group.json()['id']}", headers=headers).status_code, 200
                )
                self.assertEqual(client.get(group_route).json(), [])

    def test_dataset_api_does_not_enqueue_before_confirmation_and_checks_worker_and_body(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict("os.environ", {"TUSHARE_TOKEN": ""}):
            app = create_app(Path(temporary), start_worker=False)
            headers = {"X-Collector-Request": "1"}
            body = {
                "settings": {"raw_root": str(Path(temporary) / "raw"), "start_date": "2026-01-01"},
                "expected_revision": 0,
                "mode": "full",
                "end_date": "2026-11-12",
            }
            with TestClient(app, base_url="http://localhost") as client:
                self.assertEqual(len(client.get("/api/datasets").json()), len(RECIPES))
                review_route = "/api/datasets/daily/review"
                self.assertEqual(client.post(review_route, json=body).status_code, 403)
                self.assertEqual(
                    client.post(review_route, headers=headers, json={**body, "token": TOKEN}).status_code, 422
                )
                reviewed = client.post(review_route, headers=headers, json=body)
                self.assertEqual(reviewed.status_code, 200)
                self.assertEqual(reviewed.json()["stage"], "dependencies")
                self.assertEqual(reviewed.json()["plan"]["total_slices"], 1)
                self.assertEqual(client.get("/api/runs").json(), [])
                self.assertTrue(all(item["revision"] == 0 for item in client.get("/api/datasets").json()))
                coverage = "/api/datasets/daily/coverage"
                self.assertEqual(client.get(coverage).json()["items"], [])
                for params in [{"offset": -1}, {"limit": 201}, {"q": "x" * 201}, {"state": "unknown"}]:
                    self.assertEqual(client.get(coverage, params=params).status_code, 422)
                route = "/api/datasets/trade_cal/plans"
                self.assertEqual(client.post(route, json=body).status_code, 403)
                self.assertEqual(
                    client.post(route, headers=headers, json={**body, "token": TOKEN}).status_code, 422
                )
                checked = client.post(route, headers=headers, json=body)
                self.assertEqual(checked.status_code, 200)
                self.assertEqual(client.get("/api/runs").json(), [])
                payload = {"plan_id": checked.json()["id"]}
                launch = "/api/datasets/trade_cal/runs"
                self.assertEqual(client.post(launch, headers=headers, json=payload).status_code, 409)
                client.put("/api/credential", headers=headers, json={"token": TOKEN})
                self.assertEqual(client.post(launch, headers=headers, json=payload).status_code, 409)
                with patch.object(app.state.runner, "thread", SimpleNamespace(is_alive=lambda: True)):
                    created = client.post(launch, headers=headers, json=payload)
                    self.assertEqual(created.status_code, 201)
                    self.assertEqual(client.post(launch, headers=headers, json=payload).status_code, 409)
                self.assertEqual(len(client.get("/api/runs").json()), 1)
                self.assertEqual(client.get("/api/configs").json(), [])
                run = client.get(f"/api/runs/{created.json()['id']}").json()
                self.assertEqual(run["dataset_plan"]["recipe"]["id"], "trade_cal")
                self.assertNotIn(TOKEN, json.dumps(run))
                self.assertNotIn(TOKEN.encode(), app.state.store.path.read_bytes())
