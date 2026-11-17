from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

import duckdb
import pyarrow as pa
import uvicorn
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .archive_delete import check_deletion, cleanup_deletion, delete_archive
from .artifacts import choose_directory, export_data, preview_slice
from .credentials import CredentialStore, checked_token
from .data_needs import DataNeedAction, DataNeeds, DataNeedSave
from .datasets import (
    DatasetBundleRequest,
    DatasetGroupRequest,
    DatasetLaunchRequest,
    DatasetPlanRequest,
    DatasetService,
    DatasetSettingsRequest,
)
from .models import CATALOG, ENTRIES, MAX_SLICES, CollectorError, TaskConfig, absolute_directory, plan
from .permissions import ACCESS, DEFAULT_RPM, PERMISSIONS, effective_rpm
from .runner import Runner
from .storage_policy import StoragePolicy, StoragePolicyPause, StoragePolicySave
from .store import Store
from .warehouse import WAREHOUSE_ADAPTERS, DailyWarehouse, DateWarehouse, SnapshotWarehouse, warehouse_catalog
from .warehouse_cleanup import execute_cleanup, preview_cleanup
from .warehouse_cleanup_global import execute_global_cleanup, preview_global_cleanup
from .warehouse_records import RecordWarehouse
from .warehouse_requests import RequestWarehouse

STATIC = Path(__file__).with_name("static")
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class ConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    config: TaskConfig


class Credential(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=1, max_length=512)
    remember: StrictBool = False


class WorkerSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    collection_threads: StrictInt = Field(ge=1, le=16)


class DirectorySelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    initial_path: str | None = Field(default=None, max_length=4096)


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination: str = Field(min_length=1, max_length=4096)
    slice_id: str | None = Field(default=None, min_length=1, max_length=64)
    layout: Literal["raw", "organized"] = "raw"


class WarehouseRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WarehouseSortKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    column: str = Field(min_length=1, max_length=100)
    direction: Literal["asc", "desc"] = "asc"


class WarehouseExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    destination: str = Field(min_length=1, max_length=4096)
    start_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    end_date: str | None = Field(default=None, pattern=r"^\d{8}$")
    columns: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(
        default_factory=list, max_length=500,
    )
    ts_codes: list[Annotated[str, Field(min_length=1, max_length=32)]] = Field(
        default_factory=list, max_length=2000,
    )
    snapshot_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    variant_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    file_layout: Literal["partitioned", "single", "grouped"] = "partitioned"
    sort_by: list[WarehouseSortKey] = Field(default_factory=list, max_length=10)
    split_by: str | None = Field(default=None, min_length=1, max_length=100)


class ArchiveDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")

class WarehouseCleanupRequest(ArchiveDeleteRequest):
    snapshot_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    retention_days: StrictInt = Field(default=0, ge=0, le=36500)
    check_mode: Literal["fast", "deep"] = "fast"

class GlobalWarehouseCleanupRequest(ArchiveDeleteRequest):
    retention_days: StrictInt = Field(default=0, ge=0, le=36500)
    check_mode: Literal["fast", "deep"] = "fast"


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    config_ids: list[str] = Field(min_length=1, max_length=102)
    expected_revisions: dict[str, Annotated[int, Field(ge=1)]] | None = None


class GroupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    config_ids: list[str] = Field(min_length=1, max_length=102)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1)


class LivePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entry_id: str
    params: dict = Field(default_factory=dict)
    fields: str = Field(default="", max_length=20000)
    raw_root: str

    @field_validator("raw_root")
    @classmethod
    def directory(cls, value):
        return str(absolute_directory(value))


