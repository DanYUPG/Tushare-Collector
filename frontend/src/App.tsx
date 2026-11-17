import { CheckCircle2, Loader2, X } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPaletteModal } from "./components/CommandPaletteModal";
import { CredentialModal } from "./components/CredentialModal";
import { DatasetBundleDrawer } from "./components/DatasetBundleDrawer";
import { DatasetPlanDrawer } from "./components/DatasetPlanDrawer";
import { DatasetsView } from "./components/DatasetsView";
import { DataNeedsView } from "./components/DataNeedsView";
import { ExportModal } from "./components/ExportModal";
import { LiveLogDock } from "./components/LiveLogDock";
import { RunDetailDrawer } from "./components/RunDetailDrawer";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { WorkerSettingsModal } from "./components/WorkerSettingsModal";

const DailyWarehouseView = lazy(() =>
  import("./components/DailyWarehouseView").then((m) => ({
    default: m.DailyWarehouseView,
  })),
);
const LocalDataView = lazy(() =>
  import("./components/LocalDataView").then((m) => ({
    default: m.LocalDataView,
  })),
);
const PermissionsView = lazy(() =>
  import("./components/PermissionsView").then((m) => ({
    default: m.PermissionsView,
  })),
);
const RunsAndTasksView = lazy(() =>
  import("./components/RunsAndTasksView").then((m) => ({
    default: m.RunsAndTasksView,
  })),
);
const CustomApiView = lazy(() =>
  import("./components/CustomApiView").then((m) => ({
    default: m.CustomApiView,
  })),
);
import { collectorApi } from "./lib/api";
import { patchLocationState, readLocationState, workspaceView } from "./lib/navigation";
import {
  advanceActivityCursor,
  datasetPresentation,
  matchesPermissionFilter,
  readStoredDrafts,
  summarizeExportResult,
  writeStoredDrafts,
} from "./lib/helpers";
import type {
  ActivityEvent,
  ActivityLevel,
  ActivityWorker,
  BatchItem,
  Catalog,
  DailyWarehouseStatus,
  DatasetBundleRecord,
  DatasetGroup,
  DatasetItem,
  DatasetMode,
  DatasetReturnDraft,
  DatasetSettings,
  NavTab,
  PermissionsCatalog,
  RunSummary,
  SavedConfig,
  SavedGroup,
  ServerStatus,
  WarehouseCatalog,
  WorkerSettings,
  TaskConfigPayload,
} from "./types";

function todayShanghaiIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const RUN_LIFECYCLE_KINDS = new Set([
  "run_queued",
  "run_started",
  "run_succeeded",
  "run_failed",
  "run_cancelled",
  "run_interrupted",
  "run_resumed",
]);

