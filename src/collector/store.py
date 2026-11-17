from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .archive_navigation import BUSINESS_DOMAINS, ENTRY_DOMAINS, domain_entries
from .models import CATALOG, ENTRIES, MAX_SLICES, CollectorError, TaskConfig, plan
from .permissions import API_ACCESS, effective_rpm

ACTIVITY_LIMIT = 10000


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.activity_tokens = lambda: ()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS configs (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS batches (
                    id TEXT PRIMARY KEY, config_ids_json TEXT NOT NULL, total_runs INTEGER NOT NULL,
                    total_slices INTEGER NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, config_id TEXT NOT NULL REFERENCES configs(id),
                    config_json TEXT NOT NULL, entry_json TEXT NOT NULL, state TEXT NOT NULL,
                    total INTEGER NOT NULL, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                    batch_id TEXT REFERENCES batches(id)
                );
                CREATE TABLE IF NOT EXISTS slices (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL,
                    params_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
                    rows INTEGER NOT NULL DEFAULT 0,
                    raw_path TEXT, raw_sha256 TEXT, meta_path TEXT, meta_sha256 TEXT, error TEXT,
                    UNIQUE(run_id, ordinal)
                );
                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY, slice_id TEXT NOT NULL REFERENCES slices(id), state TEXT NOT NULL,
                    started_at TEXT NOT NULL, finished_at TEXT, error TEXT,
                    raw_dir TEXT, response_sha256 TEXT
                );
                CREATE INDEX IF NOT EXISTS slices_run ON slices(run_id, ordinal);
                CREATE INDEX IF NOT EXISTS slices_raw_path ON slices(raw_path);
                CREATE INDEX IF NOT EXISTS slices_meta_path ON slices(meta_path);
                CREATE INDEX IF NOT EXISTS attempts_slice ON attempts(slice_id, started_at);
                CREATE TABLE IF NOT EXISTS exports (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
                    slice_id TEXT REFERENCES slices(id), destination TEXT NOT NULL,
                    manifest_path TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS task_groups (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS group_configs (
                    group_id TEXT NOT NULL REFERENCES task_groups(id) ON DELETE CASCADE,
                    config_id TEXT NOT NULL REFERENCES configs(id), ordinal INTEGER NOT NULL,
                    PRIMARY KEY(group_id,config_id), UNIQUE(group_id,ordinal)
                );
                CREATE TABLE IF NOT EXISTS dataset_settings (
                    dataset_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL,
                    revision INTEGER NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS dataset_plans (
                    id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, settings_revision INTEGER NOT NULL,
                    plan_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
                    run_id TEXT REFERENCES runs(id)
                );
                CREATE TABLE IF NOT EXISTS dataset_runs (
                    run_id TEXT PRIMARY KEY REFERENCES runs(id), dataset_id TEXT NOT NULL,
                    mode TEXT NOT NULL, scope TEXT NOT NULL, recipe_json TEXT NOT NULL,
                    plan_id TEXT NOT NULL REFERENCES dataset_plans(id)
                );
                CREATE INDEX IF NOT EXISTS dataset_runs_scope ON dataset_runs(dataset_id,scope);
                CREATE TABLE IF NOT EXISTS dataset_partitions (
                    slice_id TEXT PRIMARY KEY REFERENCES slices(id), partition_key TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS dataset_splits (
                    dataset_id TEXT NOT NULL, scope TEXT NOT NULL, parent_key TEXT NOT NULL,
                    definition_json TEXT NOT NULL, created_at TEXT NOT NULL,
                    PRIMARY KEY(dataset_id,scope,parent_key)
                );
                CREATE TABLE IF NOT EXISTS dataset_groups (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, dataset_ids_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS dataset_bundles (
                    id TEXT PRIMARY KEY, plan_json TEXT NOT NULL, expires_at TEXT NOT NULL,
                    batch_id TEXT REFERENCES batches(id), created_at TEXT NOT NULL,
                    continuation_id TEXT REFERENCES dataset_bundles(id)
                );
                CREATE TABLE IF NOT EXISTS api_previews (
                    run_id TEXT PRIMARY KEY REFERENCES runs(id),
                    entry_id TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS warehouse_snapshots (
                    id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, source_raw_root TEXT NOT NULL,
                    manifest_path TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
                    rows INTEGER NOT NULL, days INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS warehouse_bundles (
                    id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES warehouse_snapshots(id),
                    destination TEXT NOT NULL, manifest_path TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL, selection_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS archive_deletions (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
                    slice_id TEXT NOT NULL UNIQUE REFERENCES slices(id),
                    raw_root TEXT NOT NULL, files_json TEXT NOT NULL, state TEXT NOT NULL,
                    created_at TEXT NOT NULL, finished_at TEXT, error TEXT
                );
                CREATE TABLE IF NOT EXISTS warehouse_cleanups (
                    deletion_id TEXT PRIMARY KEY REFERENCES archive_deletions(id),
                    dataset_id TEXT NOT NULL, repository_id TEXT NOT NULL,
                    snapshot_id TEXT NOT NULL REFERENCES warehouse_snapshots(id),
                    retention_days INTEGER NOT NULL, fingerprint TEXT NOT NULL,
                    source_key TEXT NOT NULL, source_json TEXT NOT NULL,
                    metadata_json TEXT NOT NULL, slice_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS warehouse_cleanup_confirmation
                    ON warehouse_cleanups(repository_id,fingerprint);
                CREATE TABLE IF NOT EXISTS activity_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL,
                    run_id TEXT NOT NULL REFERENCES runs(id),
                    slice_id TEXT REFERENCES slices(id), payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS activity_run_seq ON activity_events(run_id,seq);
                CREATE INDEX IF NOT EXISTS activity_level_seq ON activity_events(level,seq);
                CREATE TABLE IF NOT EXISTS api_requests (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    api_name TEXT NOT NULL, requested_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS api_requests_time ON api_requests(requested_at);
                CREATE INDEX IF NOT EXISTS api_requests_api_time ON api_requests(api_name,requested_at);
                CREATE TABLE IF NOT EXISTS worker_settings (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    collection_threads INTEGER NOT NULL CHECK(collection_threads BETWEEN 1 AND 16),
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS data_needs (
                    id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
                    revision INTEGER NOT NULL, next_attempt_at TEXT, last_error TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    bindings_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS data_need_jobs (
                    id TEXT PRIMARY KEY, need_id TEXT NOT NULL REFERENCES data_needs(id),
                    need_revision INTEGER NOT NULL, spec_json TEXT NOT NULL, state TEXT NOT NULL,
                    steps_json TEXT NOT NULL, request_limit INTEGER NOT NULL,
                    requests_sent INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, finished_at TEXT, error TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS data_need_active_job ON data_need_jobs(need_id)
                    WHERE state IN ('planning','collecting','publishing');
                CREATE INDEX IF NOT EXISTS data_need_job_history ON data_need_jobs(need_id,created_at DESC);
                CREATE TABLE IF NOT EXISTS data_need_runs (
                    run_id TEXT PRIMARY KEY REFERENCES runs(id),
                    job_id TEXT NOT NULL REFERENCES data_need_jobs(id)
                );
                CREATE INDEX IF NOT EXISTS data_need_job_runs ON data_need_runs(job_id);
                CREATE TABLE IF NOT EXISTS storage_policy (
                    id INTEGER PRIMARY KEY CHECK(id=1), spec_json TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL,
                    bindings_json TEXT NOT NULL, next_attempt_at TEXT, last_error TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS storage_policy_jobs (
                    id TEXT PRIMARY KEY, policy_revision INTEGER NOT NULL,
                    spec_json TEXT NOT NULL, bindings_json TEXT NOT NULL, steps_json TEXT NOT NULL,
                    state TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, error TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS storage_policy_active_job
                    ON storage_policy_jobs((1)) WHERE state='running';
            """)
            if "bindings_json" not in {row["name"] for row in db.execute("PRAGMA table_info(data_needs)")}:
                db.execute("ALTER TABLE data_needs ADD COLUMN bindings_json TEXT NOT NULL DEFAULT '{}'")
            if "batch_id" not in {row["name"] for row in db.execute("PRAGMA table_info(runs)")}:
                db.execute("ALTER TABLE runs ADD COLUMN batch_id TEXT REFERENCES batches(id)")
            if "error_kind" not in {row["name"] for row in db.execute("PRAGMA table_info(slices)")}:
                db.execute("ALTER TABLE slices ADD COLUMN error_kind TEXT")
            if "continuation_id" not in {
                row["name"] for row in db.execute("PRAGMA table_info(dataset_bundles)")
            }:
                db.execute(
                    "ALTER TABLE dataset_bundles ADD COLUMN continuation_id TEXT "
                    "REFERENCES dataset_bundles(id)"
                )
            db.execute("CREATE INDEX IF NOT EXISTS dataset_bundle_parent ON dataset_bundles(continuation_id)")
            if "run_id" not in {row["name"] for row in db.execute("PRAGMA table_info(api_requests)")}:
                db.execute("ALTER TABLE api_requests ADD COLUMN run_id TEXT REFERENCES runs(id)")
            db.execute(
                "CREATE INDEX IF NOT EXISTS api_requests_run_time ON api_requests(run_id,requested_at)"
            )

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=15000")
        try:
            with db:
                yield db
        finally:
            db.close()

    def sanitize_activity(self, value, token=""):
        from .client import redact

        if isinstance(value, str):
            for secret in sorted({token, *self.activity_tokens()}, key=len, reverse=True):
                value = redact(value, secret)
            return value
        if isinstance(value, dict):
            return {
                self.sanitize_activity(key, token): self.sanitize_activity(item, token)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self.sanitize_activity(item, token) for item in value]
        return value

    def _activity_event(self, db, run_id, kind, level, message, *, slice_id=None, token="", **details):
        run = db.execute(
            "SELECT r.config_json,r.entry_json,r.started_at,d.dataset_id "
            "FROM runs r LEFT JOIN dataset_runs d ON d.run_id=r.id WHERE r.id=?",
            (run_id,),
        ).fetchone()
        config, entry = json.loads(run["config_json"]), json.loads(run["entry_json"])
        payload = {
            "task_name": config["name"],
            "api_name": entry["api_name"],
            "dataset_id": run["dataset_id"],
            "ordinal": None,
            "params": {},
            "rows": None,
            "attempt": None,
            "max_attempts": config["max_attempts"],
            "duration_ms": None,
            "raw_sha256": None,
            "error_kind": None,
            "message": message,
        }
        if slice_id:
            item = db.execute("SELECT * FROM slices WHERE id=? AND run_id=?", (slice_id, run_id)).fetchone()
            attempt = db.execute(
                "SELECT * FROM attempts WHERE slice_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1",
                (slice_id,),
            ).fetchone()
            payload.update(
                ordinal=item["ordinal"],
                params=json.loads(item["params_json"]),
                rows=item["rows"],
                raw_sha256=item["raw_sha256"],
                error_kind=item["error_kind"],
                attempt=db.execute(
                    "SELECT COUNT(*) FROM attempts WHERE slice_id=? AND started_at>=?",
                    (slice_id, run["started_at"] or ""),
                ).fetchone()[0],
            )
            if attempt and attempt["finished_at"]:
                payload["duration_ms"] = max(
                    0,
                    int(
                        (
                            datetime.fromisoformat(attempt["finished_at"])
                            - datetime.fromisoformat(attempt["started_at"])
                        ).total_seconds()
                        * 1000
                    ),
                )
        payload.update(details)
        db.execute(
            "INSERT INTO activity_events(timestamp,level,kind,run_id,slice_id,payload_json) "
            "VALUES(?,?,?,?,?,?)",
            (now(), level, kind, run_id, slice_id, encode(self.sanitize_activity(payload, token))),
        )
        db.execute(
            "DELETE FROM activity_events WHERE seq < "
            "(SELECT seq FROM activity_events ORDER BY seq DESC LIMIT 1 OFFSET ?)",
            (ACTIVITY_LIMIT - 1,),
        )

    def record_activity(self, run_id, kind, level, message, **details):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._activity_event(db, run_id, kind, level, message, **details)

    def api_request_delay(self, api_name: str, rpm: int) -> float:
        with self.connect() as db:
            previous = db.execute(
                "SELECT MAX(requested_at) FROM api_requests WHERE api_name=?", (api_name,)
            ).fetchone()[0]
        return max(0, previous + 60 / rpm - time.time()) if previous is not None else 0

    def reserve_api_request(self, api_name: str):
        timestamp = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM api_requests WHERE requested_at<=?", (timestamp - 86400,))
            self.check_request_quota(db, api_name, timestamp)
            db.execute("INSERT INTO api_requests(api_name,requested_at) VALUES(?,?)", (api_name, timestamp))

    @staticmethod
    def check_request_quota(db, api_name, timestamp):
        limit = API_ACCESS[api_name]["daily_limit"]
        if limit:
            used = db.execute(
                "SELECT COUNT(*) FROM api_requests WHERE api_name=? AND requested_at>?",
                (api_name, timestamp - 86400),
            ).fetchone()[0]
            if used >= limit:
                raise CollectorError(
                    f"{api_name} 已达到本地滚动24小时额度 {limit} 次；"
                    "本次不会发送请求，请额度释放后手动续跑。其他程序使用相同Token的请求不在本地计数内。"
                )

    def admit_api_request(self, api_name: str, run_id: str, task_rpm: int, global_rpm: int) -> float:
        access = API_ACCESS[api_name]
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            timestamp = time.time()
            db.execute("DELETE FROM api_requests WHERE requested_at<=?", (timestamp - 86400,))
            self.check_request_quota(db, api_name, timestamp)
            gates = [
                (
                    db.execute("SELECT MAX(requested_at) FROM api_requests").fetchone()[0],
                    global_rpm,
                ),
                (
                    db.execute(
                        "SELECT MAX(requested_at) FROM api_requests WHERE api_name=?", (api_name,)
                    ).fetchone()[0],
                    access["configured_rpm"],
                ),
                (
                    db.execute(
                        "SELECT MAX(requested_at) FROM api_requests WHERE run_id=?", (run_id,)
                    ).fetchone()[0],
                    task_rpm,
                ),
            ]
            delay = max(
                [0.0, *(previous + 60 / rpm - timestamp for previous, rpm in gates if previous is not None)]
            )
            if delay:
                return delay
            managed = db.execute(
                "SELECT j.*,n.revision current_revision FROM data_need_runs x "
                "JOIN data_need_jobs j ON j.id=x.job_id JOIN data_needs n ON n.id=j.need_id "
                "WHERE x.run_id=?", (run_id,),
            ).fetchone()
            if managed:
                if (
                    managed["state"] not in {"planning", "collecting", "publishing"}
                    or managed["need_revision"] != managed["current_revision"]
                ):
                    raise CollectorError("数据需求已暂停或变更，不再发送请求")
                if managed["requests_sent"] >= managed["request_limit"]:
                    raise CollectorError("已达到本次数据需求的请求预算，已停止；请核查后调整需求")
                db.execute(
                    "UPDATE data_need_jobs SET requests_sent=requests_sent+1 WHERE id=?", (managed["id"],),
                )
            db.execute(
                "INSERT INTO api_requests(api_name,requested_at,run_id) VALUES(?,?,?)",
                (api_name, timestamp, run_id),
            )
        return 0.0

    def collection_threads(self) -> int:
        with self.connect() as db:
            row = db.execute("SELECT collection_threads FROM worker_settings WHERE id=1").fetchone()
        return row["collection_threads"] if row else 1

    def save_collection_threads(self, count: int):
        if type(count) is not int or not 1 <= count <= 16:
            raise CollectorError("采集线程数必须为1–16的整数")
        with self.connect() as db:
            db.execute(
                "INSERT INTO worker_settings(id,collection_threads,updated_at) VALUES(1,?,?) "
                "ON CONFLICT(id) DO UPDATE SET collection_threads=excluded.collection_threads,"
                "updated_at=excluded.updated_at",
                (count, now()),
            )

    def activity(self, after_seq=0, limit=100, level=None, run_id=""):
        clauses, values = [], []
        if after_seq:
            clauses.append("seq>?")
            values.append(min(after_seq, 2**63 - 1))
        if level:
            clauses.append("level=?")
            values.append(level)
        if run_id:
            clauses.append("run_id=?")
            values.append(run_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        order = "ASC" if after_seq else "DESC"
        with self.connect() as db:
            db.execute("BEGIN")
            latest = db.execute("SELECT COALESCE(MAX(seq),0) FROM activity_events").fetchone()[0]
            events = db.execute(
                f"SELECT * FROM activity_events{where} ORDER BY seq {order} LIMIT ?", [*values, limit]
            ).fetchall()
            if not after_seq:
                events = list(reversed(events))
            queued = db.execute("SELECT COUNT(*) FROM runs WHERE state='queued'").fetchone()[0]
            runs = db.execute(
                "SELECT r.*,d.dataset_id FROM runs r LEFT JOIN dataset_runs d ON d.run_id=r.id "
                "WHERE r.state='running' ORDER BY r.started_at,r.id"
            ).fetchall()
            active_runs, rates = [], {}
            for run in runs:
                config, entry = json.loads(run["config_json"]), json.loads(run["entry_json"])
                counts = db.execute(
                    "SELECT COALESCE(SUM(state='succeeded'),0) succeeded,"
                    "COALESCE(SUM(state='failed'),0) failed,COALESCE(SUM(state='running'),0) running,"
                    "COALESCE(SUM(state='pending'),0) pending,COALESCE(SUM(rows),0) rows "
                    "FROM slices WHERE run_id=?",
                    (run["id"],),
                ).fetchone()
                current = db.execute(
                    "SELECT s.id slice_id,s.ordinal,s.params_json,a.started_at,"
                    "(SELECT COUNT(*) FROM attempts x WHERE x.slice_id=s.id AND x.started_at>=?) attempt "
                    "FROM slices s JOIN attempts a ON a.slice_id=s.id "
                    "WHERE s.run_id=? AND s.state='running' AND a.state='running' "
                    "ORDER BY s.ordinal,a.started_at DESC,a.rowid DESC",
                    (run["started_at"] or "", run["id"]),
                ).fetchall()
                active = {
                    "id": run["id"],
                    "name": config["name"],
                    "api_name": entry["api_name"],
                    "dataset_id": run["dataset_id"],
                    "state": run["state"],
                    "cancel_requested": bool(run["cancel_requested"]),
                    "total": run["total"],
                    **dict(counts),
                    "started_at": run["started_at"],
                    "current_slice": None,
                    "current_slices": [],
                }
                for item in current:
                    active["current_slices"].append(
                        {key: item[key] for key in ("slice_id", "ordinal", "attempt", "started_at")}
                        | {"params": json.loads(item["params_json"]), "max_attempts": config["max_attempts"]}
                    )
                if active["current_slices"]:
                    active["current_slice"] = active["current_slices"][0]
                active = self.sanitize_activity(active)
                active_runs.append(active)
                rates[run["id"]] = config["requests_per_minute"]
        return {
            "events": [
                {key: event[key] for key in ("seq", "timestamp", "level", "kind", "run_id", "slice_id")}
                | json.loads(event["payload_json"])
                for event in events
            ],
            "latest_seq": latest,
            "active_run": active_runs[0] if active_runs else None,
            "active_runs": active_runs,
            "queued_runs": queued,
            "requests_per_minute": rates[active_runs[0]["id"]] if active_runs else None,
        }

    def configurations(self):
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM configs c WHERE NOT EXISTS "
                "(SELECT 1 FROM runs r JOIN dataset_runs d ON d.run_id=r.id WHERE r.config_id=c.id) "
                "AND NOT EXISTS "
                "(SELECT 1 FROM runs r JOIN api_previews p ON p.run_id=r.id WHERE r.config_id=c.id) "
                "ORDER BY created_at DESC"
            ).fetchall()
        return [self.decode_config(row) for row in rows]

    @staticmethod
    def decode_config(row):
        return {
            "id": row["id"],
            "revision": row["revision"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "config": json.loads(row["config_json"]),
        }

    def save_config(self, config: TaskConfig, config_id: str | None = None, revision: int | None = None):
        plan(config)
        timestamp = now()
        with self.connect() as db:
            if config_id is None:
                config_id = uuid.uuid4().hex
                db.execute(
                    "INSERT INTO configs(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                    (config_id, config.name, encode(config.model_dump()), timestamp, timestamp),
                )
            else:
                self.check_unmanaged_config(db, config_id)
                updated = db.execute(
                    "UPDATE configs SET name=?, config_json=?, revision=revision+1, updated_at=? "
                    "WHERE id=? AND revision=?",
                    (config.name, encode(config.model_dump()), timestamp, config_id, revision),
                )
                if updated.rowcount != 1:
                    raise CollectorError("配置不存在或已被修改，请刷新后重试")
            row = db.execute("SELECT * FROM configs WHERE id=?", (config_id,)).fetchone()
        return self.decode_config(row)

    @staticmethod
    def check_unmanaged_config(db, config_id):
        if db.execute(
            "SELECT 1 FROM api_previews p JOIN runs r ON r.id=p.run_id WHERE r.config_id=?", (config_id,)
        ).fetchone():
            raise CollectorError("此配置用于单次数据预览，请从首页重新查询，不可直接编辑或启动")
        if db.execute(
            "SELECT 1 FROM dataset_runs d JOIN runs r ON r.id=d.run_id WHERE r.config_id=?",
            (config_id,),
        ).fetchone():
            raise CollectorError("此配置由预置数据集管理，请从数据集生成新计划，不可直接编辑或启动")

    def create_run(self, config_id: str, expected_revision: int | None = None):
        revisions = {config_id: expected_revision} if expected_revision is not None else None
        _, run_ids = self._enqueue([config_id], batch=False, expected_revisions=revisions)
        return self.run(run_ids[0])

    def create_batch(self, config_ids: list[str], expected_revisions: dict[str, int] | None = None):
        batch_id, _ = self._enqueue(config_ids, batch=True, expected_revisions=expected_revisions)
        return self.batch(batch_id)

    @staticmethod
    def validate_selection(config_ids: list[str]):
        if not 1 <= len(config_ids) <= 102 or len(set(config_ids)) != len(config_ids):
            raise CollectorError("请选择 1–102 个不重复的任务配置")

    def prepare(self, db, config_ids, expected_revisions=None):
        self.validate_selection(config_ids)
        if expected_revisions is not None and set(expected_revisions) != set(config_ids):
            raise CollectorError("确认版本与选中任务不一致，请重新预览")
        prepared = []
        for config_id in config_ids:
            self.check_unmanaged_config(db, config_id)
            row = db.execute("SELECT * FROM configs WHERE id=?", (config_id,)).fetchone()
            if row is None:
                raise CollectorError("配置不存在，批量提交未创建任何运行")
            if expected_revisions is not None and row["revision"] != expected_revisions[config_id]:
                raise CollectorError(f"配置「{row['name']}」已修改，请重新预览并确认")
            if db.execute(
                "SELECT id FROM runs WHERE config_id=? AND state IN ('queued','running')", (config_id,)
            ).fetchone():
                raise CollectorError(f"配置「{row['name']}」已有排队或执行中的运行")
            config = TaskConfig.model_validate_json(row["config_json"])
            slices = plan(config)
            entry = {
                **ENTRIES[config.entry_id],
                "catalog_version": CATALOG["version"],
                "catalog_verified_at": CATALOG["verified_at"],
            }
            prepared.append((row, slices, entry))
        if sum(len(slices) for _, slices, _ in prepared) > MAX_SLICES:
            raise CollectorError(f"一次批量提交最多 {MAX_SLICES} 个请求切片，请缩小范围")
        return prepared

    def batch_plan(self, config_ids: list[str], global_rpm: int):
        with self.connect() as db:
            db.execute("BEGIN")
            prepared = self.prepare(db, config_ids)
        tasks = []
        for row, slices, entry in prepared:
            config = json.loads(row["config_json"])
            tasks.append(
                {
                    "id": row["id"],
                    "revision": row["revision"],
                    "config": config,
                    "api_name": entry["api_name"],
                    "total_slices": len(slices),
                    "samples": slices[:3],
                    "effective_rpm": effective_rpm(
                        config["entry_id"], config["requests_per_minute"], global_rpm
                    ),
                    "access": entry["access"],
                }
            )
        return {
            "tasks": tasks,
            "total_runs": len(tasks),
            "total_slices": sum(task["total_slices"] for task in tasks),
            "expected_revisions": {task["id"]: task["revision"] for task in tasks},
            "estimated_seconds": None
            if any(entry["status"] == "sdk_only" for _, _, entry in prepared)
            else sum(task["total_slices"] * 60 / task["effective_rpm"] for task in tasks),
            "estimate_note": "仅按限流频率估算，不含现有排队、网络耗时和重试；SDK 计算入口的内部请求数量未知",
        }

    def groups(self):
        with self.connect() as db:
            groups = db.execute("SELECT * FROM task_groups ORDER BY created_at DESC").fetchall()
            return [
                {
                    **dict(group),
                    "config_ids": [
                        row["config_id"]
                        for row in db.execute(
                            "SELECT config_id FROM group_configs WHERE group_id=? ORDER BY ordinal",
                            (group["id"],),
                        )
                    ],
                }
                for group in groups
            ]

    def save_group(self, name: str, config_ids: list[str]):
        self.validate_selection(config_ids)
        name = name.strip()
        if not 1 <= len(name) <= 100:
            raise CollectorError("任务组名称须为 1–100 个字符")
        group_id = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM task_groups WHERE name=?", (name,)).fetchone():
                raise CollectorError("已有同名任务组，请使用其他名称")
            if any(
                db.execute("SELECT 1 FROM configs WHERE id=?", (item,)).fetchone() is None
                for item in config_ids
            ):
                raise CollectorError("任务配置不存在，任务组未保存")
            db.execute("INSERT INTO task_groups VALUES(?,?,?)", (group_id, name, now()))
            db.executemany(
                "INSERT INTO group_configs VALUES(?,?,?)",
                [(group_id, config_id, index) for index, config_id in enumerate(config_ids)],
            )
        return {"id": group_id, "name": name, "config_ids": config_ids}

    def delete_group(self, group_id: str):
        with self.connect() as db:
            if db.execute("DELETE FROM task_groups WHERE id=?", (group_id,)).rowcount != 1:
                raise CollectorError("任务组不存在")

    def _enqueue(self, config_ids: list[str], *, batch: bool, expected_revisions=None):
        run_ids = []
        batch_id = uuid.uuid4().hex if batch else None
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            prepared = self.prepare(db, config_ids, expected_revisions)
            total = sum(len(slices) for _, slices, _ in prepared)
            if batch:
                db.execute(
                    "INSERT INTO batches VALUES(?,?,?,?,?)",
                    (batch_id, encode(config_ids), len(prepared), total, now()),
                )
            for row, slices, entry in prepared:
                run_id = self._insert_run(db, row, slices, entry, batch_id)
                run_ids.append(run_id)
        return batch_id, run_ids

    def _insert_run(self, db, config, slices, entry, batch_id=None):
        run_id = uuid.uuid4().hex
        db.execute(
            "INSERT INTO runs(id,config_id,config_json,entry_json,state,total,created_at,batch_id) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (
                run_id,
                config["id"],
                config["config_json"],
                encode(entry),
                "queued",
                len(slices),
                now(),
                batch_id,
            ),
        )
        db.executemany(
            "INSERT INTO slices(id,run_id,ordinal,params_json) VALUES(?,?,?,?)",
            [(uuid.uuid4().hex, run_id, index, encode(params)) for index, params in enumerate(slices)],
        )
        self._activity_event(db, run_id, "run_queued", "info", "运行已入队")
        return run_id

    def create_preview(self, config: TaskConfig):
        if config.mode != "single" or config.split_param or config.max_attempts != 1:
            raise CollectorError("数据预览只允许单次请求，不可切片或自动重试")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute(
                "SELECT 1 FROM api_previews p JOIN runs r ON r.id=p.run_id "
                "WHERE r.state IN ('queued','running')"
            ).fetchone():
                raise CollectorError("已有数据预览排队或执行中，请等待完成后重新查询")
            config_id, timestamp = uuid.uuid4().hex, now()
            db.execute(
                "INSERT INTO configs(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                (config_id, config.name, encode(config.model_dump()), timestamp, timestamp),
            )
            row, slices, entry = self.prepare(db, [config_id])[0]
            if len(slices) != 1 or entry["status"] == "sdk_only":
                raise CollectorError("数据预览仅支持一次直接股票接口查询，不支持 SDK 派生接口")
            run_id = self._insert_run(db, row, slices, entry)
            db.execute("INSERT INTO api_previews VALUES(?,?)", (run_id, config.entry_id))
        return self.run(run_id, detail=True)

    def batch(self, batch_id: str):
        with self.connect() as db:
            row = db.execute("SELECT * FROM batches WHERE id=?", (batch_id,)).fetchone()
            if row is None:
                raise CollectorError("批次不存在")
            runs = db.execute(
                "SELECT id,state,config_json FROM runs WHERE batch_id=? ORDER BY created_at,id", (batch_id,)
            ).fetchall()
        counts = {}
        for run in runs:
            counts[run["state"]] = counts.get(run["state"], 0) + 1
        if counts.get("running"):
            state = "running"
        elif counts.get("queued"):
            state = "queued"
        elif counts.get("succeeded") == len(runs):
            state = "succeeded"
        elif counts.get("succeeded"):
            state = "partial"
        elif counts.get("cancelled") == len(runs):
            state = "cancelled"
        else:
            state = "failed"
        return {
            **dict(row),
            "state": state,
            "counts": counts,
            "runs": [
                {"id": run["id"], "state": run["state"], "name": json.loads(run["config_json"])["name"]}
                for run in runs
            ],
        }

    def batches(self):
        with self.connect() as db:
            ids = [
                row["id"] for row in db.execute("SELECT id FROM batches ORDER BY created_at DESC LIMIT 20")
            ]
        return [self.batch(batch_id) for batch_id in ids]

    def archived_slice(self, run_id: str, slice_id: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT s.*,r.config_json,"
                "EXISTS(SELECT 1 FROM api_previews p WHERE p.run_id=r.id) AS is_preview,"
                "EXISTS(SELECT 1 FROM archive_deletions x JOIN warehouse_cleanups w "
                "ON w.deletion_id=x.id WHERE x.slice_id=s.id) AS warehouse_cleaned,"
                "EXISTS(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id) AS archive_deleted "
                "FROM slices s JOIN runs r ON r.id=s.run_id "
                "WHERE s.run_id=? AND s.id=?",
                (run_id, slice_id),
            ).fetchone()
        if row is None:
            raise CollectorError("运行切片不存在")
        if row["warehouse_cleaned"]:
            raise CollectorError("此 Raw 已安全入库并确认清理；请从仓库读取，已采集覆盖保留")
        if row["archive_deleted"]:
            raise CollectorError("此归档已删除或正在清理；采集历史保留，需重新检查采集计划获取数据")
        if not row["raw_path"] or not row["meta_path"]:
            raise CollectorError("此切片尚无已登记的数据文件")
        return {**dict(row), "config": json.loads(row["config_json"])}

    def local_data(
        self, *, category="", entry_id="", raw_root="", query="", state=None,
        business_domain="", source_type=None, offset=0, limit=50,
    ):
        if offset < 0 or not 1 <= limit <= 200 or len(query) > 200:
            raise CollectorError("本地数据分页范围不正确，每页最多 200 条，查询最多 200 字符")
        if state is not None and state not in {"succeeded", "failed", "pending", "running"}:
            raise CollectorError("归档切片状态不正确")
        identifiers = domain_entries(business_domain)
        if source_type is not None and source_type not in {"dataset", "preview", "task"}:
            raise CollectorError("本地归档来源不正确")
        base = " FROM slices s JOIN runs r ON r.id=s.run_id LEFT JOIN dataset_runs d ON d.run_id=r.id "
        source = (
            "CASE WHEN EXISTS(SELECT 1 FROM api_previews p WHERE p.run_id=r.id) THEN 'preview' "
            "WHEN d.dataset_id IS NOT NULL THEN 'dataset' ELSE 'task' END"
        )
        archive = (
            "s.raw_path IS NOT NULL AND s.meta_path IS NOT NULL AND NOT EXISTS "
            "(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id)"
        )
        clauses, values = [archive], []
        if business_domain:
            clauses.append(
                "json_extract(r.entry_json,'$.id') IN (" + ",".join("?" for _ in identifiers) + ")"
            )
            values.extend(identifiers)
        if source_type:
            clauses.append(f"({source})=?")
            values.append(source_type)
        for expression, value in (
            ("json_extract(r.entry_json,'$.category')", category),
            ("json_extract(r.entry_json,'$.id')", entry_id),
            ("json_extract(r.config_json,'$.raw_root')", raw_root),
            ("s.state", state),
        ):
            if value:
                clauses.append(f"{expression}=?")
                values.append(value)
        for token in query.split():
            clauses.append(
                "instr(lower(r.config_json || ' ' || r.entry_json || ' ' || s.params_json "
                "|| ' ' || r.id || ' ' || s.id),lower(?))>0"
            )
            values.append(token)
        where = " AND ".join(clauses)
        with self.connect() as db:
            db.execute("BEGIN")
            cleanup = db.execute(
                "SELECT x.id,x.run_id,x.slice_id,x.state,x.created_at,x.error,"
                "CASE WHEN w.deletion_id IS NULL THEN 'manual' ELSE 'warehoused' END AS reason,"
                "w.dataset_id,w.snapshot_id,w.fingerprint,w.retention_days "
                "FROM archive_deletions x LEFT JOIN warehouse_cleanups w ON w.deletion_id=x.id "
                "WHERE x.state!='deleted' ORDER BY x.created_at LIMIT 50"
            ).fetchall()
            cleanup_count = db.execute(
                "SELECT COUNT(*) FROM archive_deletions WHERE state!='deleted'"
            ).fetchone()[0]
            catalog = db.execute(
                "SELECT json_extract(r.entry_json,'$.id') entry_id,"
                "json_extract(r.entry_json,'$.name') name,json_extract(r.entry_json,'$.api_name') api_name,"
                "json_extract(r.entry_json,'$.category') category,"
                "json_extract(r.entry_json,'$.category_name') category_name,COUNT(*) archives"
                + base
                + f"WHERE {archive} GROUP BY entry_id ORDER BY category,name"
            ).fetchall()
            roots = db.execute(
                "SELECT DISTINCT json_extract(r.config_json,'$.raw_root') raw_root"
                + base
                + f"WHERE {archive} ORDER BY raw_root"
            ).fetchall()
            totals = db.execute(
                "SELECT COUNT(*) archives,COUNT(DISTINCT r.id) runs,"
                "COALESCE(SUM(CASE WHEN s.state='succeeded' THEN s.rows ELSE 0 END),0) successful_rows"
                + base
                + f"WHERE {where}",
                values,
            ).fetchone()
            rows = db.execute(
                "SELECT s.id slice_id,s.run_id,s.ordinal,s.state,s.rows,s.error,s.raw_path,"
                "s.params_json,r.created_at,r.finished_at,"
                "json_extract(r.config_json,'$.name') task_name,"
                "json_extract(r.config_json,'$.raw_root') raw_root,r.entry_json,d.dataset_id,"
                "EXISTS(SELECT 1 FROM api_previews p WHERE p.run_id=r.id) is_preview,"
                + source + " source_type"
                + base
                + f"WHERE {where} ORDER BY r.created_at DESC,r.id DESC,s.ordinal LIMIT ? OFFSET ?",
                [*values, limit, offset],
            ).fetchall()
        items = []
        for row in rows:
            item = dict(row)
            entry = json.loads(item.pop("entry_json"))
            item.update(
                entry_id=entry["id"],
                name=entry["name"],
                api_name=entry["api_name"],
                category=entry["category"],
                category_name=entry["category_name"],
                params=json.loads(item.pop("params_json")),
                is_preview=bool(item["is_preview"]),
                **ENTRY_DOMAINS[entry["id"]],
            )
            items.append(item)
        return {
            "items": items,
            "pending_deletions": [dict(row) for row in cleanup],
            "pending_deletion_count": cleanup_count,
            "catalog": [dict(row) for row in catalog],
            "raw_roots": [row["raw_root"] for row in roots],
            **dict(totals),
            "offset": offset,
            "limit": limit,
            "next_offset": offset + len(items) if offset + len(items) < totals["archives"] else None,
        }

    def local_data_navigation(
        self, *, raw_root="", query="", business_domain="", include_empty=False,
    ):
        selected = set(domain_entries(business_domain))
        if len(query) > 200:
            raise CollectorError("本地数据查询最多 200 字符")
        archive = (
            "s.raw_path IS NOT NULL AND s.meta_path IS NOT NULL AND NOT EXISTS "
            "(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id)"
        )
        base = " FROM slices s JOIN runs r ON r.id=s.run_id WHERE " + archive
        with self.connect() as db:
            db.execute("BEGIN")
            roots = db.execute(
                "SELECT DISTINCT json_extract(r.config_json,'$.raw_root') raw_root"
                + base + " ORDER BY raw_root"
            ).fetchall()
            rows = db.execute(
                "SELECT json_extract(r.entry_json,'$.id') entry_id,COUNT(*) archives,"
                "SUM(s.state='succeeded') successful_archives,SUM(s.state='failed') failed_archives,"
                "SUM(s.state NOT IN ('succeeded','failed')) other_archives,"
                "SUM(CASE WHEN s.state='succeeded' THEN s.rows ELSE 0 END) successful_rows,"
                "MAX(r.finished_at) last_collected_at"
                + base
                + (" AND json_extract(r.config_json,'$.raw_root')=?" if raw_root else "")
                + " GROUP BY entry_id",
                (raw_root,) if raw_root else (),
            ).fetchall()
        counts = {row["entry_id"]: dict(row) for row in rows}
        metrics = (
            "archives", "successful_archives", "failed_archives", "other_archives", "successful_rows",
        )
        entries = []
        tokens = query.casefold().split()
        for entry in ENTRIES.values():
            text = " ".join(
                str(entry[key]) for key in ("id", "api_name", "name", "category_name")
            ).casefold()
            if not all(token in text for token in tokens):
                continue
            count = counts.get(entry["id"], {})
            entries.append({
                "entry_id": entry["id"],
                **{key: entry[key] for key in ("api_name", "name", "category", "category_name")},
                "doc_url": entry["doc_url"],
                **ENTRY_DOMAINS[entry["id"]],
                **{key: count.get(key, 0) or 0 for key in metrics},
                "last_collected_at": count.get("last_collected_at"),
                "has_data": bool(count.get("archives")),
            })

        def summary(items):
            return {
                **{key: sum(item[key] for item in items) for key in metrics},
                "defined_entries": len(items),
                "local_entries": sum(item["has_data"] for item in items),
            }

        domains = [
            {**domain, **summary([
                item for item in entries if item["business_domain"] == domain["id"]
            ])}
            for domain in BUSINESS_DOMAINS
        ]
        entries = [item for item in entries if item["entry_id"] in selected]
        return {
            "classification_version": 1,
            "summary_basis": "registered_archives",
            "hash_verified": False,
            "coverage_verified": False,
            "domains": domains,
            "entries": [item for item in entries if include_empty or item["has_data"]],
            "raw_roots": [row["raw_root"] for row in roots],
            **summary(entries),
        }

    def archived_slices(self, run_id: str):
        run = self.run(run_id)
        if run["state"] in ("queued", "running"):
            raise CollectorError("整次运行导出需要等待运行结束；执行中可导出已完成的单个切片")
        with self.connect() as db:
            ids = [
                row["id"]
                for row in db.execute(
                    "SELECT id FROM slices s WHERE run_id=? AND state='succeeded' AND NOT EXISTS "
                    "(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id) ORDER BY ordinal",
                    (run_id,),
                )
            ]
        return run, [self.archived_slice(run_id, slice_id) for slice_id in ids]

    def register_export(self, export_id, run_id, slice_id, destination, manifest_path, manifest_sha256):
        with self.connect() as db:
            db.execute(
                "INSERT INTO exports VALUES(?,?,?,?,?,?,?)",
                (export_id, run_id, slice_id, destination, manifest_path, manifest_sha256, now()),
            )

    def last_export_root(self):
        with self.connect() as db:
            row = db.execute("SELECT destination FROM exports ORDER BY created_at DESC LIMIT 1").fetchone()
        return row["destination"] if row else None

    def recover(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            interrupted = db.execute("SELECT id FROM runs WHERE state='running'").fetchall()
            db.execute(
                "UPDATE runs SET state='interrupted',error='服务重启，需手动续跑',finished_at=? "
                "WHERE state='running'",
                (now(),),
            )
            for run in interrupted:
                self._activity_event(db, run["id"], "run_interrupted", "warn", "服务重启，需手动续跑")
            db.execute("UPDATE slices SET state='pending' WHERE state='running'")
            db.execute(
                "UPDATE attempts SET state='interrupted',error='服务中断',finished_at=? "
                "WHERE state='running'",
                (now(),),
            )

    def claim(self, *, token_configured=True):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT id FROM runs WHERE state='queued' "
                "AND (? OR NOT EXISTS (SELECT 1 FROM data_need_runs x WHERE x.run_id=runs.id)) "
                "ORDER BY created_at LIMIT 1", (token_configured,),
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE runs SET state='running',started_at=?,finished_at=NULL WHERE id=?",
                (now(), row["id"]),
            )
            self._activity_event(db, row["id"], "run_started", "info", "运行开始执行")
        return self.run(row["id"])

    def runs(self):
        with self.connect() as db:
            rows = db.execute("""
                SELECT r.*, d.dataset_id, d.mode AS dataset_mode,
                    (SELECT COUNT(*) FROM archive_deletions x WHERE x.run_id=r.id) AS deleted_archives,
                    EXISTS(SELECT 1 FROM api_previews p WHERE p.run_id=r.id) AS is_preview,
                    COALESCE(SUM(s.state='succeeded'),0) AS completed,
                    COALESCE(SUM(s.rows),0) AS rows, COALESCE(SUM(s.state='failed'),0) AS failed,
                    COALESCE(SUM(s.state='failed' AND s.error_kind='row_limit'),0) AS row_limit_failures
                FROM runs r LEFT JOIN slices s ON s.run_id=r.id
                LEFT JOIN dataset_runs d ON d.run_id=r.id
                GROUP BY r.id ORDER BY r.created_at DESC LIMIT 100
            """).fetchall()
        return [{**dict(row), "config": json.loads(row["config_json"])} for row in rows]

    def run(self, run_id: str, detail: bool = False):
        with self.connect() as db:
            row = db.execute(
                "SELECT r.*,d.dataset_id,d.mode AS dataset_mode,d.plan_id AS dataset_plan_id,"
                "(SELECT COUNT(*) FROM archive_deletions x WHERE x.run_id=r.id) AS deleted_archives,"
                "EXISTS(SELECT 1 FROM api_previews p WHERE p.run_id=r.id) AS is_preview "
                "FROM runs r LEFT JOIN dataset_runs d ON d.run_id=r.id WHERE r.id=?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise CollectorError("运行不存在")
            counts = db.execute(
                "SELECT SUM(state='succeeded') completed,SUM(rows) rows,SUM(state='failed') failed,"
                "SUM(state='pending') pending,SUM(state='running') running,"
                "SUM(state='failed' AND error_kind='row_limit') row_limit_failures,"
                "SUM(CASE WHEN state='succeeded' THEN rows ELSE 0 END) successful_rows "
                "FROM slices WHERE run_id=?",
                (run_id,),
            ).fetchone()
            result = {
                **dict(row),
                **dict(counts),
                "config": json.loads(row["config_json"]),
                "entry": json.loads(row["entry_json"]),
            }
            if row["dataset_plan_id"]:
                frozen = json.loads(
                    db.execute(
                        "SELECT plan_json FROM dataset_plans WHERE id=?", (row["dataset_plan_id"],)
                    ).fetchone()["plan_json"]
                )
                result["dataset_plan"] = {
                    key: frozen[key]
                    for key in (
                        "recipe",
                        "mode",
                        "settings",
                        "start_date",
                        "end_date",
                        "counts",
                        "total_slices",
                        "warnings",
                    )
                }
            if detail:
                slices = db.execute(
                    "SELECT s.*,EXISTS(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id) "
                    "archive_deleted,EXISTS(SELECT 1 FROM archive_deletions x JOIN warehouse_cleanups w "
                    "ON w.deletion_id=x.id WHERE x.slice_id=s.id) AS warehouse_cleaned "
                    "FROM slices s WHERE run_id=? ORDER BY ordinal LIMIT 500",
                    (run_id,),
                ).fetchall()
                result["slices"] = [
                    {**dict(item), "params": json.loads(item["params_json"])} for item in slices
                ]
                result["slices_truncated"] = row["total"] > 500
                result["attempts"] = [
                    dict(item)
                    for item in db.execute(
                        "SELECT a.* FROM attempts a JOIN slices s ON a.slice_id=s.id "
                        "WHERE s.run_id=? ORDER BY a.started_at DESC LIMIT 100",
                        (run_id,),
                    )
                ]
        return result

    def dataset_context(self, slice_id: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT d.recipe_json FROM dataset_runs d JOIN slices s ON s.run_id=d.run_id WHERE s.id=?",
                (slice_id,),
            ).fetchone()
        return json.loads(row["recipe_json"]) if row else None

    def slice_page(
        self,
        run_id: str,
        offset: int = 0,
        limit: int = 50,
        query: str = "",
        state: str | None = None,
        number: int | None = None,
    ):
        if not 0 <= offset <= MAX_SLICES or not 1 <= limit <= 200 or len(query) > 200:
            raise CollectorError("切片分页范围不正确，每页最多 200 条，查询最多 200 字符")
        if state is not None and state not in {"pending", "running", "succeeded", "failed"}:
            raise CollectorError("切片状态不正确")
        if number is not None and not 1 <= number <= MAX_SLICES:
            raise CollectorError(f"切片序号必须在 1–{MAX_SLICES} 之间")
        clauses, values = ["run_id=?"], [run_id]
        for token in query.split():
            escaped = token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append("params_json LIKE ? ESCAPE '\\'")
            values.append(f"%{escaped}%")
        if state is not None:
            clauses.append("state=?")
            values.append(state)
        if number is not None:
            clauses.append("ordinal=?")
            values.append(number - 1)
        where = " AND ".join(clauses)
        with self.connect() as db:
            db.execute("BEGIN")
            run = db.execute("SELECT total FROM runs WHERE id=?", (run_id,)).fetchone()
            if run is None:
                raise CollectorError("运行不存在")
            total = db.execute(f"SELECT COUNT(*) FROM slices WHERE {where}", values).fetchone()[0]
            rows = db.execute(
                "SELECT s.*,EXISTS(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id) "
                "archive_deleted,EXISTS(SELECT 1 FROM archive_deletions x JOIN warehouse_cleanups w "
                "ON w.deletion_id=x.id WHERE x.slice_id=s.id) AS warehouse_cleaned "
                f"FROM slices s WHERE {where} ORDER BY ordinal LIMIT ? OFFSET ?",
                [*values, limit, offset],
            ).fetchall()
        return {
            "run_id": run_id,
            "total": total,
            "run_total": run["total"],
            "offset": offset,
            "limit": limit,
            "next_offset": offset + len(rows) if offset + len(rows) < total else None,
            "items": [{**dict(row), "params": json.loads(row["params_json"])} for row in rows],
        }

    def pending(self, run_id: str):
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM slices WHERE run_id=? AND state='pending' ORDER BY ordinal LIMIT 1", (run_id,)
            ).fetchone()
        return dict(row) if row else None

    def claim_slice(self, run_id: str):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT s.* FROM slices s JOIN runs r ON r.id=s.run_id "
                "WHERE s.run_id=? AND s.state='pending' AND r.state='running' AND r.cancel_requested=0 "
                "ORDER BY s.ordinal LIMIT 1",
                (run_id,),
            ).fetchone()
            if row is None:
                return None
            db.execute("UPDATE slices SET state='running' WHERE id=?", (row["id"],))
        return dict(row)

    def stop_requested(self, run_id: str):
        with self.connect() as db:
            return bool(db.execute("SELECT cancel_requested FROM runs WHERE id=?", (run_id,)).fetchone()[0])

    def cancel(self, run_id: str):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT state FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None or row["state"] not in ("queued", "running"):
                raise CollectorError("只能取消排队或执行中的运行")
            db.execute("UPDATE runs SET cancel_requested=1 WHERE id=?", (run_id,))
            self._activity_event(db, run_id, "run_cancel_requested", "warn", "已请求取消运行")
            if row["state"] == "queued":
                db.execute("UPDATE runs SET state='cancelled',finished_at=? WHERE id=?", (now(), run_id))
                self._activity_event(db, run_id, "run_cancelled", "warn", "排队中的运行已取消")

    def resume(self, run_id: str):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None or row["state"] not in ("failed", "cancelled", "interrupted"):
                raise CollectorError("只能续跑失败、取消或中断的运行")
            managed = db.execute(
                "SELECT j.state FROM data_need_runs x JOIN data_need_jobs j ON j.id=x.job_id "
                "WHERE x.run_id=?", (run_id,),
            ).fetchone()
            if managed and managed["state"] not in {"planning", "collecting", "publishing"}:
                raise CollectorError("此运行由数据需求管理，请在“我的数据”中核查后重新同步")
            if db.execute("SELECT 1 FROM archive_deletions WHERE run_id=?", (run_id,)).fetchone():
                raise CollectorError("此运行含已删除归档，不能按原运行续跑；请重新检查采集计划")
            dataset = db.execute("SELECT dataset_id FROM dataset_runs WHERE run_id=?", (run_id,)).fetchone()
            if dataset and dataset["dataset_id"] == "trade_cal":
                from .datasets import MARKET_CALENDAR_EXCHANGE

                if db.execute(
                    "SELECT 1 FROM slices WHERE run_id=? AND state!='succeeded' "
                    "AND json_extract(params_json,'$.exchange')!=?",
                    (run_id, MARKET_CALENDAR_EXCHANGE),
                ).fetchone():
                    raise CollectorError(
                        "此旧日历运行包含非 SSE 基准的未完成切片；请重新检查交易日历更新计划，"
                        "复用已有 SSE 成功归档，不要按旧双所规则续跑"
                    )
            if (
                dataset
                and db.execute(
                    "SELECT 1 FROM dataset_runs d JOIN runs r ON r.id=d.run_id "
                    "WHERE d.dataset_id=? AND r.state IN ('queued','running')",
                    (dataset["dataset_id"],),
                ).fetchone()
            ):
                raise CollectorError("此数据集已有活动运行，请等待结束后续跑或补采")
            if db.execute(
                "SELECT 1 FROM runs WHERE config_id=? AND state IN ('queued','running')", (row["config_id"],)
            ).fetchone():
                raise CollectorError("同配置已有活动运行")
            for item in db.execute("SELECT * FROM slices WHERE run_id=? AND state='succeeded'", (run_id,)):
                for path_key, hash_key in (("raw_path", "raw_sha256"), ("meta_path", "meta_sha256")):
                    path = Path(item[path_key])
                    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item[hash_key]:
                        raise CollectorError(f"已完成切片的 Raw 证据缺失或损坏：{item['ordinal']}")
            db.execute(
                "UPDATE slices SET state='pending',error=NULL,error_kind=NULL "
                "WHERE run_id=? AND state!='succeeded'",
                (run_id,),
            )
            db.execute(
                "UPDATE runs SET state='queued',error=NULL,cancel_requested=0,finished_at=NULL WHERE id=?",
                (run_id,),
            )
            self._activity_event(db, run_id, "run_resumed", "info", "运行已重新入队，将保留成功切片")

    def start_attempt(self, slice_id: str):
        attempt_id = uuid.uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE slices SET state='running',error=NULL,error_kind=NULL WHERE id=?", (slice_id,))
            db.execute(
                "INSERT INTO attempts(id,slice_id,state,started_at) VALUES(?,?,?,?)",
                (attempt_id, slice_id, "running", now()),
            )
            item = db.execute("SELECT run_id,ordinal FROM slices WHERE id=?", (slice_id,)).fetchone()
            self._activity_event(
                db,
                item["run_id"],
                "slice_started",
                "info",
                f"切片 #{item['ordinal'] + 1} 开始请求",
                slice_id=slice_id,
            )
        return attempt_id

    def end_attempt(self, attempt_id: str, *, state: str, error=None, raw_dir=None, sha256=None):
        with self.connect() as db:
            db.execute(
                "UPDATE attempts SET state=?,finished_at=?,error=?,raw_dir=?,response_sha256=? WHERE id=?",
                (state, now(), error, raw_dir, sha256, attempt_id),
            )

    def finish_slice(
        self, slice_id: str, *, state: str, error=None, evidence=None, rows=0, error_kind=None, token=""
    ):
        evidence = evidence or {}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "UPDATE slices SET state=?,error=?,rows=?,raw_path=?,raw_sha256=?,"
                "meta_path=?,meta_sha256=?,error_kind=? "
                "WHERE id=?",
                (
                    state,
                    error,
                    rows,
                    evidence.get("raw_path"),
                    evidence.get("raw_sha256"),
                    evidence.get("meta_path"),
                    evidence.get("meta_sha256"),
                    error_kind,
                    slice_id,
                ),
            )
            if state in ("succeeded", "failed"):
                item = db.execute("SELECT run_id,ordinal FROM slices WHERE id=?", (slice_id,)).fetchone()
                kind = (
                    "slice_succeeded"
                    if state == "succeeded"
                    else ("slice_row_limit" if error_kind == "row_limit" else "slice_failed")
                )
                level = "ok" if state == "succeeded" else ("warn" if error_kind == "row_limit" else "error")
                message = (
                    f"切片 #{item['ordinal'] + 1} 归档完成（{rows} 行）"
                    if state == "succeeded"
                    else f"切片 #{item['ordinal'] + 1} 失败：{error or '未知错误'}"
                )
                self._activity_event(
                    db,
                    item["run_id"],
                    kind,
                    level,
                    message,
                    slice_id=slice_id,
                    token=token,
                )

    def finish_run(self, run_id: str, state: str, error=None, *, token=""):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if state != "succeeded":
                failed_slices = db.execute(
                    "SELECT id,ordinal FROM slices WHERE run_id=? AND state='running'", (run_id,)
                ).fetchall()
                db.execute(
                    "UPDATE attempts SET state=?,error=?,finished_at=? WHERE state='running' "
                    "AND slice_id IN (SELECT id FROM slices WHERE run_id=?)",
                    (
                        "interrupted" if state in ("interrupted", "cancelled") else "failed",
                        error,
                        now(),
                        run_id,
                    ),
                )
                db.execute(
                    "UPDATE slices SET state=?,error=? WHERE run_id=? AND state='running'",
                    ("pending" if state in ("interrupted", "cancelled") else "failed", error, run_id),
                )
                if state == "failed":
                    for item in failed_slices:
                        self._activity_event(
                            db,
                            run_id,
                            "slice_failed",
                            "error",
                            f"切片 #{item['ordinal'] + 1} 失败：{error or '未知错误'}",
                            slice_id=item["id"],
                            token=token,
                        )
            db.execute(
                "UPDATE runs SET state=?,error=?,finished_at=? WHERE id=?",
                (state, error, now(), run_id),
            )
            labels = {
                "succeeded": ("ok", "运行完成；本次请求已归档，不代表全量覆盖"),
                "failed": ("error", "运行失败"),
                "cancelled": ("warn", "运行已取消"),
                "interrupted": ("warn", "运行已中断"),
            }
            level, message = labels[state]
            self._activity_event(
                db,
                run_id,
                f"run_{state}",
                level,
                f"{message}：{error}" if error else message,
                token=token,
            )