def create_app(data_dir: Path | None = None, *, start_worker: bool = True, runner_factory=Runner) -> FastAPI:
    root = (data_dir or Path(os.environ.get("TC_DATA_DIR", PROJECT_ROOT / "data"))).expanduser().resolve()
    store = Store(root / "collector.sqlite3")
    credentials = CredentialStore(root)
    saved_token = credentials.load()
    token_persisted = bool(saved_token)
    credential_lock = threading.Lock()
    global_rpm = int(os.environ.get("TUSHARE_GLOBAL_RPM", str(DEFAULT_RPM)))
    if not 1 <= global_rpm <= 500:
        raise ValueError("TUSHARE_GLOBAL_RPM 必须为 1–500")
    runner = runner_factory(store, os.environ.get("TUSHARE_TOKEN", "").strip() or saved_token, global_rpm)
    del saved_token
    datasets = DatasetService(store, root / "raw")
    warehouses = {"daily": DailyWarehouse(store, datasets, root / "warehouse" / "daily")}
    for dataset_id, adapter in WAREHOUSE_ADAPTERS.items():
        if dataset_id == "daily":
            continue
        warehouse_type = (
            RecordWarehouse if adapter.engine == "record" else RequestWarehouse if adapter.engine == "request"
            else SnapshotWarehouse if adapter.grain == "current_snapshot" else DateWarehouse
        )
        warehouses[dataset_id] = warehouse_type(store, datasets, root / "warehouse" / dataset_id, adapter)
    needs = DataNeeds(store, datasets, warehouses, runner)
    storage_policy = StoragePolicy(store, datasets, warehouses, runner)

    def idle_maintenance():
        needs.tick()
        storage_policy.tick()

    runner.idle_callback = idle_maintenance

    @asynccontextmanager
    async def lifespan(application):
        if start_worker:
            runner.start()
        try:
            yield
        finally:
            if start_worker:
                await asyncio.to_thread(runner.close)

    app = FastAPI(title="Tushare 本地股票数据工作台", lifespan=lifespan)
    app.state.store, app.state.runner = store, runner
    app.state.warehouse, app.state.warehouses = warehouses["daily"], warehouses
    app.state.data_needs = needs
    app.state.storage_policy = storage_policy
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.middleware("http")
    async def local_console_guard(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.url.netloc}"
            if request.headers.get("x-collector-request") != "1" or (origin and origin != expected):
                return JSONResponse({"detail": "仅允许本地同源控制台或带请求标识的本地 CLI"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(CollectorError)
    async def collector_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        errors = [{"loc": item["loc"], "msg": item["msg"], "type": item["type"]} for item in error.errors()]
        return JSONResponse({"detail": errors}, status_code=422)

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/api/status")
    def status():
        with credential_lock:
            persisted = token_persisted
        return {
            "token_configured": bool(runner.token),
            "token_persisted": persisted,
            "credential_file": str(credentials.path),
            "worker_running": bool(runner.thread and runner.thread.is_alive()),
            "database": str(store.path),
            "default_raw_root": str(root / "raw"),
            "default_export_root": store.last_export_root() or str(root / "exports"),
            "global_requests_per_minute": runner.global_rpm,
            "catalog_verified_at": CATALOG["verified_at"],
            "account_points": PERMISSIONS["account_points"],
            "permissions_verified_at": PERMISSIONS["verified_at"],
            **runner.worker_settings(),
        }

    @app.get("/api/worker/settings")
    def worker_settings():
        return runner.worker_settings()

    @app.get("/api/data-needs")
    def data_needs():
        return needs.list()

    @app.get("/api/data-needs/catalog")
    def data_needs_catalog():
        return needs.catalog()

    @app.get("/api/storage-policy")
    def get_storage_policy():
        return storage_policy.status()

    @app.put("/api/storage-policy")
    def save_storage_policy(body: StoragePolicySave):
        return storage_policy.save(body)

    @app.post("/api/storage-policy/pause")
    def pause_storage_policy(body: StoragePolicyPause):
        return storage_policy.pause(body.expected_revision)

    @app.post("/api/data-needs", status_code=201)
    def create_data_need(body: DataNeedSave):
        return needs.save(body)

    @app.put("/api/data-needs/{need_id}")
    def update_data_need(need_id: str, body: DataNeedSave):
        return needs.save(body, need_id)

    @app.post("/api/data-needs/{need_id}/sync")
    def sync_data_need(need_id: str, body: DataNeedAction):
        if not runner.token:
            raise CollectorError("请先配置 Tushare 凭证，再授权同步")
        return needs.sync(need_id, body)

    @app.post("/api/data-needs/{need_id}/pause")
    def pause_data_need(need_id: str, body: DataNeedAction):
        return needs.pause(need_id, body.expected_revision)

    @app.put("/api/worker/settings")
    def update_worker_settings(body: WorkerSettingsRequest):
        return runner.set_collection_threads(body.collection_threads)

    @app.get("/api/activity")
    def activity(
        after_seq: int = Query(0, ge=0),
        limit: int = Query(100, ge=1, le=500),
        level: Literal["info", "ok", "warn", "error"] | None = None,
        run_id: str = Query("", max_length=64),
    ):
        return runner.activity(after_seq, limit, level, run_id)

    @app.put("/api/credential")
    def credential(body: Credential):
        nonlocal token_persisted
        token = checked_token(body.token)
        with credential_lock:
            if body.remember:
                credentials.save(token)
            else:
                credentials.clear()
            runner.set_token(token)
            token_persisted = body.remember
        return {
            "token_configured": True, "token_persisted": body.remember,
            "persistence": "local_file" if body.remember else "process_memory_only",
        }

    @app.delete("/api/credential")
    def clear_credential():
        nonlocal token_persisted
        with credential_lock:
            credentials.clear()
            runner.set_token("")
            token_persisted = False
        return {"token_configured": False, "token_persisted": False, "persistence": "cleared"}

    @app.get("/api/catalog")
    def catalog():
        return CATALOG

    @app.get("/api/permissions")
    def permissions():
        return PERMISSIONS

    @app.post("/api/directories/select")
    def select_directory(body: DirectorySelection):
        return choose_directory(body.initial_path)

    @app.post("/api/plan")
    def preview(body: TaskConfig):
        slices = plan(body)
        return {
            "total": len(slices),
            "samples": slices[:5],
            "date_semantics": "calendar_days" if body.mode == "date_range" else "manual",
            "coverage": "not_proven",
            "effective_rpm": effective_rpm(body.entry_id, body.requests_per_minute, runner.global_rpm),
            "access": ACCESS[body.entry_id],
        }

    @app.get("/api/configs")
    def configurations():
        return store.configurations()

    @app.get("/api/datasets")
    def dataset_list():
        return datasets.list()

    @app.post("/api/previews", status_code=201)
    def live_preview(body: LivePreviewRequest):
        if not runner.token or not (runner.thread and runner.thread.is_alive()):
            raise CollectorError("执行线程或 Token 未就绪，请先检查服务状态")
        entry = ENTRIES.get(body.entry_id)
        if entry is None or entry["status"] == "sdk_only":
            raise CollectorError("请选择可直接查询的股票接口；数据预览不支持 SDK 派生接口")
        config = TaskConfig(
            name=f"数据预览 · {entry['api_name']}",
            entry_id=body.entry_id,
            params=body.params,
            fields=body.fields,
            raw_root=body.raw_root,
            max_attempts=1,
            allow_empty=True,
        )
        result = store.create_preview(config)
        runner.wake.set()
        return result

    @app.put("/api/datasets/{dataset_id}/settings")
    def dataset_settings(dataset_id: str, body: DatasetSettingsRequest):
        return datasets.save_settings(dataset_id, body.settings, body.expected_revision)

    @app.get("/api/datasets/{dataset_id}/coverage")
    def dataset_coverage(
        dataset_id: str,
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=200),
        q: str = Query("", max_length=200),
        state: Literal["pending", "running", "succeeded", "failed"] | None = None,
    ):
        return datasets.coverage(dataset_id, offset, limit, q, state)

    @app.post("/api/datasets/{dataset_id}/plans")
    def dataset_plan(dataset_id: str, body: DatasetPlanRequest):
        return datasets.create_plan(dataset_id, body, runner.global_rpm)

    @app.post("/api/datasets/{dataset_id}/review")
    def dataset_review(dataset_id: str, body: DatasetPlanRequest):
        return datasets.review(dataset_id, body, runner.global_rpm)

    @app.post("/api/datasets/{dataset_id}/runs", status_code=201)
    def dataset_launch(dataset_id: str, body: DatasetLaunchRequest):
        if not runner.token or not (runner.thread and runner.thread.is_alive()):
            raise CollectorError("执行线程或 Token 未就绪，请先检查服务状态")
        result = datasets.launch(dataset_id, body.plan_id, runner.global_rpm)
        runner.wake.set()
        return result

    @app.get("/api/dataset-groups")
    def dataset_groups():
        return datasets.groups()

    @app.post("/api/dataset-groups", status_code=201)
    def dataset_group_save(body: DatasetGroupRequest):
        return datasets.save_group(body)

    @app.delete("/api/dataset-groups/{group_id}")
    def dataset_group_delete(group_id: str):
        datasets.delete_group(group_id)
        return {"deleted": True}

    @app.get("/api/dataset-bundles")
    def dataset_bundles():
        return datasets.bundles()

    @app.post("/api/dataset-bundles/plans")
    def dataset_bundle_plan(body: DatasetBundleRequest):
        return datasets.create_bundle(body, runner.global_rpm)

    @app.post("/api/dataset-bundles/runs", status_code=201)
    def dataset_bundle_launch(body: DatasetLaunchRequest):
        if not runner.token or not (runner.thread and runner.thread.is_alive()):
            raise CollectorError("执行线程或 Token 未就绪，请先检查服务状态")
        result = datasets.launch_bundle(body.plan_id, runner.global_rpm)
        runner.wake.set()
        return result

    @app.post("/api/configs", status_code=201)
    def save_config(body: TaskConfig):
        return store.save_config(body)

    @app.put("/api/configs/{config_id}")
    def update_config(config_id: str, body: ConfigUpdate):
        return store.save_config(body.config, config_id, body.revision)

    @app.post("/api/configs/{config_id}/runs", status_code=201)
    def create_run(config_id: str, body: RunRequest | None = None):
        if not runner.token:
            raise CollectorError("请先设置 Token，再启动运行")
        result = store.create_run(config_id, body.expected_revision if body else None)
        runner.wake.set()
        return result

    @app.post("/api/batches", status_code=201)
    def create_batch(body: BatchRequest):
        if not runner.token:
            raise CollectorError("请先设置 Token，再批量启动")
        result = store.create_batch(body.config_ids, body.expected_revisions)
        runner.wake.set()
        return result

    @app.get("/api/batches")
    def batches():
        return store.batches()

    @app.post("/api/batches/plan")
    def batch_plan(body: BatchRequest):
        return store.batch_plan(body.config_ids, runner.global_rpm)

    @app.get("/api/groups")
    def groups():
        return store.groups()

    @app.post("/api/groups", status_code=201)
    def save_group(body: GroupRequest):
        return store.save_group(body.name, body.config_ids)

    @app.delete("/api/groups/{group_id}")
    def delete_group(group_id: str):
        store.delete_group(group_id)
        return {"deleted": True}

    @app.get("/api/batches/{batch_id}")
    def batch(batch_id: str):
        return store.batch(batch_id)

    @app.get("/api/runs")
    def runs():
        return store.runs()

    @app.get("/api/local-data")
    def local_data(
        category: str = Query("", max_length=100),
        entry_id: str = Query("", max_length=100),
        raw_root: str = Query("", max_length=4096),
        q: str = Query("", max_length=200),
        state: Literal["succeeded", "failed", "pending", "running"] | None = None,
        business_domain: str = Query("", max_length=100),
        source_type: Literal["dataset", "preview", "task"] | None = None,
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=200),
    ):
        return store.local_data(
            category=category,
            entry_id=entry_id,
            raw_root=raw_root,
            query=q,
            state=state,
            business_domain=business_domain,
            source_type=source_type,
            offset=offset,
            limit=limit,
        )

    def checked_warehouse(dataset_id):
        if dataset_id not in warehouses:
            raise CollectorError("此数据集尚未适配仓库，请使用原始归档阅读；不会套用日线规则")
        return warehouses[dataset_id]

    @app.get("/api/warehouse/catalog")
    def local_warehouse_catalog():
        return warehouse_catalog()

    @app.get("/api/warehouse-cleanup")
    def global_warehouse_cleanup_preview(
        retention_days: int = Query(0, ge=0, le=36500), check_mode: Literal["fast", "deep"] = "fast",
    ):
        return preview_global_cleanup(warehouses, retention_days, check_mode)

    @app.post("/api/warehouse-cleanup")
    def global_warehouse_cleanup_execute(body: GlobalWarehouseCleanupRequest):
        return execute_global_cleanup(warehouses, **body.model_dump())

    @app.get("/api/warehouse/{dataset_id}")
    def data_warehouse(dataset_id: str):
        try:
            return checked_warehouse(dataset_id).status()
        except (OSError, pa.ArrowException) as error:
            raise CollectorError(f"无法读取数据仓库：{error}") from None

    @app.post("/api/warehouse/{dataset_id}/refresh")
    def refresh_data_warehouse(dataset_id: str, body: WarehouseRefreshRequest):
        try:
            return checked_warehouse(dataset_id).refresh()
        except (OSError, pa.ArrowException, sqlite3.Error) as error:
            raise CollectorError(f"数据仓库整理失败；请检查当前快照状态：{error}") from None

    @app.get("/api/warehouse/{dataset_id}/rows")
    def data_warehouse_rows(
        dataset_id: str,
        snapshot_id: str | None = Query(None, pattern=r"^[a-f0-9]{32}$"),
        variant_id: str | None = Query(None, pattern=r"^[a-f0-9]{64}$"),
        start_date: str | None = Query(None, pattern=r"^\d{8}$"),
        end_date: str | None = Query(None, pattern=r"^\d{8}$"),
        ts_code: str = Query("", max_length=32),
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=200),
    ):
        try:
            return checked_warehouse(dataset_id).rows(
                snapshot_id=snapshot_id, start_date=start_date, end_date=end_date,
                ts_code=ts_code, offset=offset, limit=limit, variant_id=variant_id,
            )
        except (OSError, pa.ArrowException) as error:
            raise CollectorError(f"无法读取仓库数据：{error}") from None

    @app.post("/api/warehouse/{dataset_id}/export", status_code=201)
    def export_data_warehouse(dataset_id: str, body: WarehouseExportRequest):
        try:
            warehouse = checked_warehouse(dataset_id)
            if warehouse.adapter.date_column and (not body.start_date or not body.end_date):
                raise CollectorError("日期型仓库导出须指定开始和结束日期")
            return warehouse.export(**body.model_dump())
        except (OSError, pa.ArrowException, duckdb.Error) as error:
            raise CollectorError(f"数据仓库导出失败；请检查可用磁盘空间与排序配置：{error}") from None

    @app.get("/api/warehouse/{dataset_id}/cleanup")
    def warehouse_cleanup_preview(
        dataset_id: str,
        snapshot_id: str = Query(pattern=r"^[a-f0-9]{32}$"),
        retention_days: int = Query(0, ge=0, le=36500),
        check_mode: Literal["fast", "deep"] = "fast",
    ):
        try:
            return preview_cleanup(
                checked_warehouse(dataset_id), retention_days=retention_days, snapshot_id=snapshot_id,
                check_mode=check_mode,
            )
        except (OSError, pa.ArrowException, sqlite3.Error) as error:
            raise CollectorError(f"无法检查已入仓 Raw 清理范围：{error}") from None

    @app.post("/api/warehouse/{dataset_id}/cleanup")
    def warehouse_cleanup_execute(dataset_id: str, body: WarehouseCleanupRequest):
        try:
            return execute_cleanup(checked_warehouse(dataset_id), **body.model_dump())
        except (OSError, pa.ArrowException, sqlite3.Error) as error:
            raise CollectorError(f"清理未完成；请重新检查后继续：{error}") from None

    @app.get("/api/local-data/navigation")
    def local_data_navigation(
        raw_root: str = Query("", max_length=4096),
        q: str = Query("", max_length=200),
        business_domain: str = Query("", max_length=100),
        include_empty: bool = False,
    ):
        return store.local_data_navigation(
            raw_root=raw_root, query=q, business_domain=business_domain, include_empty=include_empty,
        )

    @app.get("/api/runs/{run_id}")
    def run(run_id: str):
        return store.run(run_id, detail=True)

    @app.get("/api/runs/{run_id}/slices/{slice_id}/preview")
    def data_preview(
        run_id: str,
        slice_id: str,
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=200),
        q: str = Query("", max_length=200),
        column: str = Query("", max_length=200),
    ):
        try:
            return preview_slice(store, run_id, slice_id, offset, limit, q, column)
        except (OSError, pa.ArrowException) as error:
            raise CollectorError(f"无法读取归档数据：{str(error)}") from None

    @app.get("/api/runs/{run_id}/slices/{slice_id}/deletion")
    def archive_deletion_check(run_id: str, slice_id: str):
        try:
            return check_deletion(store, run_id, slice_id)
        except OSError as error:
            raise CollectorError(f"无法检查待删除归档：{error}") from None

    @app.delete("/api/runs/{run_id}/slices/{slice_id}/archive")
    def archive_delete(run_id: str, slice_id: str, body: ArchiveDeleteRequest):
        try:
            return delete_archive(store, run_id, slice_id, body.fingerprint)
        except OSError as error:
            raise CollectorError(f"无法删除归档：{error}") from None

    @app.post("/api/local-data/deletions/{deletion_id}/retry")
    def archive_deletion_retry(deletion_id: str):
        return cleanup_deletion(store, deletion_id)

    @app.get("/api/runs/{run_id}/slices")
    def slices(
        run_id: str,
        offset: int = Query(0, ge=0, le=MAX_SLICES),
        limit: int = Query(50, ge=1, le=200),
        q: str = Query("", max_length=200),
        state: Literal["pending", "running", "succeeded", "failed"] | None = None,
        number: int | None = Query(None, ge=1, le=MAX_SLICES),
    ):
        return store.slice_page(run_id, offset, limit, q, state, number)

    @app.post("/api/runs/{run_id}/export", status_code=201)
    def export(run_id: str, body: ExportRequest):
        try:
            return export_data(store, run_id, body.destination, body.slice_id, body.layout)
        except (OSError, pa.ArrowException) as error:
            raise CollectorError(f"导出失败：{str(error)}") from None

    @app.post("/api/runs/{run_id}/cancel")
    def cancel(run_id: str):
        store.cancel(run_id)
        runner.wake.set()
        return store.run(run_id)

    @app.post("/api/runs/{run_id}/resume")
    def resume(run_id: str):
        if not runner.token:
            raise CollectorError("请先设置 Token，再续跑")
        store.resume(run_id)
        runner.wake.set()
        return store.run(run_id)

    return app


def main():
    parser = argparse.ArgumentParser(description="Standalone local Tushare stock Raw collector")
    parser.add_argument("--port", type=int, default=7110)
    parser.add_argument("--data-dir", type=Path, default=None, help="Independent SQLite control directory")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port 必须为 1–65535")
    uvicorn.run(create_app(args.data_dir), host="127.0.0.1", port=args.port, workers=1)


if __name__ == "__main__":
    main()
