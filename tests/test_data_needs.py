import json
import time
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_collector import CollectorFixture, fast_forward_wait
from test_datasets import frame_for
from test_stock_rules import catalog_frame

from collector.app import create_app
from collector.archive_delete import ensure_idle
from collector.client import SDKClient
from collector.data_needs import DataNeedAction, DataNeeds, DataNeedSave, dependencies_for, next_attempt
from collector.datasets import RECIPES, DatasetPlanRequest
from collector.models import ENTRIES, CollectorError
from collector.permissions import API_ACCESS
from collector.store import encode
from collector.warehouse import RECORD_WAREHOUSE_DATASETS, WAREHOUSE_ADAPTERS, content_digest


class DataNeedsTests(CollectorFixture):
    def setUp(self):
        super().setUp()
        self.calls, self.fault = [], None
        self.frame_factory = frame_for
        owner = self

        class FakeAPI:
            def query(self, api_name, fields="", **params):
                owner.calls.append((api_name, params))
                frame = owner.frame_factory(api_name, fields, params)
                return owner.fault(api_name, params, frame) if owner.fault else frame

        def runner_factory(store, token, global_rpm):
            from collector.runner import Runner

            return Runner(
                store, "test-only-data-needs-token", global_rpm,
                client_factory=lambda token, timeout, transport, before_request: SDKClient(
                    token, timeout, before_request, api=FakeAPI(),
                ),
            )

        self.app = create_app(self.root / "data", start_worker=False, runner_factory=runner_factory)
        self.store, self.runner = self.app.state.store, self.app.state.runner
        self.needs = self.app.state.data_needs
        self.service = self.needs.datasets
        for target in ("collector.datasets.china_today", "collector.data_needs.china_today"):
            mocked = patch(target, return_value=date(2026, 11, 14))
            mocked.start()
            self.addCleanup(mocked.stop)
        fast_forward_wait(self, self.runner)

    def save(self, *, enabled=False, datasets=None, **changes):
        spec = {
            "name": "研究数据", "dataset_ids": datasets or ["daily", "daily_basic", "adj_factor"],
            "start_date": "2026-11-12", "end_date": "2026-11-13", **changes,
        }
        return self.needs.save(DataNeedSave(
            spec=spec, enabled=enabled, authorize_network=enabled,
        ))

    def sync(self, saved):
        return self.needs.sync(saved["id"], DataNeedAction(
            expected_revision=saved["revision"], authorize_network=True,
        ))

    def tick(self):
        self.needs.next_tick = 0
        self.needs.tick()

    def pump(self, *, until=None):
        for _ in range(80):
            run = self.store.claim()
            if run:
                self.runner.execute(run)
            self.tick()
            current = self.needs.list()[0]
            latest = current["jobs"][0] if current["jobs"] else None
            if latest and (
                until(latest) if until else latest["state"] in {"succeeded", "blocked", "paused"}
            ):
                return latest
        self.fail("Data need did not reach expected durable state")

    def test_api_defaults_to_save_only_and_requires_explicit_network_authorization(self):
        headers = {"X-Collector-Request": "1"}
        spec = {"name": "只保存", "dataset_ids": ["daily"], "start_date": "2026-11-12"}
        with TestClient(self.app, base_url="http://127.0.0.1") as client:
            self.assertEqual(client.post("/api/data-needs", json={"spec": spec}).status_code, 403)
            result = client.post("/api/data-needs", headers=headers, json={"spec": spec})
            self.assertEqual(result.status_code, 201, result.text)
            saved = result.json()
            self.tick()
            self.assertEqual(self.calls, [])
            self.assertEqual(client.get("/api/data-needs").json()[0]["jobs"], [])
            route = f"/api/data-needs/{saved['id']}/sync"
            body = {"expected_revision": 1}
            self.assertEqual(client.post(route, headers=headers, json=body).status_code, 409)
            self.assertEqual(client.post(route, headers=headers, json={
                **body, "authorize_network": "yes",
            }).status_code, 422)
            denied = client.post("/api/data-needs", headers=headers, json={"spec": spec, "enabled": True})
            self.assertEqual(denied.status_code, 409)
            self.assertEqual(client.post("/api/data-needs", headers=headers, json={
                "spec": {**spec, "dataset_ids": ["unknown"]},
            }).status_code, 422)
            self.assertEqual(client.post(route, headers=headers, json={
                **body, "authorize_network": True,
            }).status_code, 200)
            self.assertEqual(self.calls, [])
        with self.store.connect() as db:
            with self.assertRaisesRegex(CollectorError, "数据需求"):
                ensure_idle(db)

    @staticmethod
    def warehouse_frame(api_name, fields, params):
        if api_name in {"income", "balancesheet", "cashflow", "fina_indicator"}:
            frame = frame_for(api_name, fields, params)
        else:
            frame = catalog_frame(api_name, fields, params)
        entry = next(item for item in ENTRIES.values() if item["api_name"] == api_name)
        for field in entry["fields"]:
            name = field["name"]
            if field["type"] == "str" and name in frame:
                frame[name] = frame[name].map(lambda value: None if value is None else str(value))
        if api_name == "stock_company":
            frame["ts_code"] = {"SSE": "600000.SH", "SZSE": "000001.SZ", "BSE": "920001.BJ"}[
                params["exchange"]
            ]
        return frame

    def test_every_supported_warehouse_can_save_collect_publish_and_read_back(self):
        self.frame_factory = self.warehouse_frame
        with TestClient(self.app, base_url="http://127.0.0.1") as client:
            catalog = client.get("/api/data-needs/catalog").json()
        self.assertEqual({item["dataset_id"] for item in catalog["entries"]}, set(WAREHOUSE_ADAPTERS))
        self.assertEqual(self.calls, [])
        access = {name: {**value, "account_access": "points_satisfied"} for name, value in API_ACCESS.items()}
        with patch.dict("collector.runner.API_ACCESS", access):
            for dataset_id in WAREHOUSE_ADAPTERS:
                with self.subTest(dataset=dataset_id):
                    start, end = "2026-11-12", "2026-11-13"
                    if dataset_id in {"stk_rewards", "disclosure_date"}:
                        start = end = "2026-09-30"
                    elif dataset_id == "stock_basic":
                        end = None
                    elif RECIPES[dataset_id].get("kind") == "snapshot":
                        end = None
                    elif dataset_id == "stk_account_old":
                        start, end = "2015-05-28", "2015-05-29"
                    elif RECIPES[dataset_id].get("rule", {}).get("strategy") == "period":
                        start, end = "2026-10-30", "2026-10-31"
                    saved = self.save(datasets=[dataset_id], start_date=start, end_date=end)
                    self.sync(saved)
                    result = self.pump()
                    self.assertEqual(result["state"], "succeeded", result["error"])
                    step = next(item for item in result["steps"] if item["dataset_id"] == dataset_id)
                    self.assertTrue(step["publish"])
                    self.assertTrue(step["result"]["snapshot_id"])
                    warehouse = self.needs.warehouses[dataset_id]
                    status = warehouse.status()
                    variants = status.get("variants", [])
                    rows = warehouse.rows(**({"variant_id": variants[0]["id"]} if variants else {}))
                    self.assertGreater(rows["matching_rows"], 0)
                    if dataset_id in RECORD_WAREHOUSE_DATASETS:
                        bundle = warehouse.export(
                            str(self.root / "output"), None, None,
                            variant_id=variants[0]["id"] if variants else None,
                            file_layout="single",
                        )
                        self.assertEqual(bundle["rows"], rows["matching_rows"])
                        self.assertEqual(bundle["snapshot_id"], step["result"]["snapshot_id"])
                    root, repository_id, _, _, _ = warehouse.context()
                    snapshot = warehouse.snapshot(root, repository_id)
                    self.assertTrue(all(
                        file["validation"] == "normalized_write_readback" for file in snapshot["months"]
                    ))
                    if dataset_id == "stock_basic":
                        self.assertEqual(len(result["steps"]), 1)
                        self.assertEqual(result["requests_sent"], 15)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM storage_policy_jobs").fetchone()[0], 0)

    def test_current_snapshots_replace_removed_records_and_reject_partial_or_extra_field_runs(self):
        self.frame_factory = self.warehouse_frame
        saved = self.save(datasets=["stock_company"], end_date=None)
        self.sync(saved)
        self.assertEqual(self.pump()["state"], "succeeded")
        warehouse = self.needs.warehouses["stock_company"]
        first = warehouse.status()
        self.assertEqual(first["rows"], 3)
        self.fault = lambda api, params, frame: frame.iloc[:0] if (
            api == "stock_company" and params["exchange"] != "SSE"
        ) else frame
        self.sync(saved)
        self.assertEqual(self.pump()["state"], "succeeded")
        second = warehouse.status()
        self.assertEqual(second["rows"], 1)
        bse = next(item["id"] for item in second["variants"] if item["params"]["exchange"] == "BSE")
        self.assertEqual(warehouse.rows(variant_id=bse)["matching_rows"], 0)
        self.assertEqual(warehouse.rows(
            snapshot_id=first["snapshot_id"], variant_id=bse,
        )["matching_rows"], 1)
        with self.assertRaisesRegex(CollectorError, "不支持历史日期"):
            warehouse.rows(start_date="20261112", variant_id=bse)
        for extra in (False, True):
            self.fault = lambda api, params, frame: (
                frame.assign(unadapted=1) if extra else frame.drop(columns=["ts_code"])
            ) if api == "stock_company" else frame
            self.sync(saved)
            failed = self.pump()
            self.assertEqual(failed["state"], "blocked")
            self.assertEqual(warehouse.status()["snapshot_id"], second["snapshot_id"])

    def test_restatement_replaces_whole_runs_and_refuses_narrowing_adjusted_history(self):
        self.frame_factory = self.warehouse_frame
        for dataset_id in ("stk_factor", "pro_bar_adj"):
            with self.subTest(dataset=dataset_id):
                saved = self.save(datasets=[dataset_id], dataset_options=(
                    {dataset_id: {"adj": ["qfq"]}} if dataset_id == "pro_bar_adj" else {}
                ))
                self.sync(saved)
                self.assertEqual(self.pump()["state"], "succeeded")
                warehouse = self.needs.warehouses[dataset_id]
                first = warehouse.status()
                self.sync(saved)
                self.assertEqual(self.pump()["state"], "succeeded")
                second = warehouse.status()
                self.assertNotEqual(first["snapshot_id"], second["snapshot_id"])
                with self.store.connect() as db:
                    rows = db.execute(
                        "SELECT spec_json FROM data_needs WHERE id=?", (saved["id"],),
                    ).fetchone()
                spec = json.loads(rows["spec_json"])
                saved = self.needs.save(DataNeedSave(
                    spec={**spec, "start_date": "2026-11-13"}, expected_revision=saved["revision"],
                ), saved["id"])
                self.sync(saved)
                failed = self.pump()
                self.assertEqual(failed["state"], "blocked")
                self.assertIn("不能缩窄", failed["error"])
                self.assertEqual(warehouse.status()["snapshot_id"], second["snapshot_id"])

    def test_partial_successful_adjusted_run_keeps_old_snapshot_queryable_and_requires_full_refresh(self):
        self.frame_factory = self.warehouse_frame
        saved = self.save(datasets=["pro_bar_adj"], start_date="1990-12-19")
        self.sync(saved)
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        warehouse = self.needs.warehouses["pro_bar_adj"]
        original = warehouse.status()["snapshot_id"]
        original_rows = warehouse.rows()["matching_rows"]
        with self.store.connect() as db:
            settings, revision = self.service.checked_settings(db, "pro_bar_adj")
        plan = self.service.create_plan("pro_bar_adj", DatasetPlanRequest(
            settings=settings.model_copy(update={"lookback_days": 1}),
            expected_revision=revision, mode="incremental", end_date=date(2026, 11, 13),
        ), 30)
        self.assertLess(plan["total_slices"], plan["candidate_partitions"])
        run = self.service.launch("pro_bar_adj", plan["id"], 30)
        self.runner.execute(self.store.claim())
        self.assertEqual(self.store.run(run["id"])["state"], "succeeded")
        status = warehouse.status()
        self.assertEqual(status["snapshot_id"], original)
        self.assertIn("仅含局部请求", status["source_error"])
        self.assertTrue(status["refresh_needed"])
        self.assertEqual(warehouse.rows()["matching_rows"], original_rows)
        with self.assertRaisesRegex(CollectorError, "请全量重拉"):
            warehouse.refresh()
        self.sync(saved)
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertIsNone(warehouse.status().get("source_error"))
        self.assertNotEqual(warehouse.status()["snapshot_id"], original)

    def test_period_queries_intersect_original_week_and_month_labels_across_year_boundaries(self):
        self.frame_factory = self.warehouse_frame
        self.fault = lambda api, params, frame: frame.assign(date="20141229~0102") if (
            api == "stk_account_old"
        ) else frame
        saved = self.save(datasets=["stk_account_old"], start_date="2014-12-29", end_date="2014-12-29")
        self.sync(saved)
        self.assertEqual(self.pump()["state"], "succeeded")
        warehouse = self.needs.warehouses["stk_account_old"]
        self.assertEqual(warehouse.status()["days"], 1)
        self.assertEqual(warehouse.rows(start_date="20150101", end_date="20150101")["matching_rows"], 1)
        self.assertEqual(warehouse.rows(start_date="20150103", end_date="20150103")["matching_rows"], 0)
        self.assertEqual(warehouse.rows()["rows"][0][0], "20141229~0102")
        self.fault = None
        saved = self.save(datasets=["broker_recommend"])
        self.sync(saved)
        self.assertEqual(self.pump()["state"], "succeeded")
        warehouse = self.needs.warehouses["broker_recommend"]
        self.assertEqual(warehouse.rows(start_date="20261130", end_date="20261130")["matching_rows"], 1)
        self.assertEqual(warehouse.rows(start_date="20261201", end_date="20261201")["matching_rows"], 0)
        self.assertEqual(warehouse.status()["date_count_kind"], "period_labels_not_coverage")

    def test_untyped_json_and_nanosecond_timestamps_round_trip_without_field_or_precision_loss(self):
        self.frame_factory = self.warehouse_frame
        value = [{"org": "机构", "count": 9007199254740993}]
        for dataset_id in ("hm_list", "report_rc", "stk_nineturn"):
            with self.subTest(dataset=dataset_id):
                stamp = pd.Timestamp("2026-11-12 12:34:56.123456789")
                self.fault = lambda api, params, frame: (
                    frame.assign(orgs=pd.Series([value])) if api == "hm_list"
                    else frame.assign(create_time=stamp) if api == "report_rc"
                    else frame.assign(trade_date=stamp) if api == "stk_nineturn" else frame
                )
                saved = self.save(datasets=[dataset_id], end_date=None if dataset_id == "hm_list"
                                  else "2026-11-12")
                self.sync(saved)
                result = self.pump()
                self.assertEqual(result["state"], "succeeded", result["error"])
                warehouse = self.needs.warehouses[dataset_id]
                page = warehouse.rows()
                if dataset_id == "hm_list":
                    self.assertEqual(json.loads(page["rows"][0][page["columns"].index("orgs")]), value)
                else:
                    column = "create_time" if dataset_id == "report_rc" else "trade_date"
                    self.assertEqual(page["rows"][0][page["columns"].index(column)], stamp.isoformat())
                    self.assertEqual(warehouse.rows(
                        start_date="20261113", end_date="20261113",
                    )["matching_rows"], 0)
                bundle = warehouse.export(str(self.root / "output"), None, None, file_layout="single")
                manifest = json.loads(Path(bundle["manifest_path"]).read_text())
                if dataset_id == "hm_list":
                    self.assertEqual(manifest["field_encodings"], {"orgs": "json"})

    def test_options_are_frozen_dependencies_are_ordered_and_changed_scopes_block(self):
        self.frame_factory = self.warehouse_frame
        saved = self.save(datasets=["dc_member", "margin"],
                          dataset_options={"margin": {"exchange_id": ["BSE"]}})
        result = self.sync(saved)
        self.assertEqual([step["dataset_id"] for step in result["steps"]], [
            "trade_cal", "dc_index", "dc_member", "margin",
        ])
        self.assertEqual([step["publish"] for step in result["steps"]], [False, False, True, True])
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual({p["exchange_id"] for api, p in self.calls if api == "margin"}, {"BSE"})
        self.assertEqual(self.needs.warehouses["trade_cal"].status()["state"], "empty")
        self.assertEqual(self.needs.warehouses["dc_index"].status()["state"], "empty")
        first = result["steps"][-1]["result"]["snapshot_id"]
        before = len(self.calls)
        self.sync(saved)
        self.assertEqual(self.pump()["state"], "succeeded")
        self.assertGreater(len(self.calls), before)
        self.assertEqual(self.needs.warehouses["margin"].status()["snapshot_id"], first)
        with self.store.connect() as db:
            settings, revision = self.service.checked_settings(db, "margin")
        self.service.save_settings(
            "margin", settings.model_copy(update={"options": {"exchange_id": ["SSE"]}}), revision,
        )
        self.sync(saved)
        result = self.pump()
        self.assertEqual(result["state"], "blocked")
        self.assertIn("请求选项已变化", result["error"])

    def test_all_warehouses_can_share_one_frozen_dependency_ordered_need(self):
        saved = self.save(datasets=list(WAREHOUSE_ADAPTERS), start_date="2026-09-30")
        job = self.sync(saved)
        order = [step["dataset_id"] for step in job["steps"]]
        self.assertEqual(len(order), len(WAREHOUSE_ADAPTERS))
        self.assertEqual(set(order), set(WAREHOUSE_ADAPTERS))
        self.assertTrue(all(step["publish"] for step in job["steps"]))
        for dataset_id in order:
            for dependency in dependencies_for(dataset_id):
                self.assertLess(order.index(dependency), order.index(dataset_id))
        self.assertEqual(self.calls, [])

    def test_invalid_or_incompatible_options_and_raw_only_interfaces_cannot_be_authorized(self):
        for datasets, options in (
            (["unknown"], {}), (["margin"], {"margin": {"exchange_id": []}}),
            (["daily"], {"margin": {"exchange_id": ["SSE"]}}),
            (["daily"], {"daily": {"fake": ["value"]}}),
            (["dc_member", "dc_index"], {"dc_index": {"idx_type": ["概念板块"]}}),
        ):
            with self.subTest(datasets=datasets, options=options), self.assertRaises(ValidationError):
                self.save(datasets=datasets, dataset_options=options)
        self.assertEqual(self.needs.list(), [])
        self.assertEqual(self.calls, [])

    def test_selected_calendar_publishes_and_stopped_interfaces_never_chase_new_dates(self):
        self.frame_factory = self.warehouse_frame
        saved = self.save(datasets=["slb_sec", "trade_cal"], end_date=None)
        first = self.sync(saved)
        self.assertEqual([step["dataset_id"] for step in first["steps"]], [
            "trade_cal", "stock_basic", "slb_sec",
        ])
        self.assertEqual(self.pump()["state"], "succeeded")
        self.assertIsNotNone(self.needs.warehouses["trade_cal"].status()["snapshot_id"])
        self.assertEqual(self.needs.warehouses["stock_basic"].status()["state"], "empty")
        dates = {params["trade_date"] for api, params in self.calls if api == "slb_sec"}
        self.calls.clear()
        with patch("collector.data_needs.china_today", return_value=date(2026, 11, 18)), patch(
            "collector.datasets.china_today", return_value=date(2026, 11, 18),
        ):
            self.sync(saved)
            result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual({params["trade_date"] for api, params in self.calls if api == "slb_sec"}, dates)
        step = next(item for item in result["steps"] if item["dataset_id"] == "slb_sec")
        self.assertEqual(step["plan_summary"]["mode"], "incremental")
        self.assertTrue(any("不生成新日期" in warning for warning in step["plan_summary"]["warnings"]))

    def test_legacy_need_and_active_job_resume_without_reauthorization_or_scope_expansion(self):
        saved = self.save()
        job = self.sync(saved)
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM data_needs WHERE id=?", (saved["id"],)).fetchone()
            spec, bindings = json.loads(row["spec_json"]), json.loads(row["bindings_json"])
            spec.pop("dataset_options", None)
            for binding in bindings.values():
                binding.pop("contract", None)
                binding.pop("settings_options", None)
            for step in job["steps"]:
                for key in ("publish", "contract", "expected_options"):
                    step.pop(key, None)
            db.execute("UPDATE data_needs SET spec_json=?,bindings_json=? WHERE id=?", (
                encode(spec), encode(bindings), saved["id"],
            ))
            db.execute("UPDATE data_need_jobs SET spec_json=?,steps_json=? WHERE id=?", (
                encode(spec), encode(job["steps"]), job["id"],
            ))
        self.needs = DataNeeds(self.store, self.service, self.needs.warehouses, self.runner)
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual(self.needs.warehouses["trade_cal"].status()["state"], "empty")
        self.assertTrue(all(step["result"].get("snapshot_id") for step in result["steps"][1:]))
        self.sync(saved)
        self.assertEqual(self.pump()["state"], "succeeded")
        self.assertEqual({api for api, _ in self.calls}, {"trade_cal", "daily", "daily_basic", "adj_factor"})

    def test_snapshot_and_request_publish_fail_closed_on_extra_fields_and_bad_readback(self):
        self.frame_factory = self.warehouse_frame
        for dataset_id in ("stock_basic", "income", "stock_company"):
            with self.subTest(dataset=dataset_id):
                saved = self.save(datasets=[dataset_id], end_date=None)
                self.sync(saved)
                self.assertEqual(self.pump()["state"], "succeeded")
                warehouse = self.needs.warehouses[dataset_id]
                original = warehouse.status()["snapshot_id"]
                self.fault = lambda api, params, frame: (
                    frame.assign(fixture_extra=1) if api == dataset_id else frame
                )
                self.sync(saved)
                failed = self.pump()
                self.assertEqual(failed["state"], "blocked")
                self.assertIn("契约", failed["error"])
                self.assertEqual(warehouse.status()["snapshot_id"], original)
                self.fault = lambda api, params, frame: frame.assign(
                    **({"name": "changed"} if api == "stock_basic"
                       else {"com_name": "changed"} if api == "stock_company"
                       else {"basic_eps": 9.0}),
                ) if api == dataset_id else frame
                self.sync(saved)
                self.pump(until=lambda job: job["steps"][-1]["state"] == "publishing")
                write = pq.write_table

                def corrupt(table, path, *args, **kwargs):
                    if path.name == "current.parquet" or path.parent.name == "p":
                        table = table.slice(0, 0)
                    return write(table, path, *args, **kwargs)

                with patch("collector.warehouse.pq.write_table", side_effect=corrupt):
                    failed = self.pump()
                self.assertEqual(failed["state"], "blocked")
                self.assertIn("回读内容", failed["error"])
                self.assertEqual(warehouse.status()["snapshot_id"], original)
                self.fault = None

    def test_automatic_end_to_end_dependency_collection_readback_and_publication(self):
        saved = self.save(enabled=True, max_requests=7)
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual(result["requests_sent"], 7)
        self.assertEqual(self.calls[0][0], "trade_cal")
        self.assertEqual([step["dataset_id"] for step in result["steps"]], [
            "trade_cal", "daily", "daily_basic", "adj_factor",
        ])
        self.assertTrue(all(step["state"] == "succeeded" for step in result["steps"]))
        for dataset_id in ("daily", "daily_basic", "adj_factor"):
            warehouse = self.needs.warehouses[dataset_id]
            status = warehouse.status()
            self.assertEqual(status["rows"], 2)
            self.assertEqual(status["last_date"], "20261113")
            self.assertEqual(warehouse.rows()["matching_rows"], 2)
            root, repository_id, _, _, _ = warehouse.context()
            snapshot = warehouse.snapshot(root, repository_id)
            self.assertEqual(snapshot["months"][0]["validation"], "normalized_write_readback")
        self.assertEqual(self.needs.list()[0]["id"], saved["id"])
        before = len(self.calls)
        self.tick()
        self.assertEqual(len(self.calls), before)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)
            self.assertTrue(all(row["raw_path"] for row in db.execute("SELECT raw_path FROM slices")))

    def test_running_worker_advances_enabled_need_without_manual_step_calls(self):
        self.save(enabled=True, datasets=["daily"], max_requests=3)
        self.tick()
        queued_id = self.needs.list()[0]["jobs"][0]["steps"][0]["run_id"]
        self.runner.set_token("")
        self.assertIsNone(self.store.claim(token_configured=False))

        def immediate():
            self.needs.next_tick = 0
            self.needs.tick()

        self.runner.idle_callback = immediate
        self.runner.start()
        try:
            time.sleep(0.1)
            self.assertEqual(self.store.run(queued_id)["state"], "queued")
            self.assertEqual(self.calls, [])
            self.runner.set_token("test-only-data-needs-token")
            self.runner.wake.set()
            deadline = time.perf_counter() + 15
            while time.perf_counter() < deadline:
                jobs = self.needs.list()[0]["jobs"]
                if jobs and jobs[0]["state"] in {"succeeded", "blocked"}:
                    break
                time.sleep(0.02)
            else:
                self.fail("Running collector did not advance an enabled data need")
            self.assertEqual(jobs[0]["state"], "succeeded", jobs[0]["error"])
            self.assertEqual(jobs[0]["requests_sent"], 3)
            self.assertEqual(self.needs.warehouses["daily"].rows()["matching_rows"], 2)
        finally:
            self.runner.close()

    def test_duplicate_sync_is_idempotent_and_budget_includes_dependency_and_retries(self):
        saved = self.save(datasets=["daily"], max_requests=3)
        first = self.sync(saved)
        self.assertEqual(self.sync(saved)["id"], first["id"])
        self.assertEqual(first["steps"][-1]["state"], "pending")

        def transient(api, params, frame):
            if api == "daily":
                raise requests.exceptions.ReadTimeout("fixture temporary network failure")
            return frame

        self.fault = transient
        result = self.pump()
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["requests_sent"], 3)
        self.assertEqual(len(self.calls), 3)
        self.assertIn("预算", result["error"])
        self.assertEqual(self.needs.warehouses["daily"].status()["state"], "empty")
        self.tick()
        self.assertEqual(len(self.needs.list()[0]["jobs"]), 1)

    def test_budget_preflight_does_not_start_interface_that_cannot_fit(self):
        self.sync(self.save(datasets=["daily"], max_requests=2))
        result = self.pump()
        self.assertEqual(result["state"], "blocked")
        self.assertIn("超出本次剩余预算", result["error"])
        self.assertEqual([api for api, _ in self.calls], ["trade_cal"])
        self.assertEqual(result["steps"][-1]["state"], "pending")

    def test_restart_resumes_same_interrupted_run_and_preserves_successful_slices_and_budget(self):
        saved = self.save(datasets=["daily"])
        self.sync(saved)

        def interrupt_after_first_day(api, params, frame):
            if api == "daily" and params["trade_date"] == "20261112":
                self.runner.stopping.set()
            return frame

        self.fault = interrupt_after_first_day
        for _ in range(20):
            self.tick()
            run = self.store.claim()
            if run:
                self.runner.execute(run)
                if run["dataset_id"] == "daily":
                    break
        interrupted = self.store.run(run["id"], detail=True)
        self.assertEqual(interrupted["state"], "interrupted")
        self.assertEqual(sum(item["state"] == "succeeded" for item in interrupted["slices"]), 1)
        self.runner.stopping.clear()
        self.fault = None
        self.store.recover()
        self.needs = DataNeeds(self.store, self.service, self.needs.warehouses, self.runner)
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual(result["steps"][-1]["run_id"], run["id"])
        self.assertEqual(result["requests_sent"], 3)
        self.assertEqual(sum(api == "daily" and p["trade_date"] == "20261112" for api, p in self.calls), 1)

    def test_pause_survives_restart_cancels_queued_run_and_refuses_old_revision(self):
        saved = self.save(enabled=True, datasets=["daily"])
        self.tick()
        self.needs.pause(saved["id"], saved["revision"])
        self.needs = DataNeeds(self.store, self.service, self.needs.warehouses, self.runner)
        self.tick()
        need = self.needs.list()[0]
        self.assertFalse(need["enabled"])
        self.assertEqual(need["jobs"][0]["state"], "paused")
        self.assertEqual(self.calls, [])
        self.assertIsNone(self.store.claim())
        with self.assertRaisesRegex(CollectorError, "已变更"):
            self.sync(saved)
        run_id = need["jobs"][0]["steps"][0]["run_id"]
        with self.assertRaisesRegex(CollectorError, "数据需求管理"):
            self.store.resume(run_id)

    def test_bound_storage_change_blocks_before_network_and_enabled_ownership_is_unique(self):
        saved = self.save(enabled=True, datasets=["daily"])
        with self.assertRaisesRegex(CollectorError, "已有启用"):
            self.save(enabled=True, datasets=["daily"])
        other = self.save(datasets=["daily"])
        with self.assertRaisesRegex(CollectorError, "已有启用"):
            self.sync(other)
        self.needs.pause(saved["id"], saved["revision"])
        with self.store.connect() as db:
            settings, revision = self.service.checked_settings(db, "trade_cal")
        self.service.save_settings(
            "trade_cal", settings.model_copy(update={"raw_root": str(self.root / "another-raw")}), revision,
        )
        self.sync(other)
        result = self.pump()
        self.assertEqual(result["state"], "blocked")
        self.assertIn("目录或请求选项已变化", result["error"])
        self.assertEqual(self.calls, [])

    def test_bad_readback_does_not_replace_old_snapshot_and_keeps_source_archives(self):
        saved = self.save(datasets=["daily"])
        self.sync(saved)
        self.assertEqual(self.pump()["state"], "succeeded")
        warehouse = self.needs.warehouses["daily"]
        original = warehouse.status()["snapshot_id"]
        self.sync(saved)
        self.fault = lambda api, params, frame: frame.assign(close=2.0) if api == "daily" else frame
        self.pump(until=lambda job: job["steps"][-1]["state"] == "publishing")
        write = pq.write_table

        def corrupt(table, path, *args, **kwargs):
            if path.parent.name == "months":
                index = table.column_names.index("close")
                table = table.set_column(index, "close", pa.array([999.0] * table.num_rows))
            return write(table, path, *args, **kwargs)

        with patch("collector.warehouse.pq.write_table", side_effect=corrupt):
            result = self.pump()
        self.assertEqual(result["state"], "blocked")
        self.assertIn("回读内容", result["error"])
        self.assertEqual(warehouse.status()["snapshot_id"], original)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM warehouse_snapshots").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM archive_deletions").fetchone()[0], 0)

    def test_restart_after_publication_before_job_receipt_reuses_snapshot_without_duplicate_requests(self):
        saved = self.save(datasets=["daily"])
        self.sync(saved)
        self.pump(until=lambda job: job["steps"][-1]["state"] == "publishing")
        with patch.object(self.needs, "save_steps", side_effect=SystemExit("fixture abrupt process exit")):
            with self.assertRaises(SystemExit):
                self.tick()
        snapshot_id = self.needs.warehouses["daily"].status()["snapshot_id"]
        calls = len(self.calls)
        self.needs = DataNeeds(self.store, self.service, self.needs.warehouses, self.runner)
        result = self.pump()
        self.assertEqual(result["state"], "succeeded", result["error"])
        self.assertEqual(result["steps"][-1]["result"]["snapshot_id"], snapshot_id)
        self.assertEqual(len(self.calls), calls)

    def test_supplier_extra_fields_are_not_silently_discarded(self):
        self.sync(self.save(datasets=["daily"]))
        self.fault = lambda api, params, frame: (
            frame.assign(new_supplier_field=7) if api == "daily" else frame
        )
        result = self.pump()
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(self.needs.warehouses["daily"].status()["state"], "empty")
        with self.store.connect() as db:
            count = db.execute("SELECT COUNT(*) FROM slices WHERE raw_path IS NOT NULL").fetchone()[0]
            self.assertGreater(count, 0)

    def test_readback_digest_handles_hidden_null_bytes_and_preserves_exact_integer_changes(self):
        table = pa.table({
            "value": pa.array([1.5, float("nan"), 0.0], mask=[False, True, False]),
            "label": pa.array(["unused", "a", "unused"], mask=[True, False, True]),
            "exact": pa.array([2**53 + 17, None, 2**53 + 18], type=pa.int64()),
        })
        path = self.root / "nulls.parquet"
        pq.write_table(table, path)
        restored = pq.ParquetFile(path).read()
        self.assertEqual(content_digest(table), content_digest(restored))
        changed = restored.set_column(
            2, "exact", pa.array([2**53 + 18, None, 2**53 + 18], type=pa.int64()),
        )
        self.assertNotEqual(content_digest(table), content_digest(changed))

    def test_attempt_schedule_uses_shanghai_and_never_treats_schedule_as_data_freshness(self):
        saved = self.save()
        spec = DataNeedSave.model_validate({
            "spec": self.needs.list()[0]["spec"],
        }).spec
        self.assertEqual(
            next_attempt(spec, datetime(2026, 11, 13, 11, 0, tzinfo=timezone.utc)),
            "2026-11-13T12:00:00+00:00",
        )
        self.assertEqual(
            next_attempt(spec, datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)),
            "2026-11-14T12:00:00+00:00",
        )
        self.assertEqual(self.needs.list()[0]["id"], saved["id"])
        self.assertIsNone(self.needs.list()[0]["next_attempt_at"])