export function App() {
  const [activeTab, setActiveTabState] = useState<NavTab>(() => workspaceView(readLocationState()));
  const [routeDatasetId, setRouteDatasetId] = useState(() => readLocationState().get("dataset"));
  const [navigationWarning, setNavigationWarning] = useState<string | null>(null);
  const navigateTo = useCallback((view: NavTab, context: Record<string, string | null> = {}) => {
    patchLocationState({ view, ...(view === "custom" || view === "permissions" ? { dataset: null } : {}), ...context }, "push");
  }, []);
  const openRunDetail = useCallback((runId: string) => navigateTo("runs", { run: runId, slice: null, dataset: null }), [navigateTo]);

  // Core workspace state
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [permissions, setPermissions] = useState<PermissionsCatalog | null>(
    null,
  );
  const [workerSettings, setWorkerSettings] = useState<WorkerSettings | null>(
    null,
  );
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const setActiveTab = useCallback((view: NavTab) => {
    const params = readLocationState();
    const target = datasets.find(ds => ds.id === params.get("dataset"))
      ?? datasets.find(ds => ds.entry_id === params.get("entry"));
    navigateTo(view, target && ["warehouse", "datasets", "local-data"].includes(view)
      ? { dataset: target.id, entry: target.entry_id, run: null, slice: null } : {});
  }, [navigateTo, datasets]);
  const [datasetGroups, setDatasetGroups] = useState<DatasetGroup[]>([]);
  const [datasetBundles, setDatasetBundles] = useState<DatasetBundleRecord[]>(
    [],
  );
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [configs, setConfigs] = useState<SavedConfig[]>([]);
  const [groups, setGroups] = useState<SavedGroup[]>([]);
  const [batches, setBatches] = useState<BatchItem[]>([]);
  const [localArchiveCount, setLocalArchiveCount] = useState<number | null>(
    null,
  );
  const [pendingDeletionCount, setPendingDeletionCount] = useState(0);
  const [dailyWarehouse, setDailyWarehouse] =
    useState<DailyWarehouseStatus | null>(null);
  const [warehouseCatalog, setWarehouseCatalog] =
    useState<WarehouseCatalog | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Selection & navigation state
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingConfig, setEditingConfig] = useState<SavedConfig | null>(null);
  const [sourceConfig, setSourceConfig] = useState<TaskConfigPayload | null>(null);
  const [warehouseEvidence, setWarehouseEvidence] = useState<Record<string, DailyWarehouseStatus>>({});
  const [warehouseEvidenceError, setWarehouseEvidenceError] = useState<string | null>(null);
  const [permissionFocusEntryId, setPermissionFocusEntryId] = useState<
    string | null
  >(null);
  const [customFocusEntryId, setCustomFocusEntryId] = useState<string | null>(
    null,
  );
  const [warehouseFocus, setWarehouseFocus] = useState<{
    datasetId: string;
    signal: number;
  } | null>(null);
  const [localFocusTarget, setLocalFocusTarget] = useState<{
    entryId?: string;
    runId?: string;
    sliceId?: string;
    signal: number;
  } | null>(null);

  // Drawers & Modals
  const [datasetDrawerState, setDatasetDrawerState] = useState<{
    datasetId: string;
    mode: DatasetMode;
    tab: "plan" | "coverage";
    presetSettings?: Partial<DatasetSettings> | null;
    presetEndDate?: string | null;
    autoCheckSignal: number;
  } | null>(null);

  const [bundleDrawerReq, setBundleDrawerReq] = useState<{
    datasetIds: string[];
    mode: "full" | "incremental" | "retry";
    endDate?: string;
    continuationId?: string | null;
  } | null>(null);

  const [inspectRunId, setInspectRunId] = useState<string | null>(null);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [workerSettingsOpen, setWorkerSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const [exportTarget, setExportTarget] = useState<{
    runId: string;
    sliceId?: string | null;
    title: string;
  } | null>(null);

  // Dependency return state
  const [pendingReturn, setPendingReturn] = useState<DatasetReturnDraft | null>(
    null,
  );
  const notifiedReturnRunRef = useRef<string | null>(null);

  // Live Activity Stream (/api/activity)
  const [worker, setWorker] = useState<ActivityWorker | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [latestSeq, setLatestSeq] = useState(0);
  const [logDockOpen, setLogDockOpen] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState<ActivityLevel | "">("");
  const [logOnlyActiveRun, setLogOnlyActiveRun] = useState(false);
  const [logPaused, setLogPaused] = useState(false);

  const cursorRef = useRef(0);
  const routeSignatureRef = useRef<string | null>(null);
  const prevActiveRunIdRef = useRef<string | null>(null);

  // Toast Notification
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  useEffect(() => {
    const restore = () => {
      const params = readLocationState();
      const currentHash = window.location.hash.replace(/^#/, "");
      if (currentHash && currentHash !== params.toString()) {
        window.history.replaceState(null, "", `#${params.toString()}`);
        setNavigationWarning("链接中的无效或未知参数已忽略；未启动任何采集操作。");
      }
      const view = workspaceView(params);
      const signature = JSON.stringify(["view", "dataset", "entry", "run", "slice"].map(key => params.get(key)));
      if (routeSignatureRef.current === signature) return;
      routeSignatureRef.current = signature;
      setActiveTabState(view);
      setRouteDatasetId(params.get("dataset"));
      setWarehouseFocus(params.get("dataset") ? { datasetId: params.get("dataset")!, signal: Date.now() } : null);
      setLocalFocusTarget({
        entryId: params.get("entry") || undefined,
        runId: params.get("run") || undefined,
        sliceId: params.get("slice") || undefined,
        signal: Date.now(),
      });
      if (view === "permissions") setPermissionFocusEntryId(params.get("entry"));
      if (view === "custom") setCustomFocusEntryId(params.get("entry"));
      setInspectRunId(view === "runs" ? params.get("run") : null);
      setDatasetDrawerState(null);
    };
    const original = window.location.hash.replace(/^#/, "");
    if (original && original !== readLocationState().toString()) {
      setNavigationWarning("链接中的无效或未知参数已忽略；未启动任何采集操作。");
    }
    patchLocationState({}, "replace");
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    window.addEventListener("collector:navigation", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("collector:navigation", restore);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const refreshWorkspace = useCallback(async (includeCatalog = false) => {
    setRefreshing(true);
    try {
      const [
        st,
        dsRes,
        dsGroupsRes,
        dsBundlesRes,
        runsRes,
        cfgRes,
        grpRes,
        batRes,
        localSum,
      ] = await Promise.all([
        collectorApi.getStatus(),
        collectorApi.getDatasets(),
        collectorApi.getDatasetGroups(),
        collectorApi.getDatasetBundles(),
        collectorApi.getRuns(),
        collectorApi.getConfigs(),
        collectorApi.getGroups(),
        collectorApi.getBatches(),
        collectorApi.getLocalData({ limit: 1 }),
      ]);
      setStatus(st);
      setDatasets(dsRes);
      setDatasetGroups(dsGroupsRes);
      setDatasetBundles(dsBundlesRes);
      setRuns(runsRes);
      setConfigs(cfgRes);
      setGroups(grpRes);
      setBatches(batRes);
      setLocalArchiveCount(localSum.archives);
      setPendingDeletionCount(localSum.pending_deletion_count ?? 0);

      // Non-blocking warehouse status check (graceful while backend deploys)
      void collectorApi
        .getDailyWarehouse()
        .then((wh) => setDailyWarehouse(wh))
        .catch(() => {});

      // Fetch /api/worker/settings with graceful fallback if backend hasn't restarted yet
      try {
        const ws = await collectorApi.getWorkerSettings();
        setWorkerSettings(ws);
      } catch {
        setWorkerSettings((prev) => ({
          collection_threads:
            st.collection_threads ?? prev?.collection_threads ?? 1,
          effective_collection_threads:
            st.effective_collection_threads ??
            prev?.effective_collection_threads ??
            1,
          max_collection_threads:
            st.max_collection_threads ?? prev?.max_collection_threads ?? 16,
          applies_to: st.applies_to ?? "next_run",
        }));
      }

      if (includeCatalog) {
        const [cat, permRes, whCat] = await Promise.all([
          collectorApi.getCatalog(),
          collectorApi.getPermissions().catch(() => null),
          collectorApi.getWarehouseCatalog().catch(() => null),
        ]);
        setCatalog(cat);
        if (permRes) setPermissions(permRes);
        if (whCat) setWarehouseCatalog(whCat);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "刷新工作台状态失败");
    } finally {
      setRefreshing(false);
    }
  }, [showToast]);

  // Initial load + draft restoration
  useEffect(() => {
    void refreshWorkspace(true);
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!catalog || !datasets.length) return;
    const params = readLocationState();
    const entryId = params.get("entry");
    const datasetId = params.get("dataset");
    if (entryId && !catalog.entries.some(entry => entry.id === entryId)) {
      setNavigationWarning("链接中的接口不在当前股票目录中，请重新选择；不会自动执行采集。");
    }
    if (datasetId && !datasets.some(dataset => dataset.id === datasetId)) {
      setNavigationWarning("链接中的数据集不存在，请重新选择；不会替代执行其他数据集的采集。");
    }
  }, [catalog, datasets, activeTab, routeDatasetId]);

  useEffect(() => {
    if (!status?.database) return;
    const stored = readStoredDrafts(status.database);
    const firstReturn = stored.datasetReturns?.[0] ?? null;
    if (firstReturn) {
      setPendingReturn(firstReturn);
    }
  }, [status?.database]);

  // Persist pendingReturn into database-scoped localStorage
  const updatePendingReturn = useCallback(
    (next: DatasetReturnDraft | null) => {
      setPendingReturn(next);
      if (!status?.database) return;
      const current = readStoredDrafts(status.database);
      writeStoredDrafts(status.database, {
        ...current,
        datasetReturns: next ? [next] : [],
      });
    },
    [status?.database],
  );

  // Incremental /api/activity polling loop following exact cursor contract
  const pollActivity = useCallback(async () => {
    const currentCursor = cursorRef.current;
    const limit = currentCursor === 0 ? 150 : 200;
    try {
      const snap = await collectorApi.getActivity({
        after_seq: currentCursor,
        limit,
      });
      setWorker(snap.worker);
      if (snap.worker.collection_threads !== undefined) {
        setWorkerSettings((prev) => ({
          collection_threads: snap.worker.collection_threads ?? prev?.collection_threads ?? 1,
          effective_collection_threads:
            snap.worker.effective_collection_threads ??
            prev?.effective_collection_threads ??
            1,
          max_collection_threads:
            snap.worker.max_collection_threads ?? prev?.max_collection_threads ?? 16,
          applies_to: snap.worker.applies_to ?? prev?.applies_to ?? "next_run",
        }));
      }
      setLatestSeq(snap.latest_seq);

      const nextCursor = advanceActivityCursor(
        currentCursor,
        snap.events,
        snap.latest_seq,
        limit,
      );
      cursorRef.current = nextCursor;

      if (currentCursor === 0) {
        setActivityEvents(snap.events);
      } else if (snap.events.length > 0 && !logPaused) {
        setActivityEvents((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          const appended = snap.events.filter((e) => !seen.has(e.seq));
          if (appended.length === 0) return prev;
          const merged = [...prev, ...appended];
          return merged.length > 500 ? merged.slice(merged.length - 500) : merged;
        });
      }

      // Auto-expand log dock if a run just started
      const currentActiveId = snap.worker.active_run?.id ?? null;
      if (currentActiveId && prevActiveRunIdRef.current === null) {
        setLogDockOpen(true);
      }

      // Refresh workspace lists when run lifecycle events arrive or active run completes
      const hasLifecycleChange =
        currentCursor > 0 &&
        (snap.events.some((ev) => RUN_LIFECYCLE_KINDS.has(ev.kind)) ||
          (prevActiveRunIdRef.current !== null && currentActiveId === null));

      prevActiveRunIdRef.current = currentActiveId;
      if (hasLifecycleChange) {
        void refreshWorkspace(false);
      }
    } catch {
      // transient network error: keep cursor intact for next retry
    }
  }, [logPaused, refreshWorkspace]);

  const isEngineBusy = Boolean(
    worker?.active_run || (worker?.queued_runs ?? 0) > 0,
  );

  // Track page visibility to throttle background polling and immediately sync on tab return
  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = !document.hidden;
      setIsPageVisible(visible);
      if (visible) {
        void pollActivity();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [pollActivity]);

  // Global Cmd+K / Ctrl+K shortcut for Command Palette
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        ev.preventDefault();
        if (document.querySelector("dialog[open]")) return;
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    void pollActivity();
    const intervalMs = isPageVisible
      ? isEngineBusy
        ? 1200
        : 3000
      : isEngineBusy
        ? 6000
        : 15000;
    const timer = window.setInterval(() => {
      void pollActivity();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [pollActivity, isEngineBusy, isPageVisible]);

  // Check if dependency run completed so user can auto-return to original dataset
  useEffect(() => {
    if (!pendingReturn?.runId) return;
    const depRun = runs.find((r) => r.id === pendingReturn.runId);
    if (
      depRun?.state === "succeeded" &&
      notifiedReturnRunRef.current !== depRun.id
    ) {
      notifiedReturnRunRef.current = depRun.id;
      const targetDs = datasets.find((d) => d.id === pendingReturn.id);
      showToast(
        `前置依赖已完成归档！可继续检查「${targetDs?.name ?? pendingReturn.id}」`,
      );
      if (!datasetDrawerState && !inspectRunId && !bundleDrawerReq) {
        setDatasetDrawerState({
          datasetId: pendingReturn.id,
          mode: pendingReturn.mode,
          tab: "plan",
          presetSettings: pendingReturn.settings,
          presetEndDate: pendingReturn.endDate,
          autoCheckSignal: Date.now(),
        });
      }
    }
  }, [
    runs,
    pendingReturn,
    datasets,
    datasetDrawerState,
    inspectRunId,
    bundleDrawerReq,
    showToast,
  ]);

  const datasetStats = useMemo(() => {
    let covered = 0;
    let attention = 0;
    for (const ds of datasets) {
      const p = datasetPresentation(ds);
      if ((ds.covered_partitions ?? 0) > 0) covered += 1;
      if (p.kind === "attention") attention += 1;
    }
    return { covered, total: datasets.length, attention };
  }, [datasets]);

  const permissionsStats = useMemo(() => {
    const entries = permissions?.entries ?? [];
    let specialCount = 0;
    for (const e of entries) {
      if (
        matchesPermissionFilter(e, "independent") ||
        matchesPermissionFilter(e, "insufficient_points") ||
        matchesPermissionFilter(e, "unknown_rpm")
      ) {
        specialCount += 1;
      }
    }
    return { total: entries.length, specialCount };
  }, [permissions]);

  const handleOpenPermissionAudit = useCallback((entryId?: string) => {
    setDatasetDrawerState(null);
    if (entryId) setPermissionFocusEntryId(entryId);
    navigateTo("permissions", { entry: entryId ?? null });
  }, [navigateTo]);

  const activeOrQueuedRuns = useMemo(
    () =>
      runs.filter((r) => r.state === "running" || r.state === "queued").length,
    [runs],
  );

  const supportedWarehouseIds = useMemo(
    () => new Set(warehouseCatalog?.supported_datasets ?? []),
    [warehouseCatalog],
  );

  const handleWarehouseStatusUpdated = useCallback(
    (datasetId: string, nextStatus: DailyWarehouseStatus) => {
      setWarehouseEvidence((prev) => ({ ...prev, [datasetId]: nextStatus }));
      if (datasetId === "daily") {
        setDailyWarehouse(nextStatus);
      }
    },
    [],
  );

  useEffect(() => {
    if (dailyWarehouse) {
      setWarehouseEvidence((prev) =>
        prev.daily === dailyWarehouse ? prev : { ...prev, daily: dailyWarehouse },
      );
    }
  }, [dailyWarehouse]);

  // Persistent, bounded-concurrency warehouse status sync across Datasets & Warehouse tabs
  const warehouseCandidateKey = useMemo(() => {
    const dsSignal = datasets
      .filter((ds) => supportedWarehouseIds.has(ds.id))
      .map(
        (ds) =>
          `${ds.id}:${ds.covered_partitions ?? 0}:${ds.last_run?.id ?? ""}:${ds.last_run?.state ?? ""}`,
      )
      .join("|");
    return `${[...supportedWarehouseIds].sort().join(",")}#${dsSignal}`;
  }, [datasets, supportedWarehouseIds]);

  useEffect(() => {
    if (!warehouseCatalog?.entries.length) return;
    const controller = new AbortController();
    setWarehouseEvidenceError(null);
    const coveredSet = new Set(
      datasets.filter((ds) => (ds.covered_partitions ?? 0) > 0).map((ds) => ds.id),
    );
    const candidateIds = [...supportedWarehouseIds].sort((a, b) => {
      const aCov = coveredSet.has(a) ? 0 : 1;
      const bCov = coveredSet.has(b) ? 0 : 1;
      return aCov - bCov;
    });
    if (!candidateIds.length) return () => controller.abort();

    const concurrency = 8;
    let cursor = 0;
    const results: Array<{
      id: string;
      status: DailyWarehouseStatus | null;
      error: string | null;
    }> = [];

    const runWorker = async () => {
      while (cursor < candidateIds.length && !controller.signal.aborted) {
        const currentId = candidateIds[cursor++];
        if (!currentId) break;
        try {
          const wh = await collectorApi.getWarehouse(currentId, controller.signal);
          results.push({ id: currentId, status: wh, error: null });
        } catch (error) {
          if (controller.signal.aborted) return;
          results.push({
            id: currentId,
            status: null,
            error: error instanceof Error ? error.message : "状态未知",
          });
        }
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(concurrency, candidateIds.length) }, () => runWorker()),
    ).then(() => {
      if (controller.signal.aborted) return;
      setWarehouseEvidence((prev) => {
        const merged = { ...prev };
        for (const item of results) {
          if (item.status) merged[item.id] = item.status;
        }
        return merged;
      });
      const failed = results.filter((item) => item.error);
      setWarehouseEvidenceError(
        failed.length
          ? `仓库状态读取失败：${failed.map((item) => `${item.id}：${item.error}`).join("；")}`
          : null,
      );
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseCandidateKey]);

  const warehouseSummary = useMemo(() => {
    let readyCount = 0;
    let refreshNeededCount = 0;
    for (const [dsId, wh] of Object.entries(warehouseEvidence)) {
      if (supportedWarehouseIds.size > 0 && !supportedWarehouseIds.has(dsId)) continue;
      if (wh.state === "ready") readyCount += 1;
      if (wh.refresh_needed) refreshNeededCount += 1;
    }
    return { readyCount, refreshNeededCount };
  }, [warehouseEvidence, supportedWarehouseIds]);

  const configureRun = (run: RunSummary) => {
    setInspectRunId(null);
    if (run.dataset_id) {
      navigateTo("datasets", { dataset: run.dataset_id, entry: run.config.entry_id, run: null, slice: null });
      setDatasetDrawerState({
        datasetId: run.dataset_id, mode: "incremental", tab: "plan", autoCheckSignal: 0,
      });
    } else {
      setEditingConfig(null);
      setSourceConfig(run.config);
      navigateTo("custom", { entry: run.config.entry_id, run: null, slice: null });
    }
  };

  const openDatasetSettings = (datasetId: string, mode: DatasetMode = "incremental", tab: "plan" | "coverage" = "plan") => {
    patchLocationState({ dataset: datasetId, entry: datasets.find(ds => ds.id === datasetId)?.entry_id ?? null }, "push");
    setDatasetDrawerState({ datasetId, mode, tab, autoCheckSignal: 0 });
  };

  const activeDrawerDataset = useMemo(
    () =>
      datasetDrawerState
        ? (datasets.find((d) => d.id === datasetDrawerState.datasetId) ?? null)
        : null,
    [datasets, datasetDrawerState],
  );

  const pendingReturnDatasetName = useMemo(() => {
    if (!pendingReturn) return "";
    return (
      datasets.find((d) => d.id === pendingReturn.id)?.name ??
      pendingReturn.id
    );
  }, [datasets, pendingReturn]);

  const handleReturnToDataset = () => {
    if (!pendingReturn) return;
    setActiveTab("datasets");
    setDatasetDrawerState({
      datasetId: pendingReturn.id,
      mode: pendingReturn.mode,
      tab: "plan",
      presetSettings: pendingReturn.settings,
      presetEndDate: pendingReturn.endDate,
      autoCheckSignal: Date.now(),
    });
    updatePendingReturn(null);
  };

  const handlePreviewSlice = (runId: string, sliceId: string) => {
    setInspectRunId(null);
    setDatasetDrawerState(null);
    navigateTo("local-data", { run: runId, slice: sliceId, entry: null, dataset: null, raw_run: null, raw_slice: null });
    setLocalFocusTarget({ runId, sliceId, signal: Date.now() });
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-900">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        status={status}
        worker={worker}
        dailyWarehouse={dailyWarehouse}
        supportedWarehouseCount={
          warehouseCatalog ? warehouseCatalog.supported_datasets.length : null
        }
        readyWarehouseCount={warehouseSummary.readyCount}
        refreshNeededWarehouseCount={warehouseSummary.refreshNeededCount}
        datasetStats={datasetStats}
        permissionsStats={permissionsStats}
        localArchiveCount={localArchiveCount}
        pendingDeletionCount={pendingDeletionCount}
        activeOrQueuedRuns={activeOrQueuedRuns}
        onOpenCredential={() => setCredentialOpen(true)}
      />

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <Topbar
          activeTab={activeTab}
          status={status}
          worker={worker}
          workerSettings={workerSettings}
          refreshing={refreshing}
          logDockOpen={logDockOpen}
          pendingReturn={pendingReturn}
          pendingReturnDatasetName={pendingReturnDatasetName}
          onReturnToDataset={handleReturnToDataset}
          onRefresh={() => void refreshWorkspace(false)}
          onOpenCredential={() => setCredentialOpen(true)}
          onOpenWorkerSettings={() => setWorkerSettingsOpen(true)}
          onToggleLogDock={() => setLogDockOpen((v) => !v)}
          onOpenRunDetail={openRunDetail}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        />

        {/* Scrollable Workspace Content */}
        <main className="flex-1 overflow-y-auto p-5 lg:p-6">
          {navigationWarning && (
            <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {navigationWarning}
              <button type="button" onClick={() => setNavigationWarning(null)}>关闭提示</button>
            </div>
          )}
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-xs text-slate-500 shadow-sm">
                <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
                正在加载工作台视图…
              </div>
            }
          >
          {activeTab === "needs" && <DataNeedsView
            tokenConfigured={worker?.token_configured ?? status?.token_configured ?? false}
            workerRunning={worker?.worker_running ?? status?.worker_running ?? false}
            onOpenRun={openRunDetail}
            onOpenWarehouse={(datasetId, startDate, endDate) => navigateTo("warehouse", {
              dataset: datasetId, wh_start: startDate?.replaceAll("-", "") ?? null,
              wh_end: endDate?.replaceAll("-", "") ?? null, wh_code: null, wh_variant: null, run: null, slice: null,
            })}
          />}
          {activeTab === "datasets" && (
            <DatasetsView
              catalog={catalog}
              datasets={datasets}
              focusDatasetId={routeDatasetId}
              warehouseEvidence={warehouseEvidence}
              warehouseEvidenceError={warehouseEvidenceError}
              onFocusDataset={(datasetId) => patchLocationState({
                dataset: datasetId, entry: datasets.find(ds => ds.id === datasetId)?.entry_id ?? null,
              }, "push")}
              onShowDatasetRuns={(datasetId) => navigateTo("runs", { dataset: datasetId, run: null })}
              datasetGroups={datasetGroups}
              datasetBundles={datasetBundles}
              selectedIds={selectedDatasetIds}
              onToggleSelect={(id) =>
                setSelectedDatasetIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onSelectMany={(ids) => setSelectedDatasetIds(new Set(ids))}
              onClearSelection={() => setSelectedDatasetIds(new Set())}
              onSaveGroup={async (name, ids) => {
                await collectorApi.saveDatasetGroup(name, ids);
                await refreshWorkspace(false);
                showToast(`已保存数据集组「${name}」`);
              }}
              onDeleteGroup={async (groupId) => {
                await collectorApi.deleteDatasetGroup(groupId);
                await refreshWorkspace(false);
              }}
              onOpenDatasetDrawer={openDatasetSettings}
              onOpenBundleDrawer={(opts) => {
                const ids =
                  opts?.datasetIds && opts.datasetIds.length > 0
                    ? opts.datasetIds
                    : [...selectedDatasetIds];
                if (ids.length === 0) return;
                setBundleDrawerReq({
                  datasetIds: ids,
                  mode: opts?.mode ?? "incremental",
                  endDate: opts?.endDate ?? todayShanghaiIso(),
                  continuationId: opts?.continuationId ?? null,
                });
              }}
              onOpenRunDetail={openRunDetail}
              onJumpLocalData={(entryId) => {
                navigateTo("local-data", {
                  entry: entryId, dataset: datasets.find(ds => ds.entry_id === entryId)?.id ?? null,
                  run: null, slice: null, raw_run: null, raw_slice: null,
                });
                setLocalFocusTarget({ entryId, signal: Date.now() });
              }}
              onOpenPermissionAudit={handleOpenPermissionAudit}
              supportedWarehouseIds={supportedWarehouseIds}
              onOpenWarehouse={(datasetId) => {
                setWarehouseFocus({ datasetId, signal: Date.now() });
                navigateTo("warehouse", { dataset: datasetId, entry: datasets.find(ds => ds.id === datasetId)?.entry_id ?? null });
              }}
            />
          )}

          {activeTab === "warehouse" && (
            <DailyWarehouseView
              catalog={catalog}
              datasets={datasets}
              warehouseCatalog={warehouseCatalog}
              warehouseEvidence={warehouseEvidence}
              warehouseEvidenceError={warehouseEvidenceError}
              focusDataset={warehouseFocus}
              initialDailyWarehouse={dailyWarehouse}
              defaultExportRoot={status?.default_raw_root || ""}
              onCatalogLoaded={(wc) => setWarehouseCatalog(wc)}
              onDailyStatusUpdated={(next) => setDailyWarehouse(next)}
              onWarehouseStatusUpdated={handleWarehouseStatusUpdated}
              onOpenDatasetDrawer={openDatasetSettings}
              onOpenRawArchives={(entryId) => {
                navigateTo("local-data", {
                  entry: entryId, dataset: datasets.find(ds => ds.entry_id === entryId)?.id ?? null,
                  run: null, slice: null, raw_run: null, raw_slice: null,
                });
                setLocalFocusTarget({ entryId, signal: Date.now() });
              }}
              onOpenLogDock={() => setLogDockOpen(true)}
              onToast={showToast}
            />
          )}

          {activeTab === "permissions" && (
            <PermissionsView
              catalog={catalog}
              permissions={permissions}
              focusEntryId={permissionFocusEntryId}
              onClearFocusEntry={() => setPermissionFocusEntryId(null)}
              onJumpToDataset={(entryId) => {
                const target = datasets.find((d) => d.entry_id === entryId);
                setActiveTab("datasets");
                if (target) {
                  setDatasetDrawerState({
                    datasetId: target.id,
                    mode: "incremental",
                    tab: "plan",
                    autoCheckSignal: 0,
                  });
                } else {
                  showToast("该接口属于仅自定义采集接口（未纳入预置标准数据集），可前往「高级工具 → 自定义 API」");
                }
              }}
              onJumpToCustom={(entryId) => {
                setEditingConfig(null);
                setCustomFocusEntryId(entryId);
                setActiveTab("custom");
              }}
            />
          )}

          {activeTab === "local-data" && (
            <LocalDataView
              catalog={catalog}
              focusTarget={localFocusTarget}
              onRequestExport={(t) => setExportTarget(t)}
              onOpenRunDetail={openRunDetail}
              onArchiveMutated={() => refreshWorkspace(false)}
            />
          )}

          {activeTab === "runs" && (
            <RunsAndTasksView
              catalog={catalog}
              runs={runs}
              configs={configs}
              groups={groups}
              batches={batches}
              onConfigureRun={configureRun}
              onOpenPermissionAudit={handleOpenPermissionAudit}
              onOpenRunDetail={openRunDetail}
              onRequestExport={(t) => setExportTarget(t)}
              onEditConfig={(cfg) => {
                setEditingConfig(cfg);
                setSourceConfig(null);
                setActiveTab("custom");
              }}
              onNewCustomTask={() => {
                setEditingConfig(null);
                setSourceConfig(null);
                setActiveTab("custom");
              }}
              onMutated={() => refreshWorkspace(false)}
            />
          )}

          {activeTab === "custom" && (
            <CustomApiView
              catalog={catalog}
              defaultRawRoot={status?.default_raw_root || ""}
              databasePath={status?.database || ""}
              editingConfig={editingConfig}
              sourceConfig={sourceConfig}
              onClearSourceConfig={() => setSourceConfig(null)}
              focusEntryId={customFocusEntryId}
              onClearFocusEntry={() => setCustomFocusEntryId(null)}
              onClearEditing={() => setEditingConfig(null)}
              onSavedOrLaunched={async (run) => {
                await refreshWorkspace(false);
                if (run) {
                  setLogDockOpen(true);
                  setInspectRunId(run.id);
                  showToast(`已启动任务「${run.config.name}」`);
                } else {
                  showToast("任务配置已保存");
                }
              }}
              onPreviewSlice={handlePreviewSlice}
              onOpenPermissionAudit={handleOpenPermissionAudit}
            />
          )}
          </Suspense>
        </main>

        {/* Bottom Collapsible Real-Time Execution & Log Console */}
        <LiveLogDock
          open={logDockOpen}
          onToggleOpen={() => setLogDockOpen((v) => !v)}
          worker={worker}
          workerSettings={workerSettings}
          events={activityEvents}
          latestSeq={latestSeq}
          levelFilter={logLevelFilter}
          onChangeLevelFilter={setLogLevelFilter}
          onlyActiveRun={logOnlyActiveRun}
          onToggleOnlyActiveRun={() => setLogOnlyActiveRun((v) => !v)}
          paused={logPaused}
          onTogglePaused={() => setLogPaused((v) => !v)}
          onOpenWorkerSettings={() => setWorkerSettingsOpen(true)}
          onCancelActiveRun={async (runId) => {
            try {
              await collectorApi.cancelRun(runId);
              await pollActivity();
              await refreshWorkspace(false);
              showToast("已请求停止当前运行任务");
            } catch (err) {
              showToast(err instanceof Error ? err.message : "停止失败");
            }
          }}
          onOpenRunDetail={openRunDetail}
          onPreviewSlice={handlePreviewSlice}
        />
      </div>

      {/* Slide-over Drawers & Modals */}
      <DatasetPlanDrawer
        dataset={activeDrawerDataset}
        initialMode={datasetDrawerState?.mode ?? "incremental"}
        initialTab={datasetDrawerState?.tab ?? "plan"}
        presetSettings={datasetDrawerState?.presetSettings}
        presetEndDate={datasetDrawerState?.presetEndDate}
        autoCheckSignal={datasetDrawerState?.autoCheckSignal}
        pendingReturn={pendingReturn}
        onClose={() => setDatasetDrawerState(null)}
        onSavedSettings={() => refreshWorkspace(false)}
        onLaunchedRun={async (run, dependencyOrigin) => {
          if (dependencyOrigin) {
            updatePendingReturn({ ...dependencyOrigin, runId: run.id });
          } else if (
            pendingReturn &&
            pendingReturn.id === activeDrawerDataset?.id
          ) {
            updatePendingReturn(null);
          }
          setDatasetDrawerState(null);
          setLogDockOpen(true);
          await refreshWorkspace(false);
          await pollActivity();
          showToast(`已入队执行：${run.config.name}`);
        }}
        onReturnToOrigin={handleReturnToDataset}
        onPreviewSlice={handlePreviewSlice}
        onOpenPermissionAudit={handleOpenPermissionAudit}
      />

      <DatasetBundleDrawer
        request={bundleDrawerReq}
        datasets={datasets}
        defaultEndDate={todayShanghaiIso()}
        onClose={() => setBundleDrawerReq(null)}
        onLaunched={async (batch) => {
          setBundleDrawerReq(null);
          setLogDockOpen(true);
          await refreshWorkspace(false);
          await pollActivity();
          showToast(`已启动组合阶段（共 ${batch.total_tasks} 个数据集任务）`);
        }}
      />

      <RunDetailDrawer
        runId={inspectRunId}
        onClose={() => {
          setInspectRunId(null);
          if (workspaceView(readLocationState()) === "runs") patchLocationState({ run: null });
        }}
        onMutated={async () => {
          await refreshWorkspace(false);
          await pollActivity();
        }}
        onPreviewSlice={handlePreviewSlice}
        onRequestExport={(t) => setExportTarget(t)}
        onOpenDatasetSplit={(datasetId, mode) => {
          setInspectRunId(null);
          setActiveTab("datasets");
          setDatasetDrawerState({
            datasetId,
            mode,
            tab: "plan",
            autoCheckSignal: Date.now(),
          });
        }}
        onConfigureRun={configureRun}
        onOpenPermissionAudit={handleOpenPermissionAudit}
      />

      <CredentialModal
        open={credentialOpen}
        tokenConfigured={Boolean(
          worker?.token_configured ?? status?.token_configured,
        )}
        tokenPersisted={Boolean(status?.token_persisted)}
        credentialFile={status?.credential_file}
        onClose={() => setCredentialOpen(false)}
        onSaved={(result) => {
          setStatus(previous => previous ? {
            ...previous, token_configured: result.token_configured, token_persisted: result.token_persisted,
          } : previous);
          void refreshWorkspace(false);
          void pollActivity();
          showToast(result.persistence === "local_file"
            ? "Token 已明文保存到本机，重启自动加载"
            : result.persistence === "cleared" ? "已清除本地文件及当前进程凭证"
              : "凭证仅本次使用；之前的本地凭证已移除");
        }}
      />

      <WorkerSettingsModal
        open={workerSettingsOpen}
        settings={workerSettings}
        worker={worker}
        onClose={() => setWorkerSettingsOpen(false)}
        onSaved={(updated) => {
          setWorkerSettings(updated);
          void pollActivity();
          if (updated.collection_threads !== updated.effective_collection_threads) {
            showToast(
              `已保存采集并发为 ${updated.collection_threads} 线程（当前运行保持 ${updated.effective_collection_threads} 线程，下次运行生效）`,
            );
          } else {
            showToast(`已保存采集并发为 ${updated.collection_threads} 线程`);
          }
        }}
      />

      <ExportModal
        target={exportTarget}
        defaultDirectory={status?.default_export_root || status?.default_raw_root || ""}
        onClose={() => setExportTarget(null)}
        onExported={(res) => {
          const summary = summarizeExportResult(res);
          showToast(
            `已完成导出校验（${summary.exportedSlices} 份 · ${summary.layoutLabel}）`,
          );
        }}
      />

      <CommandPaletteModal
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        catalog={catalog}
        warehouseCatalog={warehouseCatalog}
        warehouseEvidence={warehouseEvidence}
        datasets={datasets}
        onNavigateTab={(tab) => setActiveTab(tab)}
        onOpenWarehouse={(datasetId) => {
          setWarehouseFocus({ datasetId, signal: Date.now() });
          navigateTo("warehouse", {
            dataset: datasetId,
            entry: datasets.find((ds) => ds.id === datasetId)?.entry_id ?? null,
          });
        }}
        onOpenDatasetPlan={(datasetId) => {
          navigateTo("datasets", {
            dataset: datasetId,
            entry: datasets.find((ds) => ds.id === datasetId)?.entry_id ?? null,
          });
          openDatasetSettings(datasetId, "incremental", "plan");
        }}
        onOpenCustomEntry={(entryId) => {
          setEditingConfig(null);
          setSourceConfig(null);
          setCustomFocusEntryId(entryId);
          navigateTo("custom", { entry: entryId });
        }}
        onOpenRawEntry={(entryId) => {
          navigateTo("local-data", {
            entry: entryId,
            dataset: datasets.find((ds) => ds.entry_id === entryId)?.id ?? null,
            run: null,
            slice: null,
            raw_run: null,
            raw_slice: null,
          });
          setLocalFocusTarget({ entryId, signal: Date.now() });
        }}
        onOpenPermissionEntry={(entryId) => handleOpenPermissionAudit(entryId)}
      />

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-12 right-5 z-50 flex items-center gap-2.5 rounded-xl bg-navy-900 px-4 py-2.5 text-xs font-medium text-white shadow-xl ring-1 ring-white/10">
          <CheckCircle2 className="h-4 w-4 text-teal-400 shrink-0" />
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-1 text-slate-400 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
