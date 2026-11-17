from __future__ import annotations

import hashlib
import json
import tempfile
import uuid
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq

from .artifacts import json_cell, source_paths, verified_open
from .client import CollectionFailure, Response
from .datasets import RECIPES, scope_for, validate_dataset_response
from .filesystem import atomic_move, compact_identifier, ensure_path_length, sync_directory
from .models import CollectorError
from .store import encode, now
from .warehouse import MAX_MONTH_ROWS, DateWarehouse, date_key, parquet_digest, readback_receipt, write_json

DATE_PARAMS = {"start_date", "end_date", "trade_date", "ann_date", "period", "month"}


class RequestWarehouse(DateWarehouse):
    def repository_id_for(self, raw_root, scope=None):
        return hashlib.sha256(f"{self.dataset_id}\0{raw_root}\0{scope}".encode()).hexdigest()

    def context(self):
        recipe = RECIPES[self.dataset_id]
        with self.store.connect() as db:
            db.execute("BEGIN")
            settings, _ = self.datasets.checked_settings(db, self.dataset_id)
            scope = scope_for(recipe, settings)
            _, registered = self.datasets.records(db, self.dataset_id, scope, evidence=True)
            active = bool(self.datasets.active(db, self.dataset_id))
        repository_id = self.repository_id_for(settings.raw_root, scope)
        sources = {}
        for key, source in registered.items():
            item = {**source, "partition_key": key, "config": {"raw_root": settings.raw_root}}
            sources[hashlib.sha256(key.encode()).hexdigest()] = item
        return self.root / repository_id, repository_id, settings.raw_root, sources, active

    def refresh(self, *, verify_content=False, expected_raw_root=None, expected_scope=None):
        with self.store.connect() as db:
            settings, _ = self.datasets.checked_settings(db, self.dataset_id)
            scope = scope_for(RECIPES[self.dataset_id], settings)
            if db.execute(
                "SELECT 1 FROM dataset_splits WHERE dataset_id=? AND scope=? LIMIT 1",
                (self.dataset_id, scope),
            ).fetchone():
                raise CollectorError("此范围已有拆分规则，暂不支持合并父子请求；请使用 Raw 阅读")
        return super().refresh(
            verify_content=verify_content, expected_raw_root=expected_raw_root,
            expected_scope=expected_scope,
        )

    def request_dimensions(self, params):
        recipe = RECIPES[self.dataset_id]
        spec = recipe.get("rule", {})
        date_params = DATE_PARAMS | {spec.get("date_param"), self.adapter.date_column}
        dates = {}
        if "start_date" in params and "end_date" in params:
            dates = {"start": date_key(params["start_date"]), "end": date_key(params["end_date"])}
        else:
            for name in (spec.get("date_param"), self.adapter.date_column, "ann_date", "end_date"):
                if name in params:
                    value = date_key(params[name])
                    dates = {"start": value, "end": value}
                    break
        if not dates or dates["start"] > dates["end"]:
            raise CollectorError("请求分区缺少受支持的日期区间，不能推断覆盖")
        group = {name: value for name, value in params.items() if name not in date_params}
        variant = {name: value for name, value in group.items() if name not in {"ts_code", "con_code"}}
        return dates, group, variant

    def source_table(self, partition, item, *, require_all_fields=False):
        params = json.loads(item["params_json"])
        bounds, _, variant = self.request_dimensions(params)
        raw, _, metadata = source_paths(item)
        if raw.suffix != ".parquet" or any(
            metadata.get(name) != value for name, value in (
                ("params", params), ("run_id", item["run_id"]), ("slice_id", item["id"]),
                ("api_name", self.api_name),
            )
        ):
            raise CollectorError("请求分区归档与接口、参数或来源不一致")
        with verified_open(raw, item["raw_sha256"]) as stream:
            parquet = pq.ParquetFile(stream)
            if parquet.metadata.num_rows > MAX_MONTH_ROWS:
                raise CollectorError("请求分区超过本地安全读取上限 100 万行")
            table = parquet.read()
        table = self.normalize_table(table, require_all_fields)
        try:
            validate_dataset_response(
                RECIPES[self.dataset_id],
                Response(None, None, "sdk_dataframe_parquet", frame=table.to_pandas()),
                params,
            )
        except CollectionFailure as error:
            raise CollectorError(f"请求分区业务校验失败：{error}") from None
        dates = self.date_values(table)
        if dates and bounds["start"] is not None and (
            dates[0] < bounds["start"] or dates[-1] > bounds["end"]
        ) and self.adapter.date_semantics not in {"week_interval", "month"}:
            raise CollectorError("分区记录日期超出请求范围")
        source = {
            "partition_key": item["partition_key"], "params": params,
            "request_start": bounds["start"], "request_end": bounds["end"],
            "variant_id": hashlib.sha256(encode(variant).encode()).hexdigest(), "variant": variant,
            "run_id": item["run_id"], "slice_id": item["id"], "raw_path": str(raw),
            "meta_path": item["meta_path"], "data_sha256": item["raw_sha256"],
            "meta_sha256": item["meta_sha256"], "rows": table.num_rows, "data_dates": dates,
            "observed_at": item["observed_at"], "source_order": item["source_order"],
            **({"preserved_fields": self.schema.names} if require_all_fields else {}),
            **self.source_metadata(table, item),
        }
        return table, source

    def normalize_table(self, table, require_all_fields):
        missing = set(self.schema.names) - set(table.column_names)
        if missing:
            raise CollectorError(f"请求分区缺少字段：{', '.join(sorted(missing))}；请明确补采")
        if require_all_fields and set(table.column_names) != set(self.schema.names):
            raise CollectorError("请求分区返回了仓库契约以外的字段；已保留 Raw，请适配后再发布")
        return table.select(self.schema.names).cast(self.schema, safe=True)

    def date_values(self, table):
        return sorted({date_key(value) for value in self.data_dates(table)})

    def source_metadata(self, table, item):
        return {}

    def manifest_metadata(self, sources):
        return {}

    def validate_ranges(self, sources):
        groups = defaultdict(list)
        for partition, source in sources.items():
            bounds, group, _ = self.request_dimensions(source["params"])
            groups[encode(group)].append((bounds["start"], bounds["end"], partition))
        for intervals in groups.values():
            intervals.sort()
            for previous, current in zip(intervals, intervals[1:]):
                if current[0] <= previous[1]:
                    raise CollectorError(
                        "不同请求分区存在重叠日期，不能无依据拼接或去重；旧快照保持，请使用 Raw 核查"
                    )

    def publish(self, root, repository_id, raw_root, changed, snapshot, sources, *, verify_content=False):
        snapshot_id = uuid.uuid4().hex
        parent = root / "snapshots"
        parent.mkdir(exist_ok=True)
        dates = dict(snapshot["dates"]) if snapshot else {}
        files = {item["month"]: item for item in snapshot["months"]} if snapshot else {}
        with tempfile.TemporaryDirectory(prefix=".t-", dir=root) as temporary:
            staging = Path(temporary)
            (staging / "p").mkdir()
            for partition, item in sorted(changed.items()):
                table, source = self.source_table(partition, item, require_all_fields=verify_content)
                previous = dates.get(partition)
                if previous and (
                    source["request_start"] > previous["request_start"]
                    or source["request_end"] < previous["request_end"]
                ):
                    raise CollectorError("同一请求分区的范围收窄会丢失已有记录，未发布；请补采原完整范围")
                dates[partition] = source
                path = staging / "p" / f"{compact_identifier(partition)}.parquet"
                ensure_path_length(path)
                pq.write_table(table, path, compression="zstd")
                receipt = readback_receipt(table, path, verify_content)
                files[partition] = {
                    "month": partition, "label": source["partition_key"], "kind": "request_partition",
                    "rows": table.num_rows, "days": len(source["data_dates"]),
                    "file": f"snapshots/{snapshot_id}/p/{path.name}",
                    "sha256": parquet_digest(path),
                    **receipt,
                }
            self.validate_ranges(dates)
            manifest = {
                "format_version": 1, "snapshot_id": snapshot_id, "created_at": now(),
                "source_raw_root": raw_root, "api_name": self.api_name, "entry_id": self.entry_id,
                "dataset_id": self.dataset_id, "schema": self.schema_description(),
                **self.adapter.capabilities(), "columns": self.schema.names,
                "dates": dates, "months": [files[key] for key in sorted(files)],
                "rows": sum(source["rows"] for source in dates.values()),
                "version_rule": (
                    "latest_successful_request_partition; no_row_dedup; reject_overlap_or_narrowing"
                ),
                "coverage": "not_proven",
                **self.manifest_metadata(sources),
            }
            digest = write_json(staging / "manifest.json", manifest)
            sync_directory(staging / "p")
            sync_directory(staging)
            final = parent / snapshot_id
            atomic_move(staging, final)
            sync_directory(parent)
        with self.store.connect() as db:
            db.execute(
                "INSERT INTO warehouse_snapshots VALUES(?,?,?,?,?,?,?,?)",
                (snapshot_id, repository_id, raw_root, str(final / "manifest.json"), digest,
                 manifest["created_at"], manifest["rows"], 0),
            )
        published = {
            **manifest, "manifest_path": str(final / "manifest.json"), "manifest_sha256": digest,
            "source_watermarks": snapshot.get("source_watermarks", {}) if snapshot else {},
        }
        published["source_watermarks"] = self.publish_pointer(root, published, sources)
        return published

    @staticmethod
    def variants(snapshot):
        variants = {}
        for source in snapshot["dates"].values() if snapshot else ():
            variant = variants.setdefault(source["variant_id"], {
                "id": source["variant_id"], "params": source["variant"], "partitions": 0, "rows": 0,
            })
            variant["partitions"] += 1
            variant["rows"] += source["rows"]
        return [variants[key] for key in sorted(variants)]

    def describe(self, root, raw_root, sources, active, snapshot):
        changed, added = self.changes(sources, snapshot)
        records = snapshot["dates"] if snapshot else {}
        dates = sorted({day for source in records.values() for day in source["data_dates"]})
        return {
            "dataset_id": self.dataset_id, "entry_id": self.entry_id, "name": self.name,
            **self.adapter.capabilities(), "state": "ready" if snapshot else "empty",
            "repository_root": str(root), "source_raw_root": raw_root,
            "busy": self.lock.locked(), "collection_active": active,
            "snapshot_id": snapshot["snapshot_id"] if snapshot else None,
            "created_at": snapshot["created_at"] if snapshot else None,
            "current_manifest_path": str(root / "current.json"),
            "snapshot_manifest_path": snapshot["manifest_path"] if snapshot else None,
            "columns": self.schema.names, "rows": snapshot["rows"] if snapshot else 0,
            "days": len(dates), "days_with_rows": len(dates), "dates": dates,
            "date_count_kind": "record_dates_not_coverage",
            "first_date": dates[0] if dates else None, "last_date": dates[-1] if dates else None,
            "partitions": len(records), "available_source_partitions": len(sources),
            "new_partitions": added, "changed_partitions": len(changed) - added,
            "reused_partitions": len(records) - len(changed) + added,
            "available_source_days": 0, "new_days": 0, "changed_days": 0, "reused_days": 0,
            "months": [
                {**item, "file": str(root / item["file"])} for item in snapshot["months"]
            ] if snapshot else [],
            "variants": self.variants(snapshot), "refresh_needed": bool(changed), "coverage": "not_proven",
        }

    def selected(self, snapshot_id, start_date, end_date, codes, variant_id=None):
        root, repository_id, _, _, _ = self.context()
        snapshot = self.snapshot(root, repository_id, snapshot_id)
        if snapshot is None:
            raise CollectorError("请求分区仓库尚未发布，请先整理本地归档")
        variants = {item["id"] for item in self.variants(snapshot)}
        if variant_id is None:
            if len(variants) != 1:
                raise CollectorError("此快照包含多个请求变体，请先明确选择一个 variant_id，不能混表")
            variant_id = next(iter(variants))
        if variant_id not in variants:
            raise CollectorError("请求变体不存在或不属于此快照")
        dates = sorted({
            day for source in snapshot["dates"].values() if source["variant_id"] == variant_id
            for day in source["data_dates"]
        })
        start = date_key(start_date or (dates[0] if dates else "19901219"))
        end = date_key(end_date or (dates[-1] if dates else "99991231"))
        if start > end:
            raise CollectorError("开始日期不能晚于结束日期")
        selected = {
            key: source for key, source in snapshot["dates"].items()
            if source["variant_id"] == variant_id and source["data_dates"]
            and source["data_dates"][0] <= end and source["data_dates"][-1] >= start
        }
        files = [item for item in snapshot["months"] if item["month"] in selected]
        return (
            root, {**snapshot, "selected_variant_id": variant_id}, start, end, self.checked_codes(codes),
            selected, files,
        )

    def rows(
        self, *, snapshot_id=None, start_date=None, end_date=None, ts_code="", offset=0, limit=50,
        variant_id=None,
    ):
        if offset < 0 or not 1 <= limit <= 200:
            raise CollectorError("仓库分页范围不正确")
        root, snapshot, start, end, codes, _, files = self.selected(
            snapshot_id, start_date, end_date, [ts_code] if ts_code else [], variant_id,
        )
        matching, skipped, result = 0, offset, []
        for item in files:
            table = self.filter(self.month_table(root, item), start, end, codes)
            matching += table.num_rows
            selected = table.slice(skipped, max(0, limit - len(result)))
            skipped = max(0, skipped - table.num_rows)
            values = [column.to_pylist() for column in selected.columns]
            result.extend([[json_cell(value) for value in row] for row in zip(*values, strict=True)])
        return {
            "dataset_id": self.dataset_id, "entry_id": self.entry_id, "name": self.name,
            "snapshot_id": snapshot["snapshot_id"], "variant_id": snapshot["selected_variant_id"],
            "columns": self.schema.names, "rows": result, "total_rows": snapshot["rows"],
            "matching_rows": matching, "offset": offset, "limit": limit,
            "next_offset": offset + len(result) if offset + len(result) < matching else None,
            "hash_verified": True, "coverage": "not_proven",
        }
