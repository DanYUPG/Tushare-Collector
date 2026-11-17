from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .artifacts import source_paths, verified_open
from .client import CollectionFailure, Response
from .models import (
    CATALOG,
    ENTRIES,
    MAX_SLICES,
    CollectorError,
    TaskConfig,
    absolute_directory,
    is_stock_code,
    plan,
)
from .permissions import DEFAULT_RPM, effective_rpm
from .stock_rules import (
    candidates_for,
    catalog_recipes,
    effective_options,
    recent_partition,
    response_day,
    validate_catalog_response,
)
from .store import encode, now

FIRST_DATE = date(1990, 12, 19)
MARKET_CALENDAR_EXCHANGE = "SSE"
MODES = {"full": "全量初始化", "incremental": "增量更新", "retry": "补采未完成切片", "split": "拆分触顶范围"}
RECIPES = {
    "stock_basic": {
        "name": "股票列表",
        "entry_id": "25",
        "kind": "snapshot",
        "start": "1990-12-19",
        "scope_note": "沪深北股票；SSE / SZSE / BSE × L / D / P / G / UN。保存当前快照，不重建历史股票池。",
        "incremental_note": "每次重新获取全部当前状态，保存新快照；不按最大日期追加。",
    },
    "trade_cal": {
        "name": "交易日历",
        "entry_id": "26",
        "kind": "calendar",
        "start": "1990-12-19",
        "scope_note": (
            "使用 SSE 上交所作为沪深北市场交易日基准，按年度查询完整自然日及开闭市标记；"
            "当年查询到年末。不复制或改名为 SZSE 日历。"
        ),
        "incremental_note": "补齐缺失或失败年度，并重新获取回查窗口涉及的年度（至少包含目标年度）。",
    },
    "daily": {
        "name": "日线行情",
        "entry_id": "27",
        "kind": "daily",
        "start": "1990-12-19",
        "scope_note": "按 SSE 市场基准日历的开市日，逐日查询接口返回的全部沪深北股票，不限定股票代码。",
        "incremental_note": "补新日期和历史缺口，并回拉最近若干自然日；不会因最新日期成功而跳过中间失败。",
    },
    "daily_basic": {
        "name": "每日指标",
        "entry_id": "32",
        "kind": "daily",
        "start": "2004-01-01",
        "scope_note": "按交易日查询全部股票的每日指标及接口字段；默认历史起点 2004 年，可按权限调整。",
        "incremental_note": "补新日期、历史缺口和失败范围，同时回查近期数据；账号权限可能限制历史范围。",
    },
    "adj_factor": {
        "name": "复权因子",
        "entry_id": "28",
        "kind": "daily",
        "start": "1990-12-19",
        "scope_note": "按交易日查询接口返回的全部股票复权因子，不计算复权价格。",
        "incremental_note": "补缺口并回查近期因子；窗口之外的历史修订须另行全量重拉，不保证自动发现。",
    },
}
for dataset_id, entry_id, name, date_field in (
    ("income", "33", "利润表", "ann_date"),
    ("balancesheet", "36", "资产负债表", "ann_date"),
    ("cashflow", "44", "现金流量表", "ann_date"),
    ("fina_indicator", "79", "财务指标", "end_date"),
):
    RECIPES[dataset_id] = {
        "name": name,
        "entry_id": entry_id,
        "kind": "financial",
        "start": "1990-12-19",
        "date_field": date_field,
        "window_years": 16,
        "local_limit": 100,
        "scope_note": (
            "按本地 L/D/P 股票池逐股、分日期段请求；"
            f"日期筛选按{'报告期' if date_field == 'end_date' else '公告日期'}，不切换 VIP 接口。"
        ),
        "incremental_note": (
            "补缺口并回查当前日期段；更早日期段的修订须全量重拉。保留重复报告期和修订记录，不宣称 PIT。"
        ),
    }
RECIPES.update(
    {
        "dividend": {
            "name": "分红送股",
            "entry_id": "103",
            "kind": "event",
            "start": "1990-12-19",
            "scope_note": "按自然日 ann_date 查询全部股票的分红公告，包含周末；允许无公告的日期为空。",
            "incremental_note": (
                "补新公告日和缺口，并回查近期公告；旧公告的实施进度修订可能需扩大窗口或全量重拉。"
            ),
        },
        "moneyflow": {
            "name": "个股资金流向",
            "entry_id": "170",
            "kind": "daily",
            "start": "2010-01-01",
            "scope_note": "按 SSE 市场基准日历查询接口全部股票资金流向；默认从 2010 年开始，按账号权限执行。",
            "incremental_note": "补新日期和历史缺口，并回查近期；行数触顶后可生成按股票拆分的确认计划。",
        },
    }
)
for dataset_id, recipe in RECIPES.items():
    recipe.update(id=dataset_id, version=1)
RECIPES.update(catalog_recipes(ENTRIES, RECIPES))


class DatasetSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    raw_root: str
    start_date: date = FIRST_DATE
    lookback_days: int = Field(default=7, ge=1, le=366)
    requests_per_minute: int = Field(default=DEFAULT_RPM, ge=1, le=500)
    options: dict[str, list[str]] = Field(default_factory=dict, max_length=8)

    @field_validator("raw_root")
    @classmethod
    def directory(cls, value):
        return str(absolute_directory(value))

    @field_validator("start_date")
    @classmethod
    def history_date(cls, value):
        if value < FIRST_DATE:
            raise ValueError("历史起点不能早于 1990-12-19")
        return value


class DatasetPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    settings: DatasetSettings
    expected_revision: int = Field(ge=0)
    mode: Literal["full", "incremental", "retry", "split"]
    end_date: date | None = None


class DatasetSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    settings: DatasetSettings
    expected_revision: int = Field(ge=0)


class DatasetLaunchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class DatasetGroupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    dataset_ids: list[str] = Field(min_length=1, max_length=32)


class DatasetBundleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dataset_ids: list[str] = Field(min_length=1, max_length=32)
    mode: Literal["full", "incremental", "retry"] = "incremental"
    end_date: date | None = None
    continuation_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


class DependencyRequired(CollectorError):
    def __init__(self, dataset_id, message):
        super().__init__(message)
        self.dataset_id = dataset_id


def china_today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()


def recipe_for(dataset_id):
    if dataset_id not in RECIPES:
        raise CollectorError("预置数据集不存在")
    return RECIPES[dataset_id]


def history_start(recipe, settings):
    return (
        max(settings.start_date, date.fromisoformat(recipe["start"]))
        if "rule" in recipe
        else settings.start_date
    )


def scope_for(recipe, settings):
    entry = ENTRIES[recipe["entry_id"]]
    identity = {key: recipe[key] for key in ("id", "version", "kind", "entry_id")}
    for key in ("local_limit", "date_field", "window_years"):
        if key in recipe:
            identity[key] = recipe[key]
    options = effective_options(recipe, settings)
    if "rule" in recipe:
        identity.update(rule=recipe["rule"], options=options)
    return digest(
        {
            "recipe": identity,
            "fields": [field["name"] for field in entry["fields"]],
            "row_limit": entry["row_limit"],
            "raw_root": settings.raw_root,
        }
    )


