import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pandas as pd
from test_collector import fast_forward_wait
from test_datasets import frame_for

from collector.client import CollectionFailure, Response, SDKClient
from collector.datasets import (
    RECIPES,
    DatasetBundleRequest,
    DatasetPlanRequest,
    DatasetService,
    DatasetSettings,
    scope_for,
    validate_dataset_response,
)
from collector.models import ENTRIES, CollectorError
from collector.runner import Runner
from collector.store import Store
from scripts.refresh_catalog import extract


def catalog_frame(api_name, fields, params):
    if api_name in {"stock_basic", "trade_cal"}:
        frame = frame_for(api_name, fields, params)
        if api_name == "stock_basic":
            frame["list_date"], frame["delist_date"] = "19901219", ""
        return frame
    recipe = next(item for item in RECIPES.values() if ENTRIES[item["entry_id"]]["api_name"] == api_name)
    names = (
        fields.split(",") if fields else [field["name"] for field in ENTRIES[recipe["entry_id"]]["fields"]]
    )
    if api_name == "daily" and not fields:
        names = [name for name in names if name not in {"ah_vol", "ah_amount"}]
    row = dict.fromkeys(names, 1.0)
    row.update({name: value for name, value in params.items() if name in names})
    row["ts_code"] = params.get("ts_code", "600000.SH")
    spec = recipe.get("rule", {})
    if spec.get("domain") in {"board", "membership"}:
        row["ts_code"] = params.get("ts_code", "885001.TI")
    if api_name in {"dc_index", "tdx_index"}:
        row["ts_code"] = f"BK000{len(params['idx_type'])}.DC"
    if spec.get("domain") == "membership":
        row["con_code"] = params.get("con_code", "600000.SH")
    if spec.get("date_field"):
        row[spec["date_field"]] = params.get(spec["date_param"], params.get("start_date"))
    if spec.get("strategy") == "period":
        row["end_date"] = params["trade_date"]
    if api_name in {"daily", "adj_factor"}:
        row["trade_date"] = params.get("trade_date", params.get("start_date"))
    if api_name == "stk_account_old":
        row["date"] = params["start_date"] + "~" + params["start_date"][4:]
    if api_name == "report_rc":
        row["create_time"] = pd.Timestamp(params["report_date"] + " 12:00:00")
    return pd.DataFrame([row], columns=names)


class StockRuleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = Store(self.root / "control.sqlite3")
        self.service = DatasetService(self.store, self.root / "raw")
        clock = patch("collector.datasets.china_today", return_value=date(2026, 11, 14))
        clock.start()
        self.addCleanup(clock.stop)
        self.calls, self.fault = [], None
        owner = self

        class FakeAPI:
            def query(self, api_name, fields="", **params):
                owner.calls.append((api_name, params))
                frame = catalog_frame(api_name, fields, params)
                return owner.fault(api_name, params, frame) if owner.fault else frame

        self.runner = Runner(
            self.store,
            "catalog-rule-test-credential",
            client_factory=lambda token, timeout, transport, before_request: SDKClient(
                token, timeout, before_request, api=FakeAPI()
            ),
        )
        fast_forward_wait(self, self.runner)

    def settings(self, dataset):
        with self.store.connect() as db:
            return self.service.settings(db, dataset)

    def body(self, dataset, mode="full", start="2026-11-12", end="2026-11-13", **changes):
        settings, revision = self.settings(dataset)
        return DatasetPlanRequest(
            settings={**settings.model_dump(mode="json"), "start_date": start, **changes},
            expected_revision=revision,
            mode=mode,
            end_date=end,
        )

    def plan(self, dataset, **kwargs):
        return self.service.create_plan(dataset, self.body(dataset, **kwargs), 30)

    def execute(self, plan):
        run = self.service.launch(plan["dataset_id"], plan["id"], 30)
        self.runner.execute(self.store.claim())
        return self.store.run(run["id"], detail=True)

    def seed(self, boards=False):
        for dataset in ["stock_basic", "trade_cal", *(["dc_index", "tdx_index"] if boards else [])]:
            run = self.execute(self.plan(dataset))
            self.assertEqual(run["state"], "succeeded", run.get("error"))

    def test_every_catalog_entry_plans_executes_and_updates_without_online_planning(self):
        self.assertEqual({recipe["entry_id"] for recipe in RECIPES.values()}, set(ENTRIES))
        self.assertEqual(len(RECIPES), len(ENTRIES))
        self.seed(boards=True)
        for dataset, recipe in RECIPES.items():
            if "rule" not in recipe:
                continue
            with self.subTest(dataset=dataset):
                kwargs = {}
                if recipe["rule"]["strategy"] in {"quarter", "stock_quarter"}:
                    kwargs = {"start": "2026-09-30", "end": "2026-09-30"}
                elif recipe["rule"]["strategy"] == "period":
                    kwargs = {"start": "2026-10-30", "end": "2026-10-31"}
                elif dataset == "stk_account_old":
                    kwargs = {"start": "2015-05-28", "end": "2015-05-29"}
                count = len(self.calls)
                checked = self.plan(dataset, **kwargs)
                self.assertEqual(len(self.calls), count)
                self.assertGreater(checked["total_slices"], 0)
                run = self.execute(checked)
                if dataset == "hm_detail":
                    self.assertEqual(run["state"], "failed")
                    self.assertIn("10000", run["error"])
                    self.assertEqual(len(self.calls), count)
                    continue
                self.assertEqual(run["state"], "succeeded", run.get("error"))
                self.assertEqual(len(self.calls) - count, checked["supplier_requests"])
                count = len(self.calls)
                updated = self.plan(dataset, mode="incremental", **kwargs)
                self.assertEqual(len(self.calls), count)
                self.assertEqual(updated["counts"]["missing"], 0)
                self.assertEqual(updated["counts"]["retry"], 0)

    def test_original_dataset_coverage_hashes_remain_compatible(self):
        expected = {
            "stock_basic": "f8f5010186a184ef6fd3ca6db7a021e4c15200edf0da2c3279ac39dab29d4bce",
            "trade_cal": "74385ec270356bd069ec2e92375b1e312db82c6bc09194fa2f52cff040b6f3a7",
            "daily": "870526d4a7809318fa930bc0873bdf555ae32216bbf601713c6f134b2a640a63",
            "daily_basic": "550fff8f831eea9ccfbae1970f85beaacb45dc13f9dad0c556ae9ee1a0ab4fbe",
            "adj_factor": "d3e6912ea773470dddf2ae68b8fa00bf28dbc73fd6a424ddaab3585b9b554cb8",
            "income": "ff371d24852fd31a650fea93ec32332cc5d28d1bffd8645030e6b0742a6a1ddb",
            "balancesheet": "23c15162fe414b3fb048a7939533c2c0ce5577034c6688d9ee73958b54b1eb74",
            "cashflow": "a8bf2110deb1b9df67d52d6d7e26024f69e3ad09729be4c3222c7bd9f0ebcf8f",
            "fina_indicator": "2c6597a6598e5f378a73d6ba76e711b044c297de6972241fdccf78da2dd7f994",
            "dividend": "f4598ff834bdd75372ffbba756afa9a6d879f31ed72ffddeb00cc85f745ebb9c",
            "moneyflow": "e9b2147924ed9ee26860bd6f212d81744dac8b2333611235f713ff49fc1c5b63",
        }
        # Preserve the historical POSIX identity, even when testing on Windows.
        settings = DatasetSettings.model_construct(raw_root="/collector-scope-regression")
        for dataset, fingerprint in expected.items():
            self.assertEqual(scope_for(RECIPES[dataset], settings), fingerprint, dataset)

    def test_option_scopes_are_canonical_and_bad_options_do_not_save(self):
        settings = DatasetSettings(raw_root=str(self.root / "raw"))
        recipe = RECIPES["stk_weekly_monthly"]
        default = scope_for(recipe, settings)
        self.assertEqual(
            default, scope_for(recipe, settings.model_copy(update={"options": {"freq": ["month", "week"]}}))
        )
        self.assertNotEqual(
            default, scope_for(recipe, settings.model_copy(update={"options": {"freq": ["week"]}}))
        )
        for options in ({"freq": []}, {"freq": ["invalid"]}, {"freq": ["week", "week"]}, {"unknown": ["x"]}):
            with self.subTest(options=options), self.assertRaises(CollectorError):
                self.plan("stk_weekly_monthly", options=options)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM dataset_settings").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 0)

    def test_natural_days_report_periods_and_months_use_documented_axes(self):
        self.seed()
        natural = self.plan("st", start="2026-11-07", end="2026-11-08")
        self.assertEqual(
            [part["params"] for part in natural["partitions"]],
            [{"pub_date": "20261107"}, {"pub_date": "20261108"}],
        )
        report = self.plan("disclosure_date", start="2026-09-01")
        self.assertEqual([part["params"] for part in report["partitions"]], [{"end_date": "20260930"}])
        monthly = self.plan("broker_recommend", start="2026-10-31")
        self.assertEqual(
            [part["params"] for part in monthly["partitions"]], [{"month": "202610"}, {"month": "202611"}]
        )
        period = self.plan("stk_weekly_monthly", start="2026-10-30", end="2026-10-31")
        self.assertEqual(
            [part["params"] for part in period["partitions"]],
            [{"freq": "week", "trade_date": "20261030"}, {"freq": "month", "trade_date": "20261031"}],
        )
        minute = self.plan("stk_mins", start="2026-11-13")
        self.assertEqual(minute["total_slices"], 3)
        self.assertTrue(
            all(
                part["params"]["start_date"] == "2026-11-13 00:00:00"
                and part["params"]["end_date"] == "2026-11-13 23:59:59"
                and part["params"]["freq"] == "1min"
                for part in minute["partitions"]
            )
        )

    def test_stock_window_expansion_is_missing_even_outside_recent_window(self):
        self.seed()
        self.assertEqual(
            self.execute(self.plan("express", start="2026-11-12", end="2026-11-12"))["state"], "succeeded"
        )
        checked = self.plan("express", mode="incremental", start="2026-11-01", lookback_days=1)
        self.assertEqual(checked["counts"]["missing"], 3)
        self.assertTrue(all(part["params"]["start_date"] == "20261101" for part in checked["partitions"]))

    def test_minute_response_bounds_preserve_nanoseconds_and_reject_unexpected_timezones(self):
        params = {
            "ts_code": "600000.SH", "freq": "1min",
            "start_date": "2026-11-13 00:00:00", "end_date": "2026-11-13 23:59:59",
        }
        for value in ("2026-11-13 12:34:56.123456789", "2026-11-13 23:59:59"):
            frame = pd.DataFrame({"ts_code": ["600000.SH"], "trade_time": [pd.Timestamp(value)]})
            validate_dataset_response(RECIPES["stk_mins"], Response(None, None, frame=frame), params)
        for value in ("2026-11-13 23:59:59.000000001", "2026-11-13 12:00:00+08:00"):
            with self.subTest(value=value), self.assertRaisesRegex(CollectionFailure, "返回时间戳无效"):
                frame = pd.DataFrame({"ts_code": ["600000.SH"], "trade_time": [pd.Timestamp(value)]})
                validate_dataset_response(RECIPES["stk_mins"], Response(None, None, frame=frame), params)

    def test_stopped_updates_do_not_generate_new_dates_and_legacy_bounds_are_explicit(self):
        self.seed()
        self.assertEqual(self.execute(self.plan("slb_sec"))["state"], "succeeded")
        with patch("collector.datasets.china_today", return_value=date(2026, 11, 20)):
            checked = self.plan("slb_sec", mode="incremental", end="2026-11-19")
        self.assertEqual(checked["end_date"], "2026-11-13")
        self.assertTrue(all(part["params"]["trade_date"] <= "20261113" for part in checked["partitions"]))
        with self.assertRaisesRegex(CollectorError, "先选择历史范围"):
            self.plan("slb_sec_detail", mode="incremental")
        with self.assertRaisesRegex(CollectorError, "2015-05-29"):
            self.plan("stk_account_old")
        self.assertEqual(
            next(card for card in self.service.list() if card["id"] == "stk_account_old")[
                "available_through"
            ],
            "2015-05-29",
        )

    def test_board_dependencies_are_verified_and_do_not_start_original_task(self):
        original = self.body("dc_member")
        first = self.service.review("dc_member", original, 30)
        self.assertEqual(first["plan"]["dataset_id"], "trade_cal")
        self.assertEqual(self.execute(first["plan"])["state"], "succeeded")
        second = self.service.review("dc_member", original, 30)
        self.assertEqual(second["plan"]["dataset_id"], "dc_index")
        self.assertEqual(self.execute(second["plan"])["state"], "succeeded")
        ready = self.service.review("dc_member", original, 30)
        self.assertEqual(ready["stage"], "data")
        self.assertEqual(self.settings("dc_member")[1], 0)
        with self.store.connect() as db:
            row = db.execute(
                "SELECT s.raw_path FROM slices s JOIN dataset_runs d ON s.run_id=d.run_id "
                "WHERE d.dataset_id='dc_index' LIMIT 1"
            ).fetchone()
        path = Path(row["raw_path"])
        path.write_bytes(path.read_bytes() + b"tampered-test-data")
        with self.assertRaisesRegex(CollectorError, "归档不可用"):
            self.service.launch("dc_member", ready["plan"]["id"], 30)
        self.assertEqual(self.settings("dc_member")[1], 0)

    def test_dependency_history_respects_supplier_availability_instead_of_raw_user_start(self):
        for dataset, first in (("dc_member", "2024-12-20"), ("stk_mins", "2010-01-01")):
            with self.subTest(dataset=dataset):
                review = self.service.review(dataset, self.body(dataset, start="1990-12-19"), 30)
                self.assertEqual(review["stage"], "dependencies")
                self.assertEqual(review["plan"]["dataset_id"], "trade_cal")
                self.assertEqual(review["plan"]["start_date"], first)
                self.assertEqual(self.settings(dataset)[1], 0)
        self.assertEqual(self.calls, [])

    def test_bundle_uses_board_dependency_stage_not_empty_hardcoded_dependencies(self):
        self.seed()
        self.service.save_settings("dc_member", self.body("dc_member").settings, 0)
        bundle = self.service.create_bundle(
            DatasetBundleRequest(dataset_ids=["dc_member"], mode="full", end_date="2026-11-13"), 30
        )
        self.assertEqual(bundle["stage"], "dependencies")
        self.assertEqual(bundle["stage_ids"], ["dc_index"])
        self.assertEqual(bundle["total_slices"], 6)
        self.assertEqual(self.settings("dc_index")[1], 0)

    def test_row_caps_require_confirmed_date_or_member_splits_and_no_fake_code_splits(self):
        self.seed()
        self.fault = lambda api, params, frame: (
            pd.concat([frame] * 100, ignore_index=True)
            if (
                api == "stk_managers"
                and params["ts_code"] == "600000.SH"
                and params["start_date"] != params["end_date"]
            )
            else frame
        )
        capped = self.execute(self.plan("stk_managers"))
        self.assertEqual(capped["state"], "failed")
        self.assertEqual(capped["row_limit_failures"], 1)
        checked = self.plan("stk_managers", mode="split")
        self.assertEqual(checked["total_slices"], 2)
        self.assertEqual(
            [(part["params"]["start_date"], part["params"]["end_date"]) for part in checked["partitions"]],
            [("20261112", "20261112"), ("20261113", "20261113")],
        )
        self.assertEqual(self.execute(checked)["state"], "succeeded")
        self.fault = lambda api, params, frame: (
            pd.concat([frame] * 2000, ignore_index=True) if api == "repurchase" else frame
        )
        self.assertEqual(self.execute(self.plan("repurchase", start="2026-11-13"))["state"], "failed")
        with self.assertRaisesRegex(CollectorError, "没有可继续拆分"):
            self.plan("repurchase", mode="split", start="2026-11-13")
        self.fault = lambda api, params, frame: (
            pd.concat([frame] * 100, ignore_index=True)
            if (api == "ths_member" and params.get("con_code") == "600000.SH" and not params.get("ts_code"))
            else frame
        )
        self.assertEqual(self.execute(self.plan("ths_member"))["state"], "failed")
        review = self.service.review("ths_member", self.body("ths_member", mode="split"), 30)
        self.assertEqual(review["plan"]["dataset_id"], "ths_index")
        self.execute(review["plan"])
        members = self.plan("ths_member", mode="split")
        self.assertEqual(
            members["partitions"][0]["params"], {"con_code": "600000.SH", "ts_code": "885001.TI"}
        )
        self.assertEqual(self.execute(members)["state"], "succeeded")

    def test_front_adjustment_rebases_entire_window_and_never_date_splits(self):
        self.seed()
        options = {"adj": ["qfq"], "freq": ["D"]}
        with self.assertRaisesRegex(CollectorError, "最长 16 年"):
            self.plan("pro_bar_adj", start="1990-12-19", options=options)
        checked = self.plan("pro_bar_adj", options=options)
        self.assertEqual(checked["supplier_requests"], 6)
        self.assertEqual(self.execute(checked)["state"], "succeeded")
        refreshed = self.plan("pro_bar_adj", mode="incremental", options=options)
        self.assertEqual(refreshed["counts"]["refresh"], 3)

        def capped_bar(**kwargs):
            return pd.DataFrame(
                {
                    "ts_code": [kwargs["ts_code"]] * 6000,
                    "trade_date": [kwargs["start_date"]] * 6000,
                    "close": [1.0] * 6000,
                }
            )

        with patch("tushare.pro_bar", side_effect=capped_bar):
            failed = self.execute(refreshed)
        self.assertEqual(failed["row_limit_failures"], 3)
        with self.assertRaisesRegex(CollectorError, "没有可继续拆分"):
            self.plan("pro_bar_adj", mode="split", options=options)

    def test_derived_plans_clip_verified_listing_dates_and_skip_unlisted_windows(self):
        self.fault = lambda api, params, frame: (
            frame.assign(list_date="20260302") if api == "stock_basic" else frame
        )
        self.seed()
        checked = self.plan("pro_bar_adj", start="1990-12-19")
        self.assertEqual(checked["total_slices"], 3)
        self.assertTrue(all(part["params"]["start_date"] == "20260302" for part in checked["partitions"]))

    def test_multirow_events_board_codes_and_request_dates_are_validated_without_stock_dedup(self):
        recipe = RECIPES["top_inst"]
        frame = pd.DataFrame({"ts_code": ["600000.SH"] * 2, "trade_date": ["20261113"] * 2})
        validate_dataset_response(recipe, Response(None, None, frame=frame), {"trade_date": "20261113"})
        frame.loc[0, "trade_date"] = "20261112"
        with self.assertRaises(CollectionFailure):
            validate_dataset_response(recipe, Response(None, None, frame=frame), {"trade_date": "20261113"})
        members = pd.DataFrame({"ts_code": ["885001.TI"], "con_code": ["600000.SH"]})
        validate_dataset_response(
            RECIPES["ths_member"], Response(None, None, frame=members), {"con_code": "600000.SH"}
        )
        with self.assertRaises(CollectionFailure):
            validate_dataset_response(
                RECIPES["ths_member"], Response(None, None, frame=members), {"con_code": "000001.SZ"}
            )

    def test_catalog_extraction_ignores_output_parameter_mentions_in_introduction(self):
        page = (
            '<div class="content col-md-9 col-sm-8 col-xs-12">'
            "接口：stk_factor_pro 描述：输出参数_bfq表示不复权"
            "<strong>输入参数</strong><table><tr><th>名称</th></tr>"
            "<tr><td>start_date</td><td>str</td><td>N</td></tr></table>"
            "<strong>输出参数</strong><table><tr><th>名称</th></tr>"
            "<tr><td>close</td><td>float</td><td>Y</td></tr></table>"
        )
        with patch("scripts.refresh_catalog.fetch", return_value=page):
            entry = extract({"doc_id": 328})
        self.assertEqual([field["name"] for field in entry["fields"]], ["close"])
        self.assertEqual([field["name"] for field in entry["params"]], ["start_date"])

    def test_large_minute_plan_rejects_exact_size_without_partial_launch(self):
        self.seed()
        pool = [f"{number:06d}.SH" for number in range(5001)]
        with patch.object(self.service, "_reference_pool", return_value=(pool, [], [])):
            with self.assertRaisesRegex(CollectorError, "50,010"):
                self.plan("stk_mins", options={"freq": ["1min", "5min", "15min", "30min", "60min"]})
        with self.store.connect() as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM dataset_runs WHERE dataset_id='stk_mins'").fetchone()[0], 0
            )
