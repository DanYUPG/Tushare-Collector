from __future__ import annotations

import hashlib
import sqlite3

import pyarrow as pa

from .archive_delete import ensure_idle
from .models import CollectorError
from .store import encode
from .warehouse_cleanup import (
    dependency_sources,
    execute_cleanup,
    preview_cleanup,
    validate_check_mode,
    validate_retention,
)


def preview_global_cleanup(warehouses, retention_days=0, check_mode="fast"):
    validate_retention(retention_days)
    validate_check_mode(check_mode)
    if not warehouses:
        raise CollectorError("没有已适配的仓库")
    with next(iter(warehouses.values())).store.connect() as db:
        ensure_idle(db)
    datasets, skipped = [], []
    dependencies = dependency_sources()
    for dataset_id, warehouse in sorted(warehouses.items()):
        identity = {"dataset_id": dataset_id, "name": warehouse.name}
        if dataset_id in dependencies:
            skipped.append({**identity, "reason": "作为采集规划依赖保留，不清理"})
            continue
        try:
            preview = preview_cleanup(warehouse, retention_days=retention_days, check_mode=check_mode)
        except (CollectorError, OSError, pa.ArrowException, sqlite3.Error) as error:
            skipped.append({**identity, "reason": str(error)})
            continue
        datasets.append({**preview, "name": warehouse.name})
    result = {
        "retention_days": retention_days, "check_mode": check_mode, "datasets": datasets, "skipped": skipped,
        "count": sum(item["count"] for item in datasets),
        "files": sum(item["files"] for item in datasets),
        "bytes": sum(item["bytes"] for item in datasets),
        "pending": sum(len(item["pending_cleanups"]) for item in datasets),
    }
    confirmation = {
        "retention_days": retention_days, "check_mode": check_mode,
        "datasets": [
            {key: item[key] for key in ("dataset_id", "snapshot_id", "fingerprint", "pending_cleanups")}
            for item in datasets
        ],
        "skipped": skipped,
    }
    result["fingerprint"] = hashlib.sha256(encode(confirmation).encode()).hexdigest()
    return result


def execute_global_cleanup(warehouses, fingerprint, retention_days=0, check_mode="fast"):
    preview = preview_global_cleanup(warehouses, retention_days, check_mode)
    if fingerprint != preview["fingerprint"]:
        raise CollectorError("全局清理范围或快照已变化，请重新检查并确认；尚未执行本次清理")
    results = []
    for dataset in preview["datasets"]:
        actions = list(dataset["pending_cleanups"])
        if dataset["count"]:
            actions.append(dataset)
        for action in actions:
            try:
                result = execute_cleanup(
                    warehouses[dataset["dataset_id"]], action["fingerprint"],
                    retention_days=action["retention_days"], snapshot_id=action["snapshot_id"],
                    check_mode=action["check_mode"],
                )
                results.append({**result, "name": dataset["name"]})
            except (CollectorError, OSError, pa.ArrowException, sqlite3.Error) as error:
                results.append({
                    "dataset_id": dataset["dataset_id"], "name": dataset["name"],
                    "state": "cleanup_failed", "deleted": 0, "error": str(error),
                })
    return {
        "state": "cleanup_failed" if any(item["state"] != "deleted" for item in results) else "deleted",
        "deleted": sum(item["deleted"] for item in results), "results": results,
        "skipped": preview["skipped"],
    }