def calendar_rows(frame, params):
    required = {"exchange", "cal_date", "is_open"}
    if not required.issubset(frame.columns):
        raise CollectionFailure("交易日历缺少 exchange / cal_date / is_open")
    start = datetime.strptime(params["start_date"], "%Y%m%d").date()
    end = datetime.strptime(params["end_date"], "%Y%m%d").date()
    expected = {(start + timedelta(days=n)).strftime("%Y%m%d") for n in range((end - start).days + 1)}
    result = {}
    for row in frame[["exchange", "cal_date", "is_open"]].itertuples(index=False, name=None):
        exchange, day, opened = map(str, row)
        if exchange != params["exchange"] or day not in expected or day in result or opened not in {"0", "1"}:
            raise CollectionFailure("交易日历包含重复、缺失标记或请求范围之外的记录")
        result[day] = opened == "1"
    if set(result) != expected:
        raise CollectionFailure("交易日历没有覆盖所请求年度的完整日期，不能把缺失日期当作休市")
    return result


def validate_dataset_response(recipe, response, params):
    if recipe["version"] != 1 or response.frame is None:
        raise CollectionFailure("预置数据集需要受支持的官方 SDK DataFrame")
    frame = response.frame
    if "rule" in recipe:
        validate_catalog_response(recipe, frame, params)
        return
    if recipe["kind"] == "calendar":
        calendar_rows(frame, params)
        return
    if "ts_code" not in frame.columns:
        raise CollectionFailure("数据集缺少股票代码")
    codes = frame["ts_code"].tolist()
    if any(
        not is_stock_code(code, historical=recipe["id"] in {"stock_basic", "dividend"}) for code in codes
    ):
        raise CollectionFailure("数据集返回了无效或非沪深北股票代码")
    if params.get("ts_code") and any(code != params["ts_code"] for code in codes):
        raise CollectionFailure("返回的股票与请求代码不一致")
    if recipe["kind"] in {"financial", "event"}:
        column = recipe.get("date_field", "ann_date")
        if column not in frame.columns:
            raise CollectionFailure(f"返回数据缺少 {column}")
        start = params.get("start_date", params.get("ann_date"))
        end = params.get("end_date", params.get("ann_date"))
        for value in frame[column]:
            day = str(value)
            if not re.fullmatch(r"\d{8}", day):
                raise CollectionFailure(f"返回数据的 {column} 不是八位日期")
            try:
                datetime.strptime(day, "%Y%m%d")
            except ValueError:
                raise CollectionFailure(f"返回数据的 {column} 不是有效日期") from None
            if not start <= day <= end:
                raise CollectionFailure(f"返回数据的 {column} 超出请求范围")
        return
    if frame["ts_code"].duplicated().any():
        raise CollectionFailure("同一请求返回重复股票代码")
    if recipe["kind"] == "daily":
        if frame.empty and not params.get("ts_code"):
            raise CollectionFailure("全市场开市日返回为空，不能推进覆盖")
        if "trade_date" not in frame.columns or any(
            str(value) != params["trade_date"] for value in frame["trade_date"]
        ):
            raise CollectionFailure("返回的交易日期与请求切片不一致")
    else:
        if params["list_status"] == "L" and frame.empty:
            raise CollectionFailure("上市股票列表为空，不能视为完整快照")
        suffix = {"SSE": ".SH", "SZSE": ".SZ", "BSE": ".BJ"}[params["exchange"]]
        if any(not code.endswith(suffix) for code in codes):
            raise CollectionFailure("股票列表返回的股票与所请求交易所不一致")
        if "list_status" not in frame.columns or any(
            str(value) != params["list_status"] for value in frame["list_status"]
        ):
            raise CollectionFailure("股票列表返回的上市状态与请求不一致")


