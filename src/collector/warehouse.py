from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
import threading
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import portalocker
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .archive_navigation import ENTRY_DOMAINS
from .artifacts import contained_file, copy_verified, json_cell, source_paths, verified_open
from .datasets import RECIPES, scope_for
from .filesystem import atomic_move, compact_identifier, ensure_path_length, sync_directory
from .models import ENTRIES, CollectorError, absolute_directory, is_stock_code
from .store import encode, now
from .warehouse_export import export_options, reorganize_export

MAX_MONTH_ROWS = 1_000_000
ARROW_TYPES = {"str": pa.string(), "float": pa.float64(), "int": pa.int64(), "datetime": pa.timestamp("ns")}

def content_digest(table):
    digest = hashlib.sha256(table.schema.remove_metadata().serialize())
    digest.update(table.num_rows.to_bytes(8, "big"))
    for field, column in zip(table.schema, table.columns):
        array = column.combine_chunks()
        # Null slots may hold different unused bytes after a Parquet round trip.
        nulls = pc.is_null(array).buffers()[1]
        filled = pc.fill_null(array, pa.scalar("" if pa.types.is_string(field.type) else 0, field.type))
        normalized = pa.concat_arrays([filled])
        for buffer in (nulls, *normalized.buffers()[1:]):
            value = buffer if buffer is not None else b""
            digest.update(len(value).to_bytes(8, "big"))
            digest.update(value)
    return digest.hexdigest()


def readback_receipt(table, path, enabled):
    if not enabled:
        return {}
    expected = content_digest(table)
    if content_digest(pq.ParquetFile(path).read()) != expected:
        raise CollectorError("入库文件回读内容与待发布数据不一致，未替换旧快照")
    return {"content_sha256": expected, "validation": "normalized_write_readback"}


@dataclass(frozen=True)
class WarehouseAdapter:
    dataset_id: str
    entry_id: str
    name: str
    schema: pa.Schema
    grain: str = "date_cross_section"
    date_column: str | None = "trade_date"
    key_columns: tuple[str, ...] = ("ts_code", "trade_date")
    date_param: str | None = None
    code_filter: str = "stock"
    calendar_basis: str | None = "trading_day"
    allow_empty: bool = False
    engine: str = "date"
    code_column: str = "ts_code"
    date_semantics: str = "date"
    json_columns: tuple[str, ...] = ()

    @property
    def preserves_duplicate_rows(self):
        return self.engine in {"request", "record"} or self.grain in {
            "announcement_event", "date_records", "board_records", "aggregate_series",
        }

    def capabilities(self):
        result = {
            "grain": self.grain, "date_column": self.date_column,
            "key_columns": list(self.key_columns), "code_filter": self.code_filter,
            "calendar_basis": self.calendar_basis,
            "preserves_duplicate_rows": self.preserves_duplicate_rows,
            "code_column": self.code_column,
            "storage_layout": (
                "request_partitions" if self.engine in {"request", "record"}
                else "current_snapshot" if self.grain == "current_snapshot" else "monthly"
            ),
            "supports_variants": self.engine in {"request", "record"},
        }
        if self.engine == "record":
            atomic = (
                RECIPES[self.dataset_id]["kind"] == "snapshot"
                or bool(RECIPES[self.dataset_id]["rule"].get("refresh_all"))
                or RECIPES[self.dataset_id]["rule"]["strategy"] == "derived"
            )
            result.update(
                date_semantics=self.date_semantics,
                field_encodings={name: "json" for name in self.json_columns},
                atomic_full_run=atomic,
                semantic_note=(
                    "仅取同一完整运行的授权范围，不混入其他轮次；不回放历史，也不代表同一瞬间的市场截面。"
                    if self.date_semantics == "snapshot"
                    else "按原周区间或整月与筛选范围相交，保留原始标签；周期数不是交易日覆盖。"
                    if self.date_semantics in {"month", "week_interval"}
                    else "每轮整段重新获取并替换授权历史，禁止缩窄已有范围或拼接不同运行的复权锚点。"
                    if atomic
                    else "保留原始日内时间戳，按上海自然日筛选；不同分钟频度独立为请求变体。"
                    if self.date_semantics == "timestamp"
                    else "保留原始周期标签与计算截至日，不将周／月标签当作逐日覆盖。"
                    if self.date_semantics == "period_label" else ""
                ) + (
                    " 未声明类型的内容字段以可还原的 JSON 字符串保存，字段编码见导出清单。"
                    if self.json_columns else ""
                ),
            )
        return result


WAREHOUSE_ADAPTERS = {
    dataset_id: WarehouseAdapter(
        dataset_id, entry_id, ENTRIES[entry_id]["name"],
        pa.schema([
            pa.field(field["name"], ARROW_TYPES[field["type"]]) for field in ENTRIES[entry_id]["fields"]
        ]),
    )
    for dataset_id, entry_id in (
        ("daily", "27"), ("daily_basic", "32"), ("adj_factor", "28"), ("moneyflow", "170"),
    )
}
DAILY_SCHEMA = WAREHOUSE_ADAPTERS["daily"].schema
for dataset_id, entry_id, grain, date_column, keys in (
    ("stock_basic", "25", "current_snapshot", None, ("ts_code",)),
    ("dividend", "103", "announcement_event", "ann_date", ("ts_code", "ann_date", "end_date", "div_proc")),
):
    WAREHOUSE_ADAPTERS[dataset_id] = WarehouseAdapter(
        dataset_id, entry_id, ENTRIES[entry_id]["name"],
        pa.schema([
            pa.field(field["name"], ARROW_TYPES[field["type"]]) for field in ENTRIES[entry_id]["fields"]
        ]),
        grain, date_column, keys, calendar_basis=None if date_column is None else "calendar_day",
        allow_empty=grain == "announcement_event",
    )

