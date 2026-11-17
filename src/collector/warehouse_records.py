from __future__ import annotations

import hashlib
import json

import pyarrow as pa
import pyarrow.compute as pc

from .datasets import RECIPES, scope_for
from .models import CollectorError
from .temporal import record_interval
from .warehouse import date_key
from .warehouse_requests import DATE_PARAMS, RequestWarehouse


class RecordWarehouse(RequestWarehouse):
    @property
    def atomic(self):
        return self.adapter.capabilities()["atomic_full_run"]

    @property
    def current(self):
        return self.adapter.date_semantics == "snapshot"

    def latest_run(self, db, scope, *, complete=False):
        condition = (
            "AND json_extract(p.plan_json,'$.total_slices')="
            "json_extract(p.plan_json,'$.candidate_partitions') " if complete else ""
        )
        return db.execute(
            "SELECT r.*,p.plan_json FROM runs r JOIN dataset_runs d ON d.run_id=r.id "
            "JOIN dataset_plans p ON p.id=d.plan_id "
            "WHERE d.dataset_id=? AND d.scope=? AND r.state='succeeded' " + condition
            + "ORDER BY r.finished_at DESC,r.rowid DESC LIMIT 1", (self.dataset_id, scope),
        ).fetchone()

    def incomplete_source(self):
        if not self.atomic:
            return None
        with self.store.connect() as db:
            settings, _ = self.datasets.checked_settings(db, self.dataset_id)
            run = self.latest_run(db, scope_for(RECIPES[self.dataset_id], settings))
        if run:
            plan = json.loads(run["plan_json"])
            if plan["total_slices"] != plan["candidate_partitions"]:
                return f"最新成功运行 {run['id']} 仅含局部请求，未发布；请全量重拉所需范围，旧快照仍可查询"
        return None

    def refresh(self, **kwargs):
        error = self.incomplete_source()
        if error:
            raise CollectorError(error)
        return super().refresh(**kwargs)

    def context(self):
        if not self.atomic:
            return super().context()
        with self.store.connect() as db:
            db.execute("BEGIN")
            settings, _ = self.datasets.checked_settings(db, self.dataset_id)
            scope = scope_for(RECIPES[self.dataset_id], settings)
            active = bool(self.datasets.active(db, self.dataset_id))
            run = self.latest_run(db, scope, complete=True)
            sources = {}
            if run:
                plan = json.loads(run["plan_json"])
                rows = db.execute(
                    "SELECT s.*,s.rowid source_order,p.partition_key,"
                    "COALESCE(MAX(a.finished_at),r.created_at) observed_at "
                    "FROM slices s JOIN runs r ON r.id=s.run_id "
                    "JOIN dataset_partitions p ON p.slice_id=s.id LEFT JOIN attempts a ON a.slice_id=s.id "
                    "WHERE s.run_id=? GROUP BY s.id", (run["id"],),
                ).fetchall()
                expected = {part["key"] for part in plan["partitions"]}
                if (
                    len(rows) != len(expected) or {row["partition_key"] for row in rows} != expected
                    or any(row["state"] != "succeeded" for row in rows)
                ):
                    raise CollectorError("完整运行缺少成功请求分区，未替换已有快照")
                for row in rows:
                    item = {
                        **dict(row), "config": {"raw_root": settings.raw_root},
                        "declared_range": {"start": plan["start_date"], "end": plan["end_date"]},
                        "capture_window": {"start": run["started_at"], "end": run["finished_at"]},
                    }
                    sources[hashlib.sha256(item["partition_key"].encode()).hexdigest()] = item
        repository_id = self.repository_id_for(settings.raw_root, scope)
        return self.root / repository_id, repository_id, settings.raw_root, sources, active

    def changes(self, sources, snapshot):
        if not self.atomic:
            return super().changes(sources, snapshot)
        if not sources:
            return {}, 0
        latest = next(iter(sources.values()))["run_id"]
        if snapshot and snapshot.get("source_run_id") == latest:
            return {}, 0
        if snapshot and max((item["observed_at"], item["source_order"]) for item in sources.values()) <= max(
            (item["observed_at"], item["source_order"]) for item in snapshot["dates"].values()
        ):
            return {}, 0
        return sources, sum(key not in (snapshot["dates"] if snapshot else {}) for key in sources)

    def request_dimensions(self, params):
        if self.current:
            group = dict(params)
            variant = {key: value for key, value in group.items() if key not in {"ts_code", "con_code"}}
            return {"start": None, "end": None}, group, variant
        if self.adapter.date_semantics == "month":
            first, last = record_interval(params["month"], "month")
            group = {key: value for key, value in params.items() if key != "month"}
            return {"start": first.strftime("%Y%m%d"), "end": last.strftime("%Y%m%d")}, group, group
        if self.adapter.date_semantics == "timestamp":
            first, _ = record_interval(params["start_date"])
            last, _ = record_interval(params["end_date"])
            group = {key: value for key, value in params.items() if key not in DATE_PARAMS}
            variant = {key: value for key, value in group.items() if key not in {"ts_code", "con_code"}}
            return {"start": first.strftime("%Y%m%d"), "end": last.strftime("%Y%m%d")}, group, variant
        return super().request_dimensions(params)

    def normalize_table(self, table, require_all_fields):
        if set(table.column_names) != set(self.schema.names):
            raise CollectorError("返回字段与仓库契约不一致；已保留 Raw，请适配或补采后再发布")
        for name in self.adapter.json_columns:
            try:
                values = [
                    json.dumps(value, ensure_ascii=False, allow_nan=False,
                               sort_keys=True, separators=(",", ":"))
                    if value is not None else None for value in table[name].to_pylist()
                ]
            except (TypeError, ValueError) as error:
                raise CollectorError(f"{name} 无法无损编码为 JSON：{error}") from None
            table = table.set_column(table.schema.get_field_index(name), name, pa.array(values, pa.string()))
        if any(pa.types.is_timestamp(field.type) and field.type.tz for field in table.schema):
            raise CollectorError("接口字段包含未约定的时区，不能静默移除；已保留 Raw，请确认时间契约")
        return super().normalize_table(table, True)

    def intervals(self, table):
        try:
            return [record_interval(value, self.adapter.date_semantics)
                    for value in table[self.adapter.date_column].to_pylist()]
        except (ValueError, TypeError) as error:
            raise CollectorError(f"记录时间或周期无效：{error}") from None

    def date_values(self, table):
        if self.current:
            return []
        return sorted({day.strftime("%Y%m%d") for pair in self.intervals(table) for day in pair})

    def data_dates(self, table):
        if self.current:
            return []
        if self.adapter.date_semantics in {"month", "week_interval", "period_label"}:
            return table[self.adapter.date_column].to_pylist()
        return [first.strftime("%Y%m%d") for first, _ in self.intervals(table)]

    def source_metadata(self, table, item):
        return {
            **({"record_labels": sorted(set(self.data_dates(table)))} if self.adapter.date_semantics in {
                "month", "week_interval", "period_label",
            } else {}),
        }

    def manifest_metadata(self, sources):
        result = {"version_rule": (
            "latest_complete_run; no_cross_run_merge; no_historical_replay" if self.current
            else "latest_complete_run; replace_entire_declared_history" if self.atomic
            else "latest_request_partition; preserve_records_and_period_labels"
        )}
        if self.atomic:
            item = next(iter(sources.values()))
            result.update(source_run_id=item["run_id"], declared_range=item["declared_range"],
                          capture_window=item["capture_window"])
        return result

    def validate_ranges(self, sources):
        if not self.current:
            super().validate_ranges(sources)

    def publish(self, root, repository_id, raw_root, changed, snapshot, sources, *, verify_content=False):
        if self.atomic:
            if not self.current and snapshot:
                previous = snapshot["declared_range"]
                current = next(iter(sources.values()))["declared_range"]
                if current["start"] > previous["start"] or current["end"] < previous["end"]:
                    raise CollectorError("重述历史不能缩窄已发布范围；请补采原完整范围，旧快照保持不变")
            changed, snapshot = sources, None
        return super().publish(
            root, repository_id, raw_root, changed, snapshot, sources, verify_content=verify_content,
        )

    def describe(self, root, raw_root, sources, active, snapshot):
        result = super().describe(root, raw_root, sources, active, snapshot)
        error = self.incomplete_source()
        if error:
            result.update(source_error=error, refresh_needed=True)
        if self.current:
            result.update(days=0, days_with_rows=0, dates=[], first_date=None, last_date=None,
                          source_run_id=snapshot.get("source_run_id") if snapshot else None)
        elif self.adapter.date_semantics in {"month", "week_interval", "period_label"}:
            labels = {label for item in (snapshot["dates"].values() if snapshot else ())
                      for label in item["record_labels"]}
            result.update(
                days=len(labels), days_with_rows=len(labels), date_count_kind="period_labels_not_coverage",
            )
        if snapshot:
            result.update({
                key: snapshot[key] for key in ("capture_window", "declared_range") if key in snapshot
            })
        return result

    def selected(self, snapshot_id, start_date, end_date, codes, variant_id=None):
        if not self.current:
            return super().selected(snapshot_id, start_date, end_date, codes, variant_id)
        if start_date or end_date:
            raise CollectorError("当前快照不支持历史日期筛选；请使用代码或请求变体筛选")
        root, repository_id, _, _, _ = self.context()
        snapshot = self.snapshot(root, repository_id, snapshot_id)
        if snapshot is None:
            raise CollectorError("当前快照尚未发布，请先完成并整理一轮完整采集")
        variants = {item["id"] for item in self.variants(snapshot)}
        if variant_id is None and len(variants) == 1:
            variant_id = next(iter(variants))
        if variant_id not in variants:
            raise CollectorError("请选择此快照的一个请求变体，不能混表")
        selected = {
            key: value for key, value in snapshot["dates"].items() if value["variant_id"] == variant_id
        }
        return (
            root, {**snapshot, "selected_variant_id": variant_id}, None, None, self.checked_codes(codes),
            selected, [item for item in snapshot["months"] if item["month"] in selected],
        )

    def filter(self, table, start, end, codes):
        if not self.current:
            first, last = date_key(start), date_key(end)
            mask = pa.array([
                lower.strftime("%Y%m%d") <= last and upper.strftime("%Y%m%d") >= first
                for lower, upper in self.intervals(table)
            ], pa.bool_())
            table = table.filter(mask)
        if codes:
            table = table.filter(pc.is_in(table[self.adapter.code_column], value_set=pa.array(codes)))
        return table
