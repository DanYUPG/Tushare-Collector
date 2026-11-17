from __future__ import annotations

import base64
import hashlib
import io
import json
import subprocess
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from decimal import Decimal
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pandas as pd
import requests
from fastapi.testclient import TestClient

from collector.app import create_app
from collector.artifacts import choose_directory, export_data, preview_slice
from collector.client import (
    CollectionFailure,
    Response,
    SDKClient,
    StopRun,
    TushareClient,
    validate_response,
)
from collector.filesystem import atomic_move
from collector.models import CollectorError, TaskConfig, plan
from collector.runner import Runner
from collector.store import Store

TOKEN = "unit-test-secret-not-a-real-token"


def fast_forward_wait(owner, runner):
    clock = [time.time()]
    for target in ("collector.store.time.time", "collector.runner.time.monotonic"):
        mocked = patch(target, side_effect=lambda: clock[0])
        mocked.start()
        owner.addCleanup(mocked.stop)

    def wait(run_id, seconds):
        runner.check_stop(run_id)
        clock[0] += max(0, seconds) + 0.000001

    runner.wait = wait


def response(rows=1, status=200, code=0, message=None):
    payload = {
        "code": code,
        "msg": message,
        "data": {
            "fields": ["ts_code", "trade_date", "close"],
            "items": [["600000.SH", "20261112", 7.123456789012345] for _ in range(rows)],
        },
    }
    return Response(json.dumps(payload, indent=2).encode(), status)


class FakeClient:
    def __init__(self, outputs, calls, before_request, callback=None):
        self.outputs, self.calls = outputs, calls
        self.before_request, self.callback = before_request, callback

    def request(self, api_name, params, fields):
        self.before_request()
        self.calls.append((api_name, params, fields))
        if self.callback:
            self.callback()
        output = self.outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        return output

    def close(self):
        pass


class CollectorFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "control/collector.sqlite3")

    def config(self, **kwargs):
        return TaskConfig(
            **{
                "name": "测试行情",
                "entry_id": "27",
                "params": {"trade_date": "20261112"},
                "raw_root": str(self.root / "raw"),
                "transport": "http",
                **kwargs,
            }
        )

    def runner(self, outputs, callback=None):
        calls = []

        def factory(token, timeout, transport, before_request):
            return FakeClient(outputs, calls, before_request, callback)

        runner = Runner(self.store, TOKEN, client_factory=factory)
        fast_forward_wait(self, runner)
        return runner, calls

    def run_config(self, config, outputs):
        saved = self.store.save_config(config)
        run = self.store.create_run(saved["id"])
        runner, calls = self.runner(outputs)
        runner.execute(self.store.claim())
        return self.store.run(run["id"], detail=True), calls


