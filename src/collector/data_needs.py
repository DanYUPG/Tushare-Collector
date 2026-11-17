from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pyarrow as pa
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    ValidationError,
    field_validator,
    model_validator,
)

from .datasets import FIRST_DATE, RECIPES, DatasetSettings, china_today, digest, history_start, scope_for
from .models import ENTRIES, CollectorError
from .stock_rules import effective_options
from .store import encode, now
from .warehouse import WAREHOUSE_ADAPTERS, warehouse_catalog

ACTIVE = ("planning", "collecting", "publishing")
SHANGHAI = ZoneInfo("Asia/Shanghai")


def dependencies_for(dataset_id):
    recipe = RECIPES[dataset_id]
    rule = recipe.get("rule", {})
    strategy = rule.get("strategy")
    dependencies = []
    if recipe["kind"] == "daily" or strategy in {
        "trading_day", "stock_day", "board_day", "stock_minute", "time_day",
    }:
        dependencies.append("trade_cal")
    pool = rule.get("pool")
    if recipe["kind"] == "financial" or strategy in {
        "stock_window", "stock_quarter", "stock_day", "stock_minute", "stock_snapshot", "derived",
        "realtime",
    }:
        pool = pool or "stock_basic"
    if pool:
        dependencies.append(pool)
    return list(dict.fromkeys(dependencies))


def options_for(dataset_id, options=None):
    return effective_options(RECIPES[dataset_id], SimpleNamespace(options=options or {}))


def need_layout(spec):
    result, visiting = {}, set()

    def visit(dataset_id, start, dependency=False):
        if dataset_id in visiting:
            raise CollectorError("数据需求依赖出现循环")
        if dataset_id not in WAREHOUSE_ADAPTERS:
            raise CollectorError(f"{dataset_id} 尚不支持仓库交付")
        recipe = RECIPES[dataset_id]
        start = history_start(recipe, SimpleNamespace(start_date=start))
        options = options_for(dataset_id, spec.dataset_options.get(dataset_id, {}))
        if dependency and options != options_for(dataset_id):
            raise CollectorError(f"{recipe['name']} 作为代码池依赖时须选择全部预置分类，请拆开需求")
        prior = result.get(dataset_id)
        if prior and start >= prior["start_date"]:
            return
        visiting.add(dataset_id)
        for required in dependencies_for(dataset_id):
            visit(required, start, True)
        visiting.remove(dataset_id)
        result[dataset_id] = {
            "start_date": start, "options": options, "publish": dataset_id in spec.dataset_ids,
        }

    for dataset_id in spec.dataset_ids:
        visit(dataset_id, spec.start_date)
    return result


def contract_for(dataset_id):
    return digest({
        "recipe": RECIPES[dataset_id], "schema": str(WAREHOUSE_ADAPTERS[dataset_id].schema),
        "capabilities": WAREHOUSE_ADAPTERS[dataset_id].capabilities(),
    })


class DataNeedSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    dataset_ids: list[str] = Field(min_length=1, max_length=len(WAREHOUSE_ADAPTERS))
    dataset_options: dict[str, dict[str, list[str]]] = Field(
        default_factory=dict, max_length=len(WAREHOUSE_ADAPTERS),
    )
    start_date: date = FIRST_DATE
    end_date: date | None = None
    update_hour: StrictInt = Field(default=20, ge=0, le=23)
    lookback_days: StrictInt = Field(default=7, ge=1, le=366)
    requests_per_minute: StrictInt = Field(default=100, ge=1, le=500)
    max_requests: StrictInt = Field(default=30000, ge=1, le=100000)

    @field_validator("name")
    @classmethod
    def checked_name(cls, value):
        if not value.strip():
            raise ValueError("需求名称不能为空")
        return value.strip()

    @model_validator(mode="after")
    def checked_scope(self):
        if len(set(self.dataset_ids)) != len(self.dataset_ids):
            raise ValueError("数据集不能重复")
        unknown = set(self.dataset_ids) - set(WAREHOUSE_ADAPTERS)
        if unknown:
            raise ValueError(f"尚不支持仓库交付的数据集：{', '.join(sorted(unknown))}")
        if set(self.dataset_options) - set(self.dataset_ids):
            raise ValueError("只能配置已选择数据集的采集选项")
        if not FIRST_DATE <= self.start_date <= china_today() - timedelta(days=1):
            raise ValueError("历史起点须介于 1990-12-19 与上海时间昨天之间")
        if self.end_date is not None and not self.start_date <= self.end_date <= (
            china_today() - timedelta(days=1)
        ):
            raise ValueError("截止日须介于历史起点与上海时间昨天之间")
        if self.end_date and all(RECIPES[item]["kind"] == "snapshot" for item in self.dataset_ids):
            raise ValueError("当前快照不支持历史截止日")
        try:
            need_layout(self)
        except CollectorError as error:
            raise ValueError(str(error)) from None
        return self


