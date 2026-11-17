from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Literal

import pyarrow as pa
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError

from .archive_delete import CleanupBusy, ensure_idle
from .data_needs import next_attempt
from .models import CollectorError
from .store import encode, now
from .warehouse_cleanup import AUTOMATIC_DATASETS, execute_cleanup, preview_cleanup

BATCH_SIZE = 100


class StoragePolicySpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    retention_days: StrictInt = Field(default=7, ge=1, le=36500)
    update_hour: StrictInt = Field(default=3, ge=0, le=23)
    check_mode: Literal["fast", "deep"] = "fast"


class StoragePolicySave(StoragePolicySpec):
    enabled: StrictBool = False
    authorize_delete: StrictBool = False
    expected_revision: StrictInt = Field(default=0, ge=0)


class StoragePolicyPause(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: StrictInt = Field(ge=1)


class StoragePolicy:
    def __init__(self, store, datasets, warehouses, runner):
        self.store, self.datasets, self.warehouses, self.runner = store, datasets, warehouses, runner
        self.lock = threading.RLock()
        self.next_tick = 0.0

    def status(self):
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM storage_policy WHERE id=1").fetchone()
            jobs = db.execute(
                "SELECT * FROM storage_policy_jobs ORDER BY created_at DESC LIMIT 10",
            ).fetchall()
        return {
            "revision": row["revision"] if row else 0,
            "enabled": bool(row and row["enabled"]),
            "spec": json.loads(row["spec_json"]) if row else StoragePolicySpec().model_dump(),
            "next_attempt_at": row["next_attempt_at"] if row else None,
            "last_error": row["last_error"] if row else None,
            "bindings": json.loads(row["bindings_json"]) if row else {},
            "dataset_ids": list(AUTOMATIC_DATASETS), "batch_size": BATCH_SIZE,
            "jobs": [
                {**{key: job[key] for key in (
                    "id", "policy_revision", "state", "created_at", "finished_at", "error",
                )}, "steps": [
                    {**{key: value for key, value in step.items() if key != "receipts"},
                     "completed_batches": len(step.get("receipts", []))}
                    for step in json.loads(job["steps_json"])
                ]}
                for job in jobs
            ],
        }

    def save(self, body):
        if body.enabled and not body.authorize_delete:
            raise CollectorError("启用存储策略须明确授权按保留期永久释放中间文件")
        spec = StoragePolicySpec(
            retention_days=body.retention_days, update_hour=body.update_hour, check_mode=body.check_mode,
        )
        with self.lock, self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM storage_policy WHERE id=1").fetchone()
            revision = row["revision"] if row else 0
            if revision != body.expected_revision:
                raise CollectorError("存储策略已变更，请刷新后重试")
            if db.execute("SELECT 1 FROM storage_policy_jobs WHERE state='running'").fetchone():
                raise CollectorError("存储策略正在执行，请先暂停后再修改")
            bindings = {}
            for dataset_id in AUTOMATIC_DATASETS:
                warehouse = self.warehouses[dataset_id]
                settings, _ = self.datasets.checked_settings(db, dataset_id)
                if body.enabled and settings.options:
                    raise CollectorError("自动释放暂不支持带额外请求选项的数据集")
                bindings[dataset_id] = {
                    "raw_root": settings.raw_root, "options": settings.options,
                    "warehouse_root": str(warehouse.root.resolve()),
                    "schema": warehouse.schema_description(),
                }
            db.execute(
                "INSERT INTO storage_policy VALUES(1,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "spec_json=excluded.spec_json,enabled=excluded.enabled,revision=excluded.revision,"
                "bindings_json=excluded.bindings_json,next_attempt_at=excluded.next_attempt_at,"
                "last_error=NULL,updated_at=excluded.updated_at",
                (encode(spec.model_dump()), int(body.enabled), revision + 1, encode(bindings),
                 now() if body.enabled else None, None, row["created_at"] if row else now(), now()),
            )
        self.next_tick = 0
        self.runner.wake.set()
        return self.status()

    def pause(self, revision):
        with self.lock, self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM storage_policy WHERE id=1").fetchone()
            if row is None or row["revision"] != revision:
                raise CollectorError("存储策略已变更，请刷新后重试")
            db.execute(
                "UPDATE storage_policy SET enabled=0,revision=revision+1,next_attempt_at=NULL,"
                "updated_at=? WHERE id=1", (now(),),
            )
            db.execute(
                "UPDATE storage_policy_jobs SET state='paused',finished_at=?,error='用户暂停存储策略' "
                "WHERE state='running'", (now(),),
            )
        return self.status()

    def guard(self, db, job):
        policy = db.execute("SELECT * FROM storage_policy WHERE id=1").fetchone()
        active = db.execute(
            "SELECT state FROM storage_policy_jobs WHERE id=?", (job["id"],),
        ).fetchone()
        if (
            policy is None or not policy["enabled"] or policy["last_error"]
            or policy["revision"] != job["policy_revision"]
            or policy["spec_json"] != job["spec_json"]
            or policy["bindings_json"] != job["bindings_json"]
            or active is None or active["state"] != "running"
        ):
            raise CollectorError("存储策略授权已失效，不再释放中间文件")
        for dataset_id, binding in json.loads(job["bindings_json"]).items():
            warehouse = self.warehouses[dataset_id]
            settings, _ = self.datasets.checked_settings(db, dataset_id)
            if (
                settings.raw_root != binding["raw_root"] or settings.options != binding["options"]
                or settings.options or str(warehouse.root.resolve()) != binding["warehouse_root"]
                or warehouse.schema_description() != binding["schema"]
            ):
                raise CollectorError("采集目录、仓库目录或字段契约已变化，请核查并重新授权存储策略")

    def tick(self):
        if time.monotonic() < self.next_tick or self.runner.stopping.is_set():
            return
        self.next_tick = time.monotonic() + 2
        job, policy = None, None
        with self.lock:
            try:
                with self.store.connect() as db:
                    policy = db.execute("SELECT * FROM storage_policy WHERE id=1").fetchone()
                    if policy is None or not policy["enabled"] or policy["last_error"]:
                        return
                    job = db.execute(
                        "SELECT * FROM storage_policy_jobs WHERE state='running'",
                    ).fetchone()
                    if job is None and (
                        policy["next_attempt_at"] is None or policy["next_attempt_at"] > now()
                    ):
                        return
                    db.execute("BEGIN IMMEDIATE")
                    policy = db.execute("SELECT * FROM storage_policy WHERE id=1").fetchone()
                    if policy is None or not policy["enabled"] or policy["last_error"]:
                        return
                    ensure_idle(db)
                    job = db.execute(
                        "SELECT * FROM storage_policy_jobs WHERE state='running'",
                    ).fetchone()
                    if job is None:
                        if policy["next_attempt_at"] is None or policy["next_attempt_at"] > now():
                            return
                        spec = StoragePolicySpec.model_validate_json(policy["spec_json"])
                        steps = [{
                            "dataset_id": dataset_id, "state": "pending", "cursor": None,
                            "snapshot_id": None, "batch": None, "deleted": 0, "files": 0,
                            "bytes": 0, "skipped": 0, "reason": None, "receipts": [],
                        } for dataset_id in AUTOMATIC_DATASETS]
                        job_id = uuid.uuid4().hex
                        db.execute(
                            "INSERT INTO storage_policy_jobs"
                            "(id,policy_revision,spec_json,bindings_json,steps_json,state,created_at) "
                            "VALUES(?,?,?,?,?,'running',?)",
                            (job_id, policy["revision"], policy["spec_json"], policy["bindings_json"],
                             encode(steps), now()),
                        )
                        db.execute(
                            "UPDATE storage_policy SET next_attempt_at=?,updated_at=? WHERE id=1",
                            (next_attempt(spec, datetime.now(timezone.utc)), now()),
                        )
                        job = db.execute(
                            "SELECT * FROM storage_policy_jobs WHERE id=?", (job_id,),
                        ).fetchone()
                    self.guard(db, job)
                self.advance(job)
            except CleanupBusy:
                self.next_tick = time.monotonic() + 5
            except (CollectorError, OSError, pa.ArrowException, sqlite3.Error, ValidationError) as error:
                if (
                    isinstance(error, sqlite3.OperationalError)
                    and getattr(error, "sqlite_errorcode", None) in {
                        sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED,
                    }
                ):
                    self.next_tick = time.monotonic() + 5
                    return
                message = self.store.sanitize_activity(str(error))
                with self.store.connect() as db:
                    if job is not None:
                        db.execute(
                            "UPDATE storage_policy_jobs SET state='blocked',error=?,finished_at=? "
                            "WHERE id=? AND state='running'", (message, now(), job["id"]),
                        )
                    if policy is not None:
                        db.execute(
                            "UPDATE storage_policy SET last_error=?,updated_at=? WHERE id=1 AND revision=?",
                            (message, now(), policy["revision"]),
                        )

    def persist(self, job, steps):
        complete = all(step["state"] in {"succeeded", "skipped"} for step in steps)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.guard(db, job)
            db.execute(
                "UPDATE storage_policy_jobs SET steps_json=?,state=?,finished_at=? WHERE id=?",
                (encode(steps), "succeeded" if complete else "running",
                 now() if complete else None, job["id"]),
            )

    def advance(self, job):
        steps = json.loads(job["steps_json"])
        step = next(item for item in steps if item["state"] not in {"succeeded", "skipped"})
        warehouse = self.warehouses[step["dataset_id"]]
        spec = StoragePolicySpec.model_validate_json(job["spec_json"])
        if step["batch"] is None:
            if step["snapshot_id"] is None:
                root, _, _, _, _ = warehouse.context()
                if not (root / "current.json").exists():
                    step.update(state="skipped", reason="尚未发布仓库，保留所有中间文件")
                    self.persist(job, steps)
                    return
            preview = preview_cleanup(
                warehouse, retention_days=spec.retention_days, snapshot_id=step["snapshot_id"],
                check_mode=spec.check_mode, automatic=True, limit=BATCH_SIZE, after_key=step["cursor"],
            )
            step["snapshot_id"] = preview["snapshot_id"]
            step["skipped"] += preview["excluded_count"]
            if preview["excluded"] and step["reason"] is None:
                step["reason"] = preview["excluded"][0]["reason"]
            if not preview["count"]:
                step.update(
                    cursor=preview["scan_cursor"], state="pending" if preview["has_more"] else "succeeded",
                )
            else:
                step["batch"] = {
                    key: preview[key] for key in ("fingerprint", "scan_cursor", "has_more")
                }
                step["state"] = "prepared"
            # Persist the exact batch receipt before any deletion; never re-plan it after restart.
            self.persist(job, steps)
            return
        result = execute_cleanup(
            warehouse, step["batch"]["fingerprint"], retention_days=spec.retention_days,
            snapshot_id=step["snapshot_id"], check_mode=spec.check_mode,
            automatic=True, limit=BATCH_SIZE, after_key=step["cursor"],
            guard=lambda db: self.guard(db, job),
        )
        if result["state"] != "deleted":
            step["batch"]["partial_deleted"] = result["deleted"]
            self.persist(job, steps)
            details = "；".join(item["error"] for item in result["failures"][:3])
            raise CollectorError(f"存储策略释放未完成，已停止后续批次：{details}")
        step["deleted"] += result["deleted"]
        step["files"] += result["files"]
        step["bytes"] += result["bytes"]
        step.setdefault("receipts", []).append({
            **step["batch"], "snapshot_id": step["snapshot_id"], "after_key": step["cursor"],
            "deleted": result["deleted"], "files": result["files"], "bytes": result["bytes"],
        })
        step.update(
            cursor=step["batch"]["scan_cursor"],
            state="pending" if step["batch"]["has_more"] else "succeeded", batch=None,
        )
        self.persist(job, steps)
