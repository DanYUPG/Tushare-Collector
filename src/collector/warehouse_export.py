from __future__ import annotations

from contextlib import closing

import duckdb
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .artifacts import json_cell
from .models import CollectorError

MAX_SPLIT_FILES = 10_000


def export_options(columns, file_layout, sort_by, split_by=None):
    if file_layout not in {"partitioned", "single", "grouped"}:
        raise CollectorError("导出文件组织须为 partitioned、single 或 grouped")
    if file_layout == "grouped":
        if not isinstance(split_by, str) or split_by not in columns:
            raise CollectorError("按维度拆分须指定一个已选导出字段 split_by")
    elif split_by is not None:
        raise CollectorError("只有按维度拆分 grouped 才能指定 split_by")
    keys = list(sort_by or [])
    if len(keys) > 10:
        raise CollectorError("最多支持 10 个排序字段")
    seen = set()
    for key in keys:
        if (
            not isinstance(key, dict) or set(key) != {"column", "direction"}
            or key["column"] not in columns or key["column"] in seen
            or key["direction"] not in {"asc", "desc"}
        ):
            raise CollectorError("排序字段须属于导出字段且不可重复，方向须为 asc 或 desc")
        seen.add(key["column"])
    return keys


def reorganize_export(staging, files, schema, file_layout, sort_by, split_by=None):
    """Sort on disk and stream bounded Arrow batches into final Parquet files."""
    paths = [str(staging / item["file"]) for item in files]
    output = staging / "ordered"
    output.mkdir()
    with closing(duckdb.connect()) as connection:
        connection.execute("SET memory_limit='256MB'")
        connection.execute("SET threads=2")
        connection.execute("SET temp_directory=?", [str(staging / ".sort-temp")])
        connection.execute("SET preserve_insertion_order=true")
        relation = connection.read_parquet(paths)
        ordered_keys = sort_by
        if file_layout == "grouped":
            quoted = '"' + split_by.replace('"', '""') + '"'
            groups = relation.aggregate(
                f"count(DISTINCT {quoted}) + CASE WHEN count(*) > count({quoted}) THEN 1 ELSE 0 END"
            ).fetchone()[0]
            if groups > MAX_SPLIT_FILES:
                raise CollectorError(
                    f"拆分字段 {split_by} 将生成 {groups} 个文件，超过 {MAX_SPLIT_FILES} 组上限；"
                    "请缩小导出范围或选择其他维度"
                )
            group_key = next(
                (key for key in sort_by if key["column"] == split_by),
                {"column": split_by, "direction": "asc"},
            )
            ordered_keys = [group_key] + [key for key in sort_by if key["column"] != split_by]
        if ordered_keys:
            order = ", ".join(
                '"' + key["column"].replace('"', '""') + '" '
                + key["direction"].upper() + " NULLS LAST"
                for key in ordered_keys
            )
            relation = relation.order(order)
        reader = relation.to_arrow_reader(batch_size=65_536)
        group_index = schema.get_field_index(split_by) if file_layout == "grouped" else None
        writer, current, results = None, None, []
        try:
            for batch in reader:
                if group_index is None:
                    segments = [(batch, None)]
                else:
                    runs = pc.run_end_encode(batch.column(group_index))
                    start, segments = 0, []
                    for end, value in zip(runs.run_ends.to_pylist(), runs.values, strict=True):
                        segments.append((batch.slice(start, end - start), json_cell(value.as_py())))
                        start = end
                for segment, group_value in segments:
                    if (
                        writer is None
                        or (file_layout == "partitioned" and current["rows"] >= 1_000_000)
                        or (file_layout == "grouped" and current["split_value"] != group_value)
                    ):
                        if writer is not None:
                            writer.close()
                        if file_layout == "single":
                            name = "data.parquet"
                        else:
                            prefix = "group" if file_layout == "grouped" else "part"
                            name = f"{prefix}-{len(results):06d}.parquet"
                        current = {"file": f"data/{name}", "rows": 0}
                        if file_layout == "grouped":
                            current["split_value"] = group_value
                        results.append(current)
                        writer = pq.ParquetWriter(output / name, schema, compression="zstd")
                    writer.write_batch(segment.cast(schema, safe=True))
                    current["rows"] += segment.num_rows
        finally:
            if writer is not None:
                writer.close()
    for item in files:
        (staging / item["file"]).unlink()
    for path in output.iterdir():
        path.rename(staging / "data" / path.name)
    output.rmdir()
    temporary = staging / ".sort-temp"
    if temporary.exists():
        temporary.rmdir()
    return results