for dataset_id, entry_id, grain, date_column, date_param, domain, calendar_basis, keys in (
    ("stk_premarket", "329", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("stock_st", "397", "date_records", "trade_date", "trade_date", "stock", "trading_day", ("type",)),
    ("st", "423", "date_records", "pub_date", "pub_date", "stock", "calendar_day", ("imp_date", "st_type")),
    ("bak_basic", "262", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("weekly", "144", "period_bar", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("monthly", "145", "period_bar", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("bak_daily", "255", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("stk_shock", "451", "date_records", "trade_date", "trade_date", "stock", "trading_day", ("reason",)),
    ("stk_high_shock", "452", "date_records", "trade_date", "trade_date", "stock", "trading_day",
     ("reason",)),
    ("stk_alert", "453", "date_records", "start_date", "trade_date", "stock", "calendar_day", ("type",)),
    ("pledge_stat", "110", "date_cross_section", "end_date", "end_date", "stock", "calendar_day", ()),
    ("pledge_detail", "111", "announcement_event", "ann_date", "ann_date", "stock", "calendar_day",
     ("holder_name", "start_date", "end_date")),
    ("repurchase", "124", "announcement_event", "ann_date", "ann_date", "stock", "calendar_day",
     ("end_date", "proc")),
    ("block_trade", "161", "date_records", "trade_date", "trade_date", "stock", "trading_day",
     ("buyer", "seller")),
    ("stk_seasoned", "494", "announcement_event", "ann_date", "ann_date", "stock", "calendar_day",
     ("first_ann_date", "proj_info_source")),
    ("stk_auction_o", "353", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("stk_auction_c", "354", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("stk_ah_comparison", "399", "date_records", "trade_date", "trade_date", "stock", "trading_day",
     ("hk_code",)),
    ("slb_len", "331", "aggregate_series", "trade_date", "trade_date", "none", "trading_day", ()),
    ("moneyflow_ths", "348", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("moneyflow_dc", "349", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("moneyflow_cnt_ths", "371", "board_records", "trade_date", "trade_date", "board", "trading_day", ()),
    ("moneyflow_ind_ths", "343", "board_records", "trade_date", "trade_date", "board", "trading_day", ()),
    ("moneyflow_mkt_dc", "345", "aggregate_series", "trade_date", "trade_date", "none", "trading_day", ()),
    ("top_list", "106", "date_records", "trade_date", "trade_date", "stock", "trading_day", ("reason",)),
    ("top_inst", "107", "date_records", "trade_date", "trade_date", "stock", "trading_day",
     ("exalter", "side", "reason")),
    ("limit_step", "356", "date_records", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("limit_cpt_list", "357", "board_records", "trade_date", "trade_date", "board", "trading_day", ()),
    ("ths_daily", "260", "board_records", "trade_date", "trade_date", "board", "trading_day", ()),
    ("stk_auction", "369", "date_cross_section", "trade_date", "trade_date", "stock", "trading_day", ()),
    ("hm_detail", "312", "date_records", "trade_date", "trade_date", "stock", "trading_day", ("hm_name",)),
    ("tdx_daily", "378", "board_records", "trade_date", "trade_date", "board", "trading_day", ()),
):
    WAREHOUSE_ADAPTERS[dataset_id] = WarehouseAdapter(
        dataset_id, entry_id, ENTRIES[entry_id]["name"],
        pa.schema([
            pa.field(field["name"], ARROW_TYPES[field["type"]]) for field in ENTRIES[entry_id]["fields"]
        ]),
        grain, date_column, (
            ("ts_code", date_column, *keys) if domain != "none" else (date_column, *keys)
        ),
        date_param=date_param, code_filter=domain, calendar_basis=calendar_basis, allow_empty=True,
    )

REQUEST_WAREHOUSE_DATASETS = (
    "trade_cal", "income", "balancesheet", "cashflow", "fina_indicator", "stock_hsgt",
    "stk_managers", "stk_rewards", "new_share", "stk_limit", "suspend_d", "hsgt_top10",
    "forecast", "express", "fina_audit", "fina_mainbz", "disclosure_date",
    "top10_holders", "top10_floatholders", "share_float", "stk_account",
    "stk_holdernumber", "stk_holdertrade", "cyq_perf", "cyq_chips", "margin",
    "margin_detail", "margin_secs", "slb_sec", "slb_sec_detail", "slb_len_mm",
    "moneyflow_ind_dc", "limit_list_ths", "limit_list_d", "dc_index", "dc_member", "dc_daily",
    "ths_hot", "dc_hot", "tdx_index", "tdx_member", "kpl_list", "kpl_concept_cons",
)
for dataset_id in REQUEST_WAREHOUSE_DATASETS:
    recipe = RECIPES[dataset_id]
    entry_id = recipe["entry_id"]
    spec = recipe.get("rule", {})
    date_column = (
        "cal_date" if dataset_id == "trade_cal"
        else spec.get("date_field", recipe.get("date_field", "ann_date"))
    )
    domain = spec.get("domain", "aggregate" if dataset_id == "trade_cal" else "stock")
    code_column = "con_code" if domain == "membership" else "ts_code"
    keys = [name for name in (
        "ts_code", "con_code", date_column, "end_date", "f_ann_date",
        "report_type", "comp_type", "update_flag",
    ) if name in {field["name"] for field in ENTRIES[entry_id]["fields"]}]
    WAREHOUSE_ADAPTERS[dataset_id] = WarehouseAdapter(
        dataset_id, entry_id, ENTRIES[entry_id]["name"],
        pa.schema([
            pa.field(field["name"], ARROW_TYPES[field["type"]]) for field in ENTRIES[entry_id]["fields"]
        ]),
        "financial_records" if recipe["kind"] == "financial" or spec.get("strategy") == "stock_window"
        else "calendar_records" if dataset_id == "trade_cal" else "partition_records",
        date_column, tuple(dict.fromkeys(keys)), code_filter=(
            "none" if domain == "aggregate" else "board" if domain == "board"
            else "identifier" if domain == "rank" else "stock"
        ),
        calendar_basis=None, allow_empty=True, engine="request", code_column=code_column,
    )


RECORD_WAREHOUSE_DATASETS = (
    "namechange", "stock_company", "bse_mapping", "rt_k", "stk_mins", "rt_min", "rt_min_daily",
    "pro_bar_adj", "stk_weekly_monthly", "stk_week_month_adj", "pro_bar", "stk_account_old",
    "report_rc", "stk_factor", "stk_factor_pro", "stk_nineturn", "stk_surv", "broker_recommend",
    "ths_index", "ths_member", "hm_list",
)
for dataset_id in RECORD_WAREHOUSE_DATASETS:
    recipe = RECIPES[dataset_id]
    spec = recipe["rule"]
    entry = ENTRIES[recipe["entry_id"]]
    fields = entry["fields"] or [
        field for field in ENTRIES["27"]["fields"] if field["name"] not in {"ah_vol", "ah_amount"}
    ]
    json_columns = ("orgs",) if dataset_id == "hm_list" else ("content",) if dataset_id == "stk_surv" else ()
    text_columns = {"rt_k": {"name"}, "rt_min_daily": {"freq", "time"}}.get(dataset_id, set())
    schema = pa.schema([
        pa.field(
            field["name"],
            pa.string() if field["name"] in {*json_columns, *text_columns} else ARROW_TYPES[field["type"]],
        )
        for field in fields
    ])
    snapshot = recipe["kind"] == "snapshot"
    date_column = None if snapshot else spec["date_field"]
    semantics = (
        "snapshot" if snapshot else "week_interval" if dataset_id == "stk_account_old"
        else "month" if spec["strategy"] == "month"
        else "timestamp" if dataset_id in {"stk_mins", "stk_nineturn"}
        else "period_label" if spec["strategy"] == "period" else "date"
    )
    code_column = "n_code" if dataset_id == "bse_mapping" else spec.get("code_param", "ts_code")
    keys = [name for name in (code_column, date_column) if name and name in schema.names]
    if not keys:
        keys = ["name"] if "name" in schema.names else [date_column]
    WAREHOUSE_ADAPTERS[dataset_id] = WarehouseAdapter(
        dataset_id, recipe["entry_id"], entry["name"], schema,
        grain="current_snapshot" if snapshot else "temporal_records", date_column=date_column,
        key_columns=tuple(keys), code_filter=(
            "none" if spec["domain"] in {"aggregate", "dictionary"}
            else "identifier" if spec["domain"] == "mapping"
            else "board" if spec["domain"] == "board" else "stock"
        ),
        calendar_basis=None, allow_empty=spec["allow_empty"], engine="record", code_column=code_column,
        date_semantics=semantics, json_columns=json_columns,
    )


def warehouse_blocker(dataset_id, entry):
    recipe = RECIPES[dataset_id]
    spec = recipe.get("rule", {})
    if dataset_id == "stk_account_old":
        return "旧口径 date 为 YYYYMMDD~MMDD 周区间标签，跨年与范围筛选规则尚未验证"
    if not entry["fields"]:
        return "SDK 派生入口未声明稳定输出字段，复权锚点与实际列结构尚未验证"
    unknown = [
        f"{field['name']} ({field['type']})" for field in entry["fields"] if field["type"] not in ARROW_TYPES
    ]
    if unknown:
        return "字段类型尚未建立安全映射：" + "、".join(unknown)
    if spec.get("refresh_all") or spec.get("strategy") == "derived":
        return "历史整段重述与复权锚点的统一发布规则尚未验证，不能拼接局部修订"
    if recipe["kind"] == "snapshot":
        return "此类当前、关系或实时快照的完整运行与替换边界尚未验证"
    if spec.get("strategy") in {"stock_minute", "time_day", "realtime"}:
        return "分钟或实时数据的频度、时间戳与跨日分区边界尚未验证"
    return "周期或月份标签与实际记录日期的分区规则尚未验证"


def warehouse_fields(dataset_id):
    adapter = WAREHOUSE_ADAPTERS[dataset_id]
    entry = ENTRIES[adapter.entry_id]
    declarations = {field["name"]: field for field in (entry["fields"] or ENTRIES["27"]["fields"])}
    return [
        {**declarations[field.name], "arrow_type": str(field.type)}
        | ({"encoding": "json"} if field.name in adapter.json_columns else {})
        for field in adapter.schema
    ]


def warehouse_catalog():
    from .datasets import RECIPES

    datasets = {recipe["entry_id"]: dataset_id for dataset_id, recipe in RECIPES.items()}
    entries = []
    for entry_id, entry in ENTRIES.items():
        dataset_id = datasets[entry_id]
        adapter = WAREHOUSE_ADAPTERS.get(dataset_id)
        entries.append({
            "dataset_id": dataset_id, "entry_id": entry_id,
            **{key: entry[key] for key in ("api_name", "name", "category", "category_name", "doc_url")},
            **ENTRY_DOMAINS[entry_id],
            "warehouse_supported": adapter is not None,
            "warehouse_status": "supported" if adapter else "raw_only",
            "warehouse_unavailable_reason": None if adapter else warehouse_blocker(dataset_id, entry),
            **(adapter.capabilities() if adapter else {
                "grain": None, "date_column": None, "key_columns": [], "code_filter": None,
                "calendar_basis": None, "preserves_duplicate_rows": False,
                "code_column": None, "storage_layout": None, "supports_variants": False,
            }),
            "fields": warehouse_fields(dataset_id) if adapter else [
                {**field, "arrow_type": str(adapter.schema.field(field["name"]).type) if adapter else None}
                for field in entry["fields"]
            ],
            "version_rule": (
                "latest_successful_request_partition; no_row_dedup; reject_overlap_or_narrowing"
                if adapter and adapter.engine == "request"
                else "latest_complete_successful_run; not_historical_universe"
                if adapter and adapter.grain == "current_snapshot"
                else "latest_successful_request_partition; preserve_event_rows"
                if adapter and adapter.preserves_duplicate_rows
                else "latest_successful_date_partition; identical_content_reused" if adapter else None
            ),
        })
    return {"version": 1, "supported_datasets": list(WAREHOUSE_ADAPTERS), "entries": entries}


def date_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{8}", value):
        raise CollectorError("日期须为 YYYYMMDD")
    try:
        datetime.strptime(value, "%Y%m%d")
    except ValueError:
        raise CollectorError("日期无效") from None
    return value


def stock_codes(values, *, historical=False):
    if any(not is_stock_code(value, historical=historical) for value in values):
        raise CollectorError(
            "股票代码须为六位数字及 .SH / .SZ / .BJ 后缀"
            + ("，历史记录另支持 T 前缀的五至六位上海股票代码" if historical else "")
        )
    return sorted(set(values))


def write_json(path, value):
    ensure_path_length(path)
    content = (encode(value) + "\n").encode()
    with path.open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    return hashlib.sha256(content).hexdigest()


def parquet_digest(path):
    with path.open("r+b") as stream:
        os.fsync(stream.fileno())
        return hashlib.file_digest(stream, "sha256").hexdigest()


class DateWarehouse:
    def __init__(self, store, datasets, root, adapter):
        self.store, self.datasets = store, datasets
        self.root = Path(root)
        self.adapter = adapter
        self.schema = adapter.schema
        self.dataset_id, self.entry_id, self.name = adapter.dataset_id, adapter.entry_id, adapter.name
        self.api_name = ENTRIES[self.entry_id]["api_name"]
        self.lock = threading.Lock()

    def repository_id_for(self, raw_root, scope=None):
        identity = raw_root if self.dataset_id == "daily" else f"{self.dataset_id}\0{raw_root}"
        return hashlib.sha256(identity.encode()).hexdigest()

    def context(self):
        from .datasets import RECIPES

        with self.store.connect() as db:
            db.execute("BEGIN")
            settings, _ = self.datasets.checked_settings(db, self.dataset_id)
            _, registered = self.datasets.records(
                db, self.dataset_id, scope_for(RECIPES[self.dataset_id], settings), evidence=True,
            )
            active = bool(self.datasets.active(db, self.dataset_id))
        repository_id = self.repository_id_for(settings.raw_root)
        root = self.root / repository_id
        sources = {}
        for key, item in registered.items():
            day = date_key(key.split("|", 1)[0])
            expected_key = day + "|{}" if "rule" in RECIPES[self.dataset_id] else day
            expected_params = {self.adapter.date_param or self.adapter.date_column: day}
            if (
                key != expected_key or day in sources
                or json.loads(item["params_json"]) != expected_params
            ):
                raise CollectorError(
                    f"{self.name}仓库只接受预置完整单日期切片；选项、逐股或拆分请求请暂用 Raw 阅读"
                )
            item["config"] = {"raw_root": settings.raw_root}
            sources[day] = item
        return root, repository_id, settings.raw_root, sources, active

    def snapshot(self, root, repository_id, snapshot_id=None):
        pointer = root / "current.json"
        current = {}
        if snapshot_id is None:
            if not pointer.exists():
                return None
            try:
                path = contained_file(str(pointer), root)
                current = json.loads(path.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                raise CollectorError("仓库当前快照指针不可读或损坏") from None
            if not isinstance(current, dict):
                raise CollectorError("仓库当前快照指针格式不正确")
            snapshot_id = current.get("snapshot_id")
        if not isinstance(snapshot_id, str) or not re.fullmatch(r"[a-f0-9]{32}", snapshot_id):
            raise CollectorError("仓库快照标识不正确")
        with self.store.connect() as db:
            record = db.execute(
                "SELECT * FROM warehouse_snapshots WHERE id=? AND repository_id=?",
                (snapshot_id, repository_id),
            ).fetchone()
        if record is None:
            raise CollectorError("仓库快照未登记或不属于当前数据集 / Raw 目录")
        path = contained_file(record["manifest_path"], root)
        if path != root / "snapshots" / snapshot_id / "manifest.json":
            raise CollectorError("仓库快照清单路径与登记不一致")
        with verified_open(path, record["manifest_sha256"]) as stream:
            try:
                manifest = json.load(stream)
            except ValueError:
                raise CollectorError("仓库快照清单不是有效 JSON") from None
        if (
            not isinstance(manifest, dict)
            or manifest.get("format_version") != 1
            or manifest.get("snapshot_id") != snapshot_id
            or manifest.get("dataset_id", "daily") != self.dataset_id
            or manifest.get("entry_id") != self.entry_id
            or manifest.get("api_name") != self.api_name
            or manifest.get("columns") != self.schema.names
            or ("grain" in manifest and manifest["grain"] != self.adapter.grain)
            or ("date_column" in manifest and manifest["date_column"] != self.adapter.date_column)
            or (
                self.adapter.engine in {"request", "record"}
                and manifest.get("storage_layout") != "request_partitions"
            )
            or ("schema" in manifest and manifest["schema"] != self.schema_description())
            or not isinstance(manifest.get("dates"), dict)
            or not isinstance(manifest.get("months"), list)
        ):
            raise CollectorError("仓库快照结构不受支持或字段已变化")
        watermarks = current.get("source_watermarks", {})
        if not isinstance(watermarks, dict) or any(
            not isinstance(value, list) or len(value) != 2
            or not isinstance(value[0], str) or type(value[1]) is not int or value[1] < 0
            or day not in manifest["dates"]
            for day, value in watermarks.items()
        ):
            raise CollectorError("仓库同步游标格式不正确")
        try:
            for value in watermarks.values():
                datetime.fromisoformat(value[0])
        except ValueError:
            raise CollectorError("仓库同步游标时间不正确") from None
        return {
            **manifest, "manifest_path": str(path), "manifest_sha256": record["manifest_sha256"],
            "source_watermarks": watermarks,
        }

    @staticmethod
    def changes(sources, snapshot):
        previous = snapshot["dates"] if snapshot else {}
        changed = {
            day: item for day, item in sources.items()
            if day not in previous or (
                item["raw_sha256"] != previous[day]["data_sha256"]
                and (item["observed_at"], item["source_order"]) > tuple(
                    snapshot.get("source_watermarks", {}).get(
                        day, [previous[day]["observed_at"], previous[day]["source_order"]],
                    )
                )
            )
        }
        return changed, sum(day not in previous for day in changed)

    def status(self):
        root, repository_id, raw_root, sources, active = self.context()
        snapshot = self.snapshot(root, repository_id)
        return self.describe(root, raw_root, sources, active, snapshot)

    def describe(self, root, raw_root, sources, active, snapshot):
        changed, added = self.changes(sources, snapshot)
        dates = sorted(snapshot["dates"]) if snapshot else []
        return {
            "dataset_id": self.dataset_id, "entry_id": self.entry_id, "name": self.name,
            **self.adapter.capabilities(),
            "state": "ready" if snapshot else "empty",
            "repository_root": str(root),
            "source_raw_root": raw_root,
            "busy": self.lock.locked(),
            "collection_active": active,
            "snapshot_id": snapshot["snapshot_id"] if snapshot else None,
            "created_at": snapshot["created_at"] if snapshot else None,
            "current_manifest_path": str(root / "current.json"),
            "snapshot_manifest_path": snapshot["manifest_path"] if snapshot else None,
            "columns": self.schema.names,
            "rows": snapshot["rows"] if snapshot else 0,
            "days": len(dates),
            "days_with_rows": (
                sum(source["rows"] > 0 for source in snapshot["dates"].values()) if snapshot else 0
            ),
            "first_date": dates[0] if dates else None,
            "last_date": dates[-1] if dates else None,
            "months": [
                {**month, "file": str(root / month["file"])} for month in snapshot["months"]
            ] if snapshot else [],
            "dates": dates,
            "available_source_days": len(sources),
            "new_days": added,
            "changed_days": len(changed) - added,
            "reused_days": len(dates) - (len(changed) - added),
            "refresh_needed": bool(changed),
            "coverage": "not_proven",
        }

    def schema_description(self):
        return [{"name": field.name, "type": str(field.type)} for field in self.schema]

    def month_table(self, root, month):
        path = contained_file(str(root / month["file"]), root)
        with verified_open(path, month["sha256"]) as stream:
            parquet = pq.ParquetFile(stream)
            if parquet.metadata.num_rows > MAX_MONTH_ROWS:
                raise CollectorError(f"{self.name}仓库单月超过本地安全读取上限 100 万行")
            return parquet.read().cast(self.schema, safe=True)

    def source_table(self, day, item, *, require_all_fields=False):
        raw, _, metadata = source_paths(item)
        if raw.suffix != ".parquet" or any(
            metadata.get(key) != value for key, value in (
                ("params", {self.adapter.date_param or self.adapter.date_column: day}),
                ("run_id", item["run_id"]),
                ("slice_id", item["id"]), ("api_name", self.api_name),
            )
        ):
            raise CollectorError(f"{day} {self.name}归档格式、来源或请求条件不一致")
        with verified_open(raw, item["raw_sha256"]) as stream:
            parquet = pq.ParquetFile(stream)
            if not 0 <= parquet.metadata.num_rows <= MAX_MONTH_ROWS or (
                not parquet.metadata.num_rows and not self.adapter.allow_empty
            ):
                raise CollectorError(f"{day} {self.name}归档为空或超过本地安全读取上限")
            table = parquet.read()
        missing = set(self.schema.names) - set(table.column_names)
        if missing:
            raise CollectorError(f"{day} {self.name}缺少仓库字段：{', '.join(sorted(missing))}；请明确补采")
        if require_all_fields and set(table.column_names) != set(self.schema.names):
            raise CollectorError(f"{day} 返回了仓库契约以外的字段；已保留 Raw，请适配后再发布")
        table = table.select(self.schema.names).cast(self.schema, safe=True)
        dates = table[self.adapter.date_column].to_pylist()
        codes = table["ts_code"].to_pylist() if self.adapter.code_filter != "none" else []
        unique_codes = self.checked_codes(codes)
        if any(value != day for value in dates) or (
            self.adapter.grain in {"date_cross_section", "period_bar"} and len(unique_codes) != len(codes)
        ):
            raise CollectorError(f"{day} {self.name}包含错误日期或重复股票业务键，不能发布")
        source = {
            "run_id": item["run_id"], "slice_id": item["id"], "raw_path": str(raw),
            "meta_path": item["meta_path"], "data_sha256": item["raw_sha256"],
            "meta_sha256": item["meta_sha256"], "rows": table.num_rows,
            "ingested_at": metadata.get("ingested_at"),
            "observed_at": item["observed_at"], "source_order": item["source_order"],
        }
        if require_all_fields:
            source["preserved_fields"] = self.schema.names
        return table, source

    def refresh(self, *, verify_content=False, expected_raw_root=None, expected_scope=None):
        if not self.lock.acquire(blocking=False):
            raise CollectorError(f"{self.name}仓库正在整理，请等待完成")
        try:
            root, repository_id, raw_root, sources, active = self.context()
            if expected_raw_root is not None and raw_root != expected_raw_root:
                raise CollectorError("仓库来源目录已变化，请核查后重新保存数据需求")
            if expected_scope is not None and repository_id != self.repository_id_for(
                raw_root, expected_scope,
            ):
                raise CollectorError("仓库请求选项已变化，请核查后重新保存数据需求")
            if active:
                raise CollectorError(f"{self.name}采集正在排队或运行，请完成采集后再整理仓库")
            root.mkdir(parents=True, exist_ok=True)
            lock = portalocker.Lock(root / ".publish.lock", mode="a+b", timeout=0)
            try:
                lock.acquire()
            except portalocker.AlreadyLocked:
                raise CollectorError(f"其他进程正在整理此{self.name}仓库") from None
            except portalocker.LockException as error:
                raise CollectorError(
                    f"仓库文件锁失败（{type(error).__name__}），请检查目录及文件系统"
                ) from None
            with lock:
                snapshot = self.snapshot(root, repository_id)
                changed, _ = self.changes(sources, snapshot)
                if not changed:
                    if snapshot is None:
                        raise CollectorError(f"没有可整理的预置{self.name}成功归档，请先采集")
                    snapshot["source_watermarks"] = self.publish_pointer(root, snapshot, sources)
                    result = self.describe(root, raw_root, sources, active, snapshot)
                    return {**result, "busy": False, "changed": False}
                arguments = {"verify_content": True} if verify_content else {}
                published = self.publish(
                    root, repository_id, raw_root, changed, snapshot, sources, **arguments,
                )
                result = self.describe(root, raw_root, sources, active, published)
                return {**result, "busy": False, "changed": True}
        finally:
            self.lock.release()

    def publish(self, root, repository_id, raw_root, changed, snapshot, sources, *, verify_content=False):
        snapshot_id = uuid.uuid4().hex
        parent = root / "snapshots"
        parent.mkdir(exist_ok=True)
        final = parent / snapshot_id
        dates = dict(snapshot["dates"]) if snapshot else {}
        months = {month["month"]: month for month in snapshot["months"]} if snapshot else {}
        updates = defaultdict(dict)
        for day, item in changed.items():
            updates[day[:6]][day] = item
        with tempfile.TemporaryDirectory(prefix=".t-", dir=root) as temporary:
            staging = Path(temporary)
            (staging / "months").mkdir()
            for month, items in sorted(updates.items()):
                tables = []
                if month in months:
                    old = self.month_table(root, months[month])
                    replaced = pc.is_in(old[self.adapter.date_column], value_set=pa.array(list(items)))
                    tables.append(old.filter(pc.invert(replaced)))
                for day, item in sorted(items.items()):
                    table, source = self.source_table(day, item, require_all_fields=verify_content)
                    dates[day] = source
                    tables.append(table)
                total = sum(table.num_rows for table in tables)
                if total > MAX_MONTH_ROWS:
                    raise CollectorError(f"{month} 超过仓库单月安全上限 100 万行，未发布")
                sort_columns = list(dict.fromkeys([self.adapter.date_column, *self.adapter.key_columns]))
                table = pa.concat_tables(tables).sort_by([(name, "ascending") for name in sort_columns])
                path = staging / "months" / f"{month}.parquet"
                pq.write_table(table, path, compression="zstd")
                receipt = readback_receipt(table, path, verify_content)
                months[month] = {
                    "month": month, "rows": table.num_rows,
                    "days": sum(day.startswith(month) for day in dates),
                    "file": (Path("snapshots") / snapshot_id / "months" / path.name).as_posix(),
                    "sha256": parquet_digest(path),
                    **receipt,
                }
            manifest = {
                "format_version": 1, "snapshot_id": snapshot_id, "created_at": now(),
                "source_raw_root": raw_root, "api_name": self.api_name, "entry_id": self.entry_id,
                "dataset_id": self.dataset_id, "schema": self.schema_description(),
                **self.adapter.capabilities(),
                "columns": self.schema.names, "dates": dates, "months": list(sorted(
                    months.values(), key=lambda item: item["month"],
                )),
                "rows": sum(month["rows"] for month in months.values()),
                "version_rule": (
                    "latest_successful_request_partition; preserve_event_rows"
                    if self.adapter.preserves_duplicate_rows
                    else "latest_successful_date_partition; identical_content_reused"
                ),
                "coverage": "not_proven",
            }
            digest = write_json(staging / "manifest.json", manifest)
            sync_directory(staging / "months")
            sync_directory(staging)
            atomic_move(staging, final)
            sync_directory(parent)
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO warehouse_snapshots VALUES(?,?,?,?,?,?,?,?)",
                (snapshot_id, repository_id, raw_root, str(final / "manifest.json"), digest,
                 manifest["created_at"], manifest["rows"], len(dates)),
            )
        published = {
            **manifest, "manifest_path": str(final / "manifest.json"), "manifest_sha256": digest,
            "source_watermarks": snapshot.get("source_watermarks", {}) if snapshot else {},
        }
        published["source_watermarks"] = self.publish_pointer(root, published, sources)
        return published

    @staticmethod
    def publish_pointer(root, snapshot, sources):
        # Seen identical revisions must not allow an older Raw copy to downgrade the current data.
        watermarks = {
            key: value for key, value in snapshot.get("source_watermarks", {}).items()
            if key in snapshot["dates"]
        }
        for day, source in snapshot["dates"].items():
            floor = watermarks.get(day, [source["observed_at"], source["source_order"]])
            item = sources.get(day)
            if item and item["raw_sha256"] == source["data_sha256"]:
                floor = max(floor, [item["observed_at"], item["source_order"]])
            watermarks[day] = floor
        temporary_pointer = root / f".c-{compact_identifier(snapshot['snapshot_id'])}.json"
        try:
            write_json(temporary_pointer, {
                "snapshot_id": snapshot["snapshot_id"], "source_watermarks": watermarks,
            })
            atomic_move(temporary_pointer, root / "current.json", replace=True)
            sync_directory(root)
        finally:
            temporary_pointer.unlink(missing_ok=True)
        return watermarks

    def checked_codes(self, codes):
        if self.adapter.code_filter == "none":
            if codes:
                raise CollectorError(f"{self.name}是市场汇总数据，不支持股票或板块代码筛选")
            return []
        if self.adapter.code_filter in {"board", "identifier"}:
            if any(
                not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}", code)
                for code in codes
            ):
                label = "板块代码" if self.adapter.code_filter == "board" else "标的代码"
                raise CollectorError(f"{label}须为 1 至 32 位字母、数字、点、下划线或连字符")
            return sorted(set(codes))
        return stock_codes(codes, historical=self.dataset_id == "dividend")

    def selected(self, snapshot_id, start_date, end_date, codes, variant_id=None):
        if variant_id is not None:
            raise CollectorError("此仓库不支持请求变体筛选")
        root, repository_id, _, _, _ = self.context()
        snapshot = self.snapshot(root, repository_id, snapshot_id)
        if snapshot is None:
            raise CollectorError(f"{self.name}仓库尚未发布，请先整理本地归档")
        days = sorted(snapshot["dates"])
        start, end = date_key(start_date or days[0]), date_key(end_date or days[-1])
        if start > end:
            raise CollectorError("开始日期不能晚于结束日期")
        codes = self.checked_codes(codes)
        selected_dates = {day: source for day, source in snapshot["dates"].items() if start <= day <= end}
        months = [month for month in snapshot["months"] if start[:6] <= month["month"] <= end[:6]]
        return root, snapshot, start, end, codes, selected_dates, months

    def filter(self, table, start, end, codes):
        mask = pc.and_(
            pc.greater_equal(table[self.adapter.date_column], start),
            pc.less_equal(table[self.adapter.date_column], end),
        )
        if codes:
            mask = pc.and_(mask, pc.is_in(table[self.adapter.code_column], value_set=pa.array(codes)))
        return table.filter(mask)

    def data_dates(self, table):
        return table[self.adapter.date_column].to_pylist() if self.adapter.date_column else []

    def rows(
        self, *, snapshot_id=None, start_date=None, end_date=None, ts_code="", offset=0, limit=50,
        variant_id=None,
    ):
        if offset < 0 or not 1 <= limit <= 200:
            raise CollectorError("仓库分页范围不正确")
        root, snapshot, start, end, codes, dates, months = self.selected(
            snapshot_id, start_date, end_date, [ts_code] if ts_code else [], variant_id,
        )
        matching = 0 if codes else sum(source["rows"] for source in dates.values())
        skipped, results = offset, []
        for month in months:
            count = sum(source["rows"] for day, source in dates.items() if day.startswith(month["month"]))
            if not codes and skipped >= count:
                skipped -= count
                continue
            if not codes and len(results) >= limit:
                break
            table = self.filter(self.month_table(root, month), start, end, codes)
            if codes:
                matching += table.num_rows
            selected = table.slice(skipped, max(0, limit - len(results)))
            skipped = max(0, skipped - table.num_rows)
            values = [column.to_pylist() for column in selected.columns]
            results.extend([[json_cell(value) for value in row] for row in zip(*values, strict=True)])
        return {
            "snapshot_id": snapshot["snapshot_id"], "columns": self.schema.names,
            "dataset_id": self.dataset_id, "entry_id": self.entry_id, "name": self.name,
            "rows": results, "total_rows": snapshot["rows"], "matching_rows": matching,
            "offset": offset, "limit": limit,
            "next_offset": offset + len(results) if offset + len(results) < matching else None,
            "hash_verified": True, "coverage": "not_proven",
        }

    def export(
        self, destination, start_date, end_date, columns=(), ts_codes=(), snapshot_id=None, variant_id=None,
        file_layout="partitioned", sort_by=None, split_by=None,
    ):
        root, snapshot, start, end, codes, _, months = self.selected(
            snapshot_id, start_date, end_date, ts_codes, variant_id,
        )
        if len(columns) != len(set(columns)) or set(columns) - set(self.schema.names):
            raise CollectorError(f"导出字段重复或不属于{self.name}仓库")
        columns = list(columns) if columns else self.schema.names
        columns = list(self.adapter.key_columns) + [
            name for name in columns if name not in self.adapter.key_columns
        ]
        sort_by = export_options(columns, file_layout, sort_by, split_by)
        destination = absolute_directory(destination, "仓库导出")
        if destination.is_relative_to(self.root.resolve()):
            raise CollectorError("导出目录不能位于仓库内部")
        parent = destination / "tushare_warehouse_bundles"
        parent.mkdir(parents=True, exist_ok=True)
        bundle_id = uuid.uuid4().hex
        final = parent / f"{self.dataset_id}-{bundle_id}"
        files, days, total = [], set(), 0
        with tempfile.TemporaryDirectory(prefix=".t-", dir=parent) as temporary:
            staging = Path(temporary)
            (staging / "data").mkdir()
            for month in months:
                table = self.filter(self.month_table(root, month), start, end, codes).select(columns)
                if not table.num_rows:
                    continue
                file_id = (
                    compact_identifier(month["month"])
                    if self.adapter.engine in {"request", "record"} else month["month"]
                )
                path = staging / "data" / f"{file_id}.parquet"
                ensure_path_length(path)
                pq.write_table(table, path, compression="zstd")
                files.append({
                    "file": f"data/{path.name}", "sha256": parquet_digest(path), "rows": table.num_rows,
                    "source_file": str(root / month["file"]), "source_sha256": month["sha256"],
                })
                total += table.num_rows
                if self.adapter.date_column:
                    days.update(self.data_dates(table))
            if not files:
                raise CollectorError("所选仓库范围没有数据，未生成空 Bundle")
            source_files = [
                {"file": item["source_file"], "sha256": item["source_sha256"]} for item in files
            ]
            if file_layout in {"single", "grouped"} or sort_by:
                files = reorganize_export(
                    staging, files, pa.schema([self.schema.field(name) for name in columns]),
                    file_layout, sort_by, split_by,
                )
                for item in files:
                    item["sha256"] = parquet_digest(staging / item["file"])
            manifest = {
                "bundle_id": bundle_id, "created_at": now(), "snapshot_id": snapshot["snapshot_id"],
                "dataset_id": self.dataset_id, "entry_id": self.entry_id, "api_name": self.api_name,
                **self.adapter.capabilities(),
                "snapshot_manifest_path": snapshot["manifest_path"],
                "snapshot_manifest_sha256": snapshot["manifest_sha256"],
                "columns": columns, "start_date": start, "end_date": end, "ts_codes": codes,
                "variant_id": snapshot.get("selected_variant_id"),
                "rows": total, "days": len(days), "files": files, "coverage": "not_proven",
                "file_layout": file_layout, "sort_by": sort_by, "null_order": "last",
                "split_by": split_by,
                "sort_scope": "within_group" if file_layout == "grouped" else "global",
                "file_order": [item["file"] for item in files], "source_files": source_files,
                "transformation": (
                    "stock_filter_and_column_projection" if self.adapter.date_column is None
                    else "date_stock_filter_and_column_projection"
                ),
                "snapshot_file": "source_snapshot.json",
            }
            copy_verified(
                Path(snapshot["manifest_path"]), staging / "source_snapshot.json",
                snapshot["manifest_sha256"],
            )
            digest = write_json(staging / "manifest.json", manifest)
            sync_directory(staging / "data")
            sync_directory(staging)
            atomic_move(staging, final)
            sync_directory(parent)
        try:
            with self.store.connect() as db:
                db.execute(
                    "INSERT INTO warehouse_bundles VALUES(?,?,?,?,?,?,?)",
                    (bundle_id, snapshot["snapshot_id"], str(destination), str(final / "manifest.json"),
                     digest, manifest["created_at"], encode({
                         "start_date": start, "end_date": end, "columns": columns, "ts_codes": codes,
                         "file_layout": file_layout, "sort_by": sort_by, "split_by": split_by,
                     })),
                )
        except sqlite3.Error as error:
            raise CollectorError(
                f"Bundle 已写入 {final}，但登记失败：{error}；请检查数据库"
            ) from None
        return {
            "bundle_id": bundle_id, "directory": str(final), "manifest_path": str(final / "manifest.json"),
            "dataset_id": self.dataset_id, "entry_id": self.entry_id, "name": self.name,
            "manifest_sha256": digest, "snapshot_id": snapshot["snapshot_id"], "columns": columns,
            "variant_id": snapshot.get("selected_variant_id"),
            "file_layout": file_layout, "sort_by": sort_by, "split_by": split_by,
            "rows": total, "days": len(days), "files": len(files), "start_date": start, "end_date": end,
        }


class SnapshotWarehouse(DateWarehouse):
    def context(self):
        from .datasets import RECIPES

        with self.store.connect() as db:
            db.execute("BEGIN")
            settings, _ = self.datasets.checked_settings(db, self.dataset_id)
            scope = scope_for(RECIPES[self.dataset_id], settings)
            active = bool(self.datasets.active(db, self.dataset_id))
            run = db.execute(
                "SELECT r.id FROM runs r JOIN dataset_runs d ON d.run_id=r.id "
                "WHERE d.dataset_id=? AND d.scope=? AND r.state='succeeded' "
                "AND (SELECT COUNT(*) FROM slices s WHERE s.run_id=r.id)=15 "
                "AND NOT EXISTS(SELECT 1 FROM slices s WHERE s.run_id=r.id AND "
                "(s.state!='succeeded' OR EXISTS(SELECT 1 FROM archive_deletions x WHERE x.slice_id=s.id))) "
                "ORDER BY r.finished_at DESC,r.rowid DESC LIMIT 1", (self.dataset_id, scope),
            ).fetchone()
            sources = {}
            if run:
                rows = db.execute(
                    "SELECT s.*,s.rowid source_order,p.partition_key,"
                    "COALESCE(MAX(a.finished_at),r.created_at) observed_at "
                    "FROM slices s JOIN runs r ON r.id=s.run_id "
                    "JOIN dataset_partitions p ON p.slice_id=s.id LEFT JOIN attempts a ON a.slice_id=s.id "
                    "WHERE s.run_id=? GROUP BY s.id", (run["id"],),
                ).fetchall()
                expected = {
                    (exchange, status) for exchange in ("SSE", "SZSE", "BSE")
                    for status in ("L", "D", "P", "G", "UN")
                }
                actual = set()
                for row in rows:
                    item = dict(row)
                    params = json.loads(item["params_json"])
                    if set(params) != {"exchange", "list_status"}:
                        raise CollectorError("股票快照只接受预置交易所及上市状态请求")
                    actual.add((params["exchange"], params["list_status"]))
                    item["config"] = {"raw_root": settings.raw_root}
                    sources[item["partition_key"]] = item
                if actual != expected or len(rows) != len(expected) or len(sources) != len(expected):
                    raise CollectorError("股票快照需要同一次完整成功运行的 15 个状态切片，不能混用局部运行")
        repository_id = self.repository_id_for(settings.raw_root)
        return self.root / repository_id, repository_id, settings.raw_root, sources, active

    def describe(self, root, raw_root, sources, active, snapshot):
        result = super().describe(root, raw_root, sources, active, snapshot)
        result.update(
            partitions=len(snapshot["dates"]) if snapshot else 0,
            available_source_partitions=len(sources),
            new_partitions=result["new_days"], changed_partitions=result["changed_days"],
            reused_partitions=result["reused_days"],
            days=0, days_with_rows=0, dates=[], first_date=None, last_date=None,
            available_source_days=0, new_days=0, changed_days=0, reused_days=0,
            source_run_id=next(iter(snapshot["dates"].values()))["run_id"] if snapshot else None,
        )
        return result

    def source_table(self, key, item, *, require_all_fields=False):
        raw, _, metadata = source_paths(item)
        params = json.loads(item["params_json"])
        if raw.suffix != ".parquet" or any(
            metadata.get(name) != value for name, value in (
                ("params", params), ("run_id", item["run_id"]),
                ("slice_id", item["id"]), ("api_name", self.api_name),
            )
        ):
            raise CollectorError("股票快照归档格式、来源或请求条件不一致")
        with verified_open(raw, item["raw_sha256"]) as stream:
            parquet = pq.ParquetFile(stream)
            if parquet.metadata.num_rows > MAX_MONTH_ROWS:
                raise CollectorError("股票快照超过本地安全读取上限")
            table = parquet.read()
        if set(self.schema.names) - set(table.column_names):
            raise CollectorError("股票快照缺少仓库字段，请明确补采")
        if require_all_fields and set(table.column_names) != set(self.schema.names):
            raise CollectorError("股票快照返回了仓库契约以外的字段；已保留 Raw，请适配后再发布")
        table = table.select(self.schema.names).cast(self.schema, safe=True)
        if (
            len(stock_codes(table["ts_code"].to_pylist(), historical=True)) != table.num_rows
            or any(value != params["exchange"] for value in table["exchange"].to_pylist())
            or any(value != params["list_status"] for value in table["list_status"].to_pylist())
        ):
            raise CollectorError("股票快照代码重复或交易所、上市状态与请求不一致")
        return table, {
            "run_id": item["run_id"], "slice_id": item["id"], "raw_path": str(raw),
            "meta_path": item["meta_path"], "data_sha256": item["raw_sha256"],
            "meta_sha256": item["meta_sha256"], "rows": table.num_rows,
            "observed_at": item["observed_at"], "source_order": item["source_order"],
            "params": params,
            **({"preserved_fields": self.schema.names} if require_all_fields else {}),
        }

    def publish(self, root, repository_id, raw_root, changed, snapshot, sources, *, verify_content=False):
        tables, dates = [], {}
        for key, item in sorted(sources.items()):
            table, source = self.source_table(key, item, require_all_fields=verify_content)
            tables.append(table)
            dates[key] = source
        total = sum(table.num_rows for table in tables)
        if not 0 < total <= MAX_MONTH_ROWS:
            raise CollectorError("股票快照整体为空或超过安全上限，未发布")
        table = pa.concat_tables(tables).sort_by([("ts_code", "ascending")])
        if len(stock_codes(table["ts_code"].to_pylist(), historical=True)) != total:
            raise CollectorError("股票快照跨状态存在重复股票，不能发布混合快照")
        snapshot_id = uuid.uuid4().hex
        parent = root / "snapshots"
        parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".t-", dir=root) as temporary:
            staging = Path(temporary)
            (staging / "months").mkdir()
            path = staging / "months" / "current.parquet"
            pq.write_table(table, path, compression="zstd")
            receipt = readback_receipt(table, path, verify_content)
            manifest = {
                "format_version": 1, "snapshot_id": snapshot_id, "created_at": now(),
                "source_raw_root": raw_root, "api_name": self.api_name, "entry_id": self.entry_id,
                "dataset_id": self.dataset_id, "schema": self.schema_description(),
                "grain": self.adapter.grain, "date_column": None, "columns": self.schema.names,
                "dates": dates, "rows": total,
                "months": [{
                    "month": "current", "rows": total, "days": 0,
                    "file": f"snapshots/{snapshot_id}/months/current.parquet",
                    "sha256": parquet_digest(path),
                    **receipt,
                }],
                "version_rule": "latest_complete_successful_run; not_historical_universe",
                "coverage": "not_proven",
            }
            digest = write_json(staging / "manifest.json", manifest)
            sync_directory(staging / "months")
            sync_directory(staging)
            final = parent / snapshot_id
            atomic_move(staging, final)
            sync_directory(parent)
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO warehouse_snapshots VALUES(?,?,?,?,?,?,?,?)",
                (snapshot_id, repository_id, raw_root, str(final / "manifest.json"), digest,
                 manifest["created_at"], total, 0),
            )
        published = {
            **manifest, "manifest_path": str(final / "manifest.json"), "manifest_sha256": digest,
            "source_watermarks": snapshot.get("source_watermarks", {}) if snapshot else {},
        }
        published["source_watermarks"] = self.publish_pointer(root, published, sources)
        return published

    def selected(self, snapshot_id, start_date, end_date, codes, variant_id=None):
        if variant_id is not None:
            raise CollectorError("此仓库不支持请求变体筛选")
        if start_date or end_date:
            raise CollectorError("股票基础信息是当前快照，不支持历史日期筛选；请使用股票代码筛选")
        root, repository_id, _, _, _ = self.context()
        snapshot = self.snapshot(root, repository_id, snapshot_id)
        if snapshot is None:
            raise CollectorError("股票快照尚未发布，请先整理完整运行归档")
        return (
            root, snapshot, None, None, stock_codes(codes, historical=True),
            snapshot["dates"], snapshot["months"],
        )

    def filter(self, table, start, end, codes):
        if codes:
            return table.filter(pc.is_in(table["ts_code"], value_set=pa.array(codes)))
        return table

    def rows(
        self, *, snapshot_id=None, start_date=None, end_date=None, ts_code="", offset=0, limit=50,
        variant_id=None,
    ):
        if offset < 0 or not 1 <= limit <= 200:
            raise CollectorError("仓库分页范围不正确")
        root, snapshot, _, _, codes, _, months = self.selected(
            snapshot_id, start_date, end_date, [ts_code] if ts_code else [], variant_id,
        )
        table = self.filter(self.month_table(root, months[0]), None, None, codes)
        selected = table.slice(offset, limit)
        values = [column.to_pylist() for column in selected.columns]
        return {
            "dataset_id": self.dataset_id, "entry_id": self.entry_id, "name": self.name,
            "snapshot_id": snapshot["snapshot_id"], "columns": self.schema.names,
            "rows": [[json_cell(value) for value in row] for row in zip(*values, strict=True)],
            "total_rows": snapshot["rows"], "matching_rows": table.num_rows,
            "offset": offset, "limit": limit,
            "next_offset": (
                offset + selected.num_rows if offset + selected.num_rows < table.num_rows else None
            ),
            "hash_verified": True, "coverage": "not_proven",
        }


class DailyWarehouse(DateWarehouse):
    def __init__(self, store, datasets, root):
        super().__init__(store, datasets, root, WAREHOUSE_ADAPTERS["daily"])
