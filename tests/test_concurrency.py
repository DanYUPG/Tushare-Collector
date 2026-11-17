import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from test_collector import response

from collector.app import create_app
from collector.client import CollectionFailure
from collector.models import CollectorError, TaskConfig
from collector.permissions import API_ACCESS
from collector.runner import Runner
from collector.store import Store


class ConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.store = Store(self.root / "control/collector.sqlite3")
        self.calls = []
        self.call_lock = threading.Lock()
        self.release = threading.Event()
        self.addCleanup(self.release.set)

    def config(self, count=4, **changes):
        return TaskConfig(
            **{
                "name": "concurrent fixture",
                "entry_id": "27",
                "transport": "http",
                "raw_root": str(self.root / "raw"),
                "requests_per_minute": 500,
                "split_param": "trade_date",
                "split_values": [f"202611{index + 1:02d}" for index in range(count)],
                **changes,
            }
        )

    def factory(self, callback):
        owner = self

        class FakeClient:
            def __init__(self, before_request):
                self.before_request = before_request

            def request(self, api_name, params, fields):
                self.current_api_name = api_name
                self.before_request()
                with owner.call_lock:
                    owner.calls.append((api_name, dict(params), time.time()))
                return callback(params)

            def close(self):
                pass

        return lambda token, timeout, transport, before_request: FakeClient(before_request)

    def runner(self, count, callback):
        runner = Runner(self.store, "fixture-not-real-token", client_factory=self.factory(callback))
        runner.set_collection_threads(count)
        return runner

    def start_run(self, runner, config=None, *, managed=False):
        saved = self.store.save_config(config or self.config())
        queued = self.store.create_run(saved["id"])
        run = self.store.claim()
        if managed:
            run["dataset_plan"] = {"recipe": {"kind": "daily"}}
        thread = threading.Thread(target=runner.execute, args=(run,))
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(runner.stopping.set)
        self.addCleanup(self.release.set)
        return queued["id"], thread

    def wait_until(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("Concurrent fixture did not reach its expected state")

    def blocked_response(self, params):
        if not self.release.wait(5):
            raise CollectionFailure("fixture response timed out")
        return response()

    def test_threads_overlap_without_duplicate_slices_and_changes_apply_to_next_run(self):
        runner = self.runner(3, self.blocked_response)
        run_id, thread = self.start_run(runner)
        self.wait_until(lambda: len(self.calls) == 3)
        activity = runner.activity()["worker"]
        self.assertEqual(activity["busy_workers"], 3)
        self.assertEqual(len(activity["workers"]), 3)
        current = activity["active_run"]["current_slices"]
        self.assertEqual(len(current), 3)
        self.assertEqual(len({item["slice_id"] for item in current}), 3)
        self.assertEqual(activity["active_run"]["running"], 3)
        self.assertEqual(activity["active_run"]["pending"], 1)
        self.assertEqual(activity["active_run"]["current_slice"], current[0])
        app = create_app(
            self.root / "control",
            start_worker=False,
            runner_factory=lambda store, token, rpm: runner,
        )
        with TestClient(app, base_url="http://127.0.0.1") as client:
            change = client.put(
                "/api/worker/settings",
                json={"collection_threads": 1},
                headers={"x-collector-request": "1"},
            )
            self.assertEqual(change.status_code, 200)
            changed = change.json()
        self.assertEqual(changed["collection_threads"], 1)
        self.assertEqual(changed["effective_collection_threads"], 3)
        self.release.set()
        thread.join(5)
        self.assertFalse(thread.is_alive())
        result = self.store.run(run_id, detail=True)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(result["completed"], 4)
        self.assertEqual(len({item[1]["trade_date"] for item in self.calls}), 4)
        self.assertEqual(len(result["attempts"]), 4)
        self.assertTrue(all(item["raw_path"] for item in result["slices"]))
        times = sorted(item[2] for item in self.calls)
        self.assertTrue(all(right - left >= 0.119 for left, right in zip(times, times[1:])))
        self.assertEqual(runner.worker_settings()["effective_collection_threads"], 1)
        self.assertEqual(Runner(Store(self.store.path)).worker_settings()["collection_threads"], 1)
        self.calls.clear()
        self.release.clear()
        second_id, second_thread = self.start_run(runner, self.config(count=2, name="next fixture"))
        self.wait_until(lambda: len(self.calls) == 1)
        time.sleep(0.15)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(runner.activity()["worker"]["busy_workers"], 1)
        self.release.set()
        second_thread.join(5)
        self.assertEqual(self.store.run(second_id)["state"], "succeeded")

    def test_failure_stops_unsent_work_but_drains_and_archives_in_flight_success(self):
        first_started = threading.Event()

        def output(params):
            if params["trade_date"] == "20261101":
                first_started.set()
                return self.blocked_response(params)
            self.assertTrue(first_started.wait(2))
            raise CollectionFailure("fixture permission denied", kind="permission")

        runner = self.runner(2, output)
        run_id, thread = self.start_run(runner, self.config(count=5))
        self.wait_until(lambda: self.store.run(run_id)["failed"] == 1)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(thread.is_alive())
        self.assertEqual(self.store.run(run_id)["state"], "running")
        self.release.set()
        thread.join(5)
        result = self.store.run(run_id, detail=True)
        self.assertEqual(result["state"], "failed")
        self.assertIn("fixture permission denied", result["error"])
        self.assertEqual(result["completed"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["pending"], 3)
        self.assertTrue(result["slices"][0]["raw_path"])
        self.assertEqual(len(self.calls), 2)

    def test_cancel_preserves_in_flight_archives_and_does_not_dispatch_remaining_slices(self):
        runner = self.runner(2, self.blocked_response)
        run_id, thread = self.start_run(runner, self.config(count=5))
        self.wait_until(lambda: len(self.calls) == 2)
        self.store.cancel(run_id)
        self.assertTrue(thread.is_alive())
        self.assertEqual(self.store.run(run_id)["state"], "running")
        self.release.set()
        thread.join(5)
        result = self.store.run(run_id)
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(result["completed"], 2)
        self.assertEqual(result["pending"], 3)
        self.assertEqual(len(self.calls), 2)

    def test_cancel_interrupts_pacing_without_consuming_another_request(self):
        runner = self.runner(2, self.blocked_response)
        runner.global_rpm = 60
        run_id, thread = self.start_run(runner, self.config(count=3))
        self.wait_until(
            lambda: len(self.calls) == 1 and any(item["phase"] == "pacing" for item in runner.workers())
        )
        self.store.cancel(run_id)
        self.wait_until(lambda: len(runner.workers()) == 1)
        self.release.set()
        thread.join(5)
        result = self.store.run(run_id, detail=True)
        self.assertEqual(result["state"], "cancelled")
        self.assertEqual(result["completed"], 1)
        self.assertEqual(result["pending"], 2)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 1)

    def test_shutdown_waits_for_in_flight_archival_before_marking_interrupted(self):
        runner = self.runner(2, self.blocked_response)
        run_id, thread = self.start_run(runner)
        runner.thread = thread
        self.wait_until(lambda: len(self.calls) == 2)
        closed = threading.Event()

        def close():
            runner.close()
            closed.set()

        closing = threading.Thread(target=close)
        closing.start()
        self.addCleanup(closing.join, 5)
        self.addCleanup(self.release.set)
        self.wait_until(runner.stopping.is_set)
        self.assertFalse(closed.is_set())
        self.assertEqual(self.store.run(run_id)["state"], "running")
        self.release.set()
        closing.join(5)
        self.assertTrue(closed.is_set())
        result = self.store.run(run_id)
        self.assertEqual(result["state"], "interrupted")
        self.assertEqual(result["completed"], 2)
        self.assertEqual(result["pending"], 2)

    def test_retry_keeps_ownership_while_other_slices_finish(self):
        attempts = {}
        retry_started = threading.Event()
        retry_release = threading.Event()
        self.addCleanup(retry_release.set)

        def output(params):
            key = params["trade_date"]
            with self.call_lock:
                attempts[key] = attempts.get(key, 0) + 1
                number = attempts[key]
            if key == "20261101" and number == 1:
                raise CollectionFailure("fixture retry", retryable=True)
            return response()

        runner = self.runner(2, output)
        original_wait = runner.wait

        def wait(run_id, seconds):
            if seconds >= 2:
                retry_started.set()
                if not retry_release.wait(5):
                    raise CollectionFailure("fixture retry wait timed out")
                runner.check_stop(run_id)
            else:
                original_wait(run_id, seconds)

        runner.wait = wait
        run_id, thread = self.start_run(runner, self.config(count=3, max_attempts=2))
        self.addCleanup(retry_release.set)
        self.assertTrue(retry_started.wait(3))
        self.wait_until(lambda: self.store.run(run_id)["completed"] == 2)
        result = self.store.run(run_id)
        self.assertEqual(result["running"], 1)
        self.assertEqual(result["pending"], 0)
        self.assertEqual(attempts["20261101"], 1)
        retry_release.set()
        thread.join(5)
        self.assertEqual(self.store.run(run_id)["state"], "succeeded")
        self.assertEqual(attempts, {"20261101": 2, "20261102": 1, "20261103": 1})

    def test_parallel_managed_row_caps_continue_only_confirmed_slices(self):
        runner = self.runner(3, lambda params: response(rows=2))
        run_id, thread = self.start_run(runner, self.config(count=4, row_limit=2), managed=True)
        thread.join(5)
        self.assertFalse(thread.is_alive())
        result = self.store.run(run_id, detail=True)
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["row_limit_failures"], 4)
        self.assertEqual(len(self.calls), 4)
        self.assertTrue(all(item["raw_path"] for item in result["slices"]))

    def test_atomic_admission_shares_global_api_and_task_limits(self):
        saved = self.store.save_config(self.config(count=1))
        run_id = self.store.create_run(saved["id"])["id"]
        with patch("collector.store.time.time", return_value=1000000):
            with ThreadPoolExecutor(max_workers=8) as executor:
                results = list(
                    executor.map(
                        lambda index: self.store.admit_api_request(
                            "daily" if index % 2 else "adj_factor", run_id, 500, 500
                        ),
                        range(8),
                    )
                )
        self.assertEqual(sum(delay == 0 for delay in results), 1)
        self.assertTrue(all(delay == 0 or abs(delay - 0.12) < 0.000001 for delay in results))
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 1)
        with patch("collector.store.time.time", return_value=1000000.2):
            delay = self.store.admit_api_request("stock_basic", run_id, 10, 500)
        self.assertAlmostEqual(delay, 5.8)
        with patch("collector.store.time.time", return_value=1000006):
            self.assertEqual(self.store.admit_api_request("stock_basic", run_id, 500, 500), 0)
        second = self.store.create_run(self.store.save_config(self.config(count=1, name="other"))["id"])
        with patch("collector.store.time.time", return_value=1000006.2):
            self.assertAlmostEqual(self.store.admit_api_request("stock_basic", second["id"], 500, 500), 1)

    def test_atomic_quota_cannot_be_overbooked_by_concurrent_requests(self):
        saved = self.store.save_config(self.config(count=1))
        run_id = self.store.create_run(saved["id"])["id"]
        timestamps = iter(range(1000000, 1001000, 100))
        access = {**API_ACCESS["cyq_chips"], "daily_limit": 2}

        def admit(index):
            try:
                return self.store.admit_api_request("cyq_chips", run_id, 500, 500)
            except CollectorError:
                return "quota"

        with patch.dict(API_ACCESS, {"cyq_chips": access}):
            with patch("collector.store.time.time", side_effect=lambda: next(timestamps)):
                with ThreadPoolExecutor(max_workers=8) as executor:
                    results = list(executor.map(admit, range(8)))
        self.assertEqual(results.count(0), 2)
        self.assertEqual(results.count("quota"), 6)
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 2)

    def test_frontend_settings_api_validates_and_persists_without_restart(self):
        app = create_app(self.root / "control", start_worker=False)
        with TestClient(app, base_url="http://127.0.0.1") as client:
            initial = client.get("/api/worker/settings").json()
            self.assertEqual(initial["collection_threads"], 1)
            self.assertEqual(initial["max_collection_threads"], 16)
            self.assertEqual(initial["applies_to"], "next_run")
            self.assertEqual(
                client.put("/api/worker/settings", json={"collection_threads": 3}).status_code, 403
            )
            headers = {"x-collector-request": "1"}
            for value in (0, 17, True, 2.5, "3"):
                result = client.put(
                    "/api/worker/settings", json={"collection_threads": value}, headers=headers
                )
                self.assertEqual(result.status_code, 422)
            result = client.put(
                "/api/worker/settings", json={"collection_threads": 3, "unknown": 1}, headers=headers
            )
            self.assertEqual(result.status_code, 422)
            result = client.put("/api/worker/settings", json={"collection_threads": 3}, headers=headers)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["effective_collection_threads"], 3)
            status = client.get("/api/status").json()
            self.assertEqual(status["collection_threads"], 3)
            self.assertEqual(status["effective_collection_threads"], 3)
            worker = client.get("/api/activity").json()["worker"]
            self.assertEqual(worker["collection_threads"], 3)
            self.assertEqual(worker["workers"], [])
            self.assertEqual(worker["busy_workers"], 0)
            self.assertEqual(worker["active_runs"], [])
            self.assertIsNone(worker["active_run"])
        self.assertEqual(
            create_app(self.root / "control", start_worker=False).state.runner.worker_settings(),
            {
                "collection_threads": 3,
                "effective_collection_threads": 3,
                "max_collection_threads": 16,
                "applies_to": "next_run",
            },
        )
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM api_requests").fetchone()[0], 0)
