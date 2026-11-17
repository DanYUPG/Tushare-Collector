from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from pathlib import Path

from .artifacts import source_paths, sync_directory, verified_open
from .models import CollectorError
from .store import encode, now


class CleanupBusy(CollectorError):
    pass


def ensure_idle(db):
    if db.execute("SELECT 1 FROM runs WHERE state IN ('queued','running') LIMIT 1").fetchone():
        raise CleanupBusy("有采集任务正在排队或执行；请结束后再删除，避免破坏正在使用的依赖归档")
    if db.execute(
        "SELECT 1 FROM data_need_jobs WHERE state IN ('planning','collecting','publishing') LIMIT 1",
    ).fetchone():
        raise CleanupBusy("数据需求正在准备或发布，请完成或暂停该需求后再清理归档")


def deletion_info(store, run_id, slice_id):
    item = store.archived_slice(run_id, slice_id)
    run = store.run(run_id)
    return registered_deletion_info(item, run["entry"], run["dataset_id"])


def file_identity(path):
    value = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(value.st_mode):
        raise CollectorError("待清理路径不再是普通文件，拒绝删除")
    return {
        "device": value.st_dev, "inode": value.st_ino, "size": value.st_size,
        "mtime_ns": value.st_mtime_ns, "ctime_ns": value.st_ctime_ns,
    }


def registered_deletion_info(item, entry, dataset_id, *, verify_hash=True, checked_directories=None):
    run_id, slice_id = item["run_id"], item["id"]
    root = Path(item["config"]["raw_root"])
    if verify_hash:
        root = root.resolve()
        raw, meta, metadata = source_paths(item)
        if metadata.get("run_id") != run_id or metadata.get("slice_id") != slice_id:
            raise CollectorError("归档元数据与运行身份不一致，拒绝删除")
    else:
        raw, meta = Path(item["raw_path"]), Path(item["meta_path"])
        if (
            not root.is_absolute() or raw.name != "data.parquet" or meta.name != "meta.json"
            or any(not path.is_absolute() or ".." in path.parts or not path.is_relative_to(root)
                   for path in (raw, meta))
        ):
            raise CollectorError("已入仓 Raw 文件格式或名称不受支持")
    expected = (
        root / "tushare/stocks" / entry["category"] / entry["api_name"] / run_id / slice_id
    )
    if (
        raw.parent != meta.parent
        or raw.parent.parent != expected
        or not re.fullmatch(r"[a-f0-9]{32}", raw.parent.name)
    ):
        raise CollectorError("归档路径或元数据与运行身份不一致，拒绝删除")
    files = []
    for path, key in ((raw, "raw_sha256"), (meta, "meta_sha256")):
        original = Path(item["raw_path" if key == "raw_sha256" else "meta_path"])
        if original != path or (verify_hash and original.is_symlink()):
            raise CollectorError("归档路径含链接或发生变化，拒绝删除")
        if verify_hash:
            for parent in path.parents:
                if parent == root:
                    break
                if parent.is_symlink():
                    raise CollectorError("归档目录含链接，拒绝删除")
        if verify_hash:
            with verified_open(path, item[key]) as stream:
                size = os.fstat(stream.fileno()).st_size
            files.append({"path": str(path), "sha256": item[key], "bytes": size})
        else:
            checked = checked_directories if checked_directories is not None else set()
            parents = []
            for parent in path.parents:
                if parent in checked:
                    break
                if not stat.S_ISDIR(parent.stat(follow_symlinks=False).st_mode):
                    raise CollectorError("归档目录含链接或不再是目录，拒绝删除")
                parents.append(parent)
                if parent == root:
                    break
            checked.update(parents)
            identity = file_identity(path)
            files.append({
                "path": str(path), "sha256": item[key], "bytes": identity["size"], "identity": identity,
            })
    result = {
        "run_id": run_id,
        "slice_id": slice_id,
        "slice_number": item["ordinal"] + 1,
        "name": entry["name"],
        "dataset_id": dataset_id,
        "raw_root": str(root),
        "files": files,
        "bytes": sum(item["bytes"] for item in files),
        "note": (
            "永久删除当前切片已登记的数据文件和元数据，不可撤销。"
            "保留采集配置、运行历史、其他切片、旧尝试及导出副本。"
            "该归档立即退出可用覆盖；如有同范围的其他成功归档，仍可使用。"
        ),
    }
    result["fingerprint"] = hashlib.sha256(encode(result).encode()).hexdigest()
    return result


def check_deletion(store, run_id, slice_id):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        ensure_idle(db)
        return deletion_info(store, run_id, slice_id)


def delete_archive(store, run_id, slice_id, fingerprint):
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        ensure_idle(db)
        info = deletion_info(store, run_id, slice_id)
        if fingerprint != info["fingerprint"]:
            raise CollectorError("待删除归档已变化，请重新检查并确认删除范围")
        ensure_unshared(db, slice_id, info["files"])
        deletion_id = uuid.uuid4().hex
        db.execute(
            "INSERT INTO archive_deletions(id,run_id,slice_id,raw_root,files_json,state,created_at) "
            "VALUES(?,?,?,?,?,'pending',?)",
            (deletion_id, run_id, slice_id, info["raw_root"], encode(info["files"]), now()),
        )
    return cleanup_deletion(store, deletion_id)


def ensure_unshared(db, slice_id, files):
    for file in files:
        shared = db.execute(
            "SELECT id FROM slices WHERE id!=? AND (raw_path=? OR meta_path=?) LIMIT 1",
            (slice_id, file["path"], file["path"]),
        ).fetchone()
        if shared:
            raise CollectorError("文件被其他切片引用，拒绝删除共享归档")


def cleanup_files(root, files):
    for file in files:
        path = Path(file["path"])
        if not path.is_relative_to(root) or path.resolve() != path or path.is_symlink():
            raise CollectorError("待清理路径已改变或超出原 Raw 目录，拒绝删除")
        if not path.exists():
            continue
        if not path.is_file():
            raise CollectorError("待清理路径不再是普通文件，拒绝删除")
        if "identity" in file:
            if file_identity(path) != file["identity"]:
                raise CollectorError("待清理文件身份、大小或时间已变化，拒绝继续")
        else:
            with verified_open(path, file["sha256"]):
                pass
        path.unlink()
        sync_directory(path.parent)


def cleanup_deletion(store, deletion_id):
    failure = None
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        ensure_idle(db)
        row = db.execute("SELECT * FROM archive_deletions WHERE id=?", (deletion_id,)).fetchone()
        if row is None:
            raise CollectorError("归档删除记录不存在")
        if db.execute(
            "SELECT 1 FROM warehouse_cleanups WHERE deletion_id=?", (deletion_id,)
        ).fetchone():
            raise CollectorError("此归档已安全入库，请在仓库中使用原确认指纹重试清理")
        if row["state"] == "deleted":
            return {"id": deletion_id, "state": "deleted", "slice_id": row["slice_id"]}
        root = Path(row["raw_root"])
        try:
            cleanup_files(root, json.loads(row["files_json"]))
        except (OSError, CollectorError) as error:
            failure = f"归档已退出可用覆盖，但文件尚未全部清理：{error}。请在本地数据中重试清理。"
            db.execute(
                "UPDATE archive_deletions SET state='cleanup_failed',error=? WHERE id=?",
                (failure, deletion_id),
            )
        else:
            db.execute(
                "UPDATE archive_deletions SET state='deleted',finished_at=?,error=NULL WHERE id=?",
                (now(), deletion_id),
            )
    if failure:
        raise CollectorError(failure)
    return {"id": deletion_id, "state": "deleted", "slice_id": row["slice_id"]}
