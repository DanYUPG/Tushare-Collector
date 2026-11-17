from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import uuid
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import pyarrow.parquet as pq

from .client import reject_json_constant
from .filesystem import atomic_move, compact_identifier, ensure_path_length, sync_directory
from .models import CollectorError, absolute_directory
from .store import Store, encode, now

MAX_JSON_BYTES = 64 * 1024 * 1024
DIRECTORY_DIALOG_LOCK = threading.Lock()


def choose_directory(initial_path: str | None = None):
    initial = absolute_directory(initial_path, "选择") if initial_path else Path.home()
    while not initial.is_dir():
        initial = initial.parent
    script = """
on run argv
    set initialFolder to POSIX file (item 1 of argv)
    set selected to choose folder with prompt "选择 Tushare 数据目录" default location initialFolder
    return POSIX path of selected
end run
"""
    command = ["osascript", "-e", script, str(initial)]
    if sys.platform != "darwin":
        script = """
import sys
from tkinter import Tk, filedialog

root = Tk()
root.withdraw()
try:
    print(filedialog.askdirectory(title="选择 Tushare 数据目录", initialdir=sys.argv[1], mustexist=True))
finally:
    root.destroy()
"""
        command = [sys.executable, "-X", "utf8", "-c", script, str(initial)]
    if not DIRECTORY_DIALOG_LOCK.acquire(blocking=False):
        raise CollectorError("已有目录选择窗口，请先完成或取消选择")
    try:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                encoding="utf-8",
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise CollectorError(f"无法打开目录选择器：{str(error)}") from None
    finally:
        DIRECTORY_DIALOG_LOCK.release()
    if result.returncode:
        if "(-128)" in result.stderr:
            return {"cancelled": True, "path": None}
        raise CollectorError(f"目录选择失败：{result.stderr.strip()[-300:]}；也可手工填写绝对目录")
    if not result.stdout.strip():
        if sys.platform != "darwin":
            return {"cancelled": True, "path": None}
        raise CollectorError("目录选择器未返回路径")
    return {"cancelled": False, "path": str(absolute_directory(result.stdout.strip(), "选择"))}


def contained_file(value: str, root: Path) -> Path:
    try:
        path = Path(value).resolve(strict=True)
    except OSError as error:
        raise CollectorError(f"归档文件不存在或不可访问：{str(error)}") from None
    if not path.is_relative_to(root) or not path.is_file():
        raise CollectorError("归档文件不在此运行的 Raw 根目录内")
    return path


def verified_open(path: Path, expected_hash: str):
    stream = path.open("rb")
    try:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected_hash:
            raise CollectorError(f"归档文件哈希校验失败：{path.name}")
        stream.seek(0)
    except BaseException:
        stream.close()
        raise
    return stream


def source_paths(item: dict):
    root = Path(item["config"]["raw_root"]).resolve()
    raw = contained_file(item["raw_path"], root)
    meta = contained_file(item["meta_path"], root)
    if raw.name not in {"data.parquet", "dataframe.json", "response.json"} or meta.name != "meta.json":
        raise CollectorError("归档文件格式或名称不受支持")
    with verified_open(meta, item["meta_sha256"]) as stream:
        try:
            metadata = json.load(stream, parse_constant=reject_json_constant)
        except (ValueError, UnicodeDecodeError):
            raise CollectorError("归档元数据不是有效 JSON") from None
    if not isinstance(metadata, dict):
        raise CollectorError("归档元数据格式不正确")
    if metadata.get("data_file", metadata.get("response_file")) != raw.name:
        raise CollectorError("归档元数据中的文件名与登记不一致")
    if metadata.get("data_sha256", metadata.get("response_sha256")) != item["raw_sha256"]:
        raise CollectorError("归档元数据中的哈希与登记不一致")
    return raw, meta, metadata


