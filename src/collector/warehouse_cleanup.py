from __future__ import annotations

import hashlib
import json
import re
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import portalocker
import pyarrow.parquet as pq

from .archive_delete import CleanupBusy, cleanup_files, ensure_idle, ensure_unshared, registered_deletion_info
from .artifacts import contained_file, source_paths, verified_open
from .models import CollectorError
from .store import encode, now

DISPLAY_LIMIT = 100
AUTOMATIC_DATASETS = ("daily", "daily_basic", "adj_factor")
NOTE = (
    "仅永久清理当前已发布仓库快照中，来源登记一致的 Raw 数据和元数据文件。"
    "保留天数按归档观察时间计算，不按业务日期。仓库只保留其声明字段，Raw 额外字段会永久丢失；"
    "完整来源元数据和清理确认保存在 SQLite。保留仓库、目录、其他版本及导出副本。"
    "已入库覆盖不因此变为缺失，但不再作为可用 Raw 或采集依赖。"
)

def validate_check_mode(check_mode):
    if check_mode not in {"fast", "deep"}:
        raise CollectorError("清理检查模式须为 fast 或 deep")


def check_mode_note(check_mode):
    return (
        "快速检查：核对来源登记、路径、文件属性和仓库 Parquet 页脚，不重新计算 Raw 或仓库数据文件哈希；"
        "预览不读取 Raw 内容，执行前另行核验元数据。不能保证发现所有内容损坏。"
        if check_mode == "fast" else "深度检查：重新计算 Raw 与仓库数据文件 SHA256，耗时较长。"
    ) + NOTE


def validate_retention(retention_days):
    if type(retention_days) is not int or not 0 <= retention_days <= 36500:
        raise CollectorError("Raw 保留天数须为 0 至 36500 的整数")


def dependency_sources():
    from .datasets import RECIPES

    sources = {"stock_basic", "trade_cal"}
    for recipe in RECIPES.values():
        spec = recipe.get("rule", {})
        sources.update(spec[key] for key in ("pool", "split_pool") if spec.get(key))
        for mapping in spec.get("split_pools", {}).values():
            sources.update(value for value in mapping.values() if value)
    return sources


@contextmanager
def locked_context(warehouse):
    if not warehouse.lock.acquire(blocking=False):
        raise CleanupBusy("仓库正在整理或清理，请等待完成")
    try:
        root, repository_id, raw_root, _, _ = warehouse.context()
        if not root.is_dir():
            raise CollectorError("仓库尚未发布，不能清理 Raw")
        lock = portalocker.Lock(root / ".publish.lock", mode="a+b", timeout=0)
        try:
            lock.acquire()
        except portalocker.AlreadyLocked:
            raise CleanupBusy("其他进程正在整理或清理此仓库") from None
        except portalocker.LockException as error:
            raise CollectorError(f"仓库文件锁失败（{type(error).__name__}），请检查目录及文件系统") from None
        with lock:
            yield root, repository_id, raw_root
    finally:
        warehouse.lock.release()


