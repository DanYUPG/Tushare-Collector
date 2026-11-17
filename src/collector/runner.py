from __future__ import annotations

import fcntl
import json
import logging
import random
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor
from concurrent.futures import wait as wait_futures

from .client import (
    CollectionFailure,
    StopRun,
    archive,
    make_client,
    redact,
    response_contains_token,
    validate_response,
)
from .models import CollectorError, TaskConfig
from .permissions import API_ACCESS, DEFAULT_RPM, effective_rpm
from .store import Store, now

LOGGER = logging.getLogger(__name__)


class Runner:
    def __init__(
        self, store: Store, token: str = "", global_rpm: int = DEFAULT_RPM, client_factory=make_client
    ):
        self.store = store
        self.global_rpm = global_rpm
        self.client_factory = client_factory
        self._token = token.strip()
        self._token_lock = threading.Lock()
        self._redaction_tokens = {self._token}
        self.store.activity_tokens = self.redaction_tokens
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.thread: threading.Thread | None = None
        self.lock = None
        self.next_request_at = 0.0
        self.active_run_id = None
        self.current_api_name = None
        self._state_lock = threading.RLock()
        self._admission_lock = threading.Lock()
        self._collection_threads = store.collection_threads()
        self._effective_threads = self._collection_threads
        self._workers = {}
        self._run_failure = None
        self._run_failed = threading.Event()
        self.idle_callback = None

    def worker_settings(self):
        with self._state_lock:
            return {
                "collection_threads": self._collection_threads,
                "effective_collection_threads": (
                    self._effective_threads if self.active_run_id else self._collection_threads
                ),
                "max_collection_threads": 16,
                "applies_to": "next_run",
            }

    def set_collection_threads(self, count: int):
        with self._state_lock:
            self.store.save_collection_threads(count)
            self._collection_threads = count
        return self.worker_settings()

    def worker_phase(self, phase: str, *, api_name=None, delay=0):
        with self._state_lock:
            worker = self._workers.get(threading.get_ident())
            if worker is not None:
                worker.update(phase=phase, next_request_at=time.monotonic() + delay)
                if api_name:
                    worker["api_name"] = api_name
                    worker["effective_requests_per_minute"] = min(
                        worker["task_rpm"], self.global_rpm, API_ACCESS[api_name]["configured_rpm"]
                    )

    def workers(self):
        with self._state_lock:
            timestamp = time.monotonic()
            return [
                {key: value for key, value in worker.items() if key not in {"next_request_at", "task_rpm"}}
                | {"next_request_in_ms": max(0, int((worker["next_request_at"] - timestamp) * 1000))}
                for worker in sorted(self._workers.values(), key=lambda item: item["ordinal"])
            ]

    @property
    def token(self):
        with self._token_lock:
            return self._token

    def set_token(self, token: str):
        with self._token_lock:
            self._token = token.strip()
            # Frozen task metadata may still contain a previous in-process credential.
            self._redaction_tokens.add(self._token)

    def redaction_tokens(self):
        with self._token_lock:
            return tuple(self._redaction_tokens)

    def activity(self, after_seq=0, limit=100, level=None, run_id=""):
        snapshot = self.store.activity(after_seq, limit, level, run_id)
        active = snapshot["active_run"]
        workers = self.workers()
        delay = max(0, int((self.next_request_at - time.monotonic()) * 1000))
        waiting = [
            worker["next_request_in_ms"]
            for worker in workers
            if worker["phase"] == "pacing" and worker["next_request_in_ms"] > 0
        ]
        if waiting:
            delay = min(waiting)
        api_name = (
            workers[0]["api_name"]
            if workers and active and active["id"] == self.active_run_id
            else active["api_name"]
            if active
            else None
        )
        return {
            "worker": {
                "worker_running": bool(self.thread and self.thread.is_alive()),
                "token_configured": bool(self.token),
                "global_requests_per_minute": self.global_rpm,
                "effective_requests_per_minute": (
                    min(
                        self.global_rpm,
                        snapshot["requests_per_minute"],
                        API_ACCESS[api_name]["configured_rpm"],
                    )
                    if active
                    else self.global_rpm
                ),
                "current_api_name": api_name,
                "next_request_in_ms": delay,
                "pacing": bool(delay > 0 and active),
                "queued_runs": snapshot["queued_runs"],
                "active_run": active,
                "active_runs": snapshot["active_runs"],
                **self.worker_settings(),
                "busy_workers": len(workers),
                "workers": workers,
            },
            "events": snapshot["events"],
            "latest_seq": snapshot["latest_seq"],
        }

    def start(self):
        self.lock = (self.store.path.parent / ".collector-worker.lock").open("a+b")
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            self.lock = None
            raise RuntimeError(
                "此 SQLite 目录已有拉取器进程；请勿启动多个服务进程，采集线程数请在设置中配置"
            ) from None
        self.store.recover()
        self.thread = threading.Thread(target=self.loop, name="tushare-collector", daemon=False)
        self.thread.start()

    def close(self):
        self.stopping.set()
        self.wake.set()
        if self.thread:
            self.thread.join()
        if self.lock:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_UN)
            self.lock.close()
            self.lock = None

    def check_stop(self, run_id: str):
        if self.stopping.is_set():
            raise StopRun("interrupted")
        if self.store.stop_requested(run_id):
            raise StopRun("cancelled")
        if self._run_failed.is_set():
            if isinstance(self._run_failure, StopRun):
                raise StopRun(self._run_failure.state)
            raise StopRun("failed")

    def halt_run(self, error):
        with self._state_lock:
            if self._run_failure is None:
                self._run_failure = error
            self._run_failed.set()

    def wait(self, run_id: str, seconds: float):
        end = time.monotonic() + seconds
        while True:
            self.check_stop(run_id)
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            self.stopping.wait(min(0.25, remaining))

    def loop(self):
        while not self.stopping.is_set():
            try:
                with self._state_lock:
                    run = self.store.claim(token_configured=bool(self.token))
                    if run is not None:
                        self.begin_run(run["id"])
                if run is not None:
                    self.execute(run)
                    continue
                if self.idle_callback and not self.stopping.is_set():
                    self.idle_callback()
            except Exception as error:
                LOGGER.error("Collector coordinator error: %s", redact(str(error), self.token))
            self.wake.wait(0.5)
            self.wake.clear()

    def begin_run(self, run_id):
        with self._state_lock:
            if self.active_run_id == run_id:
                return
            self.active_run_id = run_id
            self._effective_threads = self._collection_threads
            self._run_failure = None
            self._run_failed.clear()

    def execute(self, run: dict):
        run_id, token = run["id"], self.token
        self.begin_run(run_id)
        try:
            config = TaskConfig.model_validate(run["config"])
            if not token:
                raise CollectionFailure("未配置 Tushare Token；配置凭证后可以续跑")
            recipe = run.get("dataset_plan", {}).get("recipe", {})
            split_supported = bool(recipe.get("rule")) or recipe.get("kind") in {
                "daily",
                "financial",
                "event",
                "catalog",
            }
            capped = self.execute_parallel(run, config, token, split_supported)
            self.check_stop(run_id)
            if capped:
                message = f"{capped} 个切片触及行数上限，已保留归档并继续其余已确认切片；请检查拆分计划"
                self.store.finish_run(run_id, "failed", message, token=token)
            else:
                self.store.finish_run(run_id, "succeeded", token=token)
        except StopRun as error:
            self.store.finish_run(
                run_id, error.state, "已停止；已归档的成功切片保留，可手动续跑", token=token
            )
        except Exception as error:
            message = redact(str(error), token)
            LOGGER.error("Run %s failed: %s", run_id, message)
            self.store.finish_run(run_id, "failed", message, token=token)
        finally:
            with self._state_lock:
                self.active_run_id = self.current_api_name = None

    def execute_parallel(self, run, config, token, split_supported):
        capped, exhausted = 0, False
        with ThreadPoolExecutor(
            max_workers=self._effective_threads, thread_name_prefix="collector-request"
        ) as pool:
            futures = {}
            while futures or not exhausted:
                if (
                    self.stopping.is_set()
                    or self.store.stop_requested(run["id"])
                    or self._run_failed.is_set()
                ):
                    exhausted = True
                while not exhausted and len(futures) < self._effective_threads:
                    if self._run_failed.is_set() or self.stopping.is_set():
                        exhausted = True
                        break
                    item = self.store.claim_slice(run["id"])
                    if item is None:
                        exhausted = True
                        break
                    future = pool.submit(self.execute_work, run, item, config, token, split_supported)
                    futures[future] = item
                if not futures:
                    break
                done, _ = wait_futures(futures, timeout=0.1, return_when=FIRST_COMPLETED)
                for future in done:
                    item = futures.pop(future)
                    try:
                        future.result()
                    except CollectionFailure as error:
                        if error.kind == "row_limit" and split_supported:
                            capped += 1
                            LOGGER.warning(
                                "Run %s slice %s capped: %s", run["id"], item["id"], redact(str(error), token)
                            )
                        else:
                            self.halt_run(error)
                    except StopRun as error:
                        self.halt_run(error)
                    except Exception as error:
                        self.halt_run(error)
        if self._run_failure is not None:
            raise self._run_failure
        self.check_stop(run["id"])
        return capped

    def execute_work(self, run, item, config, token, split_supported):
        worker_key = threading.get_ident()
        api_name = run["entry"]["api_name"]
        with self._state_lock:
            self._workers[worker_key] = {
                "worker_id": threading.current_thread().name,
                "run_id": run["id"],
                "slice_id": item["id"],
                "ordinal": item["ordinal"],
                "api_name": api_name,
                "phase": "request",
                "effective_requests_per_minute": effective_rpm(
                    config.entry_id, config.requests_per_minute, self.global_rpm
                ),
                "task_rpm": config.requests_per_minute,
                "next_request_at": time.monotonic(),
            }
        client = None
        try:
            self.check_stop(run["id"])

            def before_request():
                current_api = getattr(client, "current_api_name", api_name)
                access = API_ACCESS[current_api]
                if access["account_access"] == "insufficient_points":
                    raise CollectionFailure(
                        f"{current_api} 要求 {access['minimum_points']} 积分，当前声明为8000积分，未发送请求",
                        kind="permission",
                    )
                while True:
                    with self._admission_lock:
                        self.check_stop(run["id"])
                        try:
                            delay = self.store.admit_api_request(
                                current_api, run["id"], config.requests_per_minute, self.global_rpm
                            )
                        except CollectorError as error:
                            raise CollectionFailure(str(error), kind="quota") from None
                        if not delay:
                            self.next_request_at = time.monotonic() + 60 / effective_rpm(
                                access["id"], config.requests_per_minute, self.global_rpm
                            )
                    if not delay:
                        self.worker_phase("request", api_name=current_api)
                        return
                    self.worker_phase("pacing", api_name=current_api, delay=delay)
                    self.wait(run["id"], delay)

            client = self.client_factory(
                token, config.timeout_seconds, config.transport, before_request=before_request
            )
            self.execute_slice(run["id"], item, config, client, token, run["entry"])
        except Exception as error:
            if not (isinstance(error, CollectionFailure) and error.kind == "row_limit" and split_supported):
                self.halt_run(error)
            raise
        finally:
            try:
                if client:
                    client.close()
            except Exception as error:
                self.halt_run(error)
                raise
            finally:
                with self._state_lock:
                    self._workers.pop(worker_key, None)

    def execute_slice(self, run_id: str, item: dict, config: TaskConfig, client, token: str, entry: dict):
        from .datasets import validate_dataset_response

        params = json.loads(item["params_json"])
        dataset = self.store.dataset_context(item["id"])
        limits = [value for value in (entry["row_limit"], config.row_limit) if value is not None]
        row_limit = min(limits) if limits else None
        fields = ",".join(name.strip() for name in config.fields.split(",") if name.strip())
        for attempt_no in range(1, config.max_attempts + 1):
            self.check_stop(run_id)
            attempt_id = self.store.start_attempt(item["id"])
            started_at = now()
            evidence = None
            response = None
            failure = None
            try:
                response = client.request(entry["api_name"], params, fields)
                self.worker_phase("archiving")
                if response_contains_token(response, token):
                    failure = CollectionFailure("响应包含访问凭证，拒绝保存数据")
                evidence = archive(
                    config.raw_root,
                    entry,
                    run_id,
                    item["id"],
                    attempt_id,
                    None if failure else response.body,
                    {
                        "params": params,
                        "fields": fields,
                        "requested_at": started_at,
                        "ingested_at": now(),
                        "http_status": response.status,
                        "catalog_version": entry["catalog_version"],
                        "transport": config.transport,
                        "capture_format": response.capture_format,
                        "sdk_version": response.sdk_version,
                        "wire_response_preserved": response.capture_format == "http_response_bytes",
                        "is_derived": entry["api_name"] == "pro_bar",
                        "catalog_verified_at": entry["catalog_verified_at"],
                        "row_limit_check": row_limit,
                        "allow_empty": config.allow_empty,
                        "error": str(failure) if failure else None,
                    },
                    frame=None if failure else response.frame,
                )
                if failure:
                    raise failure
                rows = validate_response(response, fields, row_limit, config.allow_empty, token)
                if dataset:
                    validate_dataset_response(dataset, response, params)
            except (CollectionFailure, OSError) as error:
                failure = (
                    error
                    if isinstance(error, CollectionFailure)
                    else CollectionFailure(f"Raw 写入失败：{redact(str(error), token)}")
                )
                message = redact(str(failure), token)
                if response is None:
                    self.worker_phase("archiving")
                    try:
                        evidence = archive(
                            config.raw_root,
                            entry,
                            run_id,
                            item["id"],
                            attempt_id,
                            None,
                            {
                                "params": params,
                                "fields": fields,
                                "requested_at": started_at,
                                "ingested_at": now(),
                                "error": message,
                                "catalog_version": entry["catalog_version"],
                                "transport": config.transport,
                                "wire_response_preserved": False,
                                "is_derived": entry["api_name"] == "pro_bar",
                            },
                        )
                    except OSError as archive_error:
                        message += f"；失败证据写入失败：{redact(str(archive_error), token)}"
                        failure = CollectionFailure(message)
                self.store.end_attempt(
                    attempt_id,
                    state="failed",
                    error=message,
                    raw_dir=evidence["raw_dir"] if evidence else None,
                    sha256=evidence["raw_sha256"] if evidence else None,
                )
                if not failure.retryable or attempt_no == config.max_attempts:
                    self.store.finish_slice(
                        item["id"],
                        state="failed",
                        error=message,
                        evidence=evidence,
                        error_kind=failure.kind,
                        token=token,
                    )
                    raise CollectionFailure(message, kind=failure.kind) from None
                self.store.finish_slice(item["id"], state="running", error=message)
                delay = min(60, 2**attempt_no) + random.uniform(0, 1)
                self.store.record_activity(
                    run_id,
                    "slice_retry_scheduled",
                    "warn",
                    f"切片 #{item['ordinal'] + 1} 将在 {delay:.1f} 秒后重试：{message}",
                    slice_id=item["id"],
                    token=token,
                    retry_delay_seconds=delay,
                    error_kind=failure.kind,
                )
                self.worker_phase("retry_wait", delay=delay)
                self.wait(run_id, delay)
                continue
            self.store.end_attempt(
                attempt_id, state="succeeded", raw_dir=evidence["raw_dir"], sha256=evidence["raw_sha256"]
            )
            self.store.finish_slice(item["id"], state="succeeded", evidence=evidence, rows=rows, token=token)
            return
