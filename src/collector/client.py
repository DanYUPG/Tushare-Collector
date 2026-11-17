from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from functools import partial
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .filesystem import atomic_move, ensure_path_length, sync_directory
from .store import encode

API_URL = "https://api.tushare.pro"


def reject_json_constant(value):
    raise ValueError(f"Invalid JSON number: {value}")


class CollectionFailure(Exception):
    def __init__(self, message: str, retryable: bool = False, kind: str | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.kind = kind


class StopRun(Exception):
    def __init__(self, state: str):
        self.state = state
        super().__init__(state)


def redact(message: str, token: str) -> str:
    return message.replace(token, "[REDACTED]") if token else message


@dataclass(frozen=True)
class Response:
    body: bytes | None
    status: int | None
    capture_format: str = "http_response_bytes"
    sdk_version: str | None = None
    frame: pd.DataFrame | None = None


class TushareClient:
    def __init__(
        self,
        token: str,
        timeout: int,
        transport: httpx.BaseTransport | None = None,
        before_request=lambda: None,
    ):
        self.token = token
        self.before_request = before_request
        self.http = httpx.Client(
            timeout=httpx.Timeout(timeout, connect=min(10, timeout)), transport=transport
        )

    def close(self):
        self.http.close()

    def request(self, api_name: str, params: dict, fields: str) -> Response:
        self.current_api_name = api_name
        self.before_request()
        try:
            response = self.http.post(
                API_URL,
                json={"api_name": api_name, "token": self.token, "params": params, "fields": fields},
            )
        except httpx.TransportError as error:
            raise CollectionFailure(f"网络请求失败：{type(error).__name__}", retryable=True) from None
        return Response(response.content, response.status_code)


class SDKClient:
    def __init__(self, token: str, timeout: int, before_request=lambda: None, api=None):
        from tushare.pro.client import DataApi

        self.token, self.before_request = token, before_request
        self.api = api or DataApi(token, timeout=timeout)
        if api is None:
            url = vars(DataApi).get("_DataApi__http_url", "")
            parsed = urlsplit(url)
            if parsed.hostname not in {"api.tushare.pro", "api.waditu.com"}:
                raise CollectionFailure("SDK 默认地址不在官方允许列表内，拒绝发送凭证")
            # SDK 1.4.29 has no public HTTPS setter; change only this instance, never global requests.
            self.api._DataApi__http_url = urlunsplit(("https", parsed.netloc, parsed.path, "", ""))
        self.last_failure = None

    def close(self):
        pass

    def query(self, api_name, fields="", **params):
        from .models import ENTRIES

        if api_name not in {entry["api_name"] for entry in ENTRIES.values() if entry["status"] != "sdk_only"}:
            raise CollectionFailure("SDK 子请求超出股票接口范围")
        try:
            self.current_api_name = api_name
            self.before_request()
        except (StopRun, CollectionFailure) as error:
            self.last_failure = error
            raise
        try:
            return self.api.query(api_name, fields=fields, **params)
        except Exception as error:
            import requests

            if isinstance(error, requests.RequestException):
                failure = CollectionFailure(f"SDK 网络请求失败：{type(error).__name__}", retryable=True)
            else:
                message = redact(str(error), self.token)
                retryable = any(
                    marker in message for marker in ("每分钟", "频次", "频率", "稍后", "服务繁忙")
                )
                if any(marker in message.lower() for marker in ("每天", "每日", "权限", "token")):
                    retryable = False
                failure = CollectionFailure(f"SDK 调用失败：{message[:400]}", retryable=retryable)
            self.last_failure = failure
            raise failure from None

    def __getattr__(self, name):
        return partial(self.query, name)

    def request(self, api_name: str, params: dict, fields: str) -> Response:
        import tushare as ts

        self.last_failure = None
        try:
            if api_name == "pro_bar":
                frame = ts.pro_bar(api=self, retry_count=1, fields=fields, **params)
            else:
                frame = self.query(api_name, fields=fields, **params)
            if self.last_failure is not None:
                raise self.last_failure
            if not isinstance(frame, pd.DataFrame):
                raise CollectionFailure("SDK 未返回 DataFrame，不能视为成功")
        except (StopRun, CollectionFailure):
            raise
        except Exception as error:
            if self.last_failure is not None:
                raise self.last_failure from None
            raise CollectionFailure(f"SDK 返回或计算失败：{redact(str(error), self.token)[:400]}") from None
        return Response(
            None,
            None,
            "sdk_derived_dataframe_parquet" if api_name == "pro_bar" else "sdk_dataframe_parquet",
            version("tushare"),
            frame=frame,
        )


def make_client(token, timeout, transport="sdk", before_request=lambda: None):
    if transport == "sdk":
        return SDKClient(token, timeout, before_request=before_request)
    return TushareClient(token, timeout, before_request=before_request)


def response_contains_token(response: Response, token: str) -> bool:
    if not token:
        return False
    if response.body is not None and token.encode("utf-8") in response.body:
        return True
    if response.frame is not None:
        for _, series in response.frame.items():
            if isinstance(series.dtype, pd.CategoricalDtype) and any(
                token in str(value) for value in series.cat.categories
            ):
                return True
        return any(token in str(column) for column in response.frame.columns) or any(
            token in str(value) for row in response.frame.itertuples(index=False, name=None) for value in row
        )
    return False


def validate_table(returned_fields, rows: int, fields: str, row_limit: int | None, allow_empty: bool):
    if not returned_fields or not all(isinstance(name, str) for name in returned_fields):
        raise CollectionFailure("响应字段列表为空或格式不正确")
    if len(returned_fields) != len(set(returned_fields)):
        raise CollectionFailure("响应字段列表重复")
    requested = {name.strip() for name in fields.split(",") if name.strip()}
    if requested - set(returned_fields):
        raise CollectionFailure("响应缺少请求的返回字段")
    if not rows and not allow_empty:
        raise CollectionFailure("空响应未被允许；检查日期、参数、权限或接口就绪状态")
    if row_limit is not None and rows >= row_limit:
        raise CollectionFailure(
            f"返回 {rows} 行达到检查上限 {row_limit}，可能截断；请拆分参数后新建运行", kind="row_limit"
        )
    return rows


def validate_response(response: Response, fields: str, row_limit: int | None, allow_empty: bool, token: str):
    if response.frame is not None:
        return validate_table(
            list(response.frame.columns), len(response.frame), fields, row_limit, allow_empty
        )
    if response.body is None:
        raise CollectionFailure("未返回 DataFrame 或 HTTP 响应")
    if response.status is not None and response.status != 200:
        raise CollectionFailure(
            f"Tushare HTTP 状态 {response.status}",
            retryable=response.status == 429 or 500 <= response.status <= 599,
        )
    try:
        payload = json.loads(response.body, parse_constant=reject_json_constant)
    except (UnicodeDecodeError, ValueError):
        raise CollectionFailure("响应不是有效 JSON，原文已归档") from None
    if not isinstance(payload, dict) or type(payload.get("code")) is not int:
        raise CollectionFailure("响应缺少有效的业务返回码，原文已归档")
    if payload["code"] != 0:
        message = redact(str(payload.get("msg") or "未提供错误说明"), token)[:400]
        retryable = payload["code"] != 2002 and any(
            marker in message.lower()
            for marker in ("每分钟", "频次", "频率", "rate limit", "稍后", "服务繁忙")
        )
        if any(marker in message for marker in ("每天", "每日", "无权限", "权限不足", "token")):
            retryable = False
        raise CollectionFailure(f"业务错误 {payload['code']}：{message}", retryable=retryable)
    data = payload.get("data")
    if not isinstance(data, dict):
        raise CollectionFailure("响应缺少 data 对象，原文已归档")
    returned_fields, items = data.get("fields"), data.get("items")
    if not isinstance(returned_fields, list) or not all(isinstance(name, str) for name in returned_fields):
        raise CollectionFailure("响应字段列表格式不正确")
    if not returned_fields or len(returned_fields) != len(set(returned_fields)):
        raise CollectionFailure("响应字段列表为空或重复")
    if not isinstance(items, list) or any(
        not isinstance(row, list) or len(row) != len(returned_fields) for row in items
    ):
        raise CollectionFailure("响应 items 与字段列表不对齐")
    return validate_table(returned_fields, len(items), fields, row_limit, allow_empty)


def archive(
    raw_root: str,
    entry: dict,
    run_id: str,
    slice_id: str,
    attempt_id: str,
    body: bytes | None,
    metadata: dict,
    *,
    frame: pd.DataFrame | None = None,
) -> dict:
    if frame is not None and body is not None:
        raise CollectionFailure("不能同时归档 DataFrame 和 HTTP 响应")
    if body is not None and metadata.get("transport") == "sdk":
        raise CollectionFailure("SDK 模式只接受 DataFrame，不回退到 JSON")
    parent = Path(raw_root) / "tushare/stocks" / entry["category"] / entry["api_name"] / run_id / slice_id
    destination = parent / attempt_id
    filename = "data.parquet" if metadata.get("transport") == "sdk" else "response.json"
    ensure_path_length(destination / filename)
    parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".t-", dir=parent))
    raw_sha = None
    schema, rows, pandas_dtypes = None, None, None
    has_data = frame is not None or body is not None
    if frame is not None:
        try:
            table = pa.Table.from_pandas(frame, preserve_index=False)
            pq.write_table(table, temporary / filename, compression="zstd")
        except (pa.ArrowException, ValueError, TypeError) as error:
            raise CollectionFailure(f"DataFrame 无法写入 Parquet：{str(error)}") from None
        schema = [
            {"name": field.name, "type": str(field.type), "nullable": field.nullable}
            for field in table.schema
        ]
        rows = len(frame)
        pandas_dtypes = {name: str(dtype) for name, dtype in frame.dtypes.items()}
    elif body is not None:
        with (temporary / filename).open("xb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
    if has_data:
        with (temporary / filename).open("r+b") as stream:
            os.fsync(stream.fileno())
            raw_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    meta = {
        **metadata,
        "source": "tushare",
        "scope": "stocks",
        "category": entry["category"],
        "api_name": entry["api_name"],
        "doc_url": entry["doc_url"],
        "run_id": run_id,
        "slice_id": slice_id,
        "attempt_id": attempt_id,
        "collector_version": "0.1.0",
        "archive_format_version": 2,
        "storage_format": "parquet" if metadata.get("transport") == "sdk" else "json",
        "data_file": filename if has_data else None,
        "data_sha256": raw_sha,
        "rows": rows,
        "schema": schema,
        "pandas_dtypes": pandas_dtypes,
        "response_sha256": raw_sha,
        "response_file": filename if has_data else None,
        "coverage": "not_proven",
    }
    content = (encode(meta) + "\n").encode("utf-8")
    with (temporary / "meta.json").open("xb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(temporary)
    atomic_move(temporary, destination)
    sync_directory(parent)
    return {
        "raw_dir": str(destination),
        "raw_path": str(destination / filename) if has_data else None,
        "raw_sha256": raw_sha,
        "meta_path": str(destination / "meta.json"),
        "meta_sha256": hashlib.sha256(content).hexdigest(),
    }