class CollectorTests(CollectorFixture):
    def test_live_preview_executes_one_request_archives_and_does_not_change_dataset_coverage(self):
        config = self.config(
            transport="sdk", fields="ts_code,trade_date,close", max_attempts=1, allow_empty=True
        )
        run = self.store.create_preview(config)
        self.assertTrue(run["is_preview"])
        self.assertEqual(run["total"], 1)
        self.assertEqual(self.store.configurations(), [])
        runner, calls = self.runner(
            [
                Response(
                    None,
                    None,
                    "sdk_dataframe_parquet",
                    frame=pd.DataFrame(
                        {"ts_code": ["600000.SH"], "trade_date": ["20261112"], "close": [7.1]}
                    ),
                )
            ]
        )
        self.assertEqual(calls, [])
        runner.execute(self.store.claim())
        finished = self.store.run(run["id"], detail=True)
        self.assertEqual(finished["state"], "succeeded")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ("daily", {"trade_date": "20261112"}))
        self.assertTrue(self.store.runs()[0]["is_preview"])
        preview = preview_slice(self.store, run["id"], finished["slices"][0]["id"])
        self.assertEqual(preview["total_rows"], 1)
        self.assertEqual(preview["rows"][0][2], 7.1)
        with self.store.connect() as db:
            for table in ("dataset_runs", "dataset_partitions", "dataset_settings"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
        with self.assertRaisesRegex(CollectorError, "单次数据预览"):
            self.store.create_run(run["config_id"])
        with self.assertRaises(CollectorError):
            self.store.create_batch([run["config_id"]])
        with self.assertRaises(CollectorError):
            self.store.save_config(config, run["config_id"], 1)

    def test_live_preview_never_retries_and_handles_empty_and_capped_results(self):
        config = self.config(transport="sdk", max_attempts=1, allow_empty=True)
        run = self.store.create_preview(config)
        runner, calls = self.runner([CollectionFailure("暂时超时", retryable=True)])
        runner.execute(self.store.claim())
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.store.run(run["id"])["state"], "failed")
        for rows, state in ((0, "succeeded"), (6000, "failed")):
            run = self.store.create_preview(config)
            frame = pd.DataFrame({"ts_code": ["600000.SH"] * rows, "trade_date": ["20261112"] * rows})
            runner, calls = self.runner([Response(None, None, "sdk_dataframe_parquet", frame=frame)])
            runner.execute(self.store.claim())
            finished = self.store.run(run["id"], detail=True)
            self.assertEqual(len(calls), 1)
            self.assertEqual(finished["state"], state)
            if rows:
                self.assertEqual(finished["slices"][0]["error_kind"], "row_limit")
            self.assertEqual(
                preview_slice(self.store, run["id"], finished["slices"][0]["id"])["total_rows"], rows
            )

    def test_live_preview_duplicate_or_invalid_requests_do_not_leave_orphan_configs(self):
        config = self.config(transport="sdk", max_attempts=1, allow_empty=True)
        with self.assertRaisesRegex(CollectorError, "自动重试"):
            self.store.create_preview(config.model_copy(update={"max_attempts": 2}))
        with self.assertRaisesRegex(CollectorError, "SDK"):
            self.store.create_preview(
                config.model_copy(
                    update={"entry_id": "109", "params": {"ts_code": "600000.SH", "asset": "E"}}
                )
            )
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM configs").fetchone()[0], 0)
        self.store.create_preview(config)
        with self.assertRaisesRegex(CollectorError, "已有数据预览"):
            self.store.create_preview(config)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM configs").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 1)

    def test_live_preview_api_guards_worker_schema_and_single_request(self):
        app = create_app(self.root / "web-preview", start_worker=False)
        headers = {"X-Collector-Request": "1"}
        body = {
            "entry_id": "27",
            "params": {"ts_code": "600000.SH", "trade_date": "20261112"},
            "fields": "ts_code,trade_date,close",
            "raw_root": str(self.root / "preview-raw"),
        }
        with TestClient(app, base_url="http://localhost") as client:
            self.assertEqual(client.post("/api/previews", json=body).status_code, 403)
            self.assertEqual(client.post("/api/previews", json=body, headers=headers).status_code, 409)
            client.put("/api/credential", headers=headers, json={"token": TOKEN})
            self.assertEqual(client.post("/api/previews", json=body, headers=headers).status_code, 409)
            with patch.object(app.state.runner, "thread", SimpleNamespace(is_alive=lambda: True)):
                for invalid in (
                    {"token": TOKEN},
                    {"max_attempts": 2},
                    {"mode": "date_range"},
                    {"raw_root": "relative/path"},
                    {"raw_root": "/"},
                ):
                    result = client.post("/api/previews", json={**body, **invalid}, headers=headers)
                    self.assertEqual(result.status_code, 422, result.text)
                    self.assertNotIn(TOKEN, result.text)
                for invalid in (
                    {"entry_id": "109"},
                    {"entry_id": "unknown"},
                    {"params": {"token": TOKEN}},
                    {"fields": "missing_field"},
                    {"entry_id": "33", "params": {}},
                ):
                    result = client.post("/api/previews", json={**body, **invalid}, headers=headers)
                    self.assertEqual(result.status_code, 409, result.text)
                self.assertEqual(client.get("/api/runs").json(), [])
                result = client.post("/api/previews", json=body, headers=headers)
                self.assertEqual(result.status_code, 201, result.text)
                self.assertEqual(result.json()["total"], 1)
                self.assertEqual(result.json()["config"]["max_attempts"], 1)
                self.assertEqual(result.json()["config"]["transport"], "sdk")
                self.assertEqual(result.json()["slices"][0]["params"], body["params"])
                self.assertEqual(client.post("/api/previews", json=body, headers=headers).status_code, 409)
                self.assertEqual(client.get("/api/configs").json(), [])
                self.assertEqual(len(client.get("/api/runs").json()), 1)
                self.assertTrue(
                    all(item["covered_partitions"] == 0 for item in client.get("/api/datasets").json())
                )

    def test_date_and_enumeration_plan_and_conflicts(self):
        config = self.config(
            params={},
            mode="date_range",
            start_date="2026-11-10",
            end_date="2026-11-12",
            split_param="ts_code",
            split_values=["600000.SH", "000001.SZ"],
        )
        slices = plan(config)
        self.assertEqual(len(slices), 6)
        self.assertEqual(slices[-1], {"trade_date": "20261112", "ts_code": "000001.SZ"})
        with self.assertRaisesRegex(CollectorError, "冲突"):
            plan(config.model_copy(update={"split_param": "trade_date"}))
        with self.assertRaisesRegex(CollectorError, "不能重复"):
            plan(config.model_copy(update={"split_values": ["600000.SH", "600000.SH"]}))

    def test_stock_scope_fields_and_sdk_derived_restrictions(self):
        with self.assertRaisesRegex(CollectorError, "股票接口"):
            plan(self.config(entry_id="95"))
        with self.assertRaisesRegex(CollectorError, "请求参数"):
            plan(self.config(params={"token": TOKEN}))
        with self.assertRaisesRegex(CollectorError, "返回字段"):
            plan(self.config(fields="nonexistent"))
        with self.assertRaisesRegex(CollectorError, "SDK"):
            plan(self.config(entry_id="109"))
        with self.assertRaisesRegex(CollectorError, "asset=E"):
            plan(self.config(entry_id="109", transport="sdk", params={"ts_code": "600000.SH", "asset": "I"}))
        self.assertEqual(
            plan(
                self.config(
                    entry_id="146",
                    transport="sdk",
                    params={"ts_code": "600000.SH", "asset": "E", "ma": [5], "adj": "qfq"},
                )
            )[0]["ma"],
            [5],
        )

    def test_large_plans_missing_params_and_finite_numbers(self):
        with self.assertRaisesRegex(CollectorError, "20"):
            plan(self.config(params={}, mode="date_range", start_date="2000-01-01", end_date="2060-01-01"))
        with self.assertRaisesRegex(CollectorError, "必填"):
            plan(self.config(entry_id="33", params={}))
        with self.assertRaisesRegex(CollectorError, "有限"):
            plan(self.config(params={"ts_code": float("nan")}))
        with self.assertRaisesRegex(CollectorError, "ts_code 或 trade_date"):
            plan(self.config(entry_id="32", params={}))
        self.assertEqual(plan(self.config(entry_id="32")), [{"trade_date": "20261112"}])

    def test_original_http_bytes_and_request_evidence(self):
        original = response()
        run, calls = self.run_config(self.config(), [original])
        self.assertEqual(run["state"], "succeeded")
        item = run["slices"][0]
        path = Path(item["raw_path"])
        self.assertEqual(path.read_bytes(), original.body)
        self.assertEqual(item["raw_sha256"], hashlib.sha256(original.body).hexdigest())
        meta = json.loads(Path(item["meta_path"]).read_text())
        self.assertTrue(meta["wire_response_preserved"])
        self.assertFalse(meta["is_derived"])
        self.assertEqual(meta["coverage"], "not_proven")
        self.assertEqual(meta["params"], calls[0][1])
        self.assertIn("/tushare/stocks/market/daily/", str(path))
        for file in self.root.rglob("*"):
            if file.is_file():
                self.assertNotIn(TOKEN.encode(), file.read_bytes())

    def test_sdk_parquet_preserves_values_types_and_schema(self):
        frame = pd.DataFrame(
            {
                "ts_code": pd.Series(["000001.SZ", "600000.SH"], dtype="string"),
                "close": [float.fromhex("0x1.fffffffffffffp-1"), 7.123456789012345],
                "volume": pd.Series([100, None], dtype="Int64"),
                "flag": pd.Series([True, None], dtype="boolean"),
                "timestamp": pd.to_datetime(["2026-11-12T01:00:00.123456789Z", None], utc=True),
                "decimal": [Decimal("12345.000000000000000123"), None],
            }
        )
        sdk_response = Response(None, None, "sdk_dataframe_parquet", "1.4.29", frame=frame)
        run, _ = self.run_config(self.config(transport="sdk"), [sdk_response])
        self.assertEqual(run["state"], "succeeded")
        item = run["slices"][0]
        path = Path(item["raw_path"])
        self.assertEqual(path.name, "data.parquet")
        self.assertEqual(path.read_bytes()[:4], b"PAR1")
        pd.testing.assert_frame_equal(pd.read_parquet(path), frame, check_exact=True)
        self.assertEqual(item["raw_sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        meta = json.loads(Path(item["meta_path"]).read_text())
        self.assertEqual(meta["rows"], 2)
        self.assertEqual(meta["data_file"], "data.parquet")
        self.assertEqual(meta["data_sha256"], item["raw_sha256"])
        self.assertEqual(meta["pandas_dtypes"]["volume"], "Int64")
        schema = {field["name"]: field["type"] for field in meta["schema"]}
        self.assertEqual(schema["close"], "double")
        self.assertEqual(schema["volume"], "int64")
        self.assertEqual(schema["timestamp"], "timestamp[ns, tz=UTC]")
        self.assertFalse(meta["wire_response_preserved"])
        self.assertFalse(meta["is_derived"])
        self.assertIsNone(sdk_response.body)

    def test_sdk_empty_and_truncated_frames_keep_parquet_evidence(self):
        empty = pd.DataFrame({"ts_code": pd.Series(dtype="string"), "close": pd.Series(dtype="float64")})
        run, _ = self.run_config(
            self.config(transport="sdk", allow_empty=True),
            [Response(None, None, "sdk_dataframe_parquet", frame=empty)],
        )
        self.assertEqual(run["state"], "succeeded")
        self.assertEqual(run["rows"], 0)
        pd.testing.assert_frame_equal(pd.read_parquet(run["slices"][0]["raw_path"]), empty)
        truncated = pd.DataFrame({"ts_code": ["600000.SH", "000001.SZ"], "close": [7.0, 8.0]})
        run, calls = self.run_config(
            self.config(transport="sdk", row_limit=2),
            [Response(None, None, "sdk_dataframe_parquet", frame=truncated)],
        )
        self.assertEqual(run["state"], "failed")
        self.assertIn("截断", run["error"])
        self.assertEqual(len(calls), 1)
        pd.testing.assert_frame_equal(pd.read_parquet(run["slices"][0]["raw_path"]), truncated)

    def test_sdk_token_in_unused_category_is_not_persisted(self):
        frame = pd.DataFrame(
            {
                "ts_code": pd.Categorical(["600000.SH"], categories=["600000.SH", TOKEN]),
            }
        )
        run, _ = self.run_config(
            self.config(transport="sdk"),
            [Response(None, None, "sdk_dataframe_parquet", frame=frame)],
        )
        self.assertEqual(run["state"], "failed")
        self.assertIsNone(run["slices"][0]["raw_path"])
        self.assertIn("凭证", run["error"])
        for file in self.root.rglob("*"):
            if file.is_file():
                self.assertNotIn(TOKEN.encode(), file.read_bytes())

    def test_resume_keeps_legacy_sdk_json_and_adds_parquet(self):
        saved = self.store.save_config(
            self.config(
                transport="sdk",
                params={},
                mode="date_range",
                start_date="2026-11-11",
                end_date="2026-11-12",
            )
        )
        run = self.store.create_run(saved["id"])
        first = self.store.pending(run["id"])
        legacy_dir = self.root / "raw/legacy"
        legacy_dir.mkdir(parents=True)
        raw_path, meta_path = legacy_dir / "dataframe.json", legacy_dir / "meta.json"
        raw_path.write_bytes(response().body)
        meta_path.write_text('{"transport":"sdk","capture_format":"sdk_dataframe_json"}')
        evidence = {
            "raw_path": str(raw_path),
            "raw_sha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
            "meta_path": str(meta_path),
            "meta_sha256": hashlib.sha256(meta_path.read_bytes()).hexdigest(),
        }
        self.store.finish_slice(first["id"], state="succeeded", evidence=evidence, rows=1)
        self.store.finish_run(run["id"], "interrupted")
        self.store.resume(run["id"])
        frame = pd.DataFrame({"ts_code": ["600000.SH"], "close": [7.0]})
        runner, calls = self.runner([Response(None, None, "sdk_dataframe_parquet", frame=frame)])
        runner.execute(self.store.claim())
        final = self.store.run(run["id"], detail=True)
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual(len(calls), 1)
        self.assertEqual(final["slices"][0]["raw_path"], str(raw_path))
        self.assertEqual(hashlib.sha256(raw_path.read_bytes()).hexdigest(), evidence["raw_sha256"])
        self.assertTrue(final["slices"][1]["raw_path"].endswith("/data.parquet"))

    def test_permission_error_no_retry_and_retains_response(self):
        run, calls = self.run_config(self.config(), [response(code=2002, message="权限不足")])
        self.assertEqual(run["state"], "failed")
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(run["attempts"]), 1)
        self.assertTrue(Path(run["slices"][0]["raw_path"]).is_file())
        self.assertIn("2002", run["error"])

    def test_transient_http_retry_retains_both_attempts(self):
        run, calls = self.run_config(self.config(), [response(status=503), response()])
        self.assertEqual(run["state"], "succeeded")
        self.assertEqual(len(calls), 2)
        self.assertEqual({attempt["state"] for attempt in run["attempts"]}, {"failed", "succeeded"})
        self.assertTrue(all(Path(attempt["raw_dir"]).is_dir() for attempt in run["attempts"]))

    def test_network_failure_has_diagnostic_metadata(self):
        run, _ = self.run_config(
            self.config(max_attempts=1),
            [CollectionFailure("连接超时", retryable=True)],
        )
        self.assertEqual(run["state"], "failed")
        self.assertIsNone(run["slices"][0]["raw_path"])
        self.assertIn("连接超时", Path(run["slices"][0]["meta_path"]).read_text())

    def test_exact_document_limit_cannot_be_bypassed(self):
        run, calls = self.run_config(self.config(row_limit=100000), [response(rows=6000)])
        self.assertEqual(run["state"], "failed")
        self.assertIn("6000", run["error"])
        self.assertIn("截断", run["error"])
        self.assertEqual(len(calls), 1)
        self.assertTrue(Path(run["slices"][0]["raw_path"]).is_file())

    def test_empty_response_policy_and_schema_failure(self):
        empty = response(rows=0)
        with self.assertRaisesRegex(CollectionFailure, "空响应"):
            validate_response(empty, "", None, False, TOKEN)
        self.assertEqual(validate_response(empty, "", None, True, TOKEN), 0)
        malformed = Response(b'{"code":0,"data":{"fields":["a","b"],"items":[[1]]}}', 200)
        with self.assertRaisesRegex(CollectionFailure, "对齐"):
            validate_response(malformed, "", None, True, TOKEN)
        with self.assertRaisesRegex(CollectionFailure, "JSON"):
            validate_response(Response(b'{"code":0,"data":NaN}', 200), "", None, True, TOKEN)

    def test_token_echo_is_not_written_to_raw_or_sqlite(self):
        run, _ = self.run_config(self.config(), [response(code=2002, message=TOKEN)])
        self.assertEqual(run["state"], "failed")
        self.assertIsNone(run["slices"][0]["raw_path"])
        self.assertIn("凭证", run["error"])
        for file in self.root.rglob("*"):
            if file.is_file():
                self.assertNotIn(TOKEN.encode(), file.read_bytes())

    def test_resume_skips_verified_success_and_reuses_frozen_config(self):
        saved = self.store.save_config(
            self.config(
                params={},
                mode="date_range",
                start_date="2026-11-10",
                end_date="2026-11-12",
            )
        )
        initial = self.store.create_run(saved["id"])
        runner, _ = self.runner([response(), response(code=2002, message="权限不足")])
        runner.execute(self.store.claim())
        first = self.store.run(initial["id"], detail=True)
        original_path = first["slices"][0]["raw_path"]
        self.store.save_config(self.config(name="已修改配置"), saved["id"], saved["revision"])
        self.store.resume(initial["id"])
        resumed_runner, calls = self.runner([response(), response()])
        with patch.dict("collector.models.ENTRIES", {"27": {"row_limit": 1}}):
            resumed_runner.execute(self.store.claim())
        final = self.store.run(initial["id"], detail=True)
        self.assertEqual(final["state"], "succeeded")
        self.assertEqual(final["completed"], 3)
        self.assertEqual(final["config"]["name"], "测试行情")
        self.assertEqual(final["slices"][0]["raw_path"], original_path)
        self.assertEqual([call[1]["trade_date"] for call in calls], ["20261111", "20261112"])

    def test_resume_refuses_corrupt_raw(self):
        run, _ = self.run_config(
            self.config(params={}, mode="date_range", start_date="2026-11-10", end_date="2026-11-11"),
            [response(), response(code=2002, message="权限不足")],
        )
        Path(run["slices"][0]["raw_path"]).write_bytes(b"changed")
        with self.assertRaisesRegex(CollectorError, "损坏"):
            self.store.resume(run["id"])
        self.assertEqual(self.store.run(run["id"])["state"], "failed")

    def test_cancel_preserves_completed_slice(self):
        saved = self.store.save_config(
            self.config(
                params={},
                mode="date_range",
                start_date="2026-11-10",
                end_date="2026-11-11",
            )
        )
        run = self.store.create_run(saved["id"])
        runner, calls = self.runner([response()], callback=lambda: self.store.cancel(run["id"]))
        runner.execute(self.store.claim())
        final = self.store.run(run["id"], detail=True)
        self.assertEqual(final["state"], "cancelled")
        self.assertEqual(final["completed"], 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(final["slices"][1]["state"], "pending")

    def test_restart_marks_interrupted_and_does_not_auto_resume(self):
        saved = self.store.save_config(self.config())
        initial = self.store.create_run(saved["id"])
        self.store.claim()
        item = self.store.pending(initial["id"])
        self.store.start_attempt(item["id"])
        reopened = Store(self.store.path)
        reopened.recover()
        recovered = reopened.run(initial["id"], detail=True)
        self.assertEqual(recovered["state"], "interrupted")
        self.assertEqual(recovered["slices"][0]["state"], "pending")
        self.assertEqual(recovered["attempts"][0]["state"], "interrupted")
        self.assertIsNone(reopened.claim())

    def test_revision_conflict_duplicate_run_and_exclusive_worker(self):
        saved = self.store.save_config(self.config())
        self.store.save_config(self.config(name="新名称"), saved["id"], saved["revision"])
        with self.assertRaisesRegex(CollectorError, "已被修改"):
            self.store.save_config(self.config(), saved["id"], saved["revision"])
        self.store.create_run(saved["id"])
        with self.assertRaisesRegex(CollectorError, "已有"):
            self.store.create_run(saved["id"])
        self.store.cancel(self.store.runs()[0]["id"])
        first, second = Runner(self.store), Runner(self.store)
        first.start()
        self.addCleanup(first.close)
        with self.assertRaisesRegex(RuntimeError, "已有"):
            second.start()

    def test_filesystem_failure_is_explicit(self):
        config = self.config()
        self.store.save_config(config)
        Path(config.raw_root).write_text("not a directory")
        saved = self.store.configurations()[0]
        # Directory may become unusable after a queued run was planned.
        Path(config.raw_root).unlink()
        run = self.store.create_run(saved["id"])
        Path(config.raw_root).write_text("not a directory")
        runner, _ = self.runner([response()])
        runner.execute(self.store.claim())
        self.assertEqual(self.store.run(run["id"])["state"], "failed")
        self.assertIn("Raw 路径不是目录", self.store.run(run["id"])["error"])
        Path(config.raw_root).unlink()
        second = self.store.create_run(saved["id"])
        with patch("collector.runner.archive", side_effect=PermissionError("permission denied")):
            runner, _ = self.runner([response()])
            runner.execute(self.store.claim())
        self.assertIn("Raw 写入失败", self.store.run(second["id"])["error"])


class SDKTests(unittest.TestCase):
    def test_actual_sdk_uses_https_and_returns_documented_snapshot(self):
        http_response = requests.Response()
        http_response.status_code = 200
        http_response._content = response().body
        observations = []
        with patch("tushare.pro.client.requests.post", return_value=http_response) as post:
            client = SDKClient(TOKEN, 15, before_request=lambda: observations.append(True))
            result = client.request("daily", {"trade_date": "20261112"}, "ts_code,close")
        self.assertTrue(post.call_args.args[0].startswith("https://"))
        self.assertEqual(post.call_args.kwargs["timeout"], 15)
        self.assertEqual(post.call_args.kwargs["json"]["token"], TOKEN)
        self.assertEqual(len(observations), 1)
        self.assertEqual(result.capture_format, "sdk_dataframe_parquet")
        self.assertIsNone(result.body)
        self.assertIsInstance(result.frame, pd.DataFrame)
        self.assertIsNone(result.status)
        self.assertEqual(validate_response(result, "ts_code,close", 6000, False, TOKEN), 1)

    def test_sdk_failure_not_converted_to_success_and_redacts_token(self):
        class BrokenApi:
            def query(self, *args, **kwargs):
                raise Exception(f"无权限 {TOKEN}")

        client = SDKClient(TOKEN, 10, api=BrokenApi())
        with self.assertRaises(CollectionFailure) as caught:
            client.request("daily", {}, "")
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertFalse(caught.exception.retryable)

    def test_sdk_derived_result_and_every_subrequest_observed(self):
        class BarApi:
            def query(self, api_name, **params):
                if api_name == "adj_factor":
                    return pd.DataFrame({"trade_date": ["20261112", "20261111"], "adj_factor": [2, 1]})
                return pd.DataFrame(
                    {
                        "ts_code": ["600000.SH", "600000.SH"],
                        "trade_date": ["20261112", "20261111"],
                        "open": [7, 6],
                        "close": [7, 6],
                        "high": [8, 7],
                        "low": [6, 5],
                        "pre_close": [6, 5],
                        "vol": [100, 90],
                        "amount": [700, 540],
                    }
                )

        observations = []
        client = SDKClient(TOKEN, 10, api=BarApi(), before_request=lambda: observations.append(True))
        result = client.request("pro_bar", {"ts_code": "600000.SH", "asset": "E", "adj": "hfq"}, "")
        self.assertEqual(len(observations), 2)
        self.assertEqual(result.capture_format, "sdk_derived_dataframe_parquet")
        self.assertEqual(validate_response(result, "", None, False, TOKEN), 2)

    def test_sdk_derived_cancellation_survives_sdk_error_handler(self):
        def cancelled():
            raise StopRun("cancelled")

        client = SDKClient(TOKEN, 10, before_request=cancelled)
        with redirect_stdout(io.StringIO()), self.assertRaises(StopRun):
            client.request("pro_bar", {"ts_code": "600000.SH", "asset": "E"}, "")

    def test_sdk_derived_swallowed_failure_keeps_original_reason(self):
        class DeniedAPI:
            def query(self, *args, **kwargs):
                raise RuntimeError("权限不足")

        client = SDKClient(TOKEN, 10, api=DeniedAPI())

        def swallowed(**kwargs):
            try:
                kwargs["api"].query("daily")
            except CollectionFailure:
                return None

        with (
            patch("tushare.pro_bar", side_effect=swallowed),
            self.assertRaisesRegex(CollectionFailure, "权限不足"),
        ):
            client.request("pro_bar", {"ts_code": "600000.SH", "asset": "E"}, "")

    def test_http_transport_uses_official_protocol_and_no_sdk_dependency(self):
        captured = []

        def handler(request):
            captured.append(json.loads(request.content))
            return httpx.Response(200, content=response().body)

        client = TushareClient(TOKEN, 10, transport=httpx.MockTransport(handler))
        self.addCleanup(client.close)
        result = client.request("daily", {"trade_date": "20261112"}, "close")
        self.assertEqual(captured[0]["api_name"], "daily")
        self.assertEqual(captured[0]["fields"], "close")
        self.assertEqual(result.capture_format, "http_response_bytes")


class ArtifactTests(CollectorFixture):
    def test_batch_plan_confirms_revisions_and_keeps_independent_parameters(self):
        first = self.store.save_config(self.config(requests_per_minute=12))
        second = self.store.save_config(
            self.config(
                name="日期切片",
                params={},
                mode="date_range",
                start_date="2026-11-11",
                end_date="2026-11-12",
            )
        )
        ids = [first["id"], second["id"]]
        planned = self.store.batch_plan(ids, 30)
        self.assertEqual(planned["total_slices"], 3)
        self.assertEqual(planned["estimated_seconds"], 9)
        self.assertEqual(
            planned["tasks"][1]["samples"],
            [
                {"trade_date": "20261111"},
                {"trade_date": "20261112"},
            ],
        )
        self.assertEqual(self.store.runs(), [])
        self.store.save_config(self.config(params={"trade_date": "20261110"}), first["id"], 1)
        with self.assertRaisesRegex(CollectorError, "已修改"):
            self.store.create_batch(ids, planned["expected_revisions"])
        self.assertEqual(self.store.runs(), [])
        with self.assertRaisesRegex(CollectorError, "不一致"):
            self.store.create_batch(ids, {first["id"]: 2})
        fresh = self.store.batch_plan(ids, 30)
        batch = self.store.create_batch(ids, fresh["expected_revisions"])
        self.assertEqual(batch["total_slices"], 3)
        with self.assertRaisesRegex(CollectorError, "已有"):
            self.store.batch_plan(ids, 30)
        derived = self.store.save_config(
            self.config(
                name="复权行情",
                entry_id="146",
                transport="sdk",
                params={"ts_code": "600000.SH"},
            )
        )
        self.assertIsNone(self.store.batch_plan([derived["id"]], 30)["estimated_seconds"])

    def test_groups_persist_order_and_delete_without_removing_configs(self):
        first = self.store.save_config(self.config())
        second = self.store.save_config(self.config(name="任务二"))
        ids = [second["id"], first["id"]]
        group = self.store.save_group(" 每日基础数据 ", ids)
        reopened = Store(self.store.path)
        self.assertEqual(reopened.groups()[0]["config_ids"], ids)
        self.assertEqual(reopened.groups()[0]["name"], "每日基础数据")
        for name, selected in [
            ("每日基础数据", ids),
            ("空", []),
            ("重复", [ids[0], ids[0]]),
            ("缺失", [ids[0], "missing"]),
            ("  ", ids),
        ]:
            with self.assertRaises(CollectorError):
                reopened.save_group(name, selected)
        self.assertEqual(len(reopened.groups()), 1)
        reopened.delete_group(group["id"])
        self.assertEqual(reopened.groups(), [])
        self.assertEqual(len(reopened.configurations()), 2)
        with self.assertRaisesRegex(CollectorError, "不存在"):
            reopened.delete_group(group["id"])

    def test_preview_parquet_pagination_and_json_safe_values(self):
        frame = pd.DataFrame(
            {
                "index": range(310),
                "large": [2**60] * 310,
                "decimal": [Decimal("12345.000000000000000123")] * 310,
                "timestamp": pd.to_datetime(["2026-11-12T01:00:00.123456789Z"] * 310, utc=True),
                "nullable": pd.Series([None] * 310, dtype="Int64"),
            }
        )
        run, _ = self.run_config(
            self.config(transport="sdk"),
            [
                Response(None, None, "sdk_dataframe_parquet", frame=frame),
            ],
        )
        slice_id = run["slices"][0]["id"]
        page = preview_slice(self.store, run["id"], slice_id, 250, 50)
        self.assertEqual(page["total_rows"], 310)
        self.assertEqual([row[0] for row in page["rows"]], list(range(250, 300)))
        self.assertEqual(
            page["rows"][0][1:],
            [
                str(2**60),
                "12345.000000000000000123",
                "2026-11-12T01:00:00.123456789+00:00",
                None,
            ],
        )
        self.assertTrue(page["hash_verified"])
        self.assertEqual(page["slice_number"], 1)
        self.assertEqual(page["params"], {"trade_date": "20261112"})
        self.assertEqual(page["next_offset"], 300)
        json.dumps(page, allow_nan=False)
        last = preview_slice(self.store, run["id"], slice_id, 300, 200)
        self.assertEqual(len(last["rows"]), 10)
        self.assertIsNone(last["next_offset"])
        self.assertEqual(preview_slice(self.store, run["id"], slice_id, 310)["rows"], [])
        for offset, limit in [(-1, 50), (0, 0), (0, 201)]:
            with self.assertRaisesRegex(CollectorError, "分页"):
                preview_slice(self.store, run["id"], slice_id, offset, limit)

    def test_preview_empty_and_failed_truncated_parquet(self):
        empty = pd.DataFrame({"ts_code": pd.Series(dtype="string")})
        run, _ = self.run_config(
            self.config(transport="sdk", allow_empty=True),
            [
                Response(None, None, "sdk_dataframe_parquet", frame=empty),
            ],
        )
        page = preview_slice(self.store, run["id"], run["slices"][0]["id"])
        self.assertEqual(page["total_rows"], 0)
        self.assertEqual(page["rows"], [])
        self.assertEqual(page["columns"][0]["name"], "ts_code")
        run, _ = self.run_config(
            self.config(transport="sdk", row_limit=2),
            [
                Response(None, None, "sdk_dataframe_parquet", frame=pd.DataFrame({"close": [7.0, 8.0]})),
            ],
        )
        page = preview_slice(self.store, run["id"], run["slices"][0]["id"])
        self.assertEqual(page["source_state"], "failed")
        self.assertIn("截断", page["source_error"])
        self.assertEqual(len(page["rows"]), 2)

    def test_preview_http_legacy_and_invalid_business_response(self):
        run, _ = self.run_config(self.config(), [response(rows=3)])
        item = run["slices"][0]
        self.assertEqual(len(preview_slice(self.store, run["id"], item["id"], 1)["rows"]), 2)
        raw, meta = Path(item["raw_path"]), Path(item["meta_path"])
        legacy = raw.with_name("dataframe.json")
        raw.rename(legacy)
        metadata = json.loads(meta.read_text())
        metadata.update(
            response_file=legacy.name,
            response_sha256=item["raw_sha256"],
            data_file=legacy.name,
            data_sha256=item["raw_sha256"],
            capture_format="sdk_dataframe_json",
        )
        meta.write_text(json.dumps(metadata))
        evidence = {
            **item,
            "raw_path": str(legacy),
            "meta_sha256": hashlib.sha256(meta.read_bytes()).hexdigest(),
        }
        self.store.finish_slice(item["id"], state="succeeded", evidence=evidence, rows=3)
        self.assertEqual(preview_slice(self.store, run["id"], item["id"])["filename"], "dataframe.json")
        rejected, _ = self.run_config(self.config(), [response(code=2002)])
        with self.assertRaisesRegex(CollectorError, "有效的可预览表格"):
            preview_slice(self.store, rejected["id"], rejected["slices"][0]["id"])

    def test_preview_and_export_reject_tampering_and_outside_root(self):
        run, _ = self.run_config(self.config(), [response()])
        item = run["slices"][0]
        raw, meta = Path(item["raw_path"]), Path(item["meta_path"])
        original = raw.read_bytes()
        raw.write_bytes(original + b"tampered")
        for action in [
            lambda: preview_slice(self.store, run["id"], item["id"]),
            lambda: export_data(self.store, run["id"], str(self.root / "exports")),
        ]:
            with self.assertRaisesRegex(CollectorError, "哈希|损坏"):
                action()
        self.assertEqual(list((self.root / "exports").rglob("manifest.json")), [])
        raw.write_bytes(original)
        meta.write_text("{}")
        with self.assertRaisesRegex(CollectorError, "哈希"):
            preview_slice(self.store, run["id"], item["id"])
        outside = self.root / "response.json"
        outside.write_bytes(original)
        self.store.finish_slice(item["id"], state="succeeded", evidence={**item, "raw_path": str(outside)})
        with self.assertRaisesRegex(CollectorError, "Raw 根目录"):
            preview_slice(self.store, run["id"], item["id"])
        with self.assertRaisesRegex(CollectorError, "切片不存在"):
            preview_slice(self.store, "other-run", item["id"])

    def test_preview_rejects_malformed_and_oversized_json(self):
        run, _ = self.run_config(self.config(), [Response(b"{not-json", 200)])
        item = run["slices"][0]
        with self.assertRaisesRegex(CollectorError, "有效 JSON"):
            preview_slice(self.store, run["id"], item["id"])
        with Path(item["raw_path"]).open("wb") as stream:
            stream.truncate(64 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(CollectorError, "64 MiB"):
            preview_slice(self.store, run["id"], item["id"])

    def test_exports_preserve_bytes_and_skip_unsuccessful_slices(self):
        run, _ = self.run_config(
            self.config(
                params={},
                mode="date_range",
                start_date="2026-11-10",
                end_date="2026-11-12",
            ),
            [response(), response(code=2002)],
        )
        destination = str(self.root / "chosen-output")
        first = export_data(self.store, run["id"], destination)
        second = export_data(self.store, run["id"], destination)
        self.assertNotEqual(first["directory"], second["directory"])
        self.assertEqual(first["exported_slices"], 1)
        self.assertEqual(first["skipped_slices"], 2)
        manifest_bytes = Path(first["manifest_path"]).read_bytes()
        self.assertEqual(hashlib.sha256(manifest_bytes).hexdigest(), first["manifest_sha256"])
        manifest = json.loads(manifest_bytes)
        self.assertEqual(manifest["run_state"], "failed")
        item = run["slices"][0]
        for file_key, source_key in [("data_file", "raw_path"), ("meta_file", "meta_path")]:
            copied = Path(first["directory"]) / manifest["files"][0][file_key]
            self.assertEqual(copied.read_bytes(), Path(item[source_key]).read_bytes())
        self.assertEqual(Store(self.store.path).last_export_root(), destination)
        self.assertEqual(list(Path(destination).rglob(".t-*")), [])
        with self.assertRaisesRegex(CollectorError, "源归档"):
            export_data(self.store, run["id"], str(Path(item["raw_path"]).parent))
        with self.assertRaisesRegex(CollectorError, "绝对"):
            export_data(self.store, run["id"], "relative")

    def test_archive_uses_a_short_same_parent_temporary_directory_without_changing_ids(self):
        with patch("collector.client.atomic_move", wraps=atomic_move) as publish:
            run, _ = self.run_config(self.config(), [response()])
        temporary, destination = publish.call_args.args
        self.assertEqual(temporary.parent, destination.parent)
        self.assertLessEqual(len(temporary.name), 12)
        self.assertNotIn(run["id"], temporary.name)
        metadata = json.loads(Path(run["slices"][0]["meta_path"]).read_bytes())
        self.assertEqual(destination.name, metadata["attempt_id"])
        self.assertEqual(metadata["run_id"], run["id"])
        self.assertEqual(metadata["slice_id"], run["slices"][0]["id"])

    def test_organized_export_groups_date_files_by_schema_and_preserves_bytes(self):
        frames = [
            pd.DataFrame({"ts_code": ["600000.SH"], "trade_date": [day], "close": [price]})
            for day, price in (("20261110", 7), ("20261111", 8), ("20261112", 8.5))
        ]
        run, _ = self.run_config(
            self.config(
                params={}, transport="sdk", mode="date_range",
                start_date="2026-11-10", end_date="2026-11-12",
            ),
            [Response(None, None, "sdk_dataframe_parquet", frame=frame) for frame in frames],
        )
        exported = export_data(self.store, run["id"], str(self.root / "output"), layout="organized")
        root = Path(exported["directory"])
        manifest = json.loads(Path(exported["manifest_path"]).read_bytes())
        self.assertEqual(exported["layout"], "organized")
        self.assertEqual(manifest["manifest_version"], 3)
        self.assertEqual(len(manifest["groups"]), 2)
        self.assertEqual(manifest["files"][0]["group_directory"], manifest["files"][1]["group_directory"])
        self.assertNotEqual(manifest["files"][1]["group_directory"], manifest["files"][2]["group_directory"])
        self.assertFalse(manifest["merged"])
        self.assertFalse(manifest["deduplicated"])
        for item, source in zip(manifest["files"], run["slices"], strict=True):
            encoded = Path(item["data_file"]).stem
            decoded = base64.b32decode(encoded.upper() + "=" * (-len(encoded) % 8)).hex()
            self.assertEqual(decoded, source["id"])
            self.assertIn("/d/", item["data_file"])
            self.assertIn("/m/", item["meta_file"])
            windows_root = PureWindowsPath(r"C:\out") / "tushare_exports" / root.name
            for key in ("data_file", "meta_file"):
                self.assertLessEqual(len(str(windows_root / PureWindowsPath(item[key]))), 160)
            self.assertEqual(item["params"], json.loads(source["params_json"]))
            for key, original in (("data_file", "raw_path"), ("meta_file", "meta_path")):
                self.assertEqual((root / item[key]).read_bytes(), Path(source[original]).read_bytes())
            self.assertEqual(item["registered_rows"], 1)
        for group in manifest["groups"]:
            self.assertTrue(
                all(path.suffix == ".parquet" for path in (root / group["data_directory"]).iterdir())
            )
        raw = export_data(self.store, run["id"], str(self.root / "output"))
        raw_manifest = json.loads(Path(raw["manifest_path"]).read_bytes())
        self.assertEqual(raw["layout"], "raw")
        self.assertEqual(raw_manifest["manifest_version"], 2)
        self.assertTrue(raw_manifest["files"][0]["data_file"].startswith("000001-"))
        self.assertNotEqual(raw["directory"], exported["directory"])

    def test_organized_export_separates_frequency_and_front_adjustment_anchors(self):
        frame = pd.DataFrame({"ts_code": ["600000.SH"], "trade_date": ["20261112"], "close": [8.5]})
        def outputs():
            return [Response(None, None, "sdk_dataframe_parquet", frame=frame)] * 2

        run, _ = self.run_config(
            self.config(
                entry_id="109", transport="sdk", params={"asset": "E", "adj": "hfq", "ts_code": "600000.SH"},
                split_param="freq", split_values=["D", "W"],
            ),
            outputs(),
        )
        exported = export_data(self.store, run["id"], str(self.root / "output"), layout="organized")
        groups = json.loads(Path(exported["manifest_path"]).read_bytes())["groups"]
        self.assertEqual({group["request_options"]["freq"] for group in groups}, {"D", "W"})
        self.assertEqual(len({group["directory"] for group in groups}), 2)
        qfq, _ = self.run_config(
            self.config(
                entry_id="146", transport="sdk",
                params={
                    "asset": "E", "adj": "qfq", "freq": "D", "start_date": "20261101", "end_date": "20261112",
                },
                split_param="ts_code", split_values=["600000.SH", "000001.SZ"],
            ),
            outputs(),
        )
        exported = export_data(self.store, qfq["id"], str(self.root / "output"), layout="organized")
        groups = json.loads(Path(exported["manifest_path"]).read_bytes())["groups"]
        self.assertEqual(len(groups), 2)
        self.assertTrue(
            all(group["entry_id"] == "146" and group["api_name"] == "pro_bar" for group in groups)
        )
        self.assertTrue(all(group["request_options"]["start_date"] == "20261101" for group in groups))
        self.assertEqual(
            {group["request_options"]["ts_code"] for group in groups}, {"600000.SH", "000001.SZ"}
        )

    def test_organized_json_export_marks_unknown_schema_and_keeps_failed_selection_explicit(self):
        run, _ = self.run_config(
            self.config(params={}, mode="date_range", start_date="2026-11-10", end_date="2026-11-11"),
            [response(), response(code=2002, message="权限不足")],
        )
        exported = export_data(self.store, run["id"], str(self.root / "output"), layout="organized")
        manifest = json.loads(Path(exported["manifest_path"]).read_bytes())
        self.assertEqual(exported["exported_slices"], 1)
        self.assertEqual(exported["skipped_slices"], 1)
        self.assertEqual(manifest["groups"][0]["schema_status"], "unknown")
        self.assertIsNone(manifest["groups"][0]["schema"])
        copied = Path(exported["directory"]) / manifest["files"][0]["data_file"]
        self.assertEqual(copied.read_bytes(), Path(run["slices"][0]["raw_path"]).read_bytes())
        failed = export_data(
            self.store, run["id"], str(self.root / "output"), run["slices"][1]["id"], "organized",
        )
        failed_manifest = json.loads(Path(failed["manifest_path"]).read_bytes())
        self.assertEqual(failed_manifest["groups"][0]["source_state"], "failed")
        self.assertEqual(failed_manifest["files"][0]["source_state"], "failed")
        self.assertIn("权限不足", failed_manifest["files"][0]["source_error"])

    def test_organized_export_rejects_corruption_without_publishing_partial_package(self):
        run, _ = self.run_config(self.config(), [response()])
        Path(run["slices"][0]["raw_path"]).write_bytes(b"tampered")
        with self.assertRaisesRegex(CollectorError, "损坏"):
            export_data(self.store, run["id"], str(self.root / "output"), layout="organized")
        self.assertEqual(list((self.root / "output/tushare_exports").iterdir()), [])
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM exports").fetchone()[0], 0)
        with self.assertRaisesRegex(CollectorError, "布局"):
            export_data(self.store, run["id"], str(self.root / "output"), layout="unsupported")

    def test_organized_export_verifies_parquet_schema_and_handles_missing_legacy_declaration(self):
        frame = pd.DataFrame({"ts_code": ["600000.SH"], "trade_date": ["20261112"], "close": [8.5]})
        run, _ = self.run_config(
            self.config(transport="sdk"), [Response(None, None, "sdk_dataframe_parquet", frame=frame)],
        )
        item = run["slices"][0]
        path = Path(item["meta_path"])
        metadata = json.loads(path.read_bytes())
        expected_type = metadata["schema"][0]["type"]
        metadata["schema"][0]["type"] = "int64"

        def update_metadata():
            content = json.dumps(metadata).encode()
            path.write_bytes(content)
            with self.store.connect() as db:
                db.execute(
                    "UPDATE slices SET meta_sha256=? WHERE id=?",
                    (hashlib.sha256(content).hexdigest(), item["id"]),
                )

        update_metadata()
        with self.assertRaisesRegex(CollectorError, "实际字段结构"):
            export_data(self.store, run["id"], str(self.root / "output"), layout="organized")
        self.assertEqual(list((self.root / "output/tushare_exports").iterdir()), [])
        metadata.pop("schema")
        update_metadata()
        exported = export_data(self.store, run["id"], str(self.root / "output"), layout="organized")
        group = json.loads(Path(exported["manifest_path"]).read_bytes())["groups"][0]
        self.assertEqual(group["schema_status"], "verified_parquet")
        self.assertEqual(group["schema"][0]["type"], expected_type)

    def test_export_api_accepts_layout_and_keeps_default_offline(self):
        app = create_app(self.root / "web", start_worker=False)
        self.store = app.state.store
        run, _ = self.run_config(self.config(), [response()])
        with (
            TestClient(app, base_url="http://127.0.0.1") as client,
            patch("collector.client.make_client", side_effect=AssertionError("No supplier")),
        ):
            endpoint = f"/api/runs/{run['id']}/export"
            body = {"destination": str(self.root / "output")}
            headers = {"X-Collector-Request": "1"}
            self.assertEqual(client.post(endpoint, json=body).status_code, 403)
            self.assertEqual(
                client.post(endpoint, json={**body, "layout": "unsupported"}, headers=headers).status_code,
                422,
            )
            for layout in ("raw", "organized"):
                result = client.post(
                    endpoint, json=body if layout == "raw" else {**body, "layout": layout}, headers=headers,
                )
                self.assertEqual(result.status_code, 201)
                self.assertEqual(result.json()["layout"], layout)

    def test_slice_paging_and_export_selection_beyond_500(self):
        saved = self.store.save_config(
            self.config(
                split_param="ts_code",
                split_values=[f"{i:06d}.SH" for i in range(501)],
            )
        )
        run = self.store.create_run(saved["id"])
        self.assertTrue(self.store.run(run["id"], detail=True)["slices_truncated"])
        first = self.store.slice_page(run["id"], limit=200)
        self.assertEqual((first["total"], first["run_total"], first["next_offset"]), (501, 501, 200))
        self.assertEqual([item["ordinal"] for item in first["items"]], list(range(200)))
        last = self.store.slice_page(run["id"], offset=500)
        self.assertEqual(last["items"][0]["ordinal"], 500)
        self.assertIsNone(last["next_offset"])
        self.assertEqual(self.store.slice_page(run["id"], offset=501)["items"], [])
        found = self.store.slice_page(run["id"], query="20261112 000500.sh", state="pending", number=501)
        self.assertEqual(found["total"], 1)
        self.assertEqual(found["items"][0]["id"], last["items"][0]["id"])
        self.assertEqual(found["items"][0]["params"]["ts_code"], "000500.SH")
        for filters in [
            {"query": "20261113"},
            {"query": "000500.SH", "state": "failed"},
            {"number": 502},
            {"query": "%"},
            {"query": "' OR 1=1 --"},
        ]:
            self.assertEqual(self.store.slice_page(run["id"], **filters)["total"], 0)
        for filters in [
            {"offset": -1},
            {"offset": 10**30},
            {"limit": 0},
            {"limit": 201},
            {"query": "x" * 201},
            {"state": "other"},
            {"number": 0},
            {"number": 10**30},
        ]:
            with self.assertRaises(CollectorError):
                self.store.slice_page(run["id"], **filters)
        with self.assertRaisesRegex(CollectorError, "运行不存在"):
            self.store.slice_page("missing")
        with self.assertRaisesRegex(CollectorError, "等待运行结束"):
            self.store.archived_slices(run["id"])
        with self.store.connect() as db:
            db.execute(
                "UPDATE slices SET state='succeeded',raw_path='data',meta_path='meta' WHERE run_id=?",
                (run["id"],),
            )
        self.store.finish_run(run["id"], "succeeded")
        self.assertEqual(len(self.store.archived_slices(run["id"])[1]), 501)
        self.assertEqual(len(self.store.run(run["id"], detail=True)["slices"]), 500)
        self.assertEqual(self.store.slice_page(run["id"], state="succeeded", number=501)["total"], 1)

    def test_slice_search_is_run_scoped_and_escapes_like_wildcards(self):
        ids = []
        for code in ["600000.SH", "percent%code", "under_score", "600000.SH", "percentXcode", "underXscore"]:
            saved = self.store.save_config(self.config(params={"ts_code": code}))
            ids.append(self.store.create_run(saved["id"])["id"])
        self.assertEqual(self.store.slice_page(ids[0], query="600000.SH")["total"], 1)
        self.assertEqual(self.store.slice_page(ids[0], query="%")["items"], [])
        self.assertEqual(self.store.slice_page(ids[1], query="%")["total"], 1)
        self.assertEqual(self.store.slice_page(ids[4], query="percent%code")["items"], [])
        self.assertEqual(self.store.slice_page(ids[2], query="under_score")["total"], 1)
        self.assertEqual(self.store.slice_page(ids[5], query="under_score")["items"], [])

    def test_batches_are_atomic_bounded_and_continue_after_child_failure(self):
        first = self.store.save_config(self.config())
        second = self.store.save_config(
            self.config(name="股票列表", entry_id="25", params={"list_status": "L"})
        )
        for ids in [[first["id"], "missing"], [first["id"], first["id"]], []]:
            with self.assertRaises(CollectorError):
                self.store.create_batch(ids)
            self.assertEqual(self.store.runs(), [])
            self.assertEqual(self.store.batches(), [])
        with patch("collector.store.plan", return_value=[{"trade_date": "20261112"}] * 10001):
            with self.assertRaisesRegex(CollectorError, "20000"):
                self.store.create_batch([first["id"], second["id"]])
        self.assertEqual(self.store.runs(), [])
        batch = self.store.create_batch([first["id"], second["id"]])
        self.assertEqual(batch["total_runs"], 2)
        self.assertEqual(batch["total_slices"], 2)
        with self.assertRaisesRegex(CollectorError, "已有"):
            self.store.create_batch([second["id"]])
        self.assertEqual(len(self.store.batches()), 1)
        runner, calls = self.runner([response(code=2002), response()])
        for _ in range(2):
            runner.execute(self.store.claim())
        self.assertEqual([call[0] for call in calls], ["daily", "stock_basic"])
        self.assertEqual(calls[1][1], {"list_status": "L"})
        self.assertEqual(self.store.batch(batch["id"])["state"], "partial")
        failed = next(run for run in self.store.runs() if run["state"] == "failed")
        self.store.resume(failed["id"])
        runner, _ = self.runner([response()])
        runner.execute(self.store.claim())
        self.assertEqual(Store(self.store.path).batch(batch["id"])["state"], "succeeded")

    def test_old_sqlite_schema_is_upgraded_without_changing_archives(self):
        run, _ = self.run_config(self.config(), [response()])
        item = run["slices"][0]
        with self.store.connect() as db:
            db.execute("ALTER TABLE runs DROP COLUMN batch_id")
            db.execute("DROP TABLE batches")
            db.execute("DROP TABLE exports")
        upgraded = Store(self.store.path)
        restored = upgraded.run(run["id"], detail=True)
        self.assertIsNone(restored["batch_id"])
        self.assertEqual(restored["slices"], run["slices"])
        self.assertTrue(preview_slice(upgraded, run["id"], item["id"])["hash_verified"])
        batch = upgraded.create_batch([run["config_id"]])
        self.assertEqual(batch["state"], "queued")
        self.assertEqual(len(Store(self.store.path).runs()), 2)

    def test_native_directory_picker_success_cancel_and_error(self):
        with patch("collector.artifacts.sys.platform", "darwin"):
            with patch(
                "collector.artifacts.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, f"{self.root}/\n", ""),
            ) as command:
                self.assertEqual(
                    choose_directory(str(self.root / "not-created/child"))["path"], str(self.root)
                )
                self.assertEqual(command.call_args.args[0][-1], str(self.root))
                self.assertNotIn(str(self.root), command.call_args.args[0][2])
            with patch(
                "collector.artifacts.subprocess.run",
                return_value=subprocess.CompletedProcess([], 1, "", "User canceled. (-128)"),
            ):
                self.assertEqual(choose_directory(), {"cancelled": True, "path": None})
            with patch(
                "collector.artifacts.subprocess.run",
                return_value=subprocess.CompletedProcess([], 1, "", "permission denied"),
            ):
                with self.assertRaisesRegex(CollectorError, "目录选择失败"):
                    choose_directory()

    def test_cross_platform_directory_picker_keeps_unicode_paths_and_reports_gui_failures(self):
        selected = self.root / "中文目录"
        selected.mkdir()
        for platform in ("win32", "linux"):
            with self.subTest(platform=platform), patch("collector.artifacts.sys.platform", platform):
                with patch(
                    "collector.artifacts.subprocess.run",
                    return_value=subprocess.CompletedProcess([], 0, f"{selected}\n", ""),
                ) as command:
                    self.assertEqual(choose_directory(str(self.root))["path"], str(selected))
                    self.assertEqual(command.call_args.args[0][-1], str(self.root))
                    self.assertEqual(command.call_args.kwargs["encoding"], "utf-8")
                    self.assertNotIn(str(self.root), command.call_args.args[0][-2])
                with patch(
                    "collector.artifacts.subprocess.run",
                    return_value=subprocess.CompletedProcess([], 0, "\n", ""),
                ):
                    self.assertEqual(choose_directory(), {"cancelled": True, "path": None})
                with patch(
                    "collector.artifacts.subprocess.run",
                    return_value=subprocess.CompletedProcess([], 1, "", "Tk is not available"),
                ):
                    with self.assertRaisesRegex(CollectorError, "目录选择失败.*手工"):
                        choose_directory()


class WebTests(unittest.TestCase):
    def test_slice_listing_api_validates_filters_and_pages_without_launching(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = create_app(Path(temporary), start_worker=False)
            saved = app.state.store.save_config(
                TaskConfig(
                    name="切片查询",
                    entry_id="27",
                    raw_root=str(Path(temporary) / "raw"),
                    params={"trade_date": "20261112"},
                    split_param="ts_code",
                    split_values=[f"{i:06d}.SH" for i in range(501)],
                )
            )
            run = app.state.store.create_run(saved["id"])
            with TestClient(app, base_url="http://localhost") as client:
                url = f"/api/runs/{run['id']}/slices"
                last = client.get(url, params={"q": "000500.SH 20261112", "number": 501, "state": "pending"})
                self.assertEqual(last.status_code, 200)
                self.assertEqual(last.json()["items"][0]["ordinal"], 500)
                self.assertEqual(last.json()["total"], 1)
                self.assertEqual(client.get(url + "?offset=500").json()["next_offset"], None)
                for params in [
                    {"offset": -1},
                    {"offset": 10**30},
                    {"limit": 0},
                    {"limit": 201},
                    {"limit": "invalid"},
                    {"q": "x" * 201},
                    {"number": 0},
                    {"number": 10**30},
                    {"number": 1.5},
                    {"state": "unknown"},
                ]:
                    self.assertEqual(client.get(url, params=params).status_code, 422)
                self.assertEqual(client.get("/api/runs/missing/slices").status_code, 409)
                self.assertEqual(len(client.get("/api/runs").json()), 1)
                self.assertFalse(client.get("/api/status").json()["worker_running"])

    def test_single_launch_rejects_stale_confirmed_revision_without_creating_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = create_app(Path(temporary), start_worker=False)
            store = app.state.store
            config = TaskConfig(
                name="确认日线",
                entry_id="27",
                raw_root=str(Path(temporary) / "raw"),
                params={"trade_date": "20261112"},
            )
            saved = store.save_config(config)
            checked = store.batch_plan([saved["id"]], 30)["tasks"][0]
            updated = store.save_config(config.model_copy(update={"name": "新版本"}), saved["id"], 1)
            headers = {"X-Collector-Request": "1"}
            with TestClient(app, base_url="http://localhost") as client:
                client.put("/api/credential", headers=headers, json={"token": TOKEN})
                route = f"/api/configs/{saved['id']}/runs"
                rejected = client.post(
                    route, headers=headers, json={"expected_revision": checked["revision"]}
                )
                self.assertEqual(rejected.status_code, 409)
                self.assertEqual(store.runs(), [])
                accepted = client.post(
                    route, headers=headers, json={"expected_revision": updated["revision"]}
                )
                self.assertEqual(accepted.status_code, 201)
                self.assertIsNone(accepted.json()["batch_id"])
                self.assertEqual(accepted.json()["pending"], 1)
                self.assertEqual(accepted.json()["successful_rows"], 0)
                self.assertEqual(
                    client.post(
                        route, headers=headers, json={"expected_revision": updated["revision"]}
                    ).status_code,
                    409,
                )

    def test_group_and_revision_checked_batch_endpoints(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = create_app(Path(temporary), start_worker=False)
            headers = {"X-Collector-Request": "1"}
            saved = app.state.store.save_config(
                TaskConfig(
                    name="日线",
                    entry_id="27",
                    raw_root=str(Path(temporary) / "raw"),
                    params={"trade_date": "20261112"},
                )
            )
            with TestClient(app, base_url="http://localhost") as client:
                body = {"name": "每日更新", "config_ids": [saved["id"]]}
                self.assertEqual(client.post("/api/groups", json=body).status_code, 403)
                group = client.post("/api/groups", json=body, headers=headers)
                self.assertEqual(group.status_code, 201)
                plan_body = {"config_ids": [saved["id"]]}
                planned = client.post("/api/batches/plan", json=plan_body, headers=headers)
                self.assertEqual(planned.status_code, 200)
                self.assertEqual(client.get("/api/runs").json(), [])
                client.put("/api/credential", headers=headers, json={"token": TOKEN})
                app.state.store.save_config(
                    TaskConfig.model_validate({**saved["config"], "name": "修改后的日线"}),
                    saved["id"],
                    1,
                )
                rejected = client.post(
                    "/api/batches",
                    headers=headers,
                    json={
                        **plan_body,
                        "expected_revisions": planned.json()["expected_revisions"],
                    },
                )
                self.assertEqual(rejected.status_code, 409)
                self.assertEqual(client.get("/api/runs").json(), [])
                self.assertEqual(
                    client.delete(f"/api/groups/{group.json()['id']}", headers=headers).status_code, 200
                )
                self.assertEqual(client.get("/api/groups").json(), [])
                self.assertEqual(len(client.get("/api/configs").json()), 1)

    def test_batch_preview_export_api_validation_and_persistence(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict("os.environ", {"TUSHARE_TOKEN": ""}):
            root = Path(temporary).resolve()
            app = create_app(root, start_worker=False)
            headers = {"X-Collector-Request": "1"}
            with TestClient(app, base_url="http://localhost") as client:
                ids = [
                    client.post(
                        "/api/configs",
                        headers=headers,
                        json={
                            "name": name,
                            "entry_id": "27",
                            "transport": "http",
                            "params": {"trade_date": "20261112"},
                            "raw_root": str(root / "raw"),
                        },
                    ).json()["id"]
                    for name in ["任务 A", "任务 B"]
                ]
                self.assertEqual(
                    client.post("/api/batches", headers=headers, json={"config_ids": ids}).status_code, 409
                )
                client.put("/api/credential", headers=headers, json={"token": TOKEN})
                created = client.post("/api/batches", headers=headers, json={"config_ids": ids})
                self.assertEqual(created.status_code, 201)
                outputs, calls = [response(), response()], []
                runner = Runner(
                    app.state.store,
                    TOKEN,
                    client_factory=lambda token, timeout, transport, before_request: FakeClient(
                        outputs, calls, before_request
                    ),
                )
                fast_forward_wait(self, runner)
                for _ in ids:
                    runner.execute(app.state.store.claim())
                run = client.get("/api/runs").json()[0]
                item = client.get(f"/api/runs/{run['id']}").json()["slices"][0]
                url = f"/api/runs/{run['id']}/slices/{item['id']}/preview"
                self.assertEqual(client.get(url).json()["total_rows"], 1)
                self.assertEqual(client.get(url + "?limit=201").status_code, 422)
                self.assertEqual(client.get(url + "?offset=-1").status_code, 422)
                exported = client.post(
                    f"/api/runs/{run['id']}/export",
                    headers=headers,
                    json={"destination": str(root / "output")},
                )
                self.assertEqual(exported.status_code, 201)
                self.assertEqual(
                    client.get("/api/status").json()["default_export_root"], str(root / "output")
                )
                with patch(
                    "collector.app.choose_directory", return_value={"path": str(root), "cancelled": False}
                ):
                    self.assertEqual(
                        client.post("/api/directories/select", headers=headers, json={}).status_code, 200
                    )
                    self.assertEqual(client.post("/api/directories/select", json={}).status_code, 403)
                with patch("collector.app.preview_slice", side_effect=PermissionError("denied")):
                    self.assertEqual(client.get(url).status_code, 409)
                    self.assertIn("无法读取归档", client.get(url).json()["detail"])
            with TestClient(create_app(root, start_worker=False), base_url="http://localhost") as reopened:
                self.assertEqual(reopened.get("/api/batches").json()[0]["state"], "succeeded")
                self.assertEqual(
                    reopened.get("/api/status").json()["default_export_root"], str(root / "output")
                )

    def test_frontend_api_config_and_token_are_independent_and_persistent(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict("os.environ", {"TUSHARE_TOKEN": ""}):
            root = Path(temporary).resolve()
            app = create_app(root, start_worker=False)
            headers = {"X-Collector-Request": "1"}
            with TestClient(app, base_url="http://localhost") as client:
                self.assertEqual(client.get("/").status_code, 200)
                self.assertEqual(client.get("/static/app.js").status_code, 200)
                self.assertEqual(client.get("/api/status").json()["token_configured"], False)
                body = {
                    "name": "股票列表",
                    "entry_id": "25",
                    "params": {"list_status": "L"},
                    "raw_root": str(root / "raw"),
                }
                self.assertEqual(client.post("/api/configs", json=body).status_code, 403)
                forbidden = {**headers, "Origin": "https://other.example"}
                self.assertEqual(client.post("/api/configs", json=body, headers=forbidden).status_code, 403)
                saved = client.post("/api/configs", json=body, headers=headers).json()
                self.assertEqual(saved["config"]["transport"], "sdk")
                self.assertEqual(
                    client.post(f"/api/configs/{saved['id']}/runs", headers=headers).status_code, 409
                )
                credential = client.put("/api/credential", json={"token": TOKEN}, headers=headers)
                self.assertEqual(credential.json()["persistence"], "process_memory_only")
                self.assertNotIn(TOKEN, client.get("/api/status").text)
                invalid = client.put(
                    "/api/credential", json={"token": TOKEN, "extra": TOKEN}, headers=headers
                )
                self.assertEqual(invalid.status_code, 422)
                self.assertNotIn(TOKEN, invalid.text)
                run = client.post(f"/api/configs/{saved['id']}/runs", headers=headers)
                self.assertEqual(run.status_code, 201)
                self.assertEqual(run.json()["state"], "queued")
                self.assertNotIn(TOKEN, client.get("/api/runs").text)
            with TestClient(create_app(root, start_worker=False), base_url="http://localhost") as reopened:
                self.assertEqual(len(reopened.get("/api/configs").json()), 1)
                self.assertEqual(reopened.get("/api/status").json()["token_configured"], False)
                self.assertEqual(len(reopened.get("/api/runs").json()), 1)


if __name__ == "__main__":
    unittest.main()