def json_cell(value):
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return str(value) if abs(value) > 9007199254740991 else value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, bytes):
        return f"<binary: {len(value)} bytes>"
    if isinstance(value, list):
        return [json_cell(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_cell(item) for key, item in value.items()}
    return str(value)


def preview_slice(
    store: Store,
    run_id: str,
    slice_id: str,
    offset: int = 0,
    limit: int = 50,
    query: str = "",
    column: str = "",
):
    if offset < 0 or not 1 <= limit <= 200 or len(query) > 200:
        raise CollectorError("预览分页范围不正确，每页最多 200 行")
    if column and not query:
        raise CollectorError("按字段筛选时须填写搜索内容")
    item = store.archived_slice(run_id, slice_id)
    raw, _, metadata = source_paths(item)
    if raw.suffix != ".parquet" and raw.stat().st_size > MAX_JSON_BYTES:
        raise CollectorError("JSON 归档超过 64 MiB 预览限制，可导出原文件后离线查看")
    with verified_open(raw, item["raw_sha256"]) as stream:
        if raw.suffix == ".parquet":
            parquet = pq.ParquetFile(stream)
            columns = [{"name": field.name, "type": str(field.type)} for field in parquet.schema_arrow]
            total = parquet.metadata.num_rows
            if column and column not in {item["name"] for item in columns}:
                raise CollectorError("筛选字段不存在")
            rows = []
            skip = offset
            matched = 0
            if query:
                names = [item["name"] for item in columns]
                for batch in parquet.iter_batches(batch_size=256):
                    for record in batch.to_pylist():
                        values = [record[column]] if column else record.values()
                        if not any(query.casefold() in str(json_cell(value)).casefold() for value in values):
                            continue
                        if offset <= matched < offset + limit:
                            rows.append([json_cell(record[name]) for name in names])
                        matched += 1
            elif offset < total:
                for batch in parquet.iter_batches(batch_size=256):
                    if skip >= batch.num_rows:
                        skip -= batch.num_rows
                        continue
                    page = batch.slice(skip, min(limit - len(rows), batch.num_rows - skip))
                    rows.extend(
                        [[json_cell(row[column["name"]]) for column in columns] for row in page.to_pylist()]
                    )
                    skip = 0
                    if len(rows) >= limit:
                        break
            if not query:
                matched = total
        else:
            try:
                document = json.load(stream, parse_constant=reject_json_constant)
            except (ValueError, UnicodeDecodeError):
                raise CollectorError("归档响应不是有效 JSON，无法预览表格") from None
            data = document.get("data") if isinstance(document, dict) and document.get("code") == 0 else None
            names = data.get("fields") if isinstance(data, dict) else None
            items = data.get("items") if isinstance(data, dict) else None
            if (
                not isinstance(names, list)
                or not names
                or not all(isinstance(name, str) for name in names)
                or len(names) != len(set(names))
                or not isinstance(items, list)
                or any(not isinstance(row, list) or len(row) != len(names) for row in items)
            ):
                raise CollectorError("归档响应不含有效的可预览表格")
            columns = [{"name": name, "type": "JSON"} for name in names]
            total = len(items)
            if column and column not in names:
                raise CollectorError("筛选字段不存在")
            filtered = (
                [
                    row
                    for row in items
                    if any(
                        query.casefold() in str(json_cell(value)).casefold()
                        for value in ([row[names.index(column)]] if column else row)
                    )
                ]
                if query
                else items
            )
            matched = len(filtered)
            rows = [[json_cell(value) for value in row] for row in filtered[offset : offset + limit]]
    return {
        "run_id": run_id,
        "slice_id": slice_id,
        "source_state": item["state"],
        "source_error": item["error"],
        "is_preview": bool(item["is_preview"]),
        "filename": raw.name,
        "columns": columns,
        "total_rows": total,
        "matching_rows": matched,
        "query": query,
        "column": column,
        "offset": offset,
        "limit": limit,
        "rows": rows,
        "next_offset": offset + len(rows) if offset + len(rows) < matched else None,
        "capture_format": metadata.get("capture_format"),
        "is_derived": metadata.get("is_derived"),
        "hash_verified": True,
        "slice_number": item["ordinal"] + 1,
        "params": json.loads(item["params_json"]),
        "requested_at": metadata.get("requested_at"),
        "ingested_at": metadata.get("ingested_at"),
    }


def copy_verified(source: Path, target: Path, expected_hash: str):
    ensure_path_length(target)
    digest = hashlib.sha256()
    with source.open("rb") as reader, target.open("xb") as writer:
        while chunk := reader.read(1024 * 1024):
            digest.update(chunk)
            writer.write(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    if digest.hexdigest() != expected_hash:
        raise CollectorError(f"导出期间源文件发生变化或损坏：{source.name}")


def organized_export_group(entry, item, metadata, parquet_schema=None):
    params = json.loads(item["params_json"])
    partition_keys = {
        "ts_code", "trade_date", "cal_date", "ann_date", "start_date", "end_date",
        "period", "date", "month", "report_date", "float_date", "surv_date", "ipo_date",
    }
    options = {key: value for key, value in params.items() if key not in partition_keys}
    # Front-adjusted slices can use different price anchors even with identical fields.
    if entry["api_name"] == "pro_bar" and params.get("adj") == "qfq":
        options.update({key: params[key] for key in ("ts_code", "start_date", "end_date") if key in params})
    fields = metadata.get("fields", "")
    if not isinstance(fields, str):
        raise CollectorError("归档元数据的请求字段格式不正确，不能整理导出")
    requested_fields = [field.strip() for field in fields.split(",") if field.strip()]
    variant = {
        "request_options": options,
        "requested_fields": requested_fields,
        "capture_format": metadata.get("capture_format"),
        "source_state": item["state"],
    }
    schema = metadata.get("schema")
    if schema is not None and (
        not isinstance(schema, list)
        or not schema
        or any(
            not isinstance(field, dict)
            or not isinstance(field.get("name"), str)
            or not isinstance(field.get("type"), str)
            or type(field.get("nullable")) is not bool
            for field in schema
        )
    ):
        raise CollectorError("归档元数据的字段结构格式不正确，不能整理导出")
    if parquet_schema is not None:
        if schema is not None and schema != parquet_schema:
            raise CollectorError("Parquet 实际字段结构与归档声明不一致，不能整理导出")
        schema = parquet_schema
    variant_id = hashlib.sha256(encode(variant).encode()).hexdigest()
    schema_id = hashlib.sha256(encode(schema).encode()).hexdigest() if schema is not None else "unknown"
    identity = {
        "entry_id": entry["id"], "api_name": entry["api_name"],
        "variant_id": variant_id, "schema_id": schema_id,
    }
    group_id = hashlib.sha256(encode(identity).encode()).hexdigest()
    relative = Path("g-" + compact_identifier(group_id))
    return {
        **identity,
        "group_id": group_id,
        "directory": relative.as_posix(),
        "data_directory": (relative / "d").as_posix(),
        "metadata_directory": (relative / "m").as_posix(),
        "schema": schema,
        "schema_status": (
            "verified_parquet" if parquet_schema is not None
            else "archive_metadata" if schema is not None else "unknown"
        ),
        **variant,
    }


def export_data(
    store: Store, run_id: str, destination: str, slice_id: str | None = None, layout: str = "raw",
):
    if layout not in {"raw", "organized"}:
        raise CollectorError("导出布局只能为 raw 或 organized")
    root = absolute_directory(destination, "导出")
    if slice_id:
        run, items = store.run(run_id), [store.archived_slice(run_id, slice_id)]
    else:
        run, items = store.archived_slices(run_id)
    if not items:
        raise CollectorError("此运行没有可以导出的成功切片")
    sources = [(item, *source_paths(item)) for item in items]
    if any(root.is_relative_to(raw.parent) for _, raw, _, _ in sources):
        raise CollectorError("导出目录不能位于源归档的切片目录内")
    export_id = uuid.uuid4().hex
    parent = root / "tushare_exports"
    final = parent / f"export-{export_id}"
    ensure_path_length(final / "manifest.json")
    parent.mkdir(parents=True, exist_ok=True)
    files = []
    groups = {}
    with tempfile.TemporaryDirectory(prefix=".t-", dir=parent) as temporary:
        staging = Path(temporary)
        for item, raw, meta, metadata in sources:
            group = None
            verified_data = None
            params = json.loads(item["params_json"])
            if layout == "organized":
                if any(metadata.get(key) != value for key, value in (
                    ("run_id", run_id), ("slice_id", item["id"]), ("api_name", run["entry"]["api_name"]),
                    ("params", params),
                )):
                    raise CollectorError("归档元数据的来源或请求条件与登记不一致，不能整理导出")
                filename = compact_identifier(item["id"])
                verified_data = staging / f".v-{filename}{raw.suffix}"
                copy_verified(raw, verified_data, item["raw_sha256"])
                parquet_schema = [
                    {"name": field.name, "type": str(field.type), "nullable": field.nullable}
                    for field in pq.read_schema(verified_data)
                ] if raw.suffix == ".parquet" else None
                group = organized_export_group(run["entry"], item, metadata, parquet_schema)
                groups.setdefault(group["directory"], group)
                data_relative = Path(group["data_directory"]) / (filename + raw.suffix)
                meta_relative = Path(group["metadata_directory"]) / f"{filename}.json"
            else:
                relative = Path(f"{item['ordinal'] + 1:06d}-{item['id']}")
                data_relative, meta_relative = relative / raw.name, relative / meta.name
            data_target, meta_target = staging / data_relative, staging / meta_relative
            for relative in (data_relative, meta_relative):
                ensure_path_length(staging / relative)
                ensure_path_length(final / relative)
            data_target.parent.mkdir(parents=True, exist_ok=True)
            meta_target.parent.mkdir(parents=True, exist_ok=True)
            if verified_data is not None:
                verified_data.rename(data_target)
            else:
                copy_verified(raw, data_target, item["raw_sha256"])
            copy_verified(meta, meta_target, item["meta_sha256"])
            files.append(
                {
                    "slice_id": item["id"],
                    "source_state": item["state"],
                    "source_error": item["error"],
                    "data_file": data_relative.as_posix(),
                    "data_sha256": item["raw_sha256"],
                    "meta_file": meta_relative.as_posix(),
                    "meta_sha256": item["meta_sha256"],
                    "source_path": str(raw),
                    "source_meta_path": str(meta),
                    "capture_format": metadata.get("capture_format"),
                    "is_derived": metadata.get("is_derived"),
                    "run_id": run_id,
                    "entry_id": run["entry"]["id"],
                    "api_name": run["entry"]["api_name"],
                    "category": run["entry"]["category"],
                    "doc_url": run["entry"]["doc_url"],
                    "dataset_id": run.get("dataset_id"),
                    "attempt_id": metadata.get("attempt_id"),
                    "transport": metadata.get("transport"),
                    "requested_fields": metadata.get("fields"),
                    "params": params,
                    "registered_rows": item["rows"],
                    "archived_rows": metadata.get("rows"),
                    "schema": group["schema"] if group else metadata.get("schema"),
                    "schema_status": group["schema_status"] if group else (
                        "archive_metadata" if metadata.get("schema") is not None else "unknown"
                    ),
                    "requested_at": metadata.get("requested_at"),
                    "ingested_at": metadata.get("ingested_at"),
                    "group_directory": group["directory"] if group else None,
                }
            )
        manifest = {
            "manifest_version": 3 if layout == "organized" else 2,
            "layout": layout,
            "export_id": export_id,
            "run_id": run_id,
            "run_state": run["state"],
            "created_at": now(),
            "mode": "slice" if slice_id else "successful_slices",
            "exported_slices": len(items),
            "run_total_slices": run["total"],
            "skipped_slices": run["total"] - len(items) if not slice_id else None,
            "coverage": "not_proven",
            "merged": False,
            "deduplicated": False,
            "groups": list(groups.values()),
            "warnings": [
                "目录与文件名为内部标识，完整请求条件见清单；不表示实际数据覆盖，登记行数可能含重复。",
                "JSON 保持原响应格式；未知字段结构未核定兼容性，不应直接当作统一业务表。",
                "分组不保证业务主键唯一、数据连续或复权序列一致，不自动选取最新修订。",
            ] if layout == "organized" else [],
            "files": files,
        }
        content = (encode(manifest) + "\n").encode("utf-8")
        with (staging / "manifest.json").open("xb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        for directory, _, _ in os.walk(staging, topdown=False):
            sync_directory(Path(directory))
        atomic_move(staging, final)
        sync_directory(parent)
    manifest_path = final / "manifest.json"
    digest = hashlib.sha256(content).hexdigest()
    try:
        store.register_export(export_id, run_id, slice_id, str(root), str(manifest_path), digest)
    except sqlite3.Error as error:
        raise CollectorError(f"文件已导出至 {final}，但 SQLite 登记失败：{str(error)}") from None
    return {
        "export_id": export_id,
        "layout": layout,
        "directory": str(final),
        "manifest_path": str(manifest_path),
        "manifest_sha256": digest,
        "exported_slices": len(items),
        "skipped_slices": manifest["skipped_slices"],
        "destination": str(root),
    }