class DataNeedSave(BaseModel):
    model_config = ConfigDict(extra="forbid")
    spec: DataNeedSpec
    enabled: StrictBool = False
    authorize_network: StrictBool = False
    expected_revision: StrictInt = Field(default=0, ge=0)


class DataNeedAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: StrictInt = Field(ge=1)
    authorize_network: StrictBool = False


def next_attempt(spec, timestamp):
    local = timestamp.astimezone(SHANGHAI)
    target = local.replace(hour=spec.update_hour, minute=0, second=0, microsecond=0)
    if target <= local:
        target += timedelta(days=1)
    return target.astimezone(timezone.utc).isoformat()


class DataNeeds:
    """Runs one durable orchestration step while the collection worker is idle."""

    def __init__(self, store, datasets, warehouses, runner):
        self.store, self.datasets, self.warehouses, self.runner = store, datasets, warehouses, runner
        self.lock = threading.RLock()
        self.next_tick = 0.0

    def catalog(self):
        entries = []
        for item in warehouse_catalog()["entries"]:
            if not item["warehouse_supported"]:
                continue
            dataset_id = item["dataset_id"]
            recipe = RECIPES[dataset_id]
            rule = recipe.get("rule", {})
            date_field = rule.get("date_field", recipe.get("date_field", item["date_column"]))
            entries.append({
                **{key: item[key] for key in (
                    "dataset_id", "entry_id", "api_name", "name", "category", "category_name",
                    "doc_url", "grain", "date_column", "storage_layout", "supports_variants",
                )},
                "date_mode": "snapshot" if recipe["kind"] == "snapshot" else "range",
                "date_label": (
                    "当前快照" if recipe["kind"] == "snapshot"
                    else "统计周期（按区间相交）" if item.get("date_semantics") == "week_interval"
                    else "月份（按整月相交）" if item.get("date_semantics") == "month"
                    else "交易日内时间" if item.get("date_semantics") == "timestamp"
                    else "周／月周期标签" if item.get("date_semantics") == "period_label"
                    else "公告日期" if date_field == "ann_date"
                    else "报告期" if rule.get("strategy") in {"quarter", "stock_quarter"}
                    or date_field == "end_date"
                    else "交易日历日期" if dataset_id == "trade_cal"
                    else "交易日期" if date_field == "trade_date"
                    else f"记录日期（{item['date_column']}）"
                ),
                "start_date": recipe["start"], "available_until": rule.get("available_until"),
                "archive_only": bool(rule.get("archive_only")),
                "options": rule.get("options", {}), "dependencies": dependencies_for(dataset_id),
                "scope_note": recipe["scope_note"], "update_note": recipe["incremental_note"],
                "field_count": len(item["fields"]),
                "permission": ENTRIES[recipe["entry_id"]]["permission_note"],
                "semantic_note": item.get("semantic_note", ""),
                "atomic_full_run": item.get("atomic_full_run", False),
            })
        return {"version": 1, "entries": entries}

    def list(self):
        with self.store.connect() as db:
            result = []
            for row in db.execute("SELECT * FROM data_needs ORDER BY created_at DESC"):
                jobs = db.execute(
                    "SELECT * FROM data_need_jobs WHERE need_id=? ORDER BY created_at DESC LIMIT 10",
                    (row["id"],),
                ).fetchall()
                result.append({
                    **{key: row[key] for key in (
                        "id", "revision", "next_attempt_at", "last_error", "created_at", "updated_at",
                    )},
                    "enabled": bool(row["enabled"]), "spec": json.loads(row["spec_json"]),
                    "bindings": json.loads(row["bindings_json"]),
                    "jobs": [self.job_record(job) for job in jobs],
                })
            return result

    @staticmethod
    def job_record(row):
        return {
            **{key: row[key] for key in (
                "id", "need_id", "need_revision", "state", "requests_sent", "request_limit",
                "created_at", "finished_at", "error",
            )},
            "steps": json.loads(row["steps_json"]),
        }

    @staticmethod
    def checked_need(db, need_id, revision):
        row = db.execute("SELECT * FROM data_needs WHERE id=?", (need_id,)).fetchone()
        if row is None:
            raise CollectorError("数据需求不存在")
        if row["revision"] != revision:
            raise CollectorError("数据需求已变更，请刷新后重试")
        return row

    def save(self, body, need_id=None):
        if body.enabled and not body.authorize_network:
            raise CollectorError("启用自动维护须明确授权联网采集、所需依赖和请求预算")
        with self.lock, self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if need_id:
                row = self.checked_need(db, need_id, body.expected_revision)
                if db.execute(
                    "SELECT 1 FROM data_need_jobs WHERE need_id=? AND state IN (?,?,?)",
                    (need_id, *ACTIVE),
                ).fetchone():
                    raise CollectorError("需求正在执行，请先暂停后再修改")
                revision, created = row["revision"] + 1, row["created_at"]
            else:
                if body.expected_revision:
                    raise CollectorError("新需求的版本须为 0")
                need_id, revision, created = uuid.uuid4().hex, 1, now()
            if body.enabled:
                self.check_ownership(db, need_id, body.spec)
            bindings = {}
            for dataset_id in need_layout(body.spec):
                settings, _ = self.datasets.checked_settings(db, dataset_id)
                bindings[dataset_id] = {
                    "raw_root": settings.raw_root,
                    "schema": self.warehouses[dataset_id].schema_description(),
                    "settings_options": options_for(dataset_id, settings.options),
                    "contract": contract_for(dataset_id),
                }
            db.execute(
                "INSERT INTO data_needs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "spec_json=excluded.spec_json,enabled=excluded.enabled,revision=excluded.revision,"
                "next_attempt_at=excluded.next_attempt_at,last_error=NULL,updated_at=excluded.updated_at,"
                "bindings_json=excluded.bindings_json",
                (need_id, encode(body.spec.model_dump(mode="json")), int(body.enabled), revision,
                 now() if body.enabled else None, None, created, now(), encode(bindings)),
            )
        self.runner.wake.set()
        return {"id": need_id, "revision": revision}

    @staticmethod
    def check_ownership(db, need_id, spec):
        layout = need_layout(spec)
        for other in db.execute("SELECT spec_json FROM data_needs WHERE enabled=1 AND id!=?", (need_id,)):
            other_spec = DataNeedSpec.model_validate_json(other["spec_json"])
            if set(other_spec.dataset_ids) & set(spec.dataset_ids):
                raise CollectorError("同一数据集已有启用的需求，请修改原需求或先暂停，避免重复维护")
            for dataset_id, settings in need_layout(other_spec).items():
                if dataset_id in layout and settings["options"] != layout[dataset_id]["options"]:
                    raise CollectorError("其他启用需求使用不同的依赖选项，请先暂停或统一代码池分类")

    def pause(self, need_id, revision):
        with self.lock, self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.checked_need(db, need_id, revision)
            runs = db.execute(
                "SELECT r.id,r.state FROM data_need_runs x JOIN runs r ON r.id=x.run_id "
                "JOIN data_need_jobs j ON j.id=x.job_id "
                "WHERE j.need_id=? AND r.state IN ('queued','running')",
                (need_id,),
            ).fetchall()
            for run in runs:
                db.execute("UPDATE runs SET cancel_requested=1 WHERE id=?", (run["id"],))
                if run["state"] == "queued":
                    db.execute("UPDATE runs SET state='cancelled',finished_at=? WHERE id=?", (
                        now(), run["id"],
                    ))
                self.store._activity_event(db, run["id"], "run_cancel_requested", "warn", "数据需求已暂停")
            db.execute(
                "UPDATE data_need_jobs SET state='paused',finished_at=?,error='用户暂停需求' "
                "WHERE need_id=? AND state IN (?,?,?)", (now(), need_id, *ACTIVE),
            )
            db.execute(
                "UPDATE data_needs SET enabled=0,revision=revision+1,next_attempt_at=NULL,updated_at=? "
                "WHERE id=?", (now(), need_id),
            )
        return {"id": need_id, "revision": revision + 1}

    def sync(self, need_id, body):
        if not body.authorize_network:
            raise CollectorError("立即同步须明确授权联网采集、所需依赖和请求预算")
        with self.lock, self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self.checked_need(db, need_id, body.expected_revision)
            self.check_ownership(db, need_id, DataNeedSpec.model_validate_json(row["spec_json"]))
            job = db.execute(
                "SELECT * FROM data_need_jobs WHERE need_id=? AND state IN (?,?,?)", (need_id, *ACTIVE),
            ).fetchone()
            if job is None:
                job = self.new_job(db, row)
            result = self.job_record(job)
        self.runner.wake.set()
        return result

    def new_job(self, db, need):
        spec = DataNeedSpec.model_validate_json(need["spec_json"])
        target = spec.end_date or (china_today() - timedelta(days=1))
        bindings = json.loads(need["bindings_json"])
        steps = []
        for dataset_id, scope in need_layout(spec).items():
            if dataset_id not in bindings:
                raise CollectorError("需求缺少目录与字段绑定，请重新保存需求后再授权执行")
            settings = DatasetSettings(
                raw_root=bindings[dataset_id]["raw_root"], start_date=scope["start_date"],
                lookback_days=spec.lookback_days, requests_per_minute=spec.requests_per_minute,
                options=scope["options"],
            )
            steps.append({
                "dataset_id": dataset_id, "state": "pending", "run_id": None,
                "settings": settings.model_dump(mode="json"),
                "target": (
                    china_today() if RECIPES[dataset_id]["kind"] == "snapshot" else target
                ).isoformat(),
                "publish": scope["publish"],
                "expected_options": bindings[dataset_id].get("settings_options", {}),
                "contract": bindings[dataset_id].get("contract"),
                "fields": self.warehouses[dataset_id].schema.names,
                "schema": bindings[dataset_id]["schema"],
                "result": None,
            })
        job_id = uuid.uuid4().hex
        db.execute(
            "INSERT INTO data_need_jobs(id,need_id,need_revision,spec_json,state,steps_json,"
            "request_limit,created_at) VALUES(?,?,?,?,'planning',?,?,?)",
            (job_id, need["id"], need["revision"], need["spec_json"], encode(steps),
             spec.max_requests, now()),
        )
        db.execute(
            "UPDATE data_needs SET last_error=NULL,next_attempt_at=?,updated_at=? WHERE id=?",
            (next_attempt(spec, datetime.now(timezone.utc)) if need["enabled"] else None, now(), need["id"]),
        )
        return db.execute("SELECT * FROM data_need_jobs WHERE id=?", (job_id,)).fetchone()

    def tick(self):
        if time.monotonic() < self.next_tick or not self.runner.token or self.runner.stopping.is_set():
            return
        self.next_tick = time.monotonic() + 2
        with self.lock:
            job_id, need_id = None, None
            try:
                with self.store.connect() as db:
                    db.execute("BEGIN IMMEDIATE")
                    # Do not publish while any collector run is using the store.
                    if db.execute(
                        "SELECT 1 FROM runs WHERE state IN ('queued','running') LIMIT 1",
                    ).fetchone():
                        return
                    job = db.execute(
                        "SELECT * FROM data_need_jobs WHERE state IN (?,?,?) ORDER BY created_at LIMIT 1",
                        ACTIVE,
                    ).fetchone()
                    if job is None:
                        need = db.execute(
                            "SELECT * FROM data_needs WHERE enabled=1 AND last_error IS NULL "
                            "AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 1", (now(),),
                        ).fetchone()
                        if need is None:
                            return
                        need_id = need["id"]
                        job = self.new_job(db, need)
                    job_id, need_id = job["id"], job["need_id"]
                self.advance(job)
            except (CollectorError, OSError, pa.ArrowException, sqlite3.Error, ValidationError) as error:
                message = self.store.sanitize_activity(str(error))
                with self.store.connect() as db:
                    if job_id:
                        db.execute(
                            "UPDATE data_need_jobs SET state='blocked',error=?,finished_at=? WHERE id=?",
                            (message, now(), job_id),
                        )
                    if need_id:
                        db.execute("UPDATE data_needs SET last_error=?,updated_at=? WHERE id=?", (
                            message, now(), need_id,
                        ))

    def advance(self, job):
        steps = json.loads(job["steps_json"])
        step = next((item for item in steps if item["state"] != "succeeded"), None)
        if step is None:
            with self.store.connect() as db:
                db.execute(
                    "UPDATE data_need_jobs SET state='succeeded',finished_at=?,error=NULL WHERE id=?",
                    (now(), job["id"]),
                )
            return
        dataset_id = step["dataset_id"]
        warehouse = self.warehouses[dataset_id]
        if step.get("contract") and step["contract"] != contract_for(dataset_id):
            raise CollectorError("采集或仓库规则已变化，请重新保存需求并确认后执行")
        if step["fields"] != warehouse.schema.names:
            raise CollectorError("仓库字段契约已变化，请重新保存需求并确认后执行")
        if step["schema"] != warehouse.schema_description():
            raise CollectorError("仓库字段类型契约已变化，请重新保存需求并确认后执行")
        with self.store.connect() as db:
            settings, revision = self.datasets.checked_settings(db, dataset_id)
        if settings.raw_root != step["settings"]["raw_root"] or options_for(
            dataset_id, settings.options,
        ) != step.get("expected_options", {}):
            raise CollectorError(f"{dataset_id} 的目录或请求选项已变化，请核查后重新保存需求")
        if step["state"] == "pending":
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                settings, revision = self.datasets.checked_settings(db, dataset_id)
                if settings.raw_root != step["settings"]["raw_root"] or options_for(
                    dataset_id, settings.options,
                ) != step.get("expected_options", {}):
                    raise CollectorError("目录或请求选项已变化，请核查后重新保存需求")
                desired = DatasetSettings.model_validate(step["settings"])
                scope = scope_for(RECIPES[dataset_id], desired)
                if self.datasets.split_definitions(db, dataset_id, scope):
                    raise CollectorError("当前范围已有人工拆分规则，尚不能安全自动入仓；请先核查 Raw")
                mode = "incremental"
                if RECIPES[dataset_id].get("rule", {}).get("strategy") == "derived":
                    mode = "full"
                if RECIPES[dataset_id].get("rule", {}).get("archive_only"):
                    latest, _ = self.datasets.records(db, dataset_id, scope)
                    if not latest:
                        mode = "full"
                current = self.datasets._build(
                    db, dataset_id, desired, mode,
                    date.fromisoformat(step["target"]), self.runner.global_rpm,
                )
                required = current.get("supplier_requests", current["total_slices"])
                if required > job["request_limit"] - job["requests_sent"]:
                    raise CollectorError(
                        f"{dataset_id} 至少需要 {required} 次请求，超出本次剩余预算；"
                        "未启动该接口，请调整范围或预算"
                    )
                if current["partitions"]:
                    self.datasets._store_plan(db, current, revision)
                    current["settings_revision"] = revision
                    run_id, _ = self.datasets._enqueue_plan(db, current, current["id"])
                    db.execute("INSERT INTO data_need_runs VALUES(?,?)", (run_id, job["id"]))
                    step.update(state="collecting", run_id=run_id)
                else:
                    self.datasets._save_settings(
                        db, dataset_id, DatasetSettings.model_validate(step["settings"]), revision,
                    )
                    step["state"] = "publishing"
                step["expected_options"] = options_for(dataset_id, desired.options)
                step["plan_summary"] = {
                    key: current[key] for key in ("mode", "start_date", "end_date", "counts", "warnings")
                }
                bindings = json.loads(db.execute(
                    "SELECT bindings_json FROM data_needs WHERE id=?", (job["need_id"],),
                ).fetchone()[0])
                bindings[dataset_id]["settings_options"] = step["expected_options"]
                db.execute(
                    "UPDATE data_needs SET bindings_json=? WHERE id=?",
                    (encode(bindings), job["need_id"]),
                )
                self.save_steps(db, job["id"], steps, step["state"])
            self.runner.wake.set()
            return
        if step["state"] == "collecting":
            run = self.store.run(step["run_id"])
            if run["state"] in {"queued", "running"}:
                return
            if run["state"] == "interrupted":
                if job["requests_sent"] >= job["request_limit"]:
                    raise CollectorError("服务中断后请求预算已耗尽，请核查后重新同步")
                self.store.resume(run["id"])
                self.runner.wake.set()
                return
            if run["state"] != "succeeded":
                raise CollectorError(
                    f"{RECIPES[dataset_id]['name']}采集未完成：{run.get('error') or run['state']}。"
                    "自动执行已暂停；请核查权限、限额或触顶等原因后重新同步。旧仓库保持可查询。"
                )
            step["state"] = "publishing"
            with self.store.connect() as db:
                self.save_steps(db, job["id"], steps, "publishing")
            return
        if step["state"] == "publishing":
            if step.get("publish", dataset_id != "trade_cal"):
                result = warehouse.refresh(
                    verify_content=True, expected_raw_root=step["settings"]["raw_root"],
                    expected_scope=scope_for(
                        RECIPES[dataset_id], DatasetSettings.model_validate(step["settings"]),
                    ),
                )
                step["result"] = {
                    key: result[key] for key in ("snapshot_id", "rows", "days", "last_date", "changed")
                }
            else:
                step["result"] = {"role": "planning_dependency"}
            step["state"] = "succeeded"
            with self.store.connect() as db:
                self.save_steps(db, job["id"], steps, "planning")

    @staticmethod
    def save_steps(db, job_id, steps, state):
        db.execute(
            "UPDATE data_need_jobs SET steps_json=?,state=? WHERE id=?", (encode(steps), state, job_id),
        )