def verified_snapshot(
    warehouse, db, root, repository_id, raw_root, snapshot_id=None, *, approved=False, check_mode="fast",
):
    snapshot = warehouse.snapshot(root, repository_id, snapshot_id if approved else None)
    if snapshot is None:
        raise CollectorError("仓库尚未发布，不能清理 Raw")
    if snapshot_id is not None and snapshot_id != snapshot["snapshot_id"]:
        raise CollectorError("只允许清理当前已发布快照的来源；快照已变化，请重新检查")
    record = db.execute(
        "SELECT * FROM warehouse_snapshots WHERE id=? AND repository_id=?",
        (snapshot["snapshot_id"], repository_id),
    ).fetchone()
    if (
        record is None or record["source_raw_root"] != raw_root
        or snapshot.get("source_raw_root") != raw_root
    ):
        raise CollectorError("仓库快照的 Raw 根目录与登记不一致")
    files = {}
    for item in snapshot["months"]:
        if not isinstance(item, dict) or any(
            key not in item for key in ("month", "file", "sha256", "rows")
        ):
            raise CollectorError("仓库文件清单不完整，拒绝清理")
        label = item["month"]
        if (
            not isinstance(label, str) or label in files or type(item["rows"]) is not int
            or not isinstance(item["file"], str)
            or not isinstance(item["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
        ):
            raise CollectorError("仓库文件分区或行数不正确，拒绝清理")
        path = root / item["file"]
        resolved = contained_file(str(path), root)
        if path != resolved or not path.is_relative_to(root / "snapshots"):
            raise CollectorError("仓库文件路径含链接或超出快照目录，拒绝清理")
        with (verified_open(path, item["sha256"]) if check_mode == "deep" else path.open("rb")) as stream:
            parquet = pq.ParquetFile(stream)
            if (
                parquet.metadata.num_rows != item["rows"]
                or parquet.schema_arrow.names != warehouse.schema.names
            ):
                raise CollectorError("仓库文件行数或字段与清单不一致，拒绝清理")
        files[label] = item["rows"]
    expected = {}
    for key, source in snapshot["dates"].items():
        if (
            not isinstance(source, dict) or type(source.get("rows")) is not int
            or source["rows"] < 0
        ):
            raise CollectorError("仓库来源清单不完整，拒绝清理")
        label = (
            "current" if warehouse.adapter.grain == "current_snapshot"
            else key if warehouse.adapter.engine == "request" else key[:6]
        )
        expected[label] = expected.get(label, 0) + source["rows"]
    if files != expected or sum(files.values()) != snapshot.get("rows"):
        raise CollectorError("仓库来源分区与已发布文件不一致，拒绝清理")
    return snapshot


def source_record(db, warehouse, source, raw_root, source_key):
    row = db.execute(
        "SELECT s.*,s.rowid source_order,r.config_json,r.entry_json,d.dataset_id,p.partition_key,"
        "COALESCE(MAX(a.finished_at),r.created_at) observed_at "
        "FROM slices s JOIN runs r ON r.id=s.run_id JOIN dataset_runs d ON d.run_id=r.id "
        "JOIN dataset_partitions p ON p.slice_id=s.id LEFT JOIN attempts a ON a.slice_id=s.id "
        "WHERE s.id=? AND s.run_id=? GROUP BY s.id",
        (source.get("slice_id"), source.get("run_id")),
    ).fetchone()
    if row is None:
        raise CollectorError("仓库来源切片未登记，不能猜测清理范围")
    item = dict(row)
    item["config"] = json.loads(item["config_json"])
    expected_key = (
        hashlib.sha256(item["partition_key"].encode()).hexdigest()
        if warehouse.adapter.engine == "request" else item["partition_key"].split("|", 1)[0]
    )
    if (
        item["dataset_id"] != warehouse.dataset_id or item["state"] != "succeeded"
        or expected_key != source_key
        or ("params" in source and source["params"] != json.loads(item["params_json"]))
        or ("partition_key" in source and source["partition_key"] != item["partition_key"])
        or item["config"].get("raw_root") != raw_root
        or json.loads(item["entry_json"])["id"] != warehouse.entry_id
        or any(item[key] != source.get(other) for key, other in (
            ("raw_path", "raw_path"), ("meta_path", "meta_path"),
            ("raw_sha256", "data_sha256"), ("meta_sha256", "meta_sha256"),
            ("observed_at", "observed_at"), ("source_order", "source_order"), ("rows", "rows"),
        ))
        or any(not isinstance(item[key], str) or not re.fullmatch(r"[a-f0-9]{64}", item[key])
               for key in ("raw_sha256", "meta_sha256"))
    ):
        raise CollectorError("仓库来源身份、路径或哈希与登记不一致")
    return item


def pending_cleanups(db, repository_id):
    rows = db.execute(
        "SELECT w.fingerprint,w.snapshot_id,w.retention_days,COUNT(*) count,"
        "SUM(x.state!='deleted') remaining,"
        "CASE WHEN json_type(x.files_json,'$[0].identity')='object' THEN 'fast' ELSE 'deep' END check_mode "
        "FROM warehouse_cleanups w "
        "JOIN archive_deletions x ON x.id=w.deletion_id WHERE w.repository_id=? "
        "GROUP BY w.fingerprint,w.snapshot_id,w.retention_days,check_mode HAVING remaining>0 "
        "ORDER BY MIN(w.created_at) LIMIT ?",
        (repository_id, DISPLAY_LIMIT),
    ).fetchall()
    return [dict(row) for row in rows]


def confirmation_fingerprint(
    warehouse, repository_id, snapshot, retention_days, candidates, check_mode="deep",
):
    confirmation = {
        "dataset_id": warehouse.dataset_id, "repository_id": repository_id,
        "snapshot_id": snapshot["snapshot_id"], "manifest_sha256": snapshot["manifest_sha256"],
        "retention_days": retention_days, "candidates": [
            {key: item[key] for key in ("run_id", "slice_id", "source_key", "files", "source", "observed_at")}
            for item in candidates
        ],
    }
    if check_mode == "fast":
        confirmation["check_mode"] = check_mode
    return hashlib.sha256(encode(confirmation).encode()).hexdigest()


def automatic_source(warehouse, snapshot, key, source):
    if warehouse.dataset_id not in AUTOMATIC_DATASETS:
        raise CollectorError("此数据集尚未适配自动存储策略")
    if source.get("preserved_fields") != warehouse.schema.names:
        raise CollectorError("缺少来源全字段保留证明，保留中间文件；旧来源不会自动认证")
    if not any(
        month["month"] == key[:6] and month.get("validation") == "normalized_write_readback"
        and isinstance(month.get("content_sha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", month["content_sha256"])
        for month in snapshot["months"]
    ):
        raise CollectorError("仓库文件缺少写后回读校验记录，保留中间文件")


def build_preview(
    warehouse, db, root, repository_id, raw_root, retention_days, snapshot_id, check_mode="fast",
    *, automatic=False, limit=None, after_key=None,
):
    if limit is not None and (type(limit) is not int or not 1 <= limit <= 500):
        raise CollectorError("清理批次大小须为 1 至 500 的整数")
    if automatic and limit is None:
        raise CollectorError("自动清理必须限制单次检查范围")
    snapshot = verified_snapshot(
        warehouse, db, root, repository_id, raw_root, snapshot_id, check_mode=check_mode,
    )
    candidates, excluded = [], []
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    dependency = warehouse.dataset_id in dependency_sources()
    seen, checked_directories = set(), set()
    sources = sorted(
        (key, source) for key, source in snapshot["dates"].items()
        if after_key is None or key > after_key
    )
    selected = sources if limit is None else sources[:limit]
    for key, source in selected:
        identity = {"run_id": source.get("run_id"), "slice_id": source.get("slice_id"), "source_key": key}
        try:
            if dependency:
                raise CollectorError("此数据集仍作为采集规划的 Raw 依赖，尚无仓库依赖读取，保守排除")
            if automatic:
                automatic_source(warehouse, snapshot, key, source)
            item = source_record(db, warehouse, source, raw_root, key)
            if item["id"] in seen:
                raise CollectorError("同一来源切片重复出现在快照中，拒绝猜测")
            seen.add(item["id"])
            if db.execute(
                "SELECT 1 FROM archive_deletions WHERE slice_id=?", (item["id"],)
            ).fetchone():
                raise CollectorError("来源 Raw 已删除或已确认清理，不重复选择")
            observed = datetime.fromisoformat(item["observed_at"])
            if observed.tzinfo is None:
                raise CollectorError("归档观察时间缺少时区，拒绝推断保留期")
            if observed > cutoff:
                raise CollectorError("归档观察时间尚未达到 Raw 保留天数")
            info = registered_deletion_info(
                item, json.loads(item["entry_json"]), warehouse.dataset_id, verify_hash=check_mode == "deep",
                checked_directories=checked_directories,
            )
            ensure_unshared(db, item["id"], info["files"])
            metadata = None
            if check_mode == "deep":
                _, _, metadata = source_paths(item)
                validate_source_metadata(metadata, item, warehouse)
            candidates.append({
                **identity, "raw_root": info["raw_root"], "files": info["files"], "bytes": info["bytes"],
                "observed_at": item["observed_at"], "rows": item["rows"],
                "source": source, "metadata": metadata, "slice": item,
            })
        except (CollectorError, OSError, ValueError) as error:
            excluded.append({**identity, "reason": str(error)})
    fingerprint = confirmation_fingerprint(
        warehouse, repository_id, snapshot, retention_days, candidates, check_mode,
    )
    result = {
        "dataset_id": warehouse.dataset_id, "snapshot_id": snapshot["snapshot_id"],
        "retention_days": retention_days, "fingerprint": fingerprint, "check_mode": check_mode,
        "candidates": [
            {
                key: value for key, value in item.items()
                if key not in {"source", "metadata", "slice", "raw_root"}
            }
            for item in candidates[:DISPLAY_LIMIT]
        ],
        "count": len(candidates), "files": sum(len(item["files"]) for item in candidates),
        "bytes": sum(item["bytes"] for item in candidates),
        "candidates_truncated": len(candidates) > DISPLAY_LIMIT,
        "excluded": excluded[:DISPLAY_LIMIT], "excluded_count": len(excluded),
        "excluded_truncated": len(excluded) > DISPLAY_LIMIT,
        "pending_cleanups": pending_cleanups(db, repository_id), "note": check_mode_note(check_mode),
    }
    if limit is not None:
        result.update(
            scan_cursor=selected[-1][0] if selected else after_key,
            has_more=len(sources) > len(selected),
        )
    return result, candidates


def validate_source_metadata(metadata, item, warehouse):
    if (
        metadata.get("api_name") != warehouse.api_name
        or metadata.get("params") != json.loads(item["params_json"])
        or metadata.get("run_id") != item["run_id"]
        or metadata.get("slice_id") != item["id"]
    ):
        raise CollectorError("归档元数据的接口、请求条件或身份与登记不一致")


def preview_cleanup(
    warehouse, retention_days=0, snapshot_id=None, check_mode="fast",
    *, automatic=False, limit=None, after_key=None,
):
    validate_retention(retention_days)
    validate_check_mode(check_mode)
    with locked_context(warehouse) as (root, repository_id, raw_root):
        with warehouse.store.connect() as db:
            db.execute("BEGIN")
            ensure_idle(db)
            result, _ = build_preview(
                warehouse, db, root, repository_id, raw_root, retention_days, snapshot_id, check_mode,
                automatic=automatic, limit=limit, after_key=after_key,
            )
            return result


def execute_cleanup(
    warehouse, fingerprint, retention_days=0, snapshot_id=None, check_mode="fast",
    *, automatic=False, limit=None, after_key=None, guard=None,
):
    validate_retention(retention_days)
    validate_check_mode(check_mode)
    if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
        raise CollectorError("必须提供预览返回的完整确认指纹")
    if automatic and guard is None:
        raise CollectorError("自动清理必须绑定仍有效的存储策略授权")
    with locked_context(warehouse) as (root, repository_id, raw_root):
        with warehouse.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if guard:
                guard(db)
            ensure_idle(db)
            existing = db.execute(
                "SELECT w.*,x.id,x.run_id,x.slice_id,x.raw_root,x.files_json,x.state,x.error "
                "FROM warehouse_cleanups w JOIN archive_deletions x ON x.id=w.deletion_id "
                "WHERE w.repository_id=? AND w.fingerprint=? ORDER BY w.source_key",
                (repository_id, fingerprint),
            ).fetchall()
            if existing:
                approved_snapshot = existing[0]["snapshot_id"]
                if (
                    any(row["retention_days"] != retention_days for row in existing)
                    or (snapshot_id is not None and snapshot_id != approved_snapshot)
                    or any(
                        ("fast" if "identity" in json.loads(row["files_json"])[0] else "deep") != check_mode
                        for row in existing
                    )
                ):
                    raise CollectorError("清理确认的快照、保留天数或检查模式不一致，请使用原确认参数")
                snapshot = verified_snapshot(
                    warehouse, db, root, repository_id, raw_root, approved_snapshot, approved=not automatic,
                    check_mode=check_mode,
                )
                approved_candidates = []
                for row in existing:
                    source = json.loads(row["source_json"])
                    if snapshot["dates"].get(row["source_key"]) != source:
                        raise CollectorError("已确认清理的仓库来源发生变化，拒绝继续")
                    if automatic:
                        automatic_source(warehouse, snapshot, row["source_key"], source)
                    source_record(db, warehouse, source, raw_root, row["source_key"])
                    approved_candidates.append({
                        "run_id": row["run_id"], "slice_id": row["slice_id"],
                        "source_key": row["source_key"], "files": json.loads(row["files_json"]),
                        "source": source, "observed_at": source["observed_at"],
                    })
                if fingerprint != confirmation_fingerprint(
                    warehouse, repository_id, snapshot, retention_days, approved_candidates, check_mode,
                ):
                    raise CollectorError("已确认的清理身份或仓库清单发生变化，拒绝继续")
                selected_snapshot = approved_snapshot
            else:
                preview, candidates = build_preview(
                    warehouse, db, root, repository_id, raw_root, retention_days, snapshot_id, check_mode,
                    automatic=automatic, limit=limit, after_key=after_key,
                )
                if fingerprint != preview["fingerprint"]:
                    raise CollectorError("待清理来源或快照已变化，请重新预览并确认")
                selected_snapshot = preview["snapshot_id"]
                for item in candidates:
                    if check_mode == "fast":
                        _, _, item["metadata"] = source_paths(item["slice"])
                        validate_source_metadata(item["metadata"], item["slice"], warehouse)
                    deletion_id = uuid.uuid4().hex
                    created = now()
                    db.execute(
                        "INSERT INTO archive_deletions"
                        "(id,run_id,slice_id,raw_root,files_json,state,created_at) "
                        "VALUES(?,?,?,?,?,'pending',?)",
                        (deletion_id, item["run_id"], item["slice_id"], item["raw_root"],
                         encode(item["files"]), created),
                    )
                    db.execute(
                        "INSERT INTO warehouse_cleanups VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (deletion_id, warehouse.dataset_id, repository_id, selected_snapshot,
                         retention_days, fingerprint, item["source_key"], encode(item["source"]),
                         encode(item["metadata"]), encode(item["slice"]), created),
                    )
            # Commit the approved source identities before the first unlink, for crash-safe retry.
        failures = []
        with warehouse.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if guard:
                guard(db)
            ensure_idle(db)
            rows = db.execute(
                "SELECT x.* FROM archive_deletions x JOIN warehouse_cleanups w ON w.deletion_id=x.id "
                "WHERE w.repository_id=? AND w.fingerprint=? ORDER BY w.source_key",
                (repository_id, fingerprint),
            ).fetchall()
            for row in rows:
                if row["state"] == "deleted":
                    continue
                try:
                    files = json.loads(row["files_json"])
                    ensure_unshared(db, row["slice_id"], files)
                    cleanup_files(Path(row["raw_root"]), files)
                except (CollectorError, OSError) as error:
                    message = f"Raw 已登记为安全入库，但文件尚未全部清理：{error}"
                    db.execute(
                        "UPDATE archive_deletions SET state='cleanup_failed',error=? WHERE id=?",
                        (message, row["id"]),
                    )
                    failures.append({"id": row["id"], "slice_id": row["slice_id"], "error": message})
                else:
                    db.execute(
                        "UPDATE archive_deletions SET state='deleted',finished_at=?,error=NULL WHERE id=?",
                        (now(), row["id"]),
                    )
        return {
            "dataset_id": warehouse.dataset_id, "snapshot_id": selected_snapshot,
            "retention_days": retention_days, "fingerprint": fingerprint, "check_mode": check_mode,
            "state": "cleanup_failed" if failures else "deleted",
            "count": len(rows), "deleted": len(rows) - len(failures), "failed": len(failures),
            "files": sum(len(json.loads(row["files_json"])) for row in rows),
            "bytes": sum(file["bytes"] for row in rows for file in json.loads(row["files_json"])),
            "failures": failures[:DISPLAY_LIMIT], "failures_truncated": len(failures) > DISPLAY_LIMIT,
        }
