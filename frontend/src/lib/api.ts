import type {
  ActivityLevel,
  ActivitySnapshot,
  ArchiveDeletionCheck,
  ArchiveSourceType,
  BatchItem,
  BatchPlan,
  Catalog,
  CredentialResult,
  DataNeed,
  DataNeedCatalog,
  DataNeedJob,
  DataNeedSave,
  DailyWarehouseExportRequest,
  DailyWarehouseExportResult,
  DailyWarehouseRefreshResult,
  DailyWarehouseRowsPage,
  DailyWarehouseStatus,
  DatasetBundlePlan,
  DatasetBundleRecord,
  DatasetCoveragePage,
  DatasetGroup,
  DatasetItem,
  DatasetMode,
  DatasetPlan,
  DatasetReview,
  DatasetSettings,
  ExportLayout,
  ExportResult,
  LocalDataNavigation,
  LocalDataPage,
  PermissionsCatalog,
  PlanPreview,
  RunDetail,
  RunSummary,
  SavedConfig,
  SavedGroup,
  WarehouseCatalog,
  WarehouseCleanupPreview,
  WarehouseCleanupResult,
  WarehouseCleanupCheckMode,
  GlobalWarehouseCleanupPreview,
  GlobalWarehouseCleanupResult,
  ServerStatus,
  StoragePolicySave,
  StoragePolicyStatus,
  SlicePage,
  SlicePreview,
  TaskConfigPayload,
  WorkerSettings,
} from "../types";
import { errorMessage } from "./helpers";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function apiFetch<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    headers["X-Collector-Request"] = "1";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  let payload: unknown = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    const text = await response.text();
    payload = text ? { detail: text } : null;
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload
        ? (payload as { detail: unknown }).detail
        : payload;
    throw new ApiError(errorMessage(detail), response.status);
  }
  return payload as T;
}

