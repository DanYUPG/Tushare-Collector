import json
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from test_collector import TOKEN, CollectorFixture, response

from collector.app import create_app
from collector.client import CollectionFailure
from collector.store import Store


class ActivityTests(CollectorFixture):
    def test_batch_and_preview_queue_events_commit_with_their_runs(self):
        first = self.store.save_config(self.config(name="first"))
        second = self.store.save_config(self.config(name="second"))
        batch = self.store.create_batch([first["id"], second["id"]])
        preview = self.store.create_preview(self.config(max_attempts=1))
        events = self.store.activity()["events"]
        self.assertEqual(len(events), 3)
        self.assertEqual(
            {item["run_id"] for item in events},
            {item["id"] for item in batch["runs"]} | {preview["id"]},
        )
        self.assertTrue(all(item["kind"] == "run_queued" for item in events))

    def test_token_rotation_does_not_expose_known_secrets_in_frozen_run_context(self):
        runner, _ = self.runner([])
        config = self.store.save_config(self.config(name=f"task {TOKEN}"))
        run = self.store.create_run(config["id"])
        runner.set_token("rotated-test-secret")
        self.store.claim()
        self.store.record_activity(run["id"], "run_failed", "error", f"old {TOKEN}; new rotated-test-secret")
        snapshot = runner.activity()
        self.assertNotIn(TOKEN, json.dumps(snapshot))
        self.assertNotIn("rotated-test-secret", json.dumps(snapshot))
        with self.store.connect() as db:
            persisted = json.dumps([dict(item) for item in db.execute("SELECT * FROM activity_events")])
        self.assertNotIn(TOKEN, persisted)
        self.assertNotIn("rotated-test-secret", persisted)

    def test_success_events_include_archive_evidence_and_survive_reopening(self):
        run, calls = self.run_config(self.config(), [response(rows=3)])
        self.assertEqual(len(calls), 1)
        events = self.store.activity()["events"]
        self.assertEqual(
            [item["kind"] for item in events],
            ["run_queued", "run_started", "slice_started", "slice_succeeded", "run_succeeded"],
        )
        self.assertEqual([item["seq"] for item in events], sorted(item["seq"] for item in events))
        event = events[-2]
        self.assertEqual(event["level"], "ok")
        self.assertEqual(event["run_id"], run["id"])
        self.assertEqual(event["slice_id"], run["slices"][0]["id"])
        self.assertEqual(event["ordinal"], 0)
        self.assertEqual(event["task_name"], run["config"]["name"])
        self.assertEqual(event["api_name"], "daily")
        self.assertIsNone(event["dataset_id"])
        self.assertEqual(event["params"], {"trade_date": "20261112"})
        self.assertEqual(event["rows"], 3)
        self.assertEqual(event["attempt"], 1)
        self.assertEqual(event["max_attempts"], run["config"]["max_attempts"])
        self.assertGreaterEqual(event["duration_ms"], 0)
        self.assertEqual(event["raw_sha256"], run["slices"][0]["raw_sha256"])
        reopened = Store(self.store.path).activity()
        self.assertEqual(reopened["events"], events)
        self.assertEqual(reopened["latest_seq"], events[-1]["seq"])

    def test_retries_and_final_failures_are_redacted_before_persistence(self):
        for final_error in (CollectionFailure(f"final {TOKEN}"), RuntimeError(f"unexpected {TOKEN}")):
            with self.subTest(error_type=type(final_error).__name__):
                runner, calls = self.runner(
                    [CollectionFailure(f"retry {TOKEN}", retryable=True), final_error]
                )
                saved = self.store.save_config(
                    self.config(
                        name=f"task {TOKEN}",
                        params={"trade_date": "20261112", "ts_code": TOKEN},
                        max_attempts=2,
                    )
                )
                run = self.store.create_run(saved["id"])
                with patch("collector.runner.random.uniform", return_value=0):
                    runner.execute(self.store.claim())
                events = self.store.activity(run_id=run["id"])["events"]
                self.assertEqual(len(calls), 2)
                self.assertEqual(
                    [item["kind"] for item in events],
                    [
                        "run_queued",
                        "run_started",
                        "slice_started",
                        "slice_retry_scheduled",
                        "slice_started",
                        "slice_failed",
                        "run_failed",
                    ],
                )
                retry = events[3]
                self.assertEqual(retry["level"], "warn")
                self.assertEqual(retry["retry_delay_seconds"], 2)
                self.assertEqual(retry["attempt"], 1)
                self.assertEqual(events[-2]["attempt"], 2)
                self.assertIn("[REDACTED]", retry["message"])
                self.assertEqual(events[-2]["level"], "error")
                self.assertEqual(events[-1]["level"], "error")
                with self.store.connect() as db:
                    persisted = json.dumps([dict(row) for row in db.execute("SELECT * FROM activity_events")])
                self.assertNotIn(TOKEN, persisted)
                self.assertNotIn(TOKEN, json.dumps(events))

    def test_row_limit_has_warning_event_with_evidence_and_no_retry(self):
        run, calls = self.run_config(self.config(row_limit=2), [response(rows=2)])
        self.assertEqual(run["state"], "failed")
        self.assertEqual(len(calls), 1)
        events = self.store.activity(run_id=run["id"])["events"]
        capped = next(item for item in events if item["kind"] == "slice_row_limit")
        self.assertEqual(capped["level"], "warn")
        self.assertEqual(capped["error_kind"], "row_limit")
        self.assertEqual(capped["raw_sha256"], run["slices"][0]["raw_sha256"])
        self.assertNotIn("slice_retry_scheduled", [item["kind"] for item in events])
        self.assertEqual(events[-1]["kind"], "run_failed")

    def test_cancellation_resumption_and_recovery_report_real_transitions(self):
        runner, _ = self.runner([])
        saved = self.store.save_config(self.config())
        run = self.store.create_run(saved["id"])
        self.store.cancel(run["id"])
        self.store.resume(run["id"])
        self.store.claim()
        first_attempt = self.store.start_attempt(self.store.pending(run["id"])["id"])
        self.store.recover()
        self.store.recover()
        events = self.store.activity()["events"]
        self.assertEqual(
            [item["kind"] for item in events],
            [
                "run_queued",
                "run_cancel_requested",
                "run_cancelled",
                "run_resumed",
                "run_started",
                "slice_started",
                "run_interrupted",
            ],
        )
        with self.store.connect() as db:
            self.assertEqual(
                db.execute("SELECT state FROM attempts WHERE id=?", (first_attempt,)).fetchone()[0],
                "interrupted",
            )
        self.store.resume(run["id"])
        self.store.claim()
        self.store.start_attempt(self.store.pending(run["id"])["id"])
        active = runner.activity()["worker"]["active_run"]
        self.assertEqual(active["current_slice"]["attempt"], 1)
        self.store.cancel(run["id"])
        self.assertTrue(runner.activity()["worker"]["active_run"]["cancel_requested"])
        self.store.finish_run(run["id"], "cancelled", "cancelled")
        self.assertEqual(self.store.activity()["events"][-1]["kind"], "run_cancelled")
        self.assertIsNone(runner.activity()["worker"]["active_run"])

    def test_tail_incremental_filters_and_bounded_monotonic_sequences(self):
        runner, _ = self.runner([])
        first = self.store.create_run(self.store.save_config(self.config(name="first"))["id"])
        second = self.store.create_run(self.store.save_config(self.config(name="second"))["id"])
        with patch("collector.store.ACTIVITY_LIMIT", 7):
            for index in range(12):
                self.store.record_activity(
                    first["id"] if index % 2 else second["id"],
                    "run_failed" if index % 2 else "run_started",
                    "error" if index % 2 else "info",
                    f"event {index}",
                )
        all_events = self.store.activity()
        self.assertEqual(len(all_events["events"]), 7)
        sequences = [item["seq"] for item in all_events["events"]]
        self.assertGreater(sequences[0], 1)
        self.assertEqual(all_events["latest_seq"], sequences[-1])
        tail = self.store.activity(limit=3)["events"]
        self.assertEqual([item["seq"] for item in tail], sequences[-3:])
        page = self.store.activity(after_seq=sequences[0], limit=2)
        self.assertEqual([item["seq"] for item in page["events"]], sequences[1:3])
        self.assertEqual(page["latest_seq"], sequences[-1])
        filtered = self.store.activity(level="error", run_id=first["id"])["events"]
        self.assertTrue(filtered)
        self.assertTrue(all(item["run_id"] == first["id"] and item["level"] == "error" for item in filtered))
        empty = self.store.activity(after_seq=sequences[-1])
        self.assertEqual(empty["events"], [])
        self.assertEqual(empty["latest_seq"], sequences[-1])
        self.store.record_activity(first["id"], "run_started", "info", "after trimming")
        self.assertGreater(self.store.activity()["latest_seq"], sequences[-1])
        self.assertTrue(runner.activity()["worker"]["token_configured"])

    def test_activity_api_is_read_only_validates_queries_and_exposes_live_counts(self):
        app = create_app(self.root / "control", start_worker=False)
        runner, store = app.state.runner, app.state.store
        with TestClient(app, base_url="http://127.0.0.1") as client:
            empty = client.get("/api/activity").json()
            self.assertEqual(empty["events"], [])
            self.assertEqual(empty["latest_seq"], 0)
            self.assertFalse(empty["worker"]["token_configured"])
            self.assertFalse(empty["worker"]["worker_running"])
            self.assertIsNone(empty["worker"]["active_run"])
            runner.set_token(TOKEN)
            runner.global_rpm = 12
            runner.thread = SimpleNamespace(is_alive=lambda: True)
            saved = store.save_config(
                self.config(
                    params={},
                    mode="date_range",
                    start_date="2026-11-12",
                    end_date="2026-11-13",
                    requests_per_minute=6,
                )
            )
            run = store.create_run(saved["id"])
            store.claim()
            item = store.pending(run["id"])
            attempt_id = store.start_attempt(item["id"])
            store.create_run(store.save_config(self.config(name="queued"))["id"])
            runner.next_request_at = 1002
            with patch("collector.runner.time.monotonic", return_value=1000):
                first = client.get("/api/activity").json()
            worker = first["worker"]
            self.assertTrue(worker["worker_running"])
            self.assertTrue(worker["token_configured"])
            self.assertEqual(worker["global_requests_per_minute"], 12)
            self.assertEqual(worker["effective_requests_per_minute"], 6)
            self.assertEqual(worker["next_request_in_ms"], 2000)
            self.assertTrue(worker["pacing"])
            self.assertEqual(worker["queued_runs"], 1)
            active = worker["active_run"]
            self.assertEqual(active["id"], run["id"])
            self.assertEqual(active["total"], 2)
            self.assertEqual(active["succeeded"], 0)
            self.assertEqual(active["failed"], 0)
            self.assertEqual(active["pending"], 1)
            self.assertEqual(active["running"], 1)
            self.assertEqual(active["rows"], 0)
            self.assertEqual(active["current_slice"]["slice_id"], item["id"])
            self.assertEqual(active["current_slice"]["ordinal"], 0)
            self.assertEqual(active["current_slice"]["attempt"], 1)
            self.assertEqual(active["current_slice"]["params"], {"trade_date": "20261112"})
            self.assertEqual(active["current_slice"]["max_attempts"], saved["config"]["max_attempts"])
            store.end_attempt(attempt_id, state="succeeded")
            store.finish_slice(item["id"], state="succeeded", rows=12)
            progressed = client.get("/api/activity", params={"after_seq": first["latest_seq"]}).json()
            self.assertEqual([event["kind"] for event in progressed["events"]], ["slice_succeeded"])
            self.assertEqual(progressed["worker"]["active_run"]["succeeded"], 1)
            self.assertEqual(progressed["worker"]["active_run"]["rows"], 12)
            self.assertIsNone(progressed["worker"]["active_run"]["current_slice"])
            store.finish_run(run["id"], "cancelled")
            with store.connect() as db:
                before = {
                    row[0]: [tuple(item) for item in db.execute(f'SELECT * FROM "{row[0]}" ORDER BY rowid')]
                    for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
            idle = client.get("/api/activity").json()
            self.assertIsNone(idle["worker"]["active_run"])
            self.assertEqual(idle["worker"]["effective_requests_per_minute"], 12)
            self.assertFalse(idle["worker"]["pacing"])
            filtered = client.get(
                "/api/activity", params={"run_id": run["id"], "level": "ok", "limit": 1}
            ).json()
            self.assertEqual(len(filtered["events"]), 1)
            self.assertEqual(filtered["events"][0]["kind"], "slice_succeeded")
            future = client.get("/api/activity", params={"after_seq": 2**80})
            self.assertEqual(future.status_code, 200)
            self.assertEqual(future.json()["events"], [])
            for params in (
                {"after_seq": -1},
                {"limit": 0},
                {"limit": 501},
                {"level": "fatal"},
                {"run_id": "x" * 65},
            ):
                self.assertEqual(client.get("/api/activity", params=params).status_code, 422)
            with store.connect() as db:
                after = {
                    row[0]: [tuple(item) for item in db.execute(f'SELECT * FROM "{row[0]}" ORDER BY rowid')]
                    for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
            self.assertEqual(before, after)