class DatasetService:
    def __init__(self, store, default_raw_root):
        self.store, self.default_raw_root = store, str(default_raw_root)

    def settings(self, db, dataset_id):
        recipe = recipe_for(dataset_id)
        row = db.execute("SELECT * FROM dataset_settings WHERE dataset_id=?", (dataset_id,)).fetchone()
        if row:
            return DatasetSettings.model_validate_json(row["settings_json"]), row["revision"]
        return DatasetSettings(raw_root=self.default_raw_root, start_date=recipe["start"]), 0

    @staticmethod
    def active(db, dataset_id):
        row = db.execute(
            "SELECT r.id FROM runs r JOIN dataset_runs d ON d.run_id=r.id "
            "WHERE d.dataset_id=? AND r.state IN ('queued','running')",
            (dataset_id,),
        ).fetchone()
        return row["id"] if row else None

    def save_settings(self, dataset_id, settings, expected_revision):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            revision = self._save_settings(db, dataset_id, settings, expected_revision)
        return {"settings": settings.model_dump(mode="json"), "revision": revision}

    def _save_settings(self, db, dataset_id, settings, expected_revision):
        effective_options(recipe_for(dataset_id), settings)
        if self.active(db, dataset_id):
            raise CollectorError("此数据集已有活动运行，请先查看进度，结束后再修改设置或生成计划")
        row = db.execute("SELECT * FROM dataset_settings WHERE dataset_id=?", (dataset_id,)).fetchone()
        revision = row["revision"] if row else 0
        if revision != expected_revision:
            raise CollectorError("数据集设置已修改，请关闭后重新打开，再检查计划")
        if row and json.loads(row["settings_json"]) == settings.model_dump(mode="json"):
            return revision
        revision += 1
        db.execute(
            "INSERT INTO dataset_settings VALUES(?,?,?,?) ON CONFLICT(dataset_id) DO UPDATE SET "
            "settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at",
            (dataset_id, encode(settings.model_dump(mode="json")), revision, now()),
        )
        return revision

    @staticmethod
    def records(db, dataset_id, scope, *, evidence=False):
        columns = (
            "s.*,s.rowid AS source_order"
            if evidence
            else "s.id,s.run_id,s.state,s.rows,s.error,s.error_kind,s.params_json,"
            "s.raw_path IS NOT NULL AS has_data"
        )
        rows = db.execute(
            f"SELECT p.partition_key,{columns},r.created_at,"
            "EXISTS(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id) AS archive_deleted,"
            "EXISTS(SELECT 1 FROM archive_deletions x JOIN warehouse_cleanups w "
            "ON w.deletion_id=x.id WHERE x.slice_id=s.id) AS warehouse_cleaned,"
            "COALESCE(MAX(a.finished_at),r.created_at) AS observed_at "
            "FROM dataset_runs d JOIN runs r ON r.id=d.run_id JOIN slices s ON s.run_id=r.id "
            "JOIN dataset_partitions p ON p.slice_id=s.id LEFT JOIN attempts a ON a.slice_id=s.id "
            "WHERE d.dataset_id=? AND d.scope=? AND NOT EXISTS "
            "(SELECT 1 FROM dataset_splits x WHERE x.dataset_id=d.dataset_id AND x.scope=d.scope "
            "AND x.parent_key=p.partition_key) GROUP BY s.id ORDER BY observed_at,s.rowid",
            (dataset_id, scope),
        ).fetchall()
        latest, successful = {}, {}
        for row in rows:
            # Keep the scope stable to reuse genuine SSE evidence from old dual-exchange runs.
            if (
                dataset_id == "trade_cal"
                and json.loads(row["params_json"]).get("exchange") != MARKET_CALENDAR_EXCHANGE
            ):
                continue
            record = dict(row)
            if record["warehouse_cleaned"]:
                record.update(has_data=False, raw_available=False, storage="warehouse")
            elif record["archive_deleted"]:
                record.update(
                    state="failed",
                    error="原始归档已删除，需重新检查采集计划",
                    error_kind="archive_deleted",
                    has_data=False,
                )
            latest[row["partition_key"]] = record
            if record["state"] == "succeeded" and not (evidence and record["warehouse_cleaned"]):
                successful[row["partition_key"]] = record
        return latest, successful

    def list(self):
        result = []
        with self.store.connect() as db:
            db.execute("BEGIN")
            for dataset_id, recipe in RECIPES.items():
                available_through = min(
                    (china_today() - timedelta(days=1)).isoformat(),
                    recipe.get("rule", {}).get("available_until", "9999-12-31"),
                )
                try:
                    settings, revision = self.settings(db, dataset_id)
                    scope_for(recipe, settings)
                except (ValidationError, CollectorError):
                    row = db.execute(
                        "SELECT * FROM dataset_settings WHERE dataset_id=?", (dataset_id,)
                    ).fetchone()
                    result.append(
                        {
                            **recipe,
                            "access": ENTRIES[recipe["entry_id"]]["access"],
                            "doc_url": ENTRIES[recipe["entry_id"]]["doc_url"],
                            "permission": ENTRIES[recipe["entry_id"]]["permission_note"],
                            "settings": json.loads(row["settings_json"])
                            if row
                            else {
                                "raw_root": self.default_raw_root,
                                "start_date": recipe["start"],
                                "lookback_days": 7,
                                "requests_per_minute": DEFAULT_RPM,
                            },
                            "revision": row["revision"] if row else 0,
                            "settings_error": "保存目录或设置已无效，请修正后保存",
                            "covered_partitions": None,
                            "unfinished_partitions": None,
                            "row_limit_partitions": None,
                            "first_partition": None,
                            "last_partition": None,
                            "last_run": None,
                            "active_run": self.active(db, dataset_id),
                            "available_through": available_through,
                            "coverage": "settings_invalid",
                        }
                    )
                    continue
                latest, successful = self.records(db, dataset_id, scope_for(recipe, settings))
                last = db.execute(
                    "SELECT r.id,r.state,r.created_at,r.error,d.mode,d.scope FROM dataset_runs d "
                    "JOIN runs r ON r.id=d.run_id WHERE d.dataset_id=? ORDER BY r.created_at DESC LIMIT 1",
                    (dataset_id,),
                ).fetchone()
                keys = sorted(successful)
                result.append(
                    {
                        **recipe,
                        "access": ENTRIES[recipe["entry_id"]]["access"],
                        "doc_url": ENTRIES[recipe["entry_id"]]["doc_url"],
                        "permission": ENTRIES[recipe["entry_id"]]["permission_note"],
                        "settings": settings.model_dump(mode="json"),
                        "revision": revision,
                        "scope": scope_for(recipe, settings),
                        "covered_partitions": len(successful),
                        "first_partition": keys[0] if keys else None,
                        "last_partition": keys[-1] if keys else None,
                        "unfinished_partitions": sum(row["state"] != "succeeded" for row in latest.values()),
                        "row_limit_partitions": sum(
                            row["error_kind"] == "row_limit" for row in latest.values()
                        ),
                        "last_run": dict(last) if last else None,
                        "active_run": self.active(db, dataset_id),
                        "available_through": available_through,
                        "coverage": "registered_success_not_proven_complete",
                    }
                )
        return result

    def coverage(self, dataset_id, offset=0, limit=50, query="", state=None):
        recipe = recipe_for(dataset_id)
        if offset < 0 or not 1 <= limit <= 200 or len(query) > 200:
            raise CollectorError("覆盖台账分页参数不正确")
        if state is not None and state not in {"pending", "running", "succeeded", "failed"}:
            raise CollectorError("覆盖台账状态筛选不正确")
        with self.store.connect() as db:
            db.execute("BEGIN")
            try:
                settings, revision = self.settings(db, dataset_id)
            except ValidationError:
                raise CollectorError("数据集设置或目录已无效，请先修正设置") from None
            latest, successful = self.records(db, dataset_id, scope_for(recipe, settings))
        items = []
        for key, row in sorted(latest.items()):
            if (state and row["state"] != state) or not all(
                token.lower() in key.lower() for token in query.split()
            ):
                continue
            success = successful.get(key)
            items.append(
                {
                    "key": key,
                    "state": row["state"],
                    "error_kind": row["error_kind"],
                    "rows": row["rows"],
                    "error": row["error"],
                    "run_id": row["run_id"],
                    "slice_id": row["id"],
                    "has_data": bool(row["has_data"]),
                    "warehouse_cleaned": bool(row["warehouse_cleaned"]),
                    "last_updated": row["observed_at"],
                    "successful_run_id": success["run_id"] if success else None,
                    "successful_slice_id": success["id"] if success else None,
                    "successful_rows": success["rows"] if success else None,
                }
            )
        return {
            "dataset_id": dataset_id,
            "raw_root": settings.raw_root,
            "settings_revision": revision,
            "total": len(items),
            "registered_partitions": len(latest),
            "offset": offset,
            "limit": limit,
            "next_offset": offset + limit if offset + limit < len(items) else None,
            "items": items[offset : offset + limit],
        }

    def _calendar(self, db, start, end):
        recipe = RECIPES["trade_cal"]
        if self.active(db, "trade_cal"):
            raise CollectorError("交易日历正在采集，请等待完成后重新检查日频计划")
        settings, revision = self.checked_settings(db, "trade_cal")
        latest, successful = self.records(db, "trade_cal", scope_for(recipe, settings), evidence=True)
        flags = {MARKET_CALENDAR_EXCHANGE: {}}
        references = []
        warnings = ["交易日基准：SSE 上交所；沪深北沿用此市场日历，不推断个股停牌，不伪造 SZSE 归档。"]
        for year in range(start.year, end.year + 1):
            for exchange in flags:
                key = f"{exchange}:{year}"
                row = successful.get(key)
                if row is None:
                    raise DependencyRequired(
                        "trade_cal",
                        f"本地交易日历缺少 {key}；请先初始化或更新“交易日历”，计划检查不会请求供应商",
                    )
                item = {**row, "config": {"raw_root": settings.raw_root}}
                try:
                    raw, _, _ = source_paths(item)
                    if raw.suffix != ".parquet":
                        raise CollectorError("预置交易日历必须为 SDK Parquet")
                    with verified_open(raw, item["raw_sha256"]) as stream:
                        frame = pq.read_table(stream).to_pandas()
                    flags[exchange].update(calendar_rows(frame, json.loads(row["params_json"])))
                except (OSError, pa.ArrowException, CollectionFailure, CollectorError) as error:
                    raise DependencyRequired(
                        "trade_cal", f"交易日历归档不可用，请重新采集 {key}：{error}"
                    ) from None
                references.append(
                    [
                        key,
                        row["id"],
                        row["raw_sha256"],
                        row["meta_sha256"],
                        latest[key]["id"],
                        latest[key]["state"],
                        latest[key]["observed_at"],
                    ]
                )
                if latest[key]["state"] != "succeeded":
                    warnings.append(f"{key} 最近更新未成功，当前使用此前成功的日历快照")
        days = []
        for n in range((end - start).days + 1):
            day = (start + timedelta(days=n)).strftime("%Y%m%d")
            if day not in flags[MARKET_CALENDAR_EXCHANGE]:
                raise DependencyRequired(
                    "trade_cal", f"本地交易日历缺少日期 {day}，请先补齐日历，不能推断为休市"
                )
            if flags[MARKET_CALENDAR_EXCHANGE][day]:
                days.append(day)
        return days, [revision, references], warnings

    def _universe(self, db, statuses=("L", "D", "P"), *, lifetimes=False):
        if self.active(db, "stock_basic"):
            raise CollectorError("股票列表正在采集，请结束后重新检查股票池计划")
        settings, revision = self.checked_settings(db, "stock_basic")
        latest, successful = self.records(
            db, "stock_basic", scope_for(RECIPES["stock_basic"], settings), evidence=True
        )
        codes, references, warnings, bounds = set(), [], [], {}
        for exchange in ("SSE", "SZSE", "BSE"):
            for status in statuses:
                key = f"{exchange}:{status}"
                row = successful.get(key)
                if row is None:
                    raise DependencyRequired("stock_basic", f"本地股票池缺少 {key}，请先采集“股票列表”")
                try:
                    raw, _, _ = source_paths({**row, "config": {"raw_root": settings.raw_root}})
                    with verified_open(raw, row["raw_sha256"]) as stream:
                        frame = pq.read_table(stream).to_pandas()
                    validate_dataset_response(
                        RECIPES["stock_basic"],
                        Response(None, None, frame=frame),
                        json.loads(row["params_json"]),
                    )
                    if lifetimes:
                        for item in frame.to_dict("records"):
                            listed = response_day(item.get("list_date")).strftime("%Y%m%d")
                            delisted = item.get("delist_date")
                            final = (
                                response_day(delisted).strftime("%Y%m%d")
                                if isinstance(delisted, str) and delisted.strip()
                                else "99991231"
                            )
                            if final < listed:
                                raise CollectionFailure("股票上市日期晚于退市日期，不能确定 SDK 查询范围")
                            bounds[item["ts_code"]] = (listed, final)
                except (OSError, pa.ArrowException, CollectionFailure, CollectorError) as error:
                    raise DependencyRequired(
                        "stock_basic", f"股票池归档不可用，请重新采集 {key}：{error}"
                    ) from None
                codes.update(frame["ts_code"].tolist())
                references.append(
                    [
                        key,
                        row["id"],
                        row["raw_sha256"],
                        row["meta_sha256"],
                        latest[key]["id"],
                        latest[key]["state"],
                        latest[key]["observed_at"],
                    ]
                )
                if latest[key]["state"] != "succeeded":
                    warnings.append(f"{key} 最近更新未成功，使用此前成功的股票池快照")
        return bounds if lifetimes else sorted(codes), [revision, references], warnings

    def _reference_pool(self, db, dataset_id, start, end):
        if dataset_id == "stock_basic":
            return self._universe(db)
        recipe = recipe_for(dataset_id)
        if self.active(db, dataset_id):
            raise CollectorError(f"依赖 {recipe['name']} 正在采集，请等待结束后重新检查")
        settings, revision = self.checked_settings(db, dataset_id)
        defaults = settings.model_copy(update={"options": {}})
        if effective_options(recipe, settings) != effective_options(recipe, defaults):
            raise DependencyRequired(
                dataset_id, f"板块池 {recipe['name']} 尚未包含全部预置分类，请先准备完整分类"
            )
        source_settings = settings.model_copy(update={"start_date": start})
        expected, references, warnings, _ = self._catalog_candidates(
            db, recipe, source_settings, "full", end, {}
        )
        latest, successful = self.records(db, dataset_id, scope_for(recipe, settings), evidence=True)
        expected = self.expand(expected, self.split_definitions(db, dataset_id, scope_for(recipe, settings)))
        codes = set()
        evidence = []
        for key, _ in expected:
            row = successful.get(key)
            if row is None:
                raise DependencyRequired(
                    dataset_id, f"本地 {recipe['name']} 缺少分类分区 {key}，需先准备板块代码池"
                )
            try:
                raw, _, _ = source_paths({**row, "config": {"raw_root": settings.raw_root}})
                with verified_open(raw, row["raw_sha256"]) as stream:
                    frame = pq.read_table(stream).to_pandas()
                validate_dataset_response(
                    recipe, Response(None, None, frame=frame), json.loads(row["params_json"])
                )
            except (OSError, pa.ArrowException, CollectionFailure, CollectorError) as error:
                raise DependencyRequired(dataset_id, f"板块分类归档不可用，请重采 {key}：{error}") from None
            codes.update(frame["ts_code"].tolist())
            evidence.append(
                [
                    key,
                    row["id"],
                    row["raw_sha256"],
                    row["meta_sha256"],
                    latest[key]["id"],
                    latest[key]["state"],
                    latest[key]["observed_at"],
                ]
            )
            if latest[key]["state"] != "succeeded":
                warnings.append(f"{recipe['name']} {key} 最近刷新失败，使用此前成功归档")
        if not codes:
            raise CollectorError(
                f"{recipe['name']} 在所选范围内没有任何板块代码；请核对历史起点、接口权限和分类数据"
            )
        return sorted(codes), [revision, references, evidence], warnings

    def _catalog_candidates(self, db, recipe, settings, mode, target, latest):
        spec = recipe["rule"]
        effective_options(recipe, settings)
        start = history_start(recipe, settings)
        end = min(target, date.fromisoformat(spec.get("available_until", target.isoformat())))
        warnings, references = [], []
        if spec.get("archive_only") and mode in {"incremental", "retry", "split"}:
            if not latest:
                raise CollectorError("此接口已停更；请先选择历史范围进行首次采集，增量不会追新日期")
            end = min(
                end,
                max(
                    response_day(json.loads(row["params_json"])[spec["date_param"]])
                    if spec["date_param"] != "range"
                    else response_day(json.loads(row["params_json"])["end_date"])
                    for row in latest.values()
                ),
            )
            target = end
            warnings.append(f"接口已停更：本次仅处理截至 {end.isoformat()} 的已登记历史，不生成新日期。")
        if recipe["kind"] != "snapshot" and start > end:
            available_until = spec.get("available_until", target.isoformat())
            raise CollectorError(f"所选日期不包含接口可用历史：{recipe['start']} 至 {available_until}")
        if start != settings.start_date or end != target:
            warnings.append(f"按接口可用边界裁剪实际查询范围：{start.isoformat()} 至 {end.isoformat()}。")
        trading = []
        strategy = spec["strategy"]
        if strategy in {"trading_day", "stock_day", "stock_minute", "board_day", "time_day"}:
            trading, refs, notes = self._calendar(db, start, end)
            references.append(refs)
            warnings.extend(notes)
        codes, lifetimes = [None], None
        source = spec.get("pool")
        if strategy in {
            "stock_window",
            "stock_quarter",
            "stock_day",
            "stock_minute",
            "stock_snapshot",
            "derived",
            "realtime",
        }:
            source = source or "stock_basic"
        if source:
            if strategy == "realtime":
                codes, refs, notes = self._universe(db, ("L",))
            elif strategy == "derived":
                lifetimes, refs, notes = self._universe(db, lifetimes=True)
                codes = sorted(lifetimes)
            else:
                codes, refs, notes = self._reference_pool(
                    db, source, start, min(end, china_today() - timedelta(days=1))
                )
            references.append(refs)
            warnings.extend(notes)
            if strategy != "realtime":
                column = spec.get("code_param", "ts_code")
                known = {
                    json.loads(row["params_json"])[column]
                    for row in latest.values()
                    if column in json.loads(row["params_json"])
                }
                if known - set(codes):
                    warnings.append("保留本数据集已登记的历史代码，不因当前股票或板块分类变化而遗忘旧分区。")
                codes = sorted(set(codes) | known)
                if lifetimes is not None and set(codes) - set(lifetimes):
                    raise CollectorError("历史代码缺少可验证的上市日期；请补齐股票主表，不推测 SDK 计算范围")
            if not codes:
                raise CollectorError("依赖代码池为空，不能生成零请求的股票/板块采集计划")
        if spec.get("archive_only"):
            warnings.append("供应商已停更；空返回不证明账号覆盖该历史区间，执行成功不表示数据仍在更新。")
        if strategy in {"stock_window", "stock_day", "stock_quarter", "stock_minute", "derived"}:
            warnings.append(
                "股票池来自当前可见的 L/D/P 归档及本数据集历史代码，不是完整历史证券主表或历史时点成分。"
            )
        return (
            candidates_for(recipe, settings, start, end, trading, codes, lifetimes),
            references,
            warnings,
            target,
        )

    @staticmethod
    def split_definitions(db, dataset_id, scope):
        return {
            row["parent_key"]: json.loads(row["definition_json"])
            for row in db.execute(
                "SELECT parent_key,definition_json FROM dataset_splits WHERE dataset_id=? AND scope=?",
                (dataset_id, scope),
            )
        }

    @staticmethod
    def expand(candidates, definitions):
        result = []

        def visit(key, params, depth=0):
            if depth > 32 or len(result) > MAX_SLICES * 10:
                raise CollectorError("拆分候选范围过大或过深，请缩小历史范围")
            definition = definitions.get(key)
            if definition is None:
                result.append((key, params))
            elif definition["kind"] == "stocks":
                for code in definition["codes"]:
                    visit(f"{key}@{code}", {**params, definition.get("param", "ts_code"): code}, depth + 1)
            else:
                boundary = definition["boundary"]
                if params["start_date"] <= boundary:
                    visit(f"{key}/L", {**params, "end_date": min(boundary, params["end_date"])}, depth + 1)
                next_day = (datetime.strptime(boundary, "%Y%m%d").date() + timedelta(days=1)).strftime(
                    "%Y%m%d"
                )
                if params["end_date"] >= next_day:
                    visit(
                        f"{key}/R", {**params, "start_date": max(next_day, params["start_date"])}, depth + 1
                    )

        for key, params in candidates:
            visit(key, params)
        return result

    def _build(self, db, dataset_id, settings, mode, target, global_rpm):
        recipe = recipe_for(dataset_id)
        if mode not in MODES:
            raise CollectorError("不支持的数据集采集模式")
        today = china_today()
        if recipe["kind"] != "snapshot" and not settings.start_date <= target <= today - timedelta(days=1):
            raise CollectorError(
                "日期范围须从历史起点开始，截止日不得晚于上海时间昨天；不采集尚未发布的当日数据"
            )
        latest, successful = self.records(db, dataset_id, scope_for(recipe, settings))
        references, warnings = [], []
        candidates = []
        if "rule" in recipe:
            if recipe["kind"] == "snapshot":
                target = today
            candidates, references, warnings, target = self._catalog_candidates(
                db, recipe, settings, mode, target, latest
            )
        elif recipe["kind"] == "snapshot":
            target = today
            candidates = [
                (f"{exchange}:{status}", {"exchange": exchange, "list_status": status})
                for exchange in ("SSE", "SZSE", "BSE")
                for status in ("L", "D", "P", "G", "UN")
            ]
        elif recipe["kind"] == "calendar":
            for year in range(settings.start_date.year, target.year + 1):
                for exchange in (MARKET_CALENDAR_EXCHANGE,):
                    candidates.append(
                        (
                            f"{exchange}:{year}",
                            {
                                "exchange": exchange,
                                "start_date": max(FIRST_DATE, date(year, 1, 1)).strftime("%Y%m%d"),
                                "end_date": date(year, 12, 31).strftime("%Y%m%d"),
                            },
                        )
                    )
        elif recipe["kind"] == "financial":
            codes, references, warnings = self._universe(db)
            known_codes = {json.loads(row["params_json"])["ts_code"] for row in latest.values()}
            if known_codes - set(codes):
                warnings.append(
                    "股票池不再包含部分已登记股票；保留本目录历史股票代码，避免漏掉已有失败分区。"
                )
            codes = sorted(set(codes) | known_codes)
            first_year = FIRST_DATE.year + ((settings.start_date.year - FIRST_DATE.year) // 16) * 16
            for year in range(first_year, target.year + 1, 16):
                start = max(settings.start_date, date(year, 1, 1)).strftime("%Y%m%d")
                end = min(target, date(year + 15, 12, 31)).strftime("%Y%m%d")
                candidates.extend(
                    (f"{code}:{year}", {"ts_code": code, "start_date": start, "end_date": end})
                    for code in codes
                )
        elif recipe["kind"] == "event":
            candidates = [
                (day.strftime("%Y%m%d"), {"ann_date": day.strftime("%Y%m%d")})
                for day in (
                    settings.start_date + timedelta(days=n)
                    for n in range((target - settings.start_date).days + 1)
                )
            ]
        else:
            days, references, warnings = self._calendar(db, settings.start_date, target)
            candidates = [(day, {"trade_date": day}) for day in days]
        definitions = self.split_definitions(db, dataset_id, scope_for(recipe, settings))
        candidates = self.expand(candidates, definitions)
        proposed = {}
        if mode == "split":
            pool = None
            for key, params in candidates:
                if latest.get(key, {}).get("error_kind") != "row_limit":
                    continue
                if "rule" in recipe:
                    spec = recipe["rule"]
                    if (
                        re.fullmatch(r"\d{8}", str(params.get("start_date", "")))
                        and re.fullmatch(r"\d{8}", str(params.get("end_date", "")))
                        and params["start_date"] < params["end_date"]
                        and params.get("adj") != "qfq"
                    ):
                        start = response_day(params["start_date"])
                        end = response_day(params["end_date"])
                        proposed[key] = {
                            "kind": "date",
                            "boundary": (start + (end - start) // 2).strftime("%Y%m%d"),
                        }
                    else:
                        source = spec.get("split_pool", "stock_basic" if spec["domain"] == "stock" else None)
                        for column, mapping in spec.get("split_pools", {}).items():
                            source = mapping.get(params.get(column))
                        code_param = spec.get("split_param", spec.get("code_param", "ts_code"))
                        if source and not params.get(code_param):
                            codes, refs, notes = self._reference_pool(
                                db, source, settings.start_date, min(target, today - timedelta(days=1))
                            )
                            references.append(refs)
                            warnings.extend(notes)
                            suffix = {
                                "SSE": ".SH",
                                "SH": ".SH",
                                "SZSE": ".SZ",
                                "SZ": ".SZ",
                                "BSE": ".BJ",
                                "BJ": ".BJ",
                            }.get(params.get("exchange"))
                            if source == "stock_basic" and suffix:
                                codes = [code for code in codes if code.endswith(suffix)]
                            if codes:
                                proposed[key] = {
                                    "kind": "stocks",
                                    "codes": codes,
                                    "param": code_param,
                                    "source_refs": refs,
                                }
                elif recipe["kind"] in {"daily", "event"} and not params.get("ts_code"):
                    if pool is None:
                        pool, pool_refs, pool_warnings = self._universe(db)
                        references.append(pool_refs)
                        warnings.extend(pool_warnings)
                    proposed[key] = {"kind": "stocks", "codes": pool, "source_refs": pool_refs}
                elif recipe["kind"] == "financial" and params["start_date"] < params["end_date"]:
                    start = datetime.strptime(params["start_date"], "%Y%m%d").date()
                    end = datetime.strptime(params["end_date"], "%Y%m%d").date()
                    proposed[key] = {
                        "kind": "date",
                        "boundary": (start + (end - start) // 2).strftime("%Y%m%d"),
                    }
            if not proposed:
                raise CollectorError(
                    "没有可继续拆分的行数触顶切片；普通失败请补采，单日单股仍触顶时需人工核对接口"
                )
            candidates = self.expand(
                [(key, params) for key, params in candidates if key in proposed], proposed
            )
        window_start = target - timedelta(days=settings.lookback_days - 1)
        partitions = []
        for key, params in candidates:
            unfinished = key in latest and latest[key]["state"] != "succeeded"
            success_params = json.loads(successful[key]["params_json"]) if key in successful else {}
            missing = key not in successful or (
                (
                    recipe["kind"] == "financial"
                    or recipe.get("rule", {}).get("strategy") in {"stock_window", "derived"}
                )
                and (
                    success_params.get("start_date", "99999999") > params["start_date"]
                    or success_params.get("end_date", "") < params["end_date"]
                )
            )
            recent = (
                recent_partition(recipe, params, key, window_start, target)
                if "rule" in recipe
                else recipe["kind"] == "snapshot"
                or (
                    int(key.split(":")[-1]) >= window_start.year
                    if recipe["kind"] == "calendar"
                    else params.get("end_date", params.get("trade_date", params.get("ann_date", "")))
                    >= window_start.strftime("%Y%m%d")
                )
            )
            reason = None
            if mode in {"full", "split"}:
                reason = "full" if mode == "full" else "split"
            elif mode == "retry":
                if unfinished:
                    reason = "retry"
            elif unfinished:
                reason = "retry"
            elif missing:
                reason = "missing"
            elif recent:
                reason = "refresh"
            if reason:
                partitions.append({"key": key, "params": params, "reason": reason})
        if len(partitions) > MAX_SLICES:
            raise CollectorError(f"数据集计划超过 {MAX_SLICES} 个切片，请缩小日期范围")
        entry = ENTRIES[recipe["entry_id"]]
        warnings.append(entry["permission_note"])
        if entry["access"]["note"]:
            warnings.append(entry["access"]["note"])
        fields = ",".join(field["name"] for field in entry["fields"])
        config = TaskConfig(
            name=f"{recipe['name']} · {MODES[mode]} · {target.isoformat()}",
            entry_id=recipe["entry_id"],
            raw_root=settings.raw_root,
            fields=fields,
            requests_per_minute=settings.requests_per_minute,
            allow_empty=recipe.get("rule", {}).get("allow_empty", False)
            or recipe["kind"] in {"snapshot", "financial", "event"}
            or any(item["params"].get("ts_code") for item in partitions),
            row_limit=recipe.get("local_limit"),
        )
        for partition in partitions:
            plan(config.model_copy(update={"params": partition["params"]}))
        counts = {
            reason: sum(item["reason"] == reason for item in partitions)
            for reason in ("full", "missing", "retry", "refresh", "split")
        }
        warnings += [
            "全量仅指指定区间及账号权限内的预置请求范围；执行成功不证明全市场覆盖。",
            "覆盖台账依据已登记的成功切片，不是文件完整性审计；预览、导出和原配置续跑会校验文件。",
            "Raw 按运行和切片独立归档，不自动合并或去重；回查窗口之外的修订不保证发现。",
        ]
        if recipe["kind"] == "daily":
            warnings.append(
                "交易日基准：SSE 上交所；沪深北沿用此市场日历，不判断个股停牌。"
                "开市日空响应会失败，不推进覆盖。"
            )
        warnings.append("达到接口或预置检查行数上限会失败，不自动分页。")
        if recipe.get("local_limit") and not entry["row_limit"]:
            warnings.append(
                f"目录未给出明确上限，使用 {recipe['local_limit']} 行检查阈值；"
                "触顶后须检查是否存在安全拆分方式。"
            )
        if definitions or proposed:
            warnings.append(
                "已拆分父切片保留在原运行中，不计入未完成；按当次确认的股票池固定拆分，不证明池外覆盖，也不随新股票池自动扩展历史拆分。"
            )
        if recipe["kind"] == "financial":
            warnings.append(
                "日期参数按本接口公告日或报告期语义执行；增量回查当前日期段，旧段修订需全量重拉。空区间只代表本次无返回，不证明账号拥有完整历史。"
            )
        if entry["row_limit"] is None:
            warnings.append("接口目录未给出明确行数上限，无法仅凭返回数量排除截断。")
        result = {
            "dataset_id": dataset_id,
            "recipe": recipe,
            "entry": entry,
            "mode": mode,
            "settings": settings.model_dump(mode="json"),
            "start_date": settings.start_date.isoformat(),
            "end_date": target.isoformat(),
            "scope": scope_for(recipe, settings),
            "partitions": partitions,
            "proposed_splits": proposed,
            "total_slices": len(partitions),
            "candidate_partitions": len(candidates),
            "covered_partitions": sum(key in successful for key, _ in candidates),
            "counts": counts,
            "warnings": warnings,
            "config": config.model_dump(mode="json"),
            "effective_rpm": effective_rpm(recipe["entry_id"], settings.requests_per_minute, global_rpm),
            "estimated_seconds": len(partitions)
            * 60
            / effective_rpm(recipe["entry_id"], settings.requests_per_minute, global_rpm),
        }
        if "rule" in recipe:
            result["options"] = effective_options(recipe, settings)
            supplier_requests = sum(
                2 if recipe["rule"]["strategy"] == "derived" and part["params"].get("adj") else 1
                for part in partitions
            )
            result["supplier_requests"] = supplier_requests
            result["estimated_seconds"] = supplier_requests * 60 / result["effective_rpm"]
            warnings.append(recipe["scope_note"])
            warnings.append(recipe["incremental_note"])
        result["fingerprint"] = digest(
            {
                "recipe": recipe,
                "entry": entry,
                "config": result["config"],
                "settings": result["settings"],
                "mode": mode,
                "target": target.isoformat(),
                "partitions": partitions,
                "splits": definitions,
                "proposed_splits": proposed,
                "calendar": references,
                "basis": [
                    [key, row["id"], row["state"], row["rows"], row["observed_at"]]
                    for key, row in sorted(latest.items())
                ],
            }
        )
        return result

    def create_plan(self, dataset_id, body, global_rpm):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            recipe_for(dataset_id)
            row = db.execute(
                "SELECT revision FROM dataset_settings WHERE dataset_id=?", (dataset_id,)
            ).fetchone()
            revision = row["revision"] if row else 0
            if revision != body.expected_revision:
                raise CollectorError("数据集设置已修改，请关闭后重新打开，再检查计划")
            if self.active(db, dataset_id):
                raise CollectorError("此数据集已有活动运行，请结束后重新检查")
            target = body.end_date or (china_today() - timedelta(days=1))
            result = self._build(db, dataset_id, body.settings, body.mode, target, global_rpm)
            self._store_plan(db, result, revision)
        return result

    def review(self, dataset_id, body, global_rpm):
        try:
            return {"stage": "data", "plan": self.create_plan(dataset_id, body, global_rpm)}
        except DependencyRequired as error:
            dependency_id, reason = error.dataset_id, str(error)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT revision FROM dataset_settings WHERE dataset_id=?", (dataset_id,)
            ).fetchone()
            if (row["revision"] if row else 0) != body.expected_revision or self.active(db, dataset_id):
                raise CollectorError("原数据集设置或执行状态已变化，请重新检查")
            target = body.end_date or china_today() - timedelta(days=1)
            source_settings = body.settings.model_copy(
                update={"start_date": history_start(recipe_for(dataset_id), body.settings)}
            )
            result, revision, reasons = self._dependency_plan(
                db, dependency_id, source_settings, target, global_rpm
            )
            self._store_plan(db, result, revision)
        return {
            "stage": "dependencies",
            "reason": "；".join([reason, *reasons]),
            "plan": result,
            "source_dataset_id": dataset_id,
            "note": "只确认准备本项依赖；成功后自动返回原采集并重新检查，不自动启动原采集。",
        }

    def _dependency_plan(self, db, dataset_id, source_settings, target, global_rpm):
        seen, reasons = set(), []
        while dataset_id not in seen:
            seen.add(dataset_id)
            if self.active(db, dataset_id):
                raise CollectorError("依赖数据正在采集，请结束后重新检查")
            recipe = recipe_for(dataset_id)
            settings, revision = self.checked_settings(db, dataset_id)
            changes = {"raw_root": settings.raw_root if revision else source_settings.raw_root}
            if recipe["kind"] != "snapshot":
                changes["start_date"] = (
                    min(settings.start_date, source_settings.start_date)
                    if revision
                    else source_settings.start_date
                )
            if dataset_id in {"ths_index", "dc_index", "tdx_index"}:
                changes["options"] = {}
            settings = settings.model_copy(update=changes)
            try:
                return self._build(db, dataset_id, settings, "full", target, global_rpm), revision, reasons
            except DependencyRequired as error:
                dataset_id = error.dataset_id
                reasons.append(str(error))
                source_settings = settings
        raise CollectorError("预置数据依赖出现循环，不能生成采集计划")

    @staticmethod
    def _store_plan(db, result, revision):
        result.update(
            id=uuid.uuid4().hex,
            settings_revision=revision,
            created_at=now(),
            expires_at=(datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        )
        db.execute(
            "INSERT INTO dataset_plans(id,dataset_id,settings_revision,plan_json,created_at,expires_at) "
            "VALUES(?,?,?,?,?,?)",
            (
                result["id"],
                result["dataset_id"],
                revision,
                encode(result),
                result["created_at"],
                result["expires_at"],
            ),
        )

    def launch(self, dataset_id, plan_id, global_rpm):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = self._check_plan(db, dataset_id, plan_id, global_rpm)
            run_id, _ = self._enqueue_plan(db, current, plan_id)
        return self.store.run(run_id)

    def _check_plan(self, db, dataset_id, plan_id, global_rpm, *, allow_empty=False):
        recipe_for(dataset_id)
        stored = db.execute(
            "SELECT * FROM dataset_plans WHERE id=? AND dataset_id=?", (plan_id, dataset_id)
        ).fetchone()
        if stored is None or stored["run_id"]:
            raise CollectorError("计划不存在或已经提交，请重新检查计划")
        if datetime.fromisoformat(stored["expires_at"]) <= datetime.now(timezone.utc):
            raise CollectorError("计划已超过 30 分钟，请重新检查")
        if self.active(db, dataset_id):
            raise CollectorError("此数据集已有活动运行")
        row = db.execute("SELECT revision FROM dataset_settings WHERE dataset_id=?", (dataset_id,)).fetchone()
        revision = row["revision"] if row else 0
        if revision != stored["settings_revision"]:
            raise CollectorError("数据集设置已修改，请重新检查计划")
        previous = json.loads(stored["plan_json"])
        try:
            settings = DatasetSettings.model_validate(previous["settings"])
        except ValidationError:
            raise CollectorError("计划中的保存目录或设置已无效，请重新检查") from None
        current = self._build(
            db, dataset_id, settings, previous["mode"], date.fromisoformat(previous["end_date"]), global_rpm
        )
        if current["fingerprint"] != previous["fingerprint"]:
            raise CollectorError("覆盖台账、日历、股票池或预置规则已变化，请重新检查计划")
        if not current["partitions"] and not allow_empty:
            raise CollectorError("没有待采集切片，无需创建空运行")
        current["settings_revision"] = revision
        return current

    def _enqueue_plan(self, db, current, plan_id, batch_id=None):
        dataset_id, recipe, config = current["dataset_id"], current["recipe"], current["config"]
        self._save_settings(
            db, dataset_id, DatasetSettings.model_validate(current["settings"]), current["settings_revision"]
        )
        config_id, run_id, timestamp = uuid.uuid4().hex, uuid.uuid4().hex, now()
        db.execute(
            "INSERT INTO configs(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)",
            (config_id, config["name"], encode(config), timestamp, timestamp),
        )
        entry = {
            **ENTRIES[recipe["entry_id"]],
            "catalog_version": CATALOG["version"],
            "catalog_verified_at": CATALOG["verified_at"],
        }
        db.execute(
            "INSERT INTO runs(id,config_id,config_json,entry_json,state,total,created_at,batch_id) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (
                run_id,
                config_id,
                encode(config),
                encode(entry),
                "queued",
                current["total_slices"],
                timestamp,
                batch_id,
            ),
        )
        db.execute(
            "INSERT INTO dataset_runs VALUES(?,?,?,?,?,?)",
            (run_id, dataset_id, current["mode"], current["scope"], encode(recipe), plan_id),
        )
        for key, definition in current.get("proposed_splits", {}).items():
            db.execute(
                "INSERT INTO dataset_splits VALUES(?,?,?,?,?)",
                (dataset_id, current["scope"], key, encode(definition), timestamp),
            )
        for index, partition in enumerate(current["partitions"]):
            slice_id = uuid.uuid4().hex
            db.execute(
                "INSERT INTO slices(id,run_id,ordinal,params_json) VALUES(?,?,?,?)",
                (slice_id, run_id, index, encode(partition["params"])),
            )
            db.execute("INSERT INTO dataset_partitions VALUES(?,?)", (slice_id, partition["key"]))
        db.execute("UPDATE dataset_plans SET run_id=? WHERE id=?", (run_id, plan_id))
        self.store._activity_event(db, run_id, "run_queued", "info", "数据集运行已入队")
        return run_id, config_id

    @staticmethod
    def validate_datasets(dataset_ids):
        if not dataset_ids or len(set(dataset_ids)) != len(dataset_ids):
            raise CollectorError("请选择不重复的数据集")
        for dataset_id in dataset_ids:
            recipe_for(dataset_id)

    def checked_settings(self, db, dataset_id):
        try:
            return self.settings(db, dataset_id)
        except ValidationError:
            raise CollectorError(
                f"数据集“{RECIPES[dataset_id]['name']}”保存设置或目录已无效，请先修正"
            ) from None

    def groups(self):
        with self.store.connect() as db:
            return [
                {**dict(row), "dataset_ids": json.loads(row["dataset_ids_json"])}
                for row in db.execute("SELECT * FROM dataset_groups ORDER BY created_at DESC")
            ]

    def save_group(self, body):
        self.validate_datasets(body.dataset_ids)
        name = body.name.strip()
        if not name:
            raise CollectorError("组合名称不能为空")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM dataset_groups WHERE name=?", (name,)).fetchone():
                raise CollectorError("已有同名数据集组合")
            group_id = uuid.uuid4().hex
            db.execute(
                "INSERT INTO dataset_groups VALUES(?,?,?,?)",
                (group_id, name, encode(body.dataset_ids), now()),
            )
        return {"id": group_id, "name": name, "dataset_ids": body.dataset_ids}

    def delete_group(self, group_id):
        with self.store.connect() as db:
            if db.execute("DELETE FROM dataset_groups WHERE id=?", (group_id,)).rowcount != 1:
                raise CollectorError("数据集组合不存在")

    def create_bundle(self, body, global_rpm):
        self.validate_datasets(body.dataset_ids)
        target = body.end_date or china_today() - timedelta(days=1)
        completed_dependencies = set()
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if body.continuation_id:
                row = db.execute(
                    "SELECT * FROM dataset_bundles WHERE id=?", (body.continuation_id,)
                ).fetchone()
                if row is None or not row["batch_id"]:
                    raise CollectorError("依赖阶段尚未提交或不存在")
                if db.execute(
                    "SELECT 1 FROM dataset_bundles WHERE continuation_id=? AND batch_id IS NOT NULL",
                    (body.continuation_id,),
                ).fetchone():
                    raise CollectorError("此阶段已提交后续阶段，请从最新阶段继续")
                prior = json.loads(row["plan_json"])
                if (
                    prior["stage"] != "dependencies"
                    or prior["dataset_ids"] != body.dataset_ids
                    or prior["mode"] != body.mode
                ):
                    raise CollectorError("下一阶段的组合选择或策略不一致")
                if db.execute(
                    "SELECT 1 FROM runs WHERE batch_id=? AND state IN ('queued','running')",
                    (row["batch_id"],),
                ).fetchone():
                    raise CollectorError("依赖阶段仍在执行，请等待结束")
                target = date.fromisoformat(prior["end_date"])
                completed_dependencies = set(prior.get("completed_dependencies", [])) | set(
                    prior["stage_ids"]
                )
            if not FIRST_DATE <= target <= china_today() - timedelta(days=1):
                raise CollectorError("组合截止日期须在 1990-12-19 至上海时间昨天之间")
            needs = {}
            wanted = [item for item in body.dataset_ids if item not in completed_dependencies]
            for dataset_id in wanted:
                if self.active(db, dataset_id):
                    raise CollectorError(f"数据集 {RECIPES[dataset_id]['name']} 已有活动运行")
                settings, _ = self.checked_settings(db, dataset_id)
                try:
                    self._build(db, dataset_id, settings, body.mode, target, global_rpm)
                except DependencyRequired as error:
                    settings = settings.model_copy(
                        update={"start_date": history_start(recipe_for(dataset_id), settings)}
                    )
                    prior = needs.get(error.dataset_id)
                    if prior is None or settings.start_date < prior.start_date:
                        needs[error.dataset_id] = settings
            stage_ids = [item for item in RECIPES if item in needs] if needs else wanted
            plans = []
            prepared_dependencies = {}
            for dataset_id in stage_ids:
                if needs:
                    result, revision, _ = self._dependency_plan(
                        db, dataset_id, needs[dataset_id], target, global_rpm
                    )
                    actual_id = result["dataset_id"]
                    previous = prepared_dependencies.get(actual_id)
                    if previous and previous[0]["settings"]["start_date"] <= result["settings"]["start_date"]:
                        continue
                    prepared_dependencies[actual_id] = result, revision
                else:
                    settings, revision = self.checked_settings(db, dataset_id)
                    result = self._build(db, dataset_id, settings, body.mode, target, global_rpm)
                    plans.append((result, revision))
            if needs:
                plans = list(prepared_dependencies.values())
            for result, revision in plans:
                self._store_plan(db, result, revision)
            plans = [result for result, _ in plans]
            stage_ids = [result["dataset_id"] for result in plans]
            total = sum(item["total_slices"] for item in plans)
            if total > MAX_SLICES:
                raise CollectorError(f"组合超过 {MAX_SLICES} 个请求，请减少数据集或缩小各自历史范围")
            result = {
                "id": uuid.uuid4().hex,
                "dataset_ids": body.dataset_ids,
                "mode": body.mode,
                "stage": "dependencies" if needs else "data",
                "stage_ids": stage_ids,
                "end_date": target.isoformat(),
                "plans": plans,
                "total_slices": total,
                "supplier_requests": sum(
                    item.get("supplier_requests", item["total_slices"]) for item in plans
                ),
                "estimated_seconds": sum(item["estimated_seconds"] for item in plans),
                "warnings": [
                    "仅提交本阶段，不自动执行后续未知规模的请求；依赖完成后需检查并确认下一阶段。",
                    "各数据集保留自己的设置。业务范围按检查时已有成功日历及股票池冻结，不因本组合内再次刷新依赖而扩展。",
                ],
                "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
                "completed_dependencies": sorted(completed_dependencies),
                "continuation_id": body.continuation_id,
            }
            db.execute(
                "INSERT INTO dataset_bundles VALUES(?,?,?,?,?,?)",
                (result["id"], encode(result), result["expires_at"], None, now(), body.continuation_id),
            )
        return result

    def launch_bundle(self, bundle_id, global_rpm):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM dataset_bundles WHERE id=?", (bundle_id,)).fetchone()
            if row is None or row["batch_id"]:
                raise CollectorError("组合计划不存在或已提交")
            if datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc):
                raise CollectorError("组合计划超过 30 分钟，请重新检查")
            if (
                row["continuation_id"]
                and db.execute(
                    "SELECT 1 FROM dataset_bundles WHERE continuation_id=? AND batch_id IS NOT NULL",
                    (row["continuation_id"],),
                ).fetchone()
            ):
                raise CollectorError("此阶段已有后续提交，请从最新阶段继续")
            frozen = json.loads(row["plan_json"])
            prepared = [
                (plan, self._check_plan(db, plan["dataset_id"], plan["id"], global_rpm, allow_empty=True))
                for plan in frozen["plans"]
            ]
            total = sum(current["total_slices"] for _, current in prepared)
            executable = [(plan, current) for plan, current in prepared if current["total_slices"]]
            if not executable or total > MAX_SLICES:
                raise CollectorError("组合没有待执行切片或超过请求上限，请重新检查")
            batch_id = uuid.uuid4().hex
            db.execute(
                "INSERT INTO batches VALUES(?,?,?,?,?)", (batch_id, "[]", len(executable), total, now())
            )
            config_ids = []
            for plan, current in executable:
                _, config_id = self._enqueue_plan(db, current, plan["id"], batch_id)
                config_ids.append(config_id)
            db.execute("UPDATE batches SET config_ids_json=? WHERE id=?", (encode(config_ids), batch_id))
            db.execute("UPDATE dataset_bundles SET batch_id=? WHERE id=?", (batch_id, bundle_id))
        return self.store.batch(batch_id)

    def bundles(self):
        with self.store.connect() as db:
            rows = db.execute("SELECT * FROM dataset_bundles ORDER BY created_at DESC LIMIT 20").fetchall()
            continued = {
                row["continuation_id"]
                for row in db.execute(
                    "SELECT continuation_id FROM dataset_bundles "
                    "WHERE batch_id IS NOT NULL AND continuation_id IS NOT NULL"
                )
            }
        batches = {row["batch_id"]: self.store.batch(row["batch_id"]) for row in rows if row["batch_id"]}
        progress = {}
        if batches:
            with self.store.connect() as db:
                progress = {
                    row["batch_id"]: dict(row)
                    for row in db.execute(
                        "SELECT r.batch_id,COUNT(s.id) total,SUM(s.state='succeeded') completed,"
                        "SUM(s.state='failed') failed,SUM(s.state='pending') pending,"
                        "SUM(s.state='running') running "
                        "FROM runs r JOIN slices s ON s.run_id=r.id "
                        f"WHERE r.batch_id IN ({','.join('?' for _ in batches)}) GROUP BY r.batch_id",
                        list(batches),
                    )
                }
        result = []
        for row in rows:
            plan = json.loads(row["plan_json"])
            result.append(
                {
                    **{
                        key: plan[key]
                        for key in (
                            "id",
                            "dataset_ids",
                            "mode",
                            "stage",
                            "stage_ids",
                            "end_date",
                            "total_slices",
                        )
                    },
                    "batch": batches[row["batch_id"]] if row["batch_id"] else None,
                    "supplier_requests": plan.get("supplier_requests", plan["total_slices"]),
                    "progress": progress[row["batch_id"]] if row["batch_id"] else None,
                    "created_at": row["created_at"],
                    "next_stage_created": row["id"] in continued,
                }
            )
        return result