export const collectorApi = {
  getDataNeedCatalog: (signal?: AbortSignal) =>
    apiFetch<DataNeedCatalog>("/data-needs/catalog", "GET", undefined, signal),
  getDataNeeds: (signal?: AbortSignal) =>
    apiFetch<DataNeed[]>("/data-needs", "GET", undefined, signal),
  saveDataNeed: (body: DataNeedSave, id?: string) =>
    apiFetch<{id: string; revision: number}>(`/data-needs${id ? `/${id}` : ""}`, id ? "PUT" : "POST", body),
  syncDataNeed: (id: string, revision: number) =>
    apiFetch<DataNeedJob>(`/data-needs/${id}/sync`, "POST", {
      expected_revision: revision, authorize_network: true,
    }),
  pauseDataNeed: (id: string, revision: number) =>
    apiFetch<{id: string; revision: number}>(`/data-needs/${id}/pause`, "POST", {expected_revision: revision}),
  getStatus: (signal?: AbortSignal) => apiFetch<ServerStatus>("/status", "GET", undefined, signal),
  getCatalog: (signal?: AbortSignal) => apiFetch<Catalog>("/catalog", "GET", undefined, signal),
  getPermissions: (signal?: AbortSignal) =>
    apiFetch<PermissionsCatalog>("/permissions", "GET", undefined, signal),

  getWorkerSettings: (signal?: AbortSignal) =>
    apiFetch<WorkerSettings>("/worker/settings", "GET", undefined, signal),

  updateWorkerSettings: (collection_threads: number) =>
    apiFetch<WorkerSettings>("/worker/settings", "PUT", {
      collection_threads: Math.trunc(collection_threads),
    }),

  getActivity: (
    params: {
      after_seq?: number;
      limit?: number;
      level?: ActivityLevel | "";
      run_id?: string;
    } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (params.after_seq !== undefined) q.set("after_seq", String(params.after_seq));
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.level) q.set("level", params.level);
    if (params.run_id) q.set("run_id", params.run_id);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return apiFetch<ActivitySnapshot>(`/activity${suffix}`, "GET", undefined, signal);
  },

  setCredential: (token: string, remember = false) =>
    apiFetch<CredentialResult>("/credential", "PUT", { token, remember }),

  clearCredential: () => apiFetch<CredentialResult>("/credential", "DELETE"),

  selectDirectory: (initial_path: string | null) =>
    apiFetch<{ cancelled: boolean; path: string | null }>("/directories/select", "POST", {
      initial_path: initial_path?.trim() || null,
    }),

  // Datasets & Bundles
  getDatasets: (signal?: AbortSignal) =>
    apiFetch<DatasetItem[]>("/datasets", "GET", undefined, signal),

  saveDatasetSettings: (
    datasetId: string,
    settings: DatasetSettings,
    expectedRevision: number,
  ) =>
    apiFetch<{ dataset_id: string; settings: DatasetSettings; revision: number }>(
      `/datasets/${datasetId}/settings`,
      "PUT",
      { settings, expected_revision: expectedRevision },
    ),

  reviewDatasetPlan: (
    datasetId: string,
    body: {
      settings: DatasetSettings;
      expected_revision: number;
      mode: DatasetMode;
      end_date?: string;
    },
  ) => apiFetch<DatasetReview>(`/datasets/${datasetId}/review`, "POST", body),

  createDatasetPlan: (
    datasetId: string,
    body: {
      settings: DatasetSettings;
      expected_revision: number;
      mode: DatasetMode;
      end_date?: string;
    },
  ) => apiFetch<DatasetPlan>(`/datasets/${datasetId}/plans`, "POST", body),

  launchDatasetRun: (datasetId: string, planId: string) =>
    apiFetch<RunSummary>(`/datasets/${datasetId}/runs`, "POST", { plan_id: planId }),

  getDatasetCoverage: (
    datasetId: string,
    params: { offset?: number; limit?: number; q?: string; state?: string },
  ) => {
    const q = new URLSearchParams();
    q.set("offset", String(params.offset ?? 0));
    q.set("limit", String(params.limit ?? 50));
    if (params.q) q.set("q", params.q);
    if (params.state) q.set("state", params.state);
    return apiFetch<DatasetCoveragePage>(`/datasets/${datasetId}/coverage?${q.toString()}`);
  },

  getDatasetGroups: (signal?: AbortSignal) =>
    apiFetch<DatasetGroup[]>("/dataset-groups", "GET", undefined, signal),

  saveDatasetGroup: (name: string, datasetIds: string[]) =>
    apiFetch<DatasetGroup>("/dataset-groups", "POST", { name, dataset_ids: datasetIds }),

  deleteDatasetGroup: (groupId: string) =>
    apiFetch<{ deleted: boolean }>(`/dataset-groups/${groupId}`, "DELETE"),

  getDatasetBundles: (signal?: AbortSignal) =>
    apiFetch<DatasetBundleRecord[]>("/dataset-bundles", "GET", undefined, signal),

  planDatasetBundle: (body: {
    dataset_ids: string[];
    mode: "full" | "incremental" | "retry";
    end_date?: string;
    continuation_id?: string | null;
  }) => apiFetch<DatasetBundlePlan>("/dataset-bundles/plans", "POST", body),

  launchDatasetBundle: (planId: string) =>
    apiFetch<BatchItem>("/dataset-bundles/runs", "POST", { plan_id: planId }),

  // Local Data Navigation, Preview, Export & Safe Deletion
  getLocalDataNavigation: (
    params: {
      raw_root?: string;
      q?: string;
      business_domain?: string;
      include_empty?: boolean;
    } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (params.raw_root) q.set("raw_root", params.raw_root);
    if (params.q) q.set("q", params.q);
    if (params.business_domain) q.set("business_domain", params.business_domain);
    if (params.include_empty) q.set("include_empty", "true");
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return apiFetch<LocalDataNavigation>(`/local-data/navigation${suffix}`, "GET", undefined, signal);
  },

  getLocalData: (params: {
    category?: string;
    business_domain?: string;
    entry_id?: string;
    raw_root?: string;
    source_type?: ArchiveSourceType | "";
    q?: string;
    state?: string;
    offset?: number;
    limit?: number;
  }) => {
    const q = new URLSearchParams();
    if (params.category) q.set("category", params.category);
    if (params.business_domain) q.set("business_domain", params.business_domain);
    if (params.entry_id) q.set("entry_id", params.entry_id);
    if (params.raw_root) q.set("raw_root", params.raw_root);
    if (params.source_type) q.set("source_type", params.source_type);
    if (params.q) q.set("q", params.q);
    if (params.state) q.set("state", params.state);
    q.set("offset", String(params.offset ?? 0));
    q.set("limit", String(params.limit ?? 30));
    return apiFetch<LocalDataPage>(`/local-data?${q.toString()}`);
  },

  previewSlice: (
    runId: string,
    sliceId: string,
    params: { offset?: number; limit?: number; q?: string; column?: string } = {},
  ) => {
    const q = new URLSearchParams();
    q.set("offset", String(params.offset ?? 0));
    q.set("limit", String(params.limit ?? 50));
    if (params.q) q.set("q", params.q);
    if (params.column) q.set("column", params.column);
    return apiFetch<SlicePreview>(`/runs/${runId}/slices/${sliceId}/preview?${q.toString()}`);
  },

  checkArchiveDeletion: (runId: string, sliceId: string) =>
    apiFetch<ArchiveDeletionCheck>(`/runs/${runId}/slices/${sliceId}/deletion`),

  deleteArchive: (runId: string, sliceId: string, fingerprint: string) =>
    apiFetch<{ id: string; state: string; error?: string }>(
      `/runs/${runId}/slices/${sliceId}/archive`,
      "DELETE",
      { fingerprint },
    ),

  retryDeletionCleanup: (deletionId: string) =>
    apiFetch<{ id: string; state: string; error?: string }>(
      `/local-data/deletions/${deletionId}/retry`,
      "POST",
    ),

  exportRunOrSlice: (
    runId: string,
    destination: string,
    sliceId?: string | null,
    layout: ExportLayout = "raw",
  ) =>
    apiFetch<ExportResult>(`/runs/${runId}/export`, "POST", {
      destination,
      slice_id: sliceId || null,
      layout,
    }),

  // Local Data Warehouse (unified monthly-partitioned immutable snapshot framework)
  getWarehouseCatalog: (signal?: AbortSignal) =>
    apiFetch<WarehouseCatalog>("/warehouse/catalog", "GET", undefined, signal),

  getWarehouse: (datasetId: string, signal?: AbortSignal) =>
    apiFetch<DailyWarehouseStatus>(
      `/warehouse/${encodeURIComponent(datasetId)}`,
      "GET",
      undefined,
      signal,
    ),

  refreshWarehouse: (datasetId: string) =>
    apiFetch<DailyWarehouseRefreshResult>(
      `/warehouse/${encodeURIComponent(datasetId)}/refresh`,
      "POST",
      {},
    ),

  getWarehouseRows: (
    datasetId: string,
    params: {
      snapshot_id?: string | null;
      variant_id?: string | null;
      start_date?: string;
      end_date?: string;
      ts_code?: string;
      offset?: number;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (params.snapshot_id) q.set("snapshot_id", params.snapshot_id);
    if (params.variant_id) q.set("variant_id", params.variant_id);
    if (params.start_date) q.set("start_date", params.start_date);
    if (params.end_date) q.set("end_date", params.end_date);
    if (params.ts_code) q.set("ts_code", params.ts_code);
    q.set("offset", String(params.offset ?? 0));
    q.set("limit", String(params.limit ?? 50));
    return apiFetch<DailyWarehouseRowsPage>(
      `/warehouse/${encodeURIComponent(datasetId)}/rows?${q.toString()}`,
      "GET",
      undefined,
      signal,
    );
  },

  exportWarehouse: (datasetId: string, body: DailyWarehouseExportRequest) => {
    const payload: Record<string, unknown> = {
      destination: body.destination,
      columns: body.columns ?? [],
    };
    if (body.ts_codes !== undefined) {
      payload.ts_codes = body.ts_codes;
    }
    if (body.start_date) {
      payload.start_date = body.start_date;
    }
    if (body.end_date) {
      payload.end_date = body.end_date;
    }
    if (body.snapshot_id) {
      payload.snapshot_id = body.snapshot_id;
    }
    if (body.variant_id) {
      payload.variant_id = body.variant_id;
    }
    if (body.file_layout) payload.file_layout = body.file_layout;
    if (body.sort_by) payload.sort_by = body.sort_by;
    if (body.split_by) payload.split_by = body.split_by;
    return apiFetch<DailyWarehouseExportResult>(
      `/warehouse/${encodeURIComponent(datasetId)}/export`,
      "POST",
      payload,
    );
  },

  previewWarehouseCleanup: (datasetId: string, snapshotId: string, retentionDays: number, checkMode: WarehouseCleanupCheckMode = "fast") =>
    apiFetch<WarehouseCleanupPreview>(`/warehouse/${encodeURIComponent(datasetId)}/cleanup?snapshot_id=${encodeURIComponent(snapshotId)}&retention_days=${retentionDays}&check_mode=${checkMode}`),

  cleanupWarehouseRaw: (datasetId: string, body: {snapshot_id: string; retention_days: number; fingerprint: string; check_mode: WarehouseCleanupCheckMode}) =>
    apiFetch<WarehouseCleanupResult>(`/warehouse/${encodeURIComponent(datasetId)}/cleanup`, "POST", body),

  previewGlobalWarehouseCleanup: (retentionDays: number, checkMode: WarehouseCleanupCheckMode = "fast") =>
    apiFetch<GlobalWarehouseCleanupPreview>(`/warehouse-cleanup?retention_days=${retentionDays}&check_mode=${checkMode}`),

  cleanupGlobalWarehouseRaw: (body: {retention_days: number; fingerprint: string; check_mode: WarehouseCleanupCheckMode}) =>
    apiFetch<GlobalWarehouseCleanupResult>("/warehouse-cleanup", "POST", body),

  getStoragePolicy: () => apiFetch<StoragePolicyStatus>("/storage-policy"),

  saveStoragePolicy: (body: StoragePolicySave) =>
    apiFetch<StoragePolicyStatus>("/storage-policy", "PUT", body),

  pauseStoragePolicy: (revision: number) =>
    apiFetch<StoragePolicyStatus>("/storage-policy/pause", "POST", {expected_revision: revision}),

  // Backward-compatible daily shortcuts
  getDailyWarehouse: (signal?: AbortSignal) =>
    apiFetch<DailyWarehouseStatus>("/warehouse/daily", "GET", undefined, signal),

  refreshDailyWarehouse: () =>
    apiFetch<DailyWarehouseRefreshResult>("/warehouse/daily/refresh", "POST", {}),

  getDailyWarehouseRows: (
    params: {
      snapshot_id?: string | null;
      start_date?: string;
      end_date?: string;
      ts_code?: string;
      offset?: number;
      limit?: number;
    } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (params.snapshot_id) q.set("snapshot_id", params.snapshot_id);
    if (params.start_date) q.set("start_date", params.start_date);
    if (params.end_date) q.set("end_date", params.end_date);
    if (params.ts_code) q.set("ts_code", params.ts_code);
    q.set("offset", String(params.offset ?? 0));
    q.set("limit", String(params.limit ?? 50));
    return apiFetch<DailyWarehouseRowsPage>(
      `/warehouse/daily/rows?${q.toString()}`,
      "GET",
      undefined,
      signal,
    );
  },

  exportDailyWarehouse: (body: DailyWarehouseExportRequest) =>
    apiFetch<DailyWarehouseExportResult>("/warehouse/daily/export", "POST", {
      destination: body.destination,
      start_date: body.start_date,
      end_date: body.end_date,
      columns: body.columns ?? [],
      ts_codes: body.ts_codes ?? [],
      ...(body.snapshot_id ? { snapshot_id: body.snapshot_id } : {}),
      ...(body.file_layout ? { file_layout: body.file_layout } : {}),
      ...(body.sort_by ? { sort_by: body.sort_by } : {}),
      ...(body.split_by ? { split_by: body.split_by } : {}),
    }),

  // Custom API, Saved Configs, Task Groups, Batches & Runs
  planTask: (config: TaskConfigPayload) => apiFetch<PlanPreview>("/plan", "POST", config),

  createLivePreview: (body: {
    entry_id: string;
    params: Record<string, unknown>;
    fields: string;
    raw_root: string;
  }) => apiFetch<RunSummary>("/previews", "POST", body),

  getConfigs: (signal?: AbortSignal) =>
    apiFetch<SavedConfig[]>("/configs", "GET", undefined, signal),

  createConfig: (config: TaskConfigPayload) =>
    apiFetch<SavedConfig>("/configs", "POST", config),

  updateConfig: (configId: string, revision: number, config: TaskConfigPayload) =>
    apiFetch<SavedConfig>(`/configs/${configId}`, "PUT", { revision, config }),

  launchConfigRun: (configId: string, expectedRevision: number) =>
    apiFetch<RunSummary>(`/configs/${configId}/runs`, "POST", {
      expected_revision: expectedRevision,
    }),

  getGroups: (signal?: AbortSignal) =>
    apiFetch<SavedGroup[]>("/groups", "GET", undefined, signal),

  createGroup: (name: string, configIds: string[]) =>
    apiFetch<SavedGroup>("/groups", "POST", { name, config_ids: configIds }),

  deleteGroup: (groupId: string) =>
    apiFetch<{ deleted: boolean }>(`/groups/${groupId}`, "DELETE"),

  planBatch: (configIds: string[]) =>
    apiFetch<BatchPlan>("/batches/plan", "POST", { config_ids: configIds }),

  launchBatch: (configIds: string[], expectedRevisions: Record<string, number>) =>
    apiFetch<BatchItem>("/batches", "POST", {
      config_ids: configIds,
      expected_revisions: expectedRevisions,
    }),

  getBatches: (signal?: AbortSignal) =>
    apiFetch<BatchItem[]>("/batches", "GET", undefined, signal),

  getRuns: (signal?: AbortSignal) =>
    apiFetch<RunSummary[]>("/runs", "GET", undefined, signal),

  getRunDetail: (runId: string) => apiFetch<RunDetail>(`/runs/${runId}`),

  getRunSlices: (
    runId: string,
    params: { offset?: number; limit?: number; q?: string; state?: string; number?: number } = {},
  ) => {
    const q = new URLSearchParams();
    q.set("offset", String(params.offset ?? 0));
    q.set("limit", String(params.limit ?? 50));
    if (params.q) q.set("q", params.q);
    if (params.state) q.set("state", params.state);
    if (params.number !== undefined) q.set("number", String(params.number));
    return apiFetch<SlicePage>(`/runs/${runId}/slices?${q.toString()}`);
  },

  cancelRun: (runId: string) => apiFetch<RunSummary>(`/runs/${runId}/cancel`, "POST"),

  resumeRun: (runId: string) => apiFetch<RunSummary>(`/runs/${runId}/resume`, "POST"),
};
