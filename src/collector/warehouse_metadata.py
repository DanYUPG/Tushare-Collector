from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tempfile
from collections import Counter
from contextlib import closing
from pathlib import Path

import portalocker

from .filesystem import atomic_move, sync_directory
from .models import CollectorError


def atomic_json(path, value):
    content = (json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n").encode()
    atomic_bytes(path, content)


def atomic_bytes(path, content):
    descriptor, name = tempfile.mkstemp(prefix=".i-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        atomic_move(temporary, path, replace=True)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def snapshot_checksum(directory, digest):
    atomic_bytes(directory / "manifest.sha256", (digest + "\n").encode("ascii"))


def register_repository(root, dataset_id, *, default=True):
    """The catalog contains locations, never copies of mutable snapshot pointers."""
    warehouse_root = root.parent.parent
    lock = portalocker.Lock(warehouse_root / ".catalog.lock", mode="a+b", timeout=15)
    try:
        lock.acquire()
    except portalocker.LockException as error:
        raise CollectorError(f"无法锁定仓库目录索引（{type(error).__name__}），请稍后重新整理") from None
    with lock:
        path = warehouse_root / "catalog.json"
        try:
            catalog = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
                "format_version": 1, "tables": {},
            }
        except ValueError:
            raise CollectorError("仓库目录索引不是有效 JSON，请核查 catalog.json") from None
        if (
            not isinstance(catalog, dict) or catalog.get("format_version") != 1
            or not isinstance(catalog.get("tables"), dict)
        ):
            raise CollectorError("仓库目录索引格式不受支持，请核查 catalog.json")
        table = catalog["tables"].setdefault(dataset_id, {"default_repository": None, "repositories": {}})
        if not isinstance(table, dict) or not isinstance(table.get("repositories"), dict):
            raise CollectorError("仓库目录索引的数据集结构不正确")
        relative = root.relative_to(warehouse_root).as_posix()
        table["repositories"][root.name] = {"path": relative}
        if default:
            table["default_repository"] = root.name
        if not path.exists() or json.loads(path.read_text(encoding="utf-8")) != catalog:
            atomic_json(path, catalog)


def prepare_warehouse(data_dir):
    """Backfill metadata using registered hashes; never open the database for writing."""
    data_dir = Path(data_dir).expanduser().resolve(strict=True)
    warehouse_root = data_dir / "warehouse"
    database = (data_dir / "collector.sqlite3").resolve(strict=True)
    if not warehouse_root.is_dir():
        raise CollectorError("没有已发布的数据仓库")
    try:
        lock = portalocker.Lock(data_dir / ".collector-worker.lock", mode="a+b", timeout=0)
        lock.acquire()
    except portalocker.LockException:
        raise CollectorError("请先正常停止采集服务，再补建 SDK 索引") from None
    with lock, closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        records = db.execute(
            "SELECT id,repository_id,manifest_path,manifest_sha256 FROM warehouse_snapshots",
        ).fetchall()
        if not records:
            raise CollectorError("没有已登记的仓库快照，请先采集并整理数据")
        repositories = {}
        validated = []
        for snapshot_id, repository_id, filename, digest in records:
            if not re.fullmatch(r"[a-f0-9]{32}", snapshot_id) or not re.fullmatch(
                r"[a-f0-9]{64}", repository_id,
            ):
                raise CollectorError("已登记的快照标识不正确")
            path = Path(filename).resolve(strict=True)
            if not path.is_relative_to(warehouse_root.resolve()):
                raise CollectorError("快照路径不在当前 warehouse 目录，请先处理迁移路径")
            root = path.parent.parent.parent
            if path != root / "snapshots" / snapshot_id / "manifest.json" or root.name != repository_id:
                raise CollectorError("快照路径与登记不一致")
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() != digest:
                raise CollectorError(f"快照清单哈希校验失败：{snapshot_id}")
            manifest = json.loads(content)
            if not isinstance(manifest, dict):
                raise CollectorError("快照清单结构不正确")
            dataset_id = manifest.get("dataset_id", "daily")
            if manifest.get("snapshot_id") != snapshot_id or root.parent.name != dataset_id:
                raise CollectorError("快照数据集或标识与目录不一致")
            repositories.setdefault((dataset_id, root), {})[snapshot_id] = digest
            validated.append((path.parent, digest))
        pointers = []
        for (dataset_id, root), snapshots in repositories.items():
            pointer = root / "current.json"
            if not pointer.exists():
                continue
            current = json.loads(pointer.read_text(encoding="utf-8"))
            if not isinstance(current, dict) or current.get("snapshot_id") not in snapshots:
                raise CollectorError("当前快照指针未登记，不能补建 SDK 索引")
            current.update(format_version=1, manifest_sha256=snapshots[current["snapshot_id"]])
            pointers.append((dataset_id, root, pointer, current))
        if not pointers:
            raise CollectorError("没有可索引的当前快照，请先在采集器中整理目标仓库")
        for directory, digest in validated:
            snapshot_checksum(directory, digest)
        counts = Counter(table for table, _, _, _ in pointers)
        for dataset_id, root, pointer, current in pointers:
            atomic_json(pointer, current)
            # Multiple historical repositories must be selected explicitly, not guessed by mtime.
            register_repository(root, dataset_id, default=counts[dataset_id] == 1)
    return {"snapshots": len(validated), "repositories": len(pointers)}


def main():
    parser = argparse.ArgumentParser(description="为已有仓库补建独立 SDK 索引（需先停止采集服务）")
    parser.add_argument("--data-dir", type=Path, required=True, help="原采集器控制目录")
    args = parser.parse_args()
    try:
        result = prepare_warehouse(args.data_dir)
    except (CollectorError, OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"SDK 索引补建失败：{error}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
