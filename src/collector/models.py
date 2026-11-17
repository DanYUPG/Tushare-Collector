from __future__ import annotations

import itertools
import json
import math
import re
from datetime import date, timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .permissions import ACCESS, DEFAULT_RPM, PERMISSIONS, permission_summary

CATALOG = json.loads(Path(__file__).with_name("catalog.json").read_text(encoding="utf-8"))
if set(ACCESS) != {entry["id"] for entry in CATALOG["entries"]}:
    raise ValueError("Permission audit must cover the complete stock catalog")
CATALOG["permissions"] = {key: value for key, value in PERMISSIONS.items() if key != "entries"}
for entry in CATALOG["entries"]:
    entry["access"] = ACCESS[entry["id"]]
    entry["permission_note"] = entry["permission"] = permission_summary(entry["access"])
ENTRIES = {entry["id"]: entry for entry in CATALOG["entries"]}
MAX_SLICES = 20000


class CollectorError(ValueError):
    pass


def is_stock_code(value, *, historical=False):
    return isinstance(value, str) and bool(re.fullmatch(
        r"(?:\d{6}\.(?:SH|SZ|BJ)|T\d{5,6}\.SH)" if historical else r"\d{6}\.(SH|SZ|BJ)",
        value,
    ))


def absolute_directory(value: str, label: str = "Raw") -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise CollectorError(f"{label} 目录必须是非文件系统根目录的绝对路径")
    path = path.resolve()
    if path == Path(path.anchor):
        raise CollectorError(f"{label} 目录不能是文件系统根目录")
    if path.exists() and not path.is_dir():
        raise CollectorError(f"{label} 路径不是目录")
    return path


class TaskConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    entry_id: str
    params: dict = Field(default_factory=dict)
    fields: str = ""
    transport: Literal["sdk", "http"] = "sdk"
    raw_root: str
    requests_per_minute: int = Field(default=DEFAULT_RPM, ge=1, le=500)
    max_attempts: int = Field(default=3, ge=1, le=5)
    timeout_seconds: int = Field(default=30, ge=5, le=120)
    row_limit: int | None = Field(default=None, ge=1)
    allow_empty: bool = False
    mode: Literal["single", "date_range"] = "single"
    date_param: str = "trade_date"
    start_date: str | None = None
    end_date: str | None = None
    split_param: str | None = None
    split_values: list[str | int | float | bool] = Field(default_factory=list, max_length=20000)

    @field_validator("name")
    @classmethod
    def nonblank_name(cls, value):
        if not value.strip():
            raise ValueError("任务名称不能为空")
        return value.strip()

    @field_validator("raw_root")
    @classmethod
    def absolute_raw_root(cls, value):
        return str(absolute_directory(value))


def plan(config: TaskConfig) -> list[dict]:
    entry = ENTRIES.get(config.entry_id)
    if entry is None:
        raise CollectorError("只能选择目录中的 Tushare 股票接口")
    if entry["status"] == "sdk_only" and config.transport != "sdk":
        raise CollectorError("该入口是 SDK 计算接口，不支持直接 HTTP Raw 拉取")
    allowed = {param["name"] for param in entry["params"]}
    unknown = set(config.params) - allowed
    if unknown:
        raise CollectorError(f"文档未列出的请求参数：{', '.join(sorted(unknown))}")
    for key, value in config.params.items():
        if entry["api_name"] == "pro_bar" and key == "ma":
            if not isinstance(value, list) or not all(
                type(item) is int and 1 <= item <= 1000 for item in value
            ):
                raise CollectorError("pro_bar.ma 必须是 1–1000 的整数数组")
            continue
        if entry["api_name"] == "pro_bar" and key == "factors":
            if not isinstance(value, list) or not all(
                isinstance(item, str) and item in {"tor", "vr"} for item in value
            ):
                raise CollectorError('pro_bar.factors 只支持 ["tor","vr"] 的子集')
            continue
        if not isinstance(value, (str, int, float, bool, type(None))):
            raise CollectorError(f"参数 {key} 必须是 JSON 标量")
        if isinstance(value, float) and not math.isfinite(value):
            raise CollectorError(f"参数 {key} 必须是有限数值")
    fields = [name.strip() for name in config.fields.split(",") if name.strip()]
    known_fields = {field["name"] for field in entry["fields"]}
    if len(fields) != len(set(fields)):
        raise CollectorError("返回字段不能重复")
    if any(not re.fullmatch(r"[A-Za-z][A-Za-z_0-9]*", name) for name in fields):
        raise CollectorError("返回字段名称格式不正确")
    if known_fields and set(fields) - known_fields:
        raise CollectorError("返回字段包含文档未列出的名称")
    dates: list[str | None] = [None]
    if config.mode == "date_range":
        if config.date_param not in allowed:
            raise CollectorError("该接口不支持所选日期参数")
        if config.date_param in config.params:
            raise CollectorError("日期切片参数不能同时在基础参数中填写")
        try:
            start = date.fromisoformat(config.start_date or "")
            end = date.fromisoformat(config.end_date or "")
        except ValueError as error:
            raise CollectorError("切片日期须为 YYYY-MM-DD") from error
        days = (end - start).days + 1
        if days < 1 or days > MAX_SLICES:
            raise CollectorError(f"日期范围必须为 1–{MAX_SLICES} 天")
        dates = [(start + timedelta(days=offset)).strftime("%Y%m%d") for offset in range(days)]
    values: list = [None]
    if config.split_param:
        if config.split_param not in allowed or not config.split_values:
            raise CollectorError("枚举切片须选择有效参数并填写非空值列表")
        if config.split_param in config.params or (
            config.mode == "date_range" and config.split_param == config.date_param
        ):
            raise CollectorError("枚举参数与基础参数或日期切片冲突")
        if any(isinstance(value, float) and not math.isfinite(value) for value in config.split_values):
            raise CollectorError("枚举值必须是有限数值")
        serialized = [json.dumps(value, ensure_ascii=False, sort_keys=True) for value in config.split_values]
        if len(serialized) != len(set(serialized)):
            raise CollectorError("枚举值不能重复")
        values = config.split_values
    elif config.split_values:
        raise CollectorError("填写枚举值时必须选择枚举参数")
    if len(dates) * len(values) > MAX_SLICES:
        raise CollectorError(f"单次运行最多 {MAX_SLICES} 个请求切片，请缩小范围")
    result = []
    for day, value in itertools.product(dates, values):
        params = dict(config.params)
        if day is not None:
            params[config.date_param] = day
        if config.split_param:
            params[config.split_param] = value
        missing = [
            param["name"]
            for param in entry["params"]
            if param["required"] and (params.get(param["name"]) is None or params.get(param["name"]) == "")
        ]
        if missing:
            raise CollectorError(f"缺少必填参数：{', '.join(missing)}")
        if entry["api_name"] == "pro_bar":
            if params.get("asset", "E") != "E":
                raise CollectorError("本项目的 pro_bar 只允许 asset=E，不支持指数、基金、期货等资产")
            if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", str(params.get("ts_code", ""))):
                raise CollectorError("pro_bar 必须填写沪深北股票代码")
        if entry["api_name"] == "daily_basic" and not (params.get("ts_code") or params.get("trade_date")):
            raise CollectorError("daily_basic 必须填写 ts_code 或 trade_date")
        result.append(params)
    return result
