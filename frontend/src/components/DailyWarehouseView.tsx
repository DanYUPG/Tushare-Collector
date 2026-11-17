import clsx from "clsx";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FolderOpen,
  FolderSearch,
  HardDriveDownload,
  Info,
  Layers,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collectorApi } from "../lib/api";
import { patchLocationState } from "../lib/navigation";
import { useViewLocalHash } from "./viewLocalHash";
import {
  DAILY_WAREHOUSE_DEFAULT_COLUMNS,
  WAREHOUSE_COLUMN_PRESETS,
  accountAccessBadge,
  buildWarehouseExportPayload,
  buildWarehouseRowsQuery,
  cellText,
  computeAnchorQuickRange,
  datasetPresentation,
  filterAndGroupWarehouseCatalog,
  filterVisibleTableColumns,
  formatDateTime,
  formatNumber,
  formatWarehouseVariantLabel,
  normalizeWarehouseTsCode,
  normalizeCompactDate,
  resolvePinnedSnapshotId,
  resolveSelectedVariantId,
  resolveWarehouseFieldLabel,
  resolveWarehouseProfile,
  type AnchorQuickRangeKind,
  type WarehouseProfile,
} from "../lib/helpers";
import { RowDetailDrawer, type RowDetailColumnMeta } from "./RowDetailDrawer";
import { WorkspaceDrawer, WorkspaceHeader, WorkspaceToolbar } from "./WorkspaceLayout";
import type {
  Catalog,
  CatalogField,
  DailyWarehouseExportResult,
  DailyWarehouseRowsPage,
  DailyWarehouseStatus,
  DatasetItem,
  DatasetMode,
  WarehouseCatalog,
  WarehouseCatalogEntry,
  WarehouseCatalogField,
  WarehouseSortKey,
} from "../types";

interface DailyWarehouseViewProps {
  catalog: Catalog | null;
  datasets: DatasetItem[];
  warehouseCatalog: WarehouseCatalog | null;
  warehouseEvidence?: Record<string, DailyWarehouseStatus>;
  warehouseEvidenceError?: string | null;
  focusDataset?: { datasetId: string; signal: number } | null;
  initialDailyWarehouse: DailyWarehouseStatus | null;
  defaultExportRoot: string;
  onCatalogLoaded: (wc: WarehouseCatalog) => void;
  onDailyStatusUpdated: (status: DailyWarehouseStatus) => void;
  onWarehouseStatusUpdated?: (datasetId: string, status: DailyWarehouseStatus) => void;
  onOpenDatasetDrawer: (
    datasetId: string,
    mode: DatasetMode,
    tab: "plan" | "coverage",
  ) => void;
  onOpenRawArchives: (entryId: string) => void;
  onOpenLogDock: () => void;
  onToast: (msg: string) => void;
}

const MAX_VISIBLE_REQUEST_PARTITIONS = 200;

interface WarehouseSelectionOwner {
  datasetId: string;
  epoch: number;
}

interface OwnedWarehouseStatus extends WarehouseSelectionOwner {
  status: DailyWarehouseStatus;
}

interface OwnedWarehouseSnapshot extends WarehouseSelectionOwner {
  snapshotId: string | null;
}

function hasWarehouseSnapshotOwnership(
  datasetId: string,
  selection: WarehouseSelectionOwner,
  loaded: OwnedWarehouseStatus | null,
  pinned: OwnedWarehouseSnapshot | null,
): boolean {
  return Boolean(
    selection.datasetId === datasetId &&
    loaded?.datasetId === datasetId &&
    loaded.epoch === selection.epoch &&
    loaded.status.state === "ready" &&
    (!loaded.status.dataset_id || loaded.status.dataset_id === datasetId) &&
    pinned?.datasetId === datasetId &&
    pinned.epoch === selection.epoch &&
    pinned.snapshotId,
  );
}

const GRAIN_FILTER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "", label: "全部形态" },
  { id: "date_cross_section", label: "截面行情/指标" },
  { id: "period_bar", label: "周期 K 线" },
  { id: "current_snapshot", label: "当前快照" },
  { id: "announcement_event", label: "公告事件" },
  { id: "financial_records", label: "财报/治理分区" },
  { id: "calendar_records", label: "交易日历分区" },
  { id: "partition_records", label: "请求分区明细" },
  { id: "date_records", label: "日期明细" },
  { id: "board_records", label: "板块明细" },
  { id: "aggregate_series", label: "市场汇总" },
];

function formatFieldDtype(field?: WarehouseCatalogField | null): {
  label: string;
  isInt64: boolean;
} {
  if (!field) return { label: "", isInt64: false };
  const arrow = (field.arrow_type || "").toLowerCase();
  const raw = (field.type || "").toLowerCase();
  if (arrow === "int64" || raw === "int") {
    return { label: "Int64", isInt64: true };
  }
  if (arrow === "double" || arrow === "float64" || raw === "float") {
    return { label: "Float64", isInt64: false };
  }
  if (arrow === "string" || raw === "str") {
    return { label: "string", isInt64: false };
  }
  return { label: field.arrow_type || field.type || "", isInt64: false };
}

export function DailyWarehouseView({
  catalog,
  datasets,
  warehouseCatalog,
  warehouseEvidence = {},
  warehouseEvidenceError = null,
  focusDataset,
  initialDailyWarehouse,
  defaultExportRoot,
  onCatalogLoaded,
  onDailyStatusUpdated,
  onWarehouseStatusUpdated,
  onOpenDatasetDrawer: openDatasetDrawer,
  onOpenRawArchives,
  onOpenLogDock,
  onToast,
}: DailyWarehouseViewProps) {
  const { params: localHash, replace: replaceLocalHash } = useViewLocalHash("warehouse", "wh_");
  const initialDsId = focusDataset?.datasetId || "daily";
  const initialCachedStatus =
    (initialDsId === "daily" ? initialDailyWarehouse : null) ??
    warehouseEvidence[initialDsId] ??
    null;
  const canSeedInitial = Boolean(initialCachedStatus);

  // Multi-dataset warehouse selector & 9-domain / 102-entry catalog browser state
  const [activeDatasetId, setActiveDatasetId] = useState<string>(initialDsId);
  const [inspectedRawOnlyEntry, setInspectedRawOnlyEntry] =
    useState<WarehouseCatalogEntry | null>(null);
  const [includeRawOnly, setIncludeRawOnly] = useState(false);
  const [warehouseStateFilter, setWarehouseStateFilter] = useState<
    "all" | "ready" | "pending_source" | "empty"
  >("all");
  const [domainFilter, setDomainFilter] = useState<string>("");
  const [grainFilter, setGrainFilter] = useState<string>("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(!warehouseCatalog);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Track which dataset_id `warehouse` actually belongs to so switching never leaks
  const [loadedWarehouse, setLoadedWarehouse] = useState<OwnedWarehouseStatus | null>(
    canSeedInitial && initialCachedStatus
      ? { datasetId: initialDsId, epoch: 0, status: initialCachedStatus }
      : null,
  );
  const loadedDatasetId = loadedWarehouse?.datasetId ?? null;
  const warehouse = loadedWarehouse?.status ?? null;
  const [statusLoading, setStatusLoading] = useState(!canSeedInitial);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Phase 2: Offline refresh state (NEVER auto-triggered)
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshBanner, setLastRefreshBanner] = useState<{
    changed: boolean;
    snapshotId: string | null;
    days: number;
    daysWithRows?: number;
    partitions: number;
    rows: number;
  } | null>(null);

  // Collapsible metadata & monthly partitions drawer
  const [showPartitions, setShowPartitions] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const onOpenDatasetDrawer: DailyWarehouseViewProps["onOpenDatasetDrawer"] = (...args) => {
    setMaintenanceOpen(false); setCatalogOpen(false); setSnapshotOpen(false);
    openDatasetDrawer(...args);
  };

  // Cross-month table reader state
  const [tsCodeInput, setTsCodeInput] = useState("");
  const [startDateInput, setStartDateInput] = useState("");
  const [endDateInput, setEndDateInput] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<{
    tsCode: string;
    startDate: string;
    endDate: string;
  }>({ tsCode: "", startDate: "", endDate: "" });
  const [rowOffset, setRowOffset] = useState(0);
  const [rowLimit, setRowLimit] = useState(50);
  const [pinnedSnapshot, setPinnedSnapshot] = useState<OwnedWarehouseSnapshot | null>(
    canSeedInitial
      ? { datasetId: initialDsId, epoch: 0, snapshotId: initialCachedStatus?.snapshot_id ?? null }
      : null,
  );
  const pinnedSnapshotId = pinnedSnapshot?.datasetId === activeDatasetId &&
    pinnedSnapshot.epoch === loadedWarehouse?.epoch
    ? pinnedSnapshot.snapshotId : null;
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(
    null,
  );

  const [rowsPage, setRowsPage] = useState<DailyWarehouseRowsPage | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [readerColumnQuery, setReaderColumnQuery] = useState("");
  const [inspectedRowIndex, setInspectedRowIndex] = useState<number | null>(null);

  // Sequential batch warehouse refresh state (strictly user-triggered)
  const batchCancelRef = useRef(false);
  const [batchRefreshState, setBatchRefreshState] = useState<{
    running: boolean;
    currentIdx: number;
    total: number;
    currentName: string;
    succeeded: number;
    unchanged: number;
    failed: Array<{ id: string; name: string; error: string }>;
  } | null>(null);

  // Multi-year field-projected bundle export panel state (slide-over drawer)
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [exportDestination, setExportDestination] = useState(defaultExportRoot);
  const [exportStartDate, setExportStartDate] = useState(
    canSeedInitial ? (initialCachedStatus?.first_date ?? "") : "",
  );
  const [exportEndDate, setExportEndDate] = useState(
    canSeedInitial ? (initialCachedStatus?.last_date ?? "") : "",
  );
  const [exportTsCodesText, setExportTsCodesText] = useState("");
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(
    () => new Set(DAILY_WAREHOUSE_DEFAULT_COLUMNS),
  );
  const [exportColumnQuery, setExportColumnQuery] = useState("");
  const [pickingDir, setPickingDir] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportFileLayout, setExportFileLayout] = useState<"partitioned" | "single" | "grouped">("partitioned");
  const [exportSortBy, setExportSortBy] = useState<WarehouseSortKey[]>([]);
  const [exportSplitBy, setExportSplitBy] = useState("");
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] =
    useState<DailyWarehouseExportResult | null>(null);

  const datasetEpochRef = useRef(0);
  const selectedDatasetRef = useRef<WarehouseSelectionOwner>({ datasetId: initialDsId, epoch: 0 });
  const statusAbortRef = useRef<AbortController | null>(null);
  const rowsAbortRef = useRef<AbortController | null>(null);
  const columnsInitKeyRef = useRef<string | null>(null);
  const dailyStatusUpdatedRef = useRef(onDailyStatusUpdated);
  dailyStatusUpdatedRef.current = onDailyStatusUpdated;
  const warehouseStatusUpdatedRef = useRef(onWarehouseStatusUpdated);
  warehouseStatusUpdatedRef.current = onWarehouseStatusUpdated;

  const loadCatalog = useCallback(
    (signal?: AbortSignal) => {
      setCatalogLoading(true);
      setCatalogError(null);
      collectorApi
        .getWarehouseCatalog(signal)
        .then((wc) => {
          if (!signal?.aborted) {
            setCatalogError(null);
            onCatalogLoaded(wc);
          }
        })
        .catch((err) => {
          if (!signal?.aborted) {
            setCatalogError(
              err instanceof Error
                ? err.message
                : "无法连接 /api/warehouse/catalog",
            );
          }
        })
        .finally(() => {
          if (!signal?.aborted) {
            setCatalogLoading(false);
          }
        });
    },
    [onCatalogLoaded],
  );

  // Fetch /api/warehouse/catalog if not yet loaded in App (no hardcoded 6-table fallback)
  useEffect(() => {
    if (warehouseCatalog) {
      setCatalogLoading(false);
      setCatalogError(null);
      return;
    }
    const ctrl = new AbortController();
    loadCatalog(ctrl.signal);
    return () => ctrl.abort();
  }, [warehouseCatalog, loadCatalog]);

  const effectiveCatalogEntries = useMemo<WarehouseCatalogEntry[]>(
    () => warehouseCatalog?.entries ?? [],
    [warehouseCatalog],
  );

  const catalogEntryMap = useMemo(() => {
    const map = new Map<string, NonNullable<Catalog["entries"]>[number]>();
    for (const e of catalog?.entries ?? []) {
      map.set(e.id, e);
    }
    return map;
  }, [catalog]);

  const datasetMap = useMemo(() => {
    const map = new Map<string, DatasetItem>();
    for (const ds of datasets) {
      map.set(ds.id, ds);
    }
    return map;
  }, [datasets]);

  const catalogGrouping = useMemo(
    () =>
      filterAndGroupWarehouseCatalog(effectiveCatalogEntries, {
        includeRawOnly,
        businessDomain: domainFilter,
        grain: includeRawOnly ? "" : grainFilter,
        search: catalogSearch,
      }),
    [
      effectiveCatalogEntries,
      includeRawOnly,
      domainFilter,
      grainFilter,
      catalogSearch,
    ],
  );

  const activeCatalogEntry = useMemo(
    () =>
      effectiveCatalogEntries.find(
        (e) =>
          e.dataset_id === activeDatasetId ||
          (e.warehouse_supported && e.api_name === activeDatasetId),
      ) ?? null,
    [effectiveCatalogEntries, activeDatasetId],
  );

  const activeDatasetItem = useMemo(
    () => datasetMap.get(activeDatasetId) ?? null,
    [datasetMap, activeDatasetId],
  );

  const activeTitle =
    warehouse?.name ||
    activeDatasetItem?.name ||
    activeCatalogEntry?.name ||
    activeDatasetId;
  const activeApiName =
    activeCatalogEntry?.api_name || activeDatasetId;
  const activeEntryId =
    warehouse?.entry_id ||
    activeCatalogEntry?.entry_id ||
    activeDatasetItem?.entry_id ||
    "";

  const activeRawCatalogEntry = useMemo(
    () => (activeEntryId ? (catalogEntryMap.get(activeEntryId) ?? null) : null),
    [catalogEntryMap, activeEntryId],
  );

  const activeAccessBadge = useMemo(
    () =>
      activeRawCatalogEntry?.access
        ? accountAccessBadge(activeRawCatalogEntry.access)
        : null,
    [activeRawCatalogEntry],
  );

  const activeProfile = useMemo(
    () =>
      resolveWarehouseProfile(
        {
          dataset_id: activeDatasetId,
          storage_layout:
            (loadedDatasetId === activeDatasetId
              ? warehouse?.storage_layout
              : undefined) ?? activeCatalogEntry?.storage_layout,
          supports_variants:
            (loadedDatasetId === activeDatasetId &&
            typeof warehouse?.supports_variants === "boolean"
              ? warehouse.supports_variants
              : undefined) ?? activeCatalogEntry?.supports_variants,
          date_count_kind:
            loadedDatasetId === activeDatasetId
              ? warehouse?.date_count_kind
              : undefined,
          date_semantics:
            (loadedDatasetId === activeDatasetId
              ? warehouse?.date_semantics
              : undefined) ?? activeCatalogEntry?.date_semantics,
          atomic_full_run:
            (loadedDatasetId === activeDatasetId
              ? warehouse?.atomic_full_run
              : undefined) ?? activeCatalogEntry?.atomic_full_run,
          semantic_note:
            (loadedDatasetId === activeDatasetId
              ? warehouse?.semantic_note
              : undefined) ?? activeCatalogEntry?.semantic_note,
          grain:
            (loadedDatasetId === activeDatasetId
              ? warehouse?.grain
              : undefined) ?? activeCatalogEntry?.grain,
          code_filter:
            (loadedDatasetId === activeDatasetId
              ? warehouse?.code_filter
              : undefined) ?? activeCatalogEntry?.code_filter,
          code_column:
            (loadedDatasetId === activeDatasetId
              ? warehouse?.code_column
              : undefined) ?? activeCatalogEntry?.code_column,
          calendar_basis:
            loadedDatasetId === activeDatasetId &&
            warehouse?.calendar_basis !== undefined
              ? warehouse.calendar_basis
              : activeCatalogEntry?.calendar_basis,
          date_column:
            loadedDatasetId === activeDatasetId &&
            warehouse?.date_column !== undefined
              ? warehouse.date_column
              : activeCatalogEntry?.date_column,
          key_columns:
            (loadedDatasetId === activeDatasetId &&
            warehouse?.key_columns &&
            warehouse.key_columns.length > 0
              ? warehouse.key_columns
              : activeCatalogEntry?.key_columns) ?? undefined,
          preserves_duplicate_rows:
            loadedDatasetId === activeDatasetId &&
            typeof warehouse?.preserves_duplicate_rows === "boolean"
              ? warehouse.preserves_duplicate_rows
              : activeCatalogEntry?.preserves_duplicate_rows,
        },
        activeDatasetId,
      ),
    [activeDatasetId, loadedDatasetId, warehouse, activeCatalogEntry],
  );

  const statusVariants = useMemo(
    () =>
      loadedDatasetId === activeDatasetId ? (warehouse?.variants ?? []) : [],
    [loadedDatasetId, activeDatasetId, warehouse?.variants],
  );

  const effectiveVariantId = useMemo(
    () =>
      resolveSelectedVariantId(
        selectedVariantId,
        statusVariants,
        activeProfile.supportsVariants,
      ),
    [selectedVariantId, statusVariants, activeProfile.supportsVariants],
  );

  const activeVariantObj = useMemo(
    () =>
      effectiveVariantId
        ? (statusVariants.find((v) => v.id === effectiveVariantId) ?? null)
        : null,
    [effectiveVariantId, statusVariants],
  );

  const requiresVariantChoice =
    activeProfile.supportsVariants &&
    statusVariants.length > 1 &&
    !effectiveVariantId;

  const mandatoryKeyColumns = activeProfile.keyColumns;

  const fieldMetaMap = useMemo(() => {
    const map = new Map<string, WarehouseCatalogField>();
    for (const f of activeCatalogEntry?.fields ?? []) {
      map.set(f.name, f);
    }
    if (map.size === 0 && activeRawCatalogEntry) {
      for (const f of activeRawCatalogEntry.fields ?? []) {
        map.set(f.name, {
          name: f.name,
          type: f.type,
          arrow_type: null,
          description: f.description,
        });
      }
    }
    return map;
  }, [activeCatalogEntry, activeRawCatalogEntry]);

  const rawFieldMap = useMemo(() => {
    const map = new Map<string, CatalogField>();
    for (const f of activeRawCatalogEntry?.fields ?? []) {
      map.set(f.name, f);
    }
    return map;
  }, [activeRawCatalogEntry]);

  const getFieldLabel = useCallback(
    (col: string) =>
      resolveWarehouseFieldLabel(
        col,
        fieldMetaMap.get(col) ?? null,
        rawFieldMap.get(col) ?? null,
        activeDatasetId,
      ),
    [fieldMetaMap, rawFieldMap, activeDatasetId],
  );

  // Resolve canonical columns dynamically from warehouse status -> warehouse catalog entry -> catalog
  const availableColumns = useMemo(() => {
    if (
      loadedDatasetId === activeDatasetId &&
      warehouse?.columns &&
      warehouse.columns.length > 0
    ) {
      return warehouse.columns;
    }
    if (activeCatalogEntry?.fields && activeCatalogEntry.fields.length > 0) {
      return activeCatalogEntry.fields.map((f) => f.name);
    }
    if (activeEntryId) {
      const rawEntry = catalog?.entries.find((e) => e.id === activeEntryId);
      if (rawEntry && rawEntry.fields.length > 0) {
        return rawEntry.fields.map((f) => f.name);
      }
    }
    return activeDatasetId === "daily"
      ? DAILY_WAREHOUSE_DEFAULT_COLUMNS
      : mandatoryKeyColumns;
  }, [
    loadedDatasetId,
    activeDatasetId,
    warehouse?.columns,
    activeCatalogEntry,
    activeEntryId,
    catalog,
    mandatoryKeyColumns,
  ]);

  // Initialize selectedColumns per dataset whenever dataset or its schema resolves
  useEffect(() => {
    const initKey = `${activeDatasetId}:${availableColumns.join(",")}`;
    if (
      availableColumns.length > 0 &&
      columnsInitKeyRef.current !== initKey
    ) {
      setSelectedColumns(new Set(availableColumns));
      columnsInitKeyRef.current = initKey;
    }
  }, [activeDatasetId, availableColumns]);

  useEffect(() => {
    if (!exportDestination && defaultExportRoot) {
      setExportDestination(defaultExportRoot);
    }
  }, [defaultExportRoot, exportDestination]);

  // Strict dataset switch: immediately clear old snapshot, rows, filters, and in-flight requests
  const selectSupportedDataset = useCallback(
    (nextDatasetId: string, preserveLocalFilters = false) => {
      setInspectedRawOnlyEntry(null);
      setCatalogOpen(false); setSnapshotOpen(false); setMaintenanceOpen(false); setExportPanelOpen(false);
      if (!nextDatasetId || nextDatasetId === selectedDatasetRef.current.datasetId) {
        return;
      }
      datasetEpochRef.current += 1;
      selectedDatasetRef.current = { datasetId: nextDatasetId, epoch: datasetEpochRef.current };
      statusAbortRef.current?.abort();
      rowsAbortRef.current?.abort();
      columnsInitKeyRef.current = null;

      setActiveDatasetId(nextDatasetId);
      setLoadedWarehouse(null);
      setStatusLoading(true);
      setStatusError(null);
      setRefreshing(false);
      setRefreshError(null);
      setLastRefreshBanner(null);
      setPinnedSnapshot(null);
      setSelectedVariantId(null);
      setRowsPage(null);
      setRowsLoading(false);
      setRowsError(null);
      setReaderColumnQuery("");
      setInspectedRowIndex(null);
      setRowOffset(0);
      setTsCodeInput("");
      setStartDateInput("");
      setEndDateInput("");
      setAppliedFilters({ tsCode: "", startDate: "", endDate: "" });
      setExportStartDate("");
      setExportEndDate("");
      setExportTsCodesText("");
      setExportColumnQuery("");
      setExportError(null);
      setExportResult(null);
      setExportSortBy([]);
      setExportSplitBy("");
      if (!preserveLocalFilters) {
        const nextEntry = effectiveCatalogEntries.find(
          (entry) => entry.dataset_id === nextDatasetId || entry.api_name === nextDatasetId,
        );
        patchLocationState({
          dataset: nextDatasetId,
          entry: nextEntry?.entry_id || datasetMap.get(nextDatasetId)?.entry_id || null,
          run: null,
          slice: null,
          wh_start: null,
          wh_end: null,
          wh_code: null,
          wh_variant: null,
        }, "push");
      }
    },
    [activeDatasetId, effectiveCatalogEntries, datasetMap],
  );

  // Respond to external dataset jump from DatasetsView
  const lastFocusSignalRef = useRef<number>(focusDataset?.signal ?? 0);
  useEffect(() => {
    if (
      focusDataset &&
      focusDataset.signal !== lastFocusSignalRef.current &&
      focusDataset.datasetId
    ) {
      lastFocusSignalRef.current = focusDataset.signal;
      selectSupportedDataset(focusDataset.datasetId, true);
    }
  }, [focusDataset, selectSupportedDataset]);

  const loadWarehouseStatus = useCallback(
    async (targetDatasetId: string, resetPinned = false) => {
      if (selectedDatasetRef.current.datasetId !== targetDatasetId) return;
      const epoch = selectedDatasetRef.current.epoch;
      statusAbortRef.current?.abort();
      const ctrl = new AbortController();
      statusAbortRef.current = ctrl;

      setStatusLoading(true);
      setStatusError(null);
      try {
        const st = await collectorApi.getWarehouse(targetDatasetId, ctrl.signal);
        if (
          ctrl.signal.aborted || datasetEpochRef.current !== epoch ||
          selectedDatasetRef.current.datasetId !== targetDatasetId
        ) {
          return;
        }
        if (st.dataset_id && st.dataset_id !== targetDatasetId) {
          throw new Error("仓库状态返回的数据集与当前选择不一致");
        }
        setLoadedWarehouse({ datasetId: targetDatasetId, epoch, status: st });
        warehouseStatusUpdatedRef.current?.(targetDatasetId, st);
        if (targetDatasetId === "daily") {
          dailyStatusUpdatedRef.current(st);
        }
        setPinnedSnapshot((prev) => ({
          datasetId: targetDatasetId,
          epoch,
          snapshotId: resolvePinnedSnapshotId(
            prev?.datasetId === targetDatasetId && prev.epoch === epoch ? prev.snapshotId : null,
            st.snapshot_id,
            resetPinned,
          ),
        }));
        setSelectedVariantId((prev) => {
          const next = resolveSelectedVariantId(
            prev,
            st.variants ?? [],
            Boolean(st.supports_variants),
          );
          if (prev && prev !== next) {
            setRowsPage(null);
            setRowOffset(0);
          }
          return next;
        });
        if (st.grain !== "current_snapshot" && st.date_column !== null) {
          setExportStartDate((prev) => prev || st.first_date || "");
          setExportEndDate((prev) => prev || st.last_date || "");
        } else {
          setExportStartDate("");
          setExportEndDate("");
        }
      } catch (err) {
        if (ctrl.signal.aborted || datasetEpochRef.current !== epoch) {
          return;
        }
        // Never fallback to daily on 409 or error; clear stale dataset data
        setLoadedWarehouse(null);
        setPinnedSnapshot(null);
        setSelectedVariantId(null);
        setRowsPage(null);
        setStatusError(
          err instanceof Error
            ? err.message
            : `读取「${targetDatasetId}」本地仓库状态失败`,
        );
      } finally {
        if (!ctrl.signal.aborted && datasetEpochRef.current === epoch) {
          setStatusLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (inspectedRawOnlyEntry) return;
    void loadWarehouseStatus(activeDatasetId, false);
  }, [activeDatasetId, inspectedRawOnlyEntry, loadWarehouseStatus]);

  // Query rows when selected dataset warehouse is ready and matches activeDatasetId
  const fetchRows = useCallback(
    async (opts: {
      datasetId: string;
      profile: WarehouseProfile;
      epoch: number;
      metadataOwner: OwnedWarehouseStatus | null;
      snapshotOwner: OwnedWarehouseSnapshot | null;
      snapshotId: string | null;
      variantId: string | null;
      startDate: string;
      endDate: string;
      tsCode: string;
      offset: number;
      limit: number;
    }) => {
      if (
        opts.epoch !== selectedDatasetRef.current.epoch ||
        !hasWarehouseSnapshotOwnership(
          opts.datasetId, selectedDatasetRef.current, opts.metadataOwner, opts.snapshotOwner,
        ) ||
        opts.snapshotId !== opts.snapshotOwner?.snapshotId
      ) return;
      rowsAbortRef.current?.abort();
      const ctrl = new AbortController();
      rowsAbortRef.current = ctrl;

      setRowsLoading(true);
      setRowsError(null);
      try {
        const query = buildWarehouseRowsQuery(opts.profile, {
          snapshotId: opts.snapshotId,
          variantId: opts.variantId,
          startDate: opts.startDate,
          endDate: opts.endDate,
          tsCode: opts.tsCode,
          offset: opts.offset,
          limit: opts.limit,
        });
        const res = await collectorApi.getWarehouseRows(
          opts.datasetId,
          query,
          ctrl.signal,
        );
        if (ctrl.signal.aborted || datasetEpochRef.current !== opts.epoch) {
          return;
        }
        setRowsPage(res);
      } catch (err) {
        if (ctrl.signal.aborted || datasetEpochRef.current !== opts.epoch) {
          return;
        }
        setRowsError(
          err instanceof Error ? err.message : "查询本地仓库数据行失败",
        );
      } finally {
        if (!ctrl.signal.aborted && datasetEpochRef.current === opts.epoch) {
          setRowsLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (
      inspectedRawOnlyEntry ||
      !warehouse ||
      loadedDatasetId !== activeDatasetId ||
      warehouse.state !== "ready" ||
      !hasWarehouseSnapshotOwnership(
        activeDatasetId, selectedDatasetRef.current, loadedWarehouse, pinnedSnapshot,
      )
    ) {
      return;
    }
    if (
      activeProfile.supportsVariants &&
      (!effectiveVariantId || statusVariants.length === 0)
    ) {
      rowsAbortRef.current?.abort();
      setRowsLoading(false);
      setRowsPage(null);
      return;
    }
    void fetchRows({
      datasetId: activeDatasetId,
      profile: activeProfile,
      epoch: datasetEpochRef.current,
      metadataOwner: loadedWarehouse,
      snapshotOwner: pinnedSnapshot,
      snapshotId: pinnedSnapshotId,
      variantId: effectiveVariantId,
      startDate: appliedFilters.startDate,
      endDate: appliedFilters.endDate,
      tsCode: appliedFilters.tsCode,
      offset: rowOffset,
      limit: rowLimit,
    });
  }, [
    inspectedRawOnlyEntry,
    activeDatasetId,
    activeProfile,
    loadedDatasetId,
    loadedWarehouse,
    warehouse?.state,
    warehouse?.snapshot_id,
    pinnedSnapshotId,
    pinnedSnapshot,
    effectiveVariantId,
    statusVariants.length,
    appliedFilters.startDate,
    appliedFilters.endDate,
    appliedFilters.tsCode,
    rowOffset,
    rowLimit,
    fetchRows,
  ]);

  const handleManualRefreshWarehouse = async () => {
    const targetDs = activeDatasetId;
    if (selectedDatasetRef.current.datasetId !== targetDs) return;
    const epoch = datasetEpochRef.current;
    setRefreshing(true);
    setRefreshError(null);
    setLastRefreshBanner(null);
    try {
      const res = await collectorApi.refreshWarehouse(targetDs);
      if (datasetEpochRef.current !== epoch) return;
      if (res.dataset_id && res.dataset_id !== targetDs) {
        throw new Error("仓库整理返回的数据集与当前选择不一致");
      }
      const resProfile = resolveWarehouseProfile(res, targetDs);
      setLoadedWarehouse({ datasetId: targetDs, epoch, status: res });
      warehouseStatusUpdatedRef.current?.(targetDs, res);
      if (targetDs === "daily") {
        onDailyStatusUpdated(res);
      }
      setLastRefreshBanner({
        changed: res.changed,
        snapshotId: res.snapshot_id,
        days: res.days,
        daysWithRows: res.days_with_rows,
        partitions: res.partitions ?? 0,
        rows: res.rows,
      });

      if (res.state === "ready" && res.snapshot_id) {
        setPinnedSnapshot({ datasetId: targetDs, epoch, snapshotId: res.snapshot_id });
        setSelectedVariantId((prev) => {
          const next = resolveSelectedVariantId(
            prev,
            res.variants ?? [],
            Boolean(res.supports_variants),
          );
          if (prev && prev !== next) {
            setRowsPage(null);
          }
          return next;
        });
        setRowOffset(0);
        if (resProfile.supportsDateFilter) {
          setExportStartDate((prev) => prev || res.first_date || "");
          setExportEndDate(res.last_date || "");
        } else {
          setExportStartDate("");
          setExportEndDate("");
        }
      }

      if (res.changed) {
        if (resProfile.isCurrentSnapshot) {
          onToast(
            `「${activeTitle}」仓库已发布新快照（${formatNumber(res.partitions ?? 0)} 个来源切片 · ${formatNumber(res.rows)} 行）`,
          );
        } else if (resProfile.isRequestPartitions) {
          onToast(
            `「${activeTitle}」仓库已发布新快照（${formatNumber(res.partitions ?? 0)} 个请求分区 · 记录含 ${formatNumber(res.days)} 个不同日期 · ${formatNumber(res.rows)} 行）`,
          );
        } else if (resProfile.isPeriodBar) {
          onToast(
            `「${activeTitle}」仓库已发布新快照（已检开市日 ${formatNumber(res.days)}${typeof res.days_with_rows === "number" ? ` · 有记录周期日 ${formatNumber(res.days_with_rows)}` : ""} · ${formatNumber(res.rows)} 行）`,
          );
        } else {
          onToast(
            `「${activeTitle}」仓库已发布新快照（${formatNumber(res.days)} 个${resProfile.dayUnitLabel} · ${formatNumber(res.rows)} 行）`,
          );
        }
      } else {
        onToast(
          `校验完成：「${activeTitle}」本地归档无新增或变更内容，沿用当前快照`,
        );
      }
    } catch (err) {
      if (datasetEpochRef.current !== epoch) return;
      // Keep existing ready snapshot & rowsPage intact on 409 or corrupt-new-slice failure
      setRefreshError(
        err instanceof Error ? err.message : "离线整理本地归档失败",
      );
    } finally {
      if (datasetEpochRef.current === epoch) {
        setRefreshing(false);
      }
    }
  };

  const applyReaderQuery = (
    nextStartRaw: string,
    nextEndRaw: string,
    nextTsCodeRaw: string,
    switchLatestSnapshot = true,
  ) => {
    try {
      let normStart = "";
      let normEnd = "";
      if (activeProfile.supportsDateFilter) {
        const startLabel =
          activeProfile.startDateFieldLabel || "起始日期";
        const endLabel = activeProfile.endDateFieldLabel || "结束日期";
        const compactStart = nextStartRaw.trim() ? normalizeCompactDate(nextStartRaw, startLabel) : "";
        const compactEnd = nextEndRaw.trim() ? normalizeCompactDate(nextEndRaw, endLabel) : "";
        normStart = compactStart;
        normEnd = compactEnd;
        if (normStart && normEnd && normStart > normEnd) {
          setRowsError("起始日期不能晚于结束日期");
          return;
        }
      }
      const cleanCode = activeProfile.supportsCodeFilter
        ? normalizeWarehouseTsCode(nextTsCodeRaw, {
            codeFilter: activeProfile.codeFilter,
            codeColumn: activeProfile.codeColumn,
            allowHistoricalTSh: activeProfile.allowsHistoricalTSh,
            datasetId: activeDatasetId,
          })
        : "";
      setRowsError(null);
      setStartDateInput(normStart);
      setEndDateInput(normEnd);
      setTsCodeInput(cleanCode);
      if (
        switchLatestSnapshot && warehouse?.snapshot_id &&
        hasWarehouseSnapshotOwnership(activeDatasetId, selectedDatasetRef.current, loadedWarehouse, pinnedSnapshot)
      ) {
        setPinnedSnapshot({
          datasetId: activeDatasetId,
          epoch: selectedDatasetRef.current.epoch,
          snapshotId: warehouse.snapshot_id,
        });
      }
      setRowOffset(0);
      setAppliedFilters({
        startDate: normStart,
        endDate: normEnd,
        tsCode: cleanCode,
      });
      replaceLocalHash({ start: normStart, end: normEnd, code: cleanCode });
    } catch (err) {
      setRowsError(err instanceof Error ? err.message : "查询筛选条件格式错误");
    }
  };

  const handleReaderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    applyReaderQuery(startDateInput, endDateInput, tsCodeInput, true);
  };

  const handleQuickRange = (
    kind: AnchorQuickRangeKind | "20d" | "250d",
  ) => {
    if (
      !warehouse ||
      warehouse.state !== "ready" ||
      !activeProfile.supportsDateFilter
    ) {
      return;
    }
    if (kind === "all") {
      applyReaderQuery("", "", tsCodeInput, true);
      return;
    }
    const dates = warehouse.dates || [];
    const last = warehouse.last_date || dates[dates.length - 1] || "";
    if (!last) return;
    if (kind === "20d" || kind === "250d") {
      const count = kind === "20d" ? 20 : 250;
      const start =
        dates.length > 0
          ? dates[Math.max(0, dates.length - count)]
          : warehouse.first_date || last;
      applyReaderQuery(start, last, tsCodeInput, true);
      return;
    }
    const range = computeAnchorQuickRange(
      last,
      kind,
      warehouse.first_date || "",
    );
    applyReaderQuery(range.startDate, range.endDate, tsCodeInput, true);
  };

  const handleSelectMonthRange = (month: string) => {
    if (
      !activeProfile.supportsDateFilter ||
      activeProfile.isCurrentSnapshot ||
      activeProfile.isRequestPartitions ||
      !/^\d{6}$/.test(month)
    ) {
      return;
    }
    const monthDates = (warehouse?.dates ?? []).filter((d) =>
      d.startsWith(month),
    );
    const start = monthDates[0] ?? `${month}01`;
    const end = monthDates[monthDates.length - 1] ?? `${month}31`;
    applyReaderQuery(start, end, tsCodeInput, true);
  };

  const handleSelectVariant = (nextVariantId: string) => {
    if (!nextVariantId || nextVariantId === effectiveVariantId) {
      return;
    }
    rowsAbortRef.current?.abort();
    setSelectedVariantId(nextVariantId);
    setRowsPage(null);
    setInspectedRowIndex(null);
    setRowOffset(0);
    setRowsError(null);
    setExportResult(null);
    setExportError(null);
    replaceLocalHash({ variant: nextVariantId });
  };

  const toggleExportColumn = (col: string) => {
    if (mandatoryKeyColumns.includes(col)) return;
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const handlePickExportDir = async () => {
    setPickingDir(true);
    setExportError(null);
    try {
      const picked = await collectorApi.selectDirectory(
        exportDestination || null,
      );
      if (!picked.cancelled && picked.path) {
        setExportDestination(picked.path);
      }
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "无法打开目录选择器",
      );
    } finally {
      setPickingDir(false);
    }
  };

  const handleSyncReaderToExport = () => {
    if (activeProfile.supportsDateFilter) {
      setExportStartDate(
        appliedFilters.startDate || warehouse?.first_date || "",
      );
      setExportEndDate(appliedFilters.endDate || warehouse?.last_date || "");
    } else {
      setExportStartDate("");
      setExportEndDate("");
    }
    if (activeProfile.supportsCodeFilter && appliedFilters.tsCode) {
      setExportTsCodesText(appliedFilters.tsCode);
    } else if (!activeProfile.supportsCodeFilter) {
      setExportTsCodesText("");
    }
  };

  const handleExportBundle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !warehouse ||
      loadedDatasetId !== activeDatasetId ||
      warehouse.state !== "ready" ||
      !hasWarehouseSnapshotOwnership(
        activeDatasetId, selectedDatasetRef.current, loadedWarehouse, pinnedSnapshot,
      )
    ) {
      setExportError(`当前「${activeTitle}」本地仓库尚未发布可用快照`);
      return;
    }
    setExportError(null);
    setExportResult(null);

    const targetSnapshot = pinnedSnapshotId;
    let payload: ReturnType<typeof buildWarehouseExportPayload>;
    try {
      payload = buildWarehouseExportPayload(activeProfile, {
        destination: exportDestination,
        startDate: exportStartDate,
        endDate: exportEndDate,
        tsCodesText: exportTsCodesText,
        allColumns: availableColumns,
        selectedColumns,
        snapshotId: targetSnapshot,
        variantId: effectiveVariantId,
        variantCount: statusVariants.length,
      });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "导出参数格式错误");
      return;
    }

    const epoch = datasetEpochRef.current;

    setExportBusy(true);
    try {
      if (exportSortBy.some(key => !selectedColumns.has(key.column))) {
        throw new Error("排序字段须包含在导出字段中，请重新选择排序字段或勾选对应列");
      }
      if (exportFileLayout === "grouped" && (
        !availableColumns.includes(exportSplitBy) ||
        (!selectedColumns.has(exportSplitBy) && !mandatoryKeyColumns.includes(exportSplitBy))
      )) {
        throw new Error("请选择一个已勾选的导出字段作为拆分维度");
      }
      const res = await collectorApi.exportWarehouse(activeDatasetId, {
        ...payload, file_layout: exportFileLayout, sort_by: exportSortBy,
        ...(exportFileLayout === "grouped" ? { split_by: exportSplitBy } : {}),
      });
      if (datasetEpochRef.current !== epoch) return;
      setExportResult(res);
      onToast(`已生成「${activeTitle}」导出 Bundle（${formatNumber(res.files)} 份 Parquet · ${formatNumber(res.rows)} 行）`);
    } catch (err) {
      if (datasetEpochRef.current !== epoch) return;
      setExportError(
        err instanceof Error ? err.message : "导出本地仓库 Bundle 失败",
      );
    } finally {
      if (datasetEpochRef.current === epoch) {
        setExportBusy(false);
      }
    }
  };

  const activeDatasetPres = useMemo(
    () => (activeDatasetItem ? datasetPresentation(activeDatasetItem) : null),
    [activeDatasetItem],
  );

  const columnPresets = useMemo(
    () => WAREHOUSE_COLUMN_PRESETS[activeDatasetId] ?? [],
    [activeDatasetId],
  );

  const rawOnlyDatasetItem = useMemo(() => {
    if (!inspectedRawOnlyEntry) return null;
    if (inspectedRawOnlyEntry.dataset_id) {
      return datasetMap.get(inspectedRawOnlyEntry.dataset_id) ?? null;
    }
    return (
      datasets.find((d) => d.entry_id === inspectedRawOnlyEntry.entry_id) ??
      null
    );
  }, [inspectedRawOnlyEntry, datasetMap, datasets]);

  const isWarehouseReady =
    loadedDatasetId === activeDatasetId && warehouse?.state === "ready";
  const hasNewerSnapshot = Boolean(
    isWarehouseReady &&
      pinnedSnapshotId &&
      warehouse?.snapshot_id &&
      pinnedSnapshotId !== warehouse.snapshot_id,
  );
  const isRefreshDisabled =
    refreshing ||
    Boolean(warehouse?.busy) ||
    Boolean(warehouse?.collection_active);

  const resolveEntryWarehouseStatus = useCallback(
    (targetDsId: string): DailyWarehouseStatus | null =>
      (loadedDatasetId === targetDsId ? warehouse : null) ??
      warehouseEvidence[targetDsId] ??
      null,
    [loadedDatasetId, warehouse, warehouseEvidence],
  );

  const classifyEntryWarehouseState = useCallback(
    (entry: WarehouseCatalogEntry): "ready" | "pending_source" | "empty" => {
      const targetDsId = entry.dataset_id || entry.api_name;
      const wh = resolveEntryWarehouseStatus(targetDsId);
      const dsItem = datasetMap.get(targetDsId);
      if (wh?.state === "ready") {
        return "ready";
      }
      const hasSource =
        (wh?.available_source_days ?? 0) > 0 ||
        (wh?.available_source_partitions ?? 0) > 0 ||
        (dsItem?.covered_partitions ?? 0) > 0;
      return hasSource ? "pending_source" : "empty";
    },
    [resolveEntryWarehouseStatus, datasetMap],
  );

  const supportedStateCounts = useMemo(() => {
    let ready = 0;
    let pendingSource = 0;
    let refreshNeeded = 0;
    let empty = 0;
    for (const entry of effectiveCatalogEntries) {
      if (!entry.warehouse_supported && entry.warehouse_status !== "supported") {
        continue;
      }
      const targetDsId = entry.dataset_id || entry.api_name;
      const wh = resolveEntryWarehouseStatus(targetDsId);
      const st = classifyEntryWarehouseState(entry);
      if (st === "ready") {
        ready += 1;
        if (wh?.refresh_needed) refreshNeeded += 1;
      } else if (st === "pending_source") {
        pendingSource += 1;
      } else {
        empty += 1;
      }
    }
    return { ready, pendingSource, refreshNeeded, empty };
  }, [effectiveCatalogEntries, resolveEntryWarehouseStatus, classifyEntryWarehouseState]);

  const refreshableEntries = useMemo(() => {
    return effectiveCatalogEntries.filter((entry) => {
      if (!entry.warehouse_supported && entry.warehouse_status !== "supported") {
        return false;
      }
      const targetDsId = entry.dataset_id || entry.api_name;
      const wh = resolveEntryWarehouseStatus(targetDsId);
      if (wh?.busy || wh?.collection_active) return false;
      const st = classifyEntryWarehouseState(entry);
      return st === "pending_source" || Boolean(wh?.refresh_needed);
    });
  }, [effectiveCatalogEntries, resolveEntryWarehouseStatus, classifyEntryWarehouseState]);

  const handleRunBatchRefresh = async () => {
    if (batchRefreshState?.running || refreshableEntries.length === 0) return;
    const queue = refreshableEntries.map((entry) => ({
      id: entry.dataset_id || entry.api_name,
      name: entry.name || entry.api_name,
    }));
    batchCancelRef.current = false;
    setBatchRefreshState({
      running: true,
      currentIdx: 0,
      total: queue.length,
      currentName: queue[0]?.name || "",
      succeeded: 0,
      unchanged: 0,
      failed: [],
    });

    let succeeded = 0;
    let unchanged = 0;
    const failed: Array<{ id: string; name: string; error: string }> = [];

    for (let idx = 0; idx < queue.length; idx += 1) {
      if (batchCancelRef.current) break;
      const item = queue[idx]!;
      setBatchRefreshState({
        running: true,
        currentIdx: idx + 1,
        total: queue.length,
        currentName: `${item.name} (${item.id})`,
        succeeded,
        unchanged,
        failed: [...failed],
      });

      try {
        const res = await collectorApi.refreshWarehouse(item.id);
        warehouseStatusUpdatedRef.current?.(item.id, res);
        if (item.id === "daily") {
          onDailyStatusUpdated(res);
        }
        if (selectedDatasetRef.current.datasetId === item.id) {
          const curEpoch = selectedDatasetRef.current.epoch;
          setLoadedWarehouse({ datasetId: item.id, epoch: curEpoch, status: res });
          if (res.state === "ready" && res.snapshot_id) {
            setPinnedSnapshot({
              datasetId: item.id,
              epoch: curEpoch,
              snapshotId: res.snapshot_id,
            });
          }
        }
        if (res.changed) succeeded += 1;
        else unchanged += 1;
      } catch (err) {
        failed.push({
          id: item.id,
          name: item.name,
          error: err instanceof Error ? err.message : "整理失败",
        });
      }
    }

    setBatchRefreshState({
      running: false,
      currentIdx: queue.length,
      total: queue.length,
      currentName: "",
      succeeded,
      unchanged,
      failed,
    });
    onToast(
      `批量整理结束：发布更新 ${succeeded} 张 · 无变更 ${unchanged} 张${failed.length > 0 ? ` · 跳过/失败 ${failed.length} 张` : ""}`,
    );
  };

  const readerColumnsMeta = useMemo<RowDetailColumnMeta[]>(() => {
    const cols = rowsPage?.columns ?? [];
    const keySet = new Set(mandatoryKeyColumns);
    return cols.map((col) => {
      const dtype = formatFieldDtype(fieldMetaMap.get(col));
      return {
        name: col,
        label: getFieldLabel(col),
        type: dtype.label || undefined,
        isInt64: dtype.isInt64,
        isKey: keySet.has(col),
      };
    });
  }, [rowsPage?.columns, mandatoryKeyColumns, fieldMetaMap, getFieldLabel]);

  const visibleReaderColumnResult = useMemo(
    () =>
      filterVisibleTableColumns(readerColumnsMeta, readerColumnQuery, {
        pinnedNames: mandatoryKeyColumns,
        keepFirst: true,
      }),
    [readerColumnsMeta, readerColumnQuery, mandatoryKeyColumns],
  );

  const orderedSupportedVisible = useMemo(() => {
    const supportedOrder = warehouseCatalog?.supported_datasets ?? [];
    const orderIdx = (id: string | null, apiName: string) => {
      const idx = supportedOrder.indexOf(id || apiName);
      return idx === -1 ? 999 : idx;
    };
    const filtered = catalogGrouping.visibleEntries.filter((entry) => {
      if (warehouseStateFilter === "all") return true;
      const targetDsId = entry.dataset_id || entry.api_name;
      const wh = resolveEntryWarehouseStatus(targetDsId);
      const st = classifyEntryWarehouseState(entry);
      if (warehouseStateFilter === "ready") return st === "ready";
      if (warehouseStateFilter === "pending_source") {
        return st === "pending_source" || Boolean(wh?.refresh_needed);
      }
      return st === "empty";
    });
    return filtered.sort(
      (a, b) =>
        orderIdx(a.dataset_id, a.api_name) - orderIdx(b.dataset_id, b.api_name),
    );
  }, [
    catalogGrouping.visibleEntries,
    warehouseCatalog,
    warehouseStateFilter,
    resolveEntryWarehouseStatus,
    classifyEntryWarehouseState,
  ]);

  const filteredExportColumns = useMemo(() => {
    const q = exportColumnQuery.trim().toLowerCase();
    if (!q) return availableColumns;
    return availableColumns.filter((col) => {
      const label = getFieldLabel(col).toLowerCase();
      return col.toLowerCase().includes(q) || label.includes(q);
    });
  }, [availableColumns, exportColumnQuery, getFieldLabel]);

  const effectiveSourceRawRoot =
    (loadedDatasetId === activeDatasetId && warehouse?.source_raw_root) ||
    activeDatasetItem?.settings?.raw_root ||
    "";

  useEffect(() => {
    if (loadedDatasetId !== activeDatasetId || !warehouse) return;
    const currentHash = new URLSearchParams(window.location.hash.slice(1));
    try {
      const startDate = activeProfile.supportsDateFilter && currentHash.get("wh_start")
        ? normalizeCompactDate(currentHash.get("wh_start"), "起始日期") : "";
      const endDate = activeProfile.supportsDateFilter && currentHash.get("wh_end")
        ? normalizeCompactDate(currentHash.get("wh_end"), "结束日期") : "";
      if (startDate && endDate && startDate > endDate) throw new Error("起始日期不能晚于结束日期");
      const tsCode = activeProfile.supportsCodeFilter
        ? normalizeWarehouseTsCode(currentHash.get("wh_code") || "", {
            codeFilter: activeProfile.codeFilter,
            codeColumn: activeProfile.codeColumn,
            allowHistoricalTSh: activeProfile.allowsHistoricalTSh,
            datasetId: activeDatasetId,
          }) : "";
      setStartDateInput(startDate);
      setEndDateInput(endDate);
      setTsCodeInput(tsCode);
      setAppliedFilters({ startDate, endDate, tsCode });
      const nextVariant = resolveSelectedVariantId(
        currentHash.get("wh_variant"), warehouse.variants ?? [], Boolean(warehouse.supports_variants),
      );
      if (nextVariant !== effectiveVariantId) {
        setRowsPage(null);
        setExportResult(null);
      }
      setSelectedVariantId(nextVariant);
      setRowOffset(0);
      setRowsError(null);
    } catch (error) {
      setRowsError(error instanceof Error ? `链接筛选无效：${error.message}` : "链接筛选无效");
    }
    // Restore only on route/filter history changes or a completed dataset switch,
    // not on status refresh, so the pinned snapshot remains untouched.
  }, [localHash, loadedDatasetId, activeDatasetId]);

  const catalogPanel = (
    <WorkspaceDrawer open={catalogOpen} onClose={() => setCatalogOpen(false)} wide
      title="数据目录" description={`已建仓 ${supportedStateCounts.ready} / ${catalogGrouping.supportedTotal} 张已适配表。选择后返回表格，目录筛选会保留。`}>
    <section
      aria-label="切换标准仓库表与接口目录"
      className="space-y-3"
    >
          {warehouseEvidenceError && (
            <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900">
              {warehouseEvidenceError}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t border-slate-100">
          {/* Warehouse Readiness Quick Filter Pills */}
          {!includeRawOnly ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {(
                [
                  ["all", `全部已适配 (${catalogGrouping.supportedTotal})`],
                  ["ready", `已建仓就绪 (${supportedStateCounts.ready})`],
                  [
                    "pending_source",
                    `有源待建仓/待整理 (${supportedStateCounts.pendingSource + supportedStateCounts.refreshNeeded})`,
                  ],
                  ["empty", `未采集 (${supportedStateCounts.empty})`],
                ] as const
              ).map(([stKey, stLabel]) => (
                <button
                  key={stKey}
                  type="button"
                  onClick={() => setWarehouseStateFilter(stKey)}
                  className={clsx(
                    "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                    warehouseStateFilter === stKey
                      ? stKey === "ready"
                        ? "bg-emerald-600 text-white shadow-sm"
                        : stKey === "pending_source"
                          ? "bg-amber-600 text-white shadow-sm"
                          : "bg-navy-900 text-white shadow-sm"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
                  )}
                >
                  {stLabel}
                </button>
              ))}
              {refreshableEntries.length > 0 && !batchRefreshState?.running && (
                <button
                  type="button"
                  disabled={refreshing}
                  onClick={() => void handleRunBatchRefresh()}
                  className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
                  title="按顺序离线校验并整理全部有源待建仓/待整理表（单表失败自动跳过，不发网络采集请求）"
                >
                  <Layers className="h-3.5 w-3.5" />
                  一键串行整理待更新表 ({refreshableEntries.length})
                </button>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-600">
              完整展示 {catalogGrouping.definedTotal} 项股票目录定义（已适配 {catalogGrouping.supportedTotal} 项 · 仅 Raw 阅读 {catalogGrouping.definedTotal - catalogGrouping.supportedTotal} 项及具体未入仓原因）
            </div>
          )}

          {batchRefreshState && (
            <div
              role="status"
              className={clsx(
                "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs",
                batchRefreshState.running
                  ? "border-teal-200 bg-teal-50/90 text-teal-950"
                  : batchRefreshState.failed.length > 0
                    ? "border-amber-200 bg-amber-50 text-amber-950"
                    : "border-emerald-200 bg-emerald-50 text-emerald-950",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                {batchRefreshState.running ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-700" />
                    <span className="font-semibold font-mono tabular-nums">
                      正在串行离线整理 ({batchRefreshState.currentIdx}/{batchRefreshState.total})：
                    </span>
                    <span>{batchRefreshState.currentName}</span>
                    <span className="text-[11px] text-teal-800">
                      （已更新 {batchRefreshState.succeeded} · 无变更 {batchRefreshState.unchanged}
                      {batchRefreshState.failed.length > 0
                        ? ` · 跳过 ${batchRefreshState.failed.length}`
                        : ""}
                      ）
                    </span>
                  </>
                ) : (
                  <span>
                    批量离线整理完成：新发布/更新{" "}
                    <strong>{batchRefreshState.succeeded}</strong> 张 · 无变更{" "}
                    <strong>{batchRefreshState.unchanged}</strong> 张
                    {batchRefreshState.failed.length > 0 && (
                      <>
                        {" "}
                        · 未满足建仓条件/跳过{" "}
                        <strong>{batchRefreshState.failed.length}</strong> 张（
                        {batchRefreshState.failed
                          .slice(0, 3)
                          .map((f) => `${f.name}: ${f.error}`)
                          .join("；")}
                        {batchRefreshState.failed.length > 3 ? "…" : ""}）
                      </>
                    )}
                  </span>
                )}
              </div>

              {batchRefreshState.running ? (
                <button
                  type="button"
                  onClick={() => {
                    batchCancelRef.current = true;
                  }}
                  className="rounded border border-teal-300 bg-white px-2.5 py-1 text-[11px] font-medium text-teal-900 hover:bg-teal-100"
                >
                  停止后续整理
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setBatchRefreshState(null)}
                  className="text-[11px] font-medium underline opacity-80 hover:opacity-100"
                >
                  关闭提示
                </button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {catalogLoading && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                同步目录…
              </span>
            )}
            <div className="relative w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="搜索接口名 / api_name / 粒度…"
                aria-label="搜索仓库目录接口"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-2.5 py-1.5 text-xs text-slate-900 focus:border-teal-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setIncludeRawOnly(false);
                  setInspectedRawOnlyEntry(null);
                  if (
                    domainFilter &&
                    !catalogGrouping.domains.find(
                      (d) => d.id === domainFilter && d.supportedCount > 0,
                    )
                  ) {
                    setDomainFilter("");
                  }
                }}
                className={clsx(
                  "rounded-md px-2.5 py-1 font-medium transition-colors",
                  !includeRawOnly
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900",
                )}
              >
                已适配仓库 ({catalogGrouping.supportedTotal})
              </button>
              <button
                type="button"
                onClick={() => setIncludeRawOnly(true)}
                className={clsx(
                  "rounded-md px-2.5 py-1 font-medium transition-colors",
                  includeRawOnly
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-600 hover:text-slate-900",
                )}
              >
                浏览全部 {catalogGrouping.definedTotal} 项定义
              </button>
            </div>
          </div>
        </div>

        {!warehouseCatalog && catalogError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
              <div>
                <div className="font-semibold">
                  读取本地数据仓库目录（/api/warehouse/catalog）失败：{catalogError}
                </div>
                <div className="text-[11px] text-rose-700 mt-0.5">
                  为避免将未确认接口误标为股票代码或日线截面，界面不会回退本地硬编码表清单，请检查连接后重试。
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => loadCatalog()}
              className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100"
            >
              重试加载仓库目录
            </button>
          </div>
        ) : (
          <>
            {/* 9 Business Domain Filter Pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setDomainFilter("")}
                className={clsx(
                  "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                  domainFilter === ""
                    ? "bg-navy-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
                )}
              >
                全部业务域 (
                {includeRawOnly
                  ? catalogGrouping.definedTotal
                  : catalogGrouping.supportedTotal}
                )
              </button>
              {catalogGrouping.domains
                .filter((dom) => includeRawOnly || dom.supportedCount > 0)
                .map((dom) => (
                  <button
                    key={dom.id}
                    type="button"
                    onClick={() =>
                      setDomainFilter(domainFilter === dom.id ? "" : dom.id)
                    }
                    className={clsx(
                      "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                      domainFilter === dom.id
                        ? "bg-navy-900 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
                    )}
                  >
                    {dom.name} (
                    {includeRawOnly
                      ? `${dom.supportedCount}/${dom.totalCount}`
                      : dom.supportedCount}
                    )
                  </button>
                ))}
            </div>

            {/* Grain Filter Pills for scannable 38-dataset browsing */}
            {!includeRawOnly && effectiveCatalogEntries.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-slate-400 mr-0.5">
                  数据形态：
                </span>
                {GRAIN_FILTER_OPTIONS.map((opt) => (
                  <button
                    key={opt.id || "all"}
                    type="button"
                    onClick={() =>
                      setGrainFilter(grainFilter === opt.id ? "" : opt.id)
                    }
                    className={clsx(
                      "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
                      grainFilter === opt.id
                        ? "bg-teal-600 text-white"
                        : "bg-slate-50 text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-100",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            {/* Supported Compact Card Selector vs Full 102-Entry Domain Browser */}
            {catalogLoading && effectiveCatalogEntries.length === 0 ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-slate-100 bg-slate-50 py-6 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" />
                正在加载仓库目录能力清单…
              </div>
            ) : catalogGrouping.visibleEntries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 py-6 text-center text-xs text-slate-500">
                当前筛选条件下无匹配接口定义
              </div>
            ) : !includeRawOnly ? (
              orderedSupportedVisible.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 py-6 text-center text-xs text-slate-500">
                  当前建仓状态或业务域筛选下暂无匹配仓库表
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {orderedSupportedVisible.map((entry) => {
                    const targetDsId = entry.dataset_id || entry.api_name;
                    const entryProfile = resolveWarehouseProfile(
                      entry,
                      targetDsId,
                    );
                    const isSelected =
                      !inspectedRawOnlyEntry && activeDatasetId === targetDsId;
                    const entryWh = resolveEntryWarehouseStatus(targetDsId);
                    const entryState = classifyEntryWarehouseState(entry);
                    const rawEntry = catalogEntryMap.get(entry.entry_id);
                    const accessState = rawEntry?.access?.account_access;
                    const hasAccessConstraint =
                      accessState === "insufficient_points" ||
                      accessState === "requires_independent_permission";

                    return (
                      <button
                        key={entry.entry_id}
                        type="button"
                        onClick={() => selectSupportedDataset(targetDsId)}
                        className={clsx(
                          "flex flex-col justify-between rounded-xl border px-3 py-2 text-left transition-all",
                          isSelected
                            ? "border-teal-600 bg-teal-50/50 ring-2 ring-teal-500/20"
                            : entryState === "ready"
                              ? "border-emerald-200/90 bg-white hover:border-emerald-400 hover:bg-emerald-50/20"
                              : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60",
                        )}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="font-semibold text-xs text-slate-900 truncate">
                              {entry.name}
                            </span>
                            <code className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
                              {entry.api_name}
                            </code>
                          </div>
                          <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                            <span className="rounded bg-slate-100 px-1.5 py-0.2 font-medium text-slate-700">
                              {entryProfile.grainLabel}
                            </span>
                            {entryProfile.supportsVariants && (
                              <span className="rounded bg-violet-50 px-1.5 py-0.2 font-medium text-violet-700">
                                请求分区/变体
                              </span>
                            )}
                            {entryProfile.codeFilter === "board" && (
                              <span className="rounded bg-indigo-50 px-1.5 py-0.2 font-medium text-indigo-700">
                                板块代码
                              </span>
                            )}
                            {entryProfile.codeFilter === "identifier" && (
                              <span className="rounded bg-sky-50 px-1.5 py-0.2 font-medium text-sky-700">
                                标的代码
                              </span>
                            )}
                            {entryProfile.isConstituentCode && (
                              <span className="rounded bg-cyan-50 px-1.5 py-0.2 font-medium text-cyan-800">
                                成分股 con_code
                              </span>
                            )}
                            {entryProfile.codeFilter === "none" && (
                              <span className="rounded bg-amber-50 px-1.5 py-0.2 font-medium text-amber-800">
                                无代码
                              </span>
                            )}
                            <span>· {entry.fields.length} 列</span>
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-1 pt-1.5 border-t border-slate-100 text-[10px]">
                          <span className="font-mono text-slate-400">
                            #{entry.entry_id}
                          </span>
                          <div className="flex items-center gap-1">
                            {hasAccessConstraint && (
                              <span
                                className={clsx(
                                  "rounded px-1.5 py-0.2 font-medium",
                                  accessState === "insufficient_points"
                                    ? "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20"
                                    : "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/20",
                                )}
                                title="仓库适配器已就绪；在线采集受当前申报账号积分或独立权限约束"
                              >
                                {accessState === "insufficient_points"
                                  ? "积分受限"
                                  : "独立权限"}
                              </span>
                            )}
                            {entryWh?.state === "ready" ? (
                              <>
                                <span className="rounded-full bg-emerald-100 px-2 py-0.2 font-semibold text-emerald-800 tabular-nums">
                                  {entryProfile.isPeriodBar
                                    ? `已建仓 · ${formatNumber(entryWh.days_with_rows ?? entryWh.days)} 周期日`
                                    : `已建仓 · ${formatNumber(entryWh.rows)} 行`}
                                </span>
                                {entryWh.refresh_needed && (
                                  <span className="rounded bg-amber-100 px-1.5 py-0.2 font-semibold text-amber-800">
                                    待整理
                                  </span>
                                )}
                              </>
                            ) : entryState === "pending_source" ? (
                              <span className="rounded-full bg-amber-50 px-2 py-0.2 font-medium text-amber-800 ring-1 ring-inset ring-amber-500/25">
                                有源待建仓
                              </span>
                            ) : (
                              <span className="text-slate-400">未采集</span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="space-y-3">
                {catalogGrouping.domains
                  .filter((dom) => dom.entries.length > 0)
                  .map((dom) => (
                    <div key={dom.id} className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600 px-1">
                        <span>{dom.name}</span>
                        <span className="font-mono text-slate-400">
                          支持仓库 {dom.supportedCount} / 共{" "}
                          {dom.entries.length} 项
                        </span>
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {dom.entries.map((entry) => {
                          const isSupported =
                            entry.warehouse_supported ||
                            entry.warehouse_status === "supported";
                          const targetDsId = entry.dataset_id || entry.api_name;
                          const isSelected = isSupported
                            ? !inspectedRawOnlyEntry &&
                              activeDatasetId === targetDsId
                            : inspectedRawOnlyEntry?.entry_id ===
                              entry.entry_id;
                          return (
                            <div
                              key={entry.entry_id}
                              className={clsx(
                                "flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs transition-all",
                                isSelected
                                  ? isSupported
                                    ? "border-teal-600 bg-teal-50/60 ring-1 ring-teal-500/30"
                                    : "border-amber-500 bg-amber-50/60 ring-1 ring-amber-500/30"
                                  : "border-slate-200 bg-slate-50/40 hover:bg-white",
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  if (isSupported) {
                                    selectSupportedDataset(targetDsId);
                                  } else {
                                    setInspectedRawOnlyEntry(entry);
                                    setCatalogOpen(false);
                                  }
                                }}
                                className="min-w-0 flex-1 text-left"
                              >
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate font-semibold text-slate-900">
                                    {entry.name}
                                  </span>
                                  <code className="shrink-0 font-mono text-[10px] text-slate-500">
                                    {entry.api_name}
                                  </code>
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                                  {isSupported ? (
                                    resolveEntryWarehouseStatus(targetDsId)?.state === "ready" ? (
                                      <span className="rounded bg-emerald-100 px-1.5 py-0.2 font-semibold text-emerald-800">
                                        已建仓 · {formatNumber(resolveEntryWarehouseStatus(targetDsId)?.rows ?? 0)}行
                                      </span>
                                    ) : (
                                      <span className="rounded bg-teal-100/80 px-1.5 py-0.2 font-semibold text-teal-800">
                                        支持本地仓库
                                      </span>
                                    )
                                  ) : (
                                    <span className="rounded bg-slate-200/80 px-1.5 py-0.2 font-medium text-slate-700">
                                      仅 Raw 阅读
                                    </span>
                                  )}
                                  <span className="font-mono text-slate-400">
                                    #{entry.entry_id} · {entry.fields.length}列
                                  </span>
                                </div>
                                {!isSupported &&
                                  entry.warehouse_unavailable_reason && (
                                    <div
                                      className="mt-1 truncate text-[10px] text-amber-800"
                                      title={entry.warehouse_unavailable_reason}
                                    >
                                      原因：{entry.warehouse_unavailable_reason}
                                    </div>
                                  )}
                              </button>

                              {!isSupported && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onOpenRawArchives(entry.entry_id)
                                  }
                                  title={`前往原始归档查看 ${entry.name} 的 Raw 文件`}
                                  className="shrink-0 inline-flex items-center gap-0.5 rounded border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium text-slate-700 hover:border-teal-500 hover:text-teal-700"
                                >
                                  Raw阅读
                                  <ArrowRight className="h-2.5 w-2.5" />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
    </section>
    </WorkspaceDrawer>
  );

  const rawOnlyPanel = inspectedRawOnlyEntry ? (
        <div className="rounded-xl border border-amber-200 bg-white p-6 shadow-sm space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                  仅 Raw 阅读（raw_only）
                </span>
                <h3 className="text-base font-semibold text-slate-900">
                  {inspectedRawOnlyEntry.name}
                </h3>
                <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
                  {inspectedRawOnlyEntry.api_name} · entry #{inspectedRawOnlyEntry.entry_id}
                </code>
                <span className="text-xs text-slate-500">
                  {inspectedRawOnlyEntry.business_domain_name} /{" "}
                  {inspectedRawOnlyEntry.category_name}
                </span>
              </div>
              {inspectedRawOnlyEntry.warehouse_unavailable_reason && (
                <div className="rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-950 max-w-3xl">
                  <span className="font-semibold">暂未入仓具体原因：</span>
                  {inspectedRawOnlyEntry.warehouse_unavailable_reason}
                </div>
              )}
              <p className="text-xs text-slate-600 leading-relaxed max-w-3xl">
                系统严格按接口真实粒度与供应商实测返回格式建模，不强套日线截面去重或伪造历史截面完整性。请前往「高级工具 → 原始归档」按业务域查看与导出经 SHA256 核验的原始归档切片。
              </p>
            </div>

            {inspectedRawOnlyEntry.doc_url && (
              <a
                href={inspectedRawOnlyEntry.doc_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                官方接口文档
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>

          {inspectedRawOnlyEntry.fields.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-slate-700">
                接口登记字段定义（共 {inspectedRawOnlyEntry.fields.length} 列）
              </div>
              <div className="flex flex-wrap gap-1.5 rounded-lg bg-slate-50 p-3 ring-1 ring-inset ring-slate-200/70">
                {inspectedRawOnlyEntry.fields.map((f) => (
                  <span
                    key={f.name}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-mono text-slate-700"
                  >
                    <span>{f.name}</span>
                    <span className="text-[10px] text-slate-400">{f.type}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => onOpenRawArchives(inspectedRawOnlyEntry.entry_id)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-navy-800"
            >
              <FolderSearch className="h-3.5 w-3.5" />
              前往「原始归档」查看 Raw 文件
            </button>

            {rawOnlyDatasetItem && (
              <button
                type="button"
                onClick={() =>
                  onOpenDatasetDrawer(
                    rawOnlyDatasetItem.id,
                    "incremental",
                    "plan",
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <CalendarRange className="h-3.5 w-3.5" />
                打开预置数据集采集计划
              </button>
            )}

            <button
              type="button"
              onClick={() => setInspectedRawOnlyEntry(null)}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              返回「{activeTitle}」本地仓库
            </button>
          </div>
        </div>
      ) : null;

  const collectionPanel = (
        <section aria-label="采集与离线整理" className="space-y-3">
          <p className="text-xs text-slate-500">按需选择联网采集或离线整理。打开此面板不会启动任务。</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Phase 1: Check / Backfill Selected Dataset Raw Archives (Network Side) */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col justify-between space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-navy-900 text-[11px] font-bold text-white">
                      1
                    </span>
                    <h2 className="text-sm font-semibold text-slate-900">
                      {activeProfile.isCurrentSnapshot
                        ? `阶段一：获取「${activeTitle}」当前完整快照归档`
                        : `阶段一：检查 / 补采「${activeTitle}」原始归档`}
                    </h2>
                  </div>
                  {warehouse?.collection_active ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 px-2.5 py-0.5 text-[11px] font-medium text-teal-700 ring-1 ring-inset ring-teal-600/20">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {activeApiName} 采集中
                    </span>
                  ) : activeDatasetPres ? (
                    <span
                      className={clsx(
                        "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                        activeDatasetPres.kind === "ready" &&
                          "bg-emerald-50 text-emerald-700",
                        activeDatasetPres.kind === "attention" &&
                          "bg-amber-50 text-amber-700",
                        activeDatasetPres.kind === "active" &&
                          "bg-teal-50 text-teal-700",
                        activeDatasetPres.kind === "empty" &&
                          "bg-slate-100 text-slate-600",
                      )}
                    >
                      预置数据集：{activeDatasetPres.status}
                    </span>
                  ) : null}
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                  {activeProfile.semanticNote ? <>{activeProfile.semanticNote} 采集计划仍须单独确认，不会自动联网。</> : activeProfile.isCurrentSnapshot ? (
                    <>
                      复用预置「{activeTitle} (
                      <code className="font-mono">{activeApiName}</code>
                      )」全量计划获取沪深北交易所 × 上市状态（SSE/SZSE/BSE × L/D/P/G/UN 共 15 个组合切片）的当前完整快照（绝不自动触发网络请求）。仓库仅发布同一次完整成功预置运行的 15 个切片，不混用部分成功、预览或自定义任务切片，亦非历史股票池或 PIT。
                    </>
                  ) : activeProfile.isRequestPartitions ? (
                    <>
                      复用预置「{activeTitle} (
                      <code className="font-mono">{activeApiName}</code>
                      )」采集计划检查与补采原始请求分区归档（绝不自动触发网络请求）。仓库按完整原请求分区发布 Parquet，以{" "}
                      <code className="font-mono text-slate-800">
                        {activeProfile.dateColumn || "end_date"}
                      </code>{" "}
                      提供区间筛选，不做 PIT 或跨报告期自动合并/去重。
                    </>
                  ) : activeProfile.isPeriodBar ? (
                    <>
                      复用预置「{activeTitle} (
                      <code className="font-mono">{activeApiName}</code>
                      )」采集计划设定目标区间并确认补采（绝不自动触发网络请求）。周期行情按开市请求日检查归档，仅周期结束日返回实际 K 线记录，非周期末开市空响应不代表数据缺失。
                    </>
                  ) : activeProfile.isAnnouncementEvent ? (
                    <>
                      复用预置「{activeTitle} (
                      <code className="font-mono">{activeApiName}</code>
                      )」采集计划，按公告日期（
                      <code className="font-mono text-slate-800">
                        {activeProfile.dateColumn || "ann_date"}
                      </code>
                      ，自然日含无公告空切片，非交易日{" "}
                      <code className="font-mono">trade_date</code>
                      ）检查与补采原始归档（绝不自动触发网络请求）。
                    </>
                  ) : (
                    <>
                      复用现有「{activeTitle} (
                      <code className="font-mono">{activeApiName}</code>
                      )」预置数据集计划设定目标日期范围并确认补采（绝不自动触发网络请求）。仓库仅纳入该数据集当前配置{" "}
                      <code className="font-mono text-slate-800">Raw</code>{" "}
                      目录下的预置归档，与同目录下其他接口仓库相互独立隔离。
                    </>
                  )}
                </p>

                {activeAccessBadge &&
                  (activeAccessBadge.tone === "rose" ||
                    activeAccessBadge.tone === "amber") && (
                    <div
                      className={clsx(
                        "rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ring-1 ring-inset",
                        activeAccessBadge.tone === "rose"
                          ? "bg-rose-50 text-rose-800 ring-rose-600/20"
                          : "bg-amber-50 text-amber-900 ring-amber-600/20",
                      )}
                    >
                      <span className="font-semibold">
                        适配器支持与账号权限独立：
                      </span>
                      本地仓库适配器已支持「{activeTitle}」，但当前申报账号权限状态为「
                      {activeAccessBadge.label}
                      」。在线补采受供应商权限约束，绝不伪装已采集；若本地已有合规归档仍可直接离线整理阅读。
                    </div>
                  )}

                {effectiveSourceRawRoot && (
                  <div
                    className="rounded-lg bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-600 truncate ring-1 ring-inset ring-slate-200/70"
                    title={effectiveSourceRawRoot}
                  >
                    关联源 Raw 目录（跟随 {activeApiName} 设置）：
                    {effectiveSourceRawRoot}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() =>
                    onOpenDatasetDrawer(
                      activeDatasetId,
                      activeProfile.phase1PrimaryMode,
                      "plan",
                    )
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-navy-800"
                >
                  <CalendarRange className="h-3.5 w-3.5" />
                  {activeProfile.isCurrentSnapshot
                    ? activeProfile.phase1PrimaryLabel
                    : `${activeProfile.phase1PrimaryLabel}「${activeTitle}」`}
                </button>
                {activeProfile.showForceRangeButton && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenDatasetDrawer(activeDatasetId, "full", "plan")
                    }
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    强制重采指定范围
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    onOpenDatasetDrawer(
                      activeDatasetId,
                      activeProfile.phase1PrimaryMode,
                      "coverage",
                    )
                  }
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  覆盖明细
                </button>
                {activeEntryId && (
                  <button
                    type="button"
                    onClick={() => onOpenRawArchives(activeEntryId)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >
                    查看原始切片
                  </button>
                )}
                {warehouse?.collection_active && (
                  <button
                    type="button"
                    onClick={() => {setMaintenanceOpen(false); onOpenLogDock();}}
                    className="inline-flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-2 text-xs font-medium text-teal-800 hover:bg-teal-100"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    实时日志
                  </button>
                )}
              </div>
            </div>

            {/* Phase 2: Offline Verify & Publish Monthly Warehouse Snapshot */}
            <div className="rounded-xl border border-teal-200/90 bg-white p-4 shadow-sm flex flex-col justify-between space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-teal-600 text-[11px] font-bold text-white">
                      2
                    </span>
                    <h2 className="text-sm font-semibold text-slate-900">
                      阶段二：离线整理归档至「{activeTitle}」仓库
                    </h2>
                  </div>
                  {warehouse && loadedDatasetId === activeDatasetId && (
                    <span
                      className={clsx(
                        "rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                        warehouse.refresh_needed
                          ? "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-500/30"
                          : warehouse.state === "ready"
                            ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20"
                            : "bg-slate-100 text-slate-600",
                      )}
                    >
                      {warehouse.refresh_needed
                        ? "有新归档待整理"
                        : warehouse.state === "ready"
                          ? "已同步最新源"
                          : "等待源归档"}
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                  {activeProfile.semanticNote ? <>纯本地核验来源 SHA256 并原子发布，不联网、不删除 Raw。{activeProfile.semanticNote}</> : activeProfile.isCurrentSnapshot ? (
                    <>
                      纯本地离线核验最新完整成功预置运行的全部 15 个交易所 × 上市状态切片 SHA256，发布不可变{" "}
                      <code className="font-mono">current</code> Parquet 快照（绝不联网；跳过局部未完成运行；不改写或删除源{" "}
                      <code className="font-mono">Raw</code>）。
                    </>
                  ) : activeProfile.isRequestPartitions ? (
                    <>
                      纯本地离线核验各原请求分区成功切片 SHA256，按{" "}
                      <code className="font-mono">request_partitions</code>{" "}
                      布局与请求变体选项（如分类/频率/交易所）隔离发布不可变 Parquet 分区文件（绝不联网；原样保留全部返回行，不做 PIT 合并或跨报告期去重；不改写或删除源{" "}
                      <code className="font-mono">Raw</code>）。
                    </>
                  ) : activeProfile.isPeriodBar ? (
                    <>
                      纯本地离线核验已检开市请求日成功切片 SHA256 并按周期结束日（
                      <code className="font-mono">
                        {activeProfile.dateColumn || "trade_date"}
                      </code>
                      ）发布不可变月度 Parquet 快照（绝不联网；已检开市日包含非周期末空响应日，不等于实际交易周期数）。
                    </>
                  ) : activeProfile.preservesDuplicateRows ? (
                    <>
                      纯本地离线核验已检切片 SHA256 并按日期列{" "}
                      <code className="font-mono">
                        {activeProfile.dateColumn || "trade_date"}
                      </code>{" "}
                      归属月度（YYYYMM）发布不可变 Parquet 快照（绝不联网；原样保留同日多条或重复原始记录，不做自动去重；已检空响应日正常纳入请求日计数，不宣称有实际记录覆盖）。
                    </>
                  ) : (
                    <>
                      纯本地离线核验成功切片 SHA256 并按{" "}
                      <code className="font-mono">
                        {activeProfile.dateColumn || "trade_date"}
                      </code>{" "}
                      归属月度发布不可变 Parquet 快照（绝不联网；不改写或删除源{" "}
                      <code className="font-mono">Raw</code>
                      ；同日多次重采自动按最新成功切片版本消歧，未变更月份直接复用已有文件）。
                    </>
                  )}
                </p>

                {warehouse && loadedDatasetId === activeDatasetId && (
                  <div className="grid grid-cols-4 gap-2 rounded-lg bg-slate-50 p-2 text-center ring-1 ring-inset ring-slate-200/70">
                    {activeProfile.isCurrentSnapshot ||
                    activeProfile.isRequestPartitions ? (
                      <>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            {activeProfile.isRequestPartitions
                              ? "可用源请求分区"
                              : "可用源切片"}
                          </div>
                          <div className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                            {formatNumber(
                              warehouse.available_source_partitions ?? 0,
                            )}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            {activeProfile.isRequestPartitions
                              ? "待纳入新分区"
                              : "待发布新切片"}
                          </div>
                          <div
                            className={clsx(
                              "font-mono text-xs font-semibold tabular-nums",
                              (warehouse.new_partitions ?? 0) > 0
                                ? "text-amber-700"
                                : "text-slate-700",
                            )}
                          >
                            +{formatNumber(warehouse.new_partitions ?? 0)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            {activeProfile.isRequestPartitions
                              ? "重采变更分区"
                              : "更新变更切片"}
                          </div>
                          <div
                            className={clsx(
                              "font-mono text-xs font-semibold tabular-nums",
                              (warehouse.changed_partitions ?? 0) > 0
                                ? "text-teal-700"
                                : "text-slate-700",
                            )}
                          >
                            {formatNumber(warehouse.changed_partitions ?? 0)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            {activeProfile.isRequestPartitions
                              ? "直接复用分区"
                              : "直接复用切片"}
                          </div>
                          <div className="font-mono text-xs font-semibold text-slate-700 tabular-nums">
                            {formatNumber(warehouse.reused_partitions ?? 0)}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            可用{activeProfile.dayUnitLabel}
                          </div>
                          <div className="font-mono text-xs font-semibold text-slate-900 tabular-nums">
                            {formatNumber(warehouse.available_source_days)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            待纳入新日
                          </div>
                          <div
                            className={clsx(
                              "font-mono text-xs font-semibold tabular-nums",
                              warehouse.new_days > 0
                                ? "text-amber-700"
                                : "text-slate-700",
                            )}
                          >
                            +{formatNumber(warehouse.new_days)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            重采变更日
                          </div>
                          <div
                            className={clsx(
                              "font-mono text-xs font-semibold tabular-nums",
                              warehouse.changed_days > 0
                                ? "text-teal-700"
                                : "text-slate-700",
                            )}
                          >
                            {formatNumber(warehouse.changed_days)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">
                            直接复用日
                          </div>
                          <div className="font-mono text-xs font-semibold text-slate-700 tabular-nums">
                            {formatNumber(warehouse.reused_days)}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isRefreshDisabled || Boolean(statusError)}
                    onClick={handleManualRefreshWarehouse}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
                  >
                    {refreshing || warehouse?.busy ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        正在校验 / 整理本地归档…
                      </>
                    ) : (
                      <>
                        <Layers className="h-3.5 w-3.5" />
                        校验并整理本地归档
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={statusLoading || refreshing}
                    onClick={() => void loadWarehouseStatus(activeDatasetId, false)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={clsx(
                        "h-3.5 w-3.5",
                        statusLoading && "animate-spin",
                      )}
                    />
                    刷新状态
                  </button>
                </div>

                {warehouse?.collection_active && (
                  <span className="text-[11px] text-amber-700">
                    「{activeTitle}」采集运行中，请待采集结束后整理（已有快照可正常读表导出）
                  </span>
                )}
              </div>
            </div>
          </div>

        </section>
  );

  return (
    <div className="space-y-4">
      <WorkspaceHeader title={inspectedRawOnlyEntry?.name || activeTitle}
        description={inspectedRawOnlyEntry ? `${inspectedRawOnlyEntry.api_name} · 暂不支持仓库查询` : `${activeApiName} · ${activeProfile.grainBadge}`}
        actions={<>
          <button type="button" onClick={() => setCatalogOpen(true)} aria-expanded={catalogOpen}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700">切换数据</button>
          {!inspectedRawOnlyEntry && <button type="button" onClick={() => setMaintenanceOpen(true)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-700">更新数据</button>}
          {isWarehouseReady && !inspectedRawOnlyEntry && <button type="button" onClick={() => setExportPanelOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-xs font-medium text-white">
            <Download className="h-3.5 w-3.5" />导出数据
          </button>}
        </>} />
      {catalogPanel}
      {!catalogOpen && (catalogError || warehouseEvidenceError) && <div role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
        <span>{catalogError || warehouseEvidenceError}</span>
        <button type="button" onClick={() => setCatalogOpen(true)} className="underline">检查数据目录</button>
      </div>}
      {batchRefreshState && !catalogOpen && <div role="status"
        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-xs ${batchRefreshState.failed.length ? "border-amber-200 bg-amber-50 text-amber-900" : "border-teal-200 bg-teal-50 text-teal-900"}`}>
        <span>{batchRefreshState.running ? `正在离线整理 ${batchRefreshState.currentIdx}/${batchRefreshState.total}：${batchRefreshState.currentName}` : "批量离线整理结束"}
          {" "}· 已更新 {batchRefreshState.succeeded} · 无变更 {batchRefreshState.unchanged} · 跳过 {batchRefreshState.failed.length}</span>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setCatalogOpen(true)} className="underline">查看明细</button>
          {batchRefreshState.running ? <button type="button" onClick={() => {batchCancelRef.current = true;}} className="underline">停止后续整理</button>
            : <button type="button" onClick={() => setBatchRefreshState(null)} className="underline">关闭提示</button>}
        </div>
      </div>}
      {rawOnlyPanel || (
        <>
          <WorkspaceDrawer open={maintenanceOpen} onClose={() => setMaintenanceOpen(false)}
            title={`更新数据 · ${activeTitle}`} wide>
            {statusError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-800">{statusError}</p>}
            {refreshError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-xs text-rose-800">{refreshError}</p>}
            {collectionPanel}
          </WorkspaceDrawer>
          {warehouse?.source_error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
            {warehouse.source_error}
          </p>}
          {isWarehouseReady && warehouse?.refresh_needed && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
              <span>本地归档有待整理更新。当前快照仍可查询与导出。</span>
              <button type="button" onClick={() => setMaintenanceOpen(true)} className="underline">查看更新操作</button>
            </div>
          )}
          {warehouse?.collection_active && <p role="status" className="rounded-lg bg-teal-50 p-3 text-xs text-teal-900">
            「{activeTitle}」正在采集。表格仍读取已发布快照。
            <button type="button" onClick={onOpenLogDock} className="ml-3 underline">查看运行日志</button>
          </p>}
          {/* Explicit Long-Running Offline Refresh Progress Banner */}
          {(refreshing || warehouse?.busy) && (
            <div className="flex items-start gap-2.5 rounded-xl border border-teal-300 bg-teal-50/90 p-3.5 text-xs text-teal-950 shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin text-teal-700 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <div className="font-semibold">
                  正在离线校验并整理「{activeTitle}」本地归档（全程零网络请求）
                </div>
                <p className="text-[11px] text-teal-800 leading-relaxed">
                  {activeProfile.isCurrentSnapshot
                    ? activeDatasetId === "stock_basic"
                      ? "正在校验同一次完整成功运行的全部 15 个交易所 × 上市状态切片 SHA256 指纹，并原子发布当前完整快照…"
                      : "正在校验同一次完整成功运行的全部授权范围切片 SHA256 指纹，并原子发布当前快照…"
                    : activeProfile.isRequestPartitions
                      ? `正在核验各请求分区切片 SHA256 指纹、隔离变体选项并按 ${activeProfile.dateColumn || "end_date"} 原子发布请求分区 Parquet…`
                      : activeProfile.isPeriodBar
                        ? `正在核验已检开市请求日切片 SHA256 指纹、提取周期结束日（${activeProfile.dateColumn || "trade_date"}）记录并原子发布月度 Parquet 分区…`
                        : activeProfile.preservesDuplicateRows
                          ? `正在核验已检切片 SHA256 指纹、按 ${activeProfile.dateColumn || "trade_date"} 保留原始明细记录并原子发布月度 Parquet 分区…`
                          : `首次整理可能涉及大量历史切片的 SHA256 指纹核对、按 ${activeProfile.dateColumn || "trade_date"} 版本消歧与月度 Parquet 原子发布，请耐心等待完成…`}
                </p>
              </div>
            </div>
          )}

          {statusError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-700 flex items-center justify-between gap-3">
              <span>{statusError}</span>
              <button
                type="button"
                onClick={() => void loadWarehouseStatus(activeDatasetId, false)}
                className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100"
              >
                重试读取
              </button>
            </div>
          )}

          {refreshError && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-xs text-rose-800">
              <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <div className="font-semibold">
                  离线整理未能发布新快照：{refreshError}
                </div>
                {isWarehouseReady && (
                  <div className="text-[11px] text-rose-700">
                    已安全保留当前有效快照（{warehouse?.snapshot_id?.slice(0, 12)}
                    …），下方读表与导出不受影响。
                  </div>
                )}
              </div>
            </div>
          )}

          {lastRefreshBanner && !refreshError && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>
                  {lastRefreshBanner.changed ? (
                    <>
                      已原子切换至新快照{" "}
                      <code className="font-mono font-semibold">
                        {lastRefreshBanner.snapshotId?.slice(0, 12)}
                      </code>
                      {activeProfile.isCurrentSnapshot ? (
                        <>
                          （共 {formatNumber(lastRefreshBanner.partitions)} 个来源切片 ·{" "}
                          {formatNumber(lastRefreshBanner.rows)} 行当前快照记录）
                        </>
                      ) : activeProfile.isRequestPartitions ? (
                        <>
                          （共 {formatNumber(lastRefreshBanner.partitions)} 个请求分区 · 记录含{" "}
                          {formatNumber(lastRefreshBanner.days)} 个{activeProfile.dayUnitLabel === "记录周期数" ? "周期标签" : "不同日期"} ·{" "}
                          {formatNumber(lastRefreshBanner.rows)} 行记录）
                        </>
                      ) : activeProfile.isPeriodBar ? (
                        <>
                          （已检开市请求日 {formatNumber(lastRefreshBanner.days)}
                          {typeof lastRefreshBanner.daysWithRows === "number"
                            ? ` · 有记录周期日 ${formatNumber(lastRefreshBanner.daysWithRows)}`
                            : ""}
                          ，含空请求日 · {formatNumber(lastRefreshBanner.rows)} 行记录）
                        </>
                      ) : (
                        <>
                          （共 {formatNumber(lastRefreshBanner.days)} 个
                          {activeProfile.dayUnitLabel}
                          {typeof lastRefreshBanner.daysWithRows === "number"
                            ? ` · 有返回记录 ${formatNumber(lastRefreshBanner.daysWithRows)} 日`
                            : ""}{" "}
                          · {formatNumber(lastRefreshBanner.rows)} 行记录）
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      校验完成：本地归档内容无变化，继续复用不可变快照{" "}
                      <code className="font-mono font-semibold">
                        {lastRefreshBanner.snapshotId?.slice(0, 12) || "—"}
                      </code>
                    </>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setLastRefreshBanner(null)}
                className="text-[11px] text-emerald-700 hover:underline"
              >
                收起
              </button>
            </div>
          )}

          {/* Snapshot Summary Ribbon + Collapsible Monthly Partitions & Paths */}
          <WorkspaceToolbar label="当前仓库快照">
            <span className="text-xs text-slate-600">
              {isWarehouseReady ? `${formatNumber(warehouse?.rows ?? 0)} 行 · ${availableColumns.length} 列` : "尚无已发布快照"}
              {isWarehouseReady && activeProfile.supportsDateFilter && warehouse?.first_date && warehouse?.last_date
                ? ` · 记录日期范围 ${warehouse.first_date}–${warehouse.last_date}（非覆盖证明）` : ""}
            </span>
            {warehouse && loadedDatasetId === activeDatasetId && <button type="button" onClick={() => setSnapshotOpen(true)}
              className="ml-auto rounded-lg px-2 py-1 text-xs text-teal-800 hover:bg-teal-50">快照详情</button>}
          </WorkspaceToolbar>
          {warehouse && loadedDatasetId === activeDatasetId && (
            <WorkspaceDrawer open={snapshotOpen} onClose={() => setSnapshotOpen(false)} title={`快照详情 · ${activeTitle}`} wide>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5 text-xs">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                    <Archive className="h-4 w-4 text-teal-600" />
                    「{activeTitle}」当前快照
                  </span>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                    {activeApiName} · {availableColumns.length} 列
                  </code>
                  <span className="rounded bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-800 ring-1 ring-inset ring-teal-600/20">
                    {activeProfile.grainBadge}
                  </span>

                  {isWarehouseReady ? (
                    <>
                      {activeProfile.supportsDateFilter && (
                        <span className="text-[11px] font-medium text-slate-700">
                          最近有记录日期：{warehouse.last_date && (
                            activeProfile.isRequestPartitions ||
                            warehouse.days === warehouse.days_with_rows
                          ) ? warehouse.last_date : "尚无法确认"}
                        </span>
                      )}
                      <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-800">
                        snapshot: {warehouse.snapshot_id?.slice(0, 12)}…
                      </code>
                      {activeProfile.isCurrentSnapshot ? (
                        <>
                          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                            当前完整快照 · {formatNumber(warehouse.partitions ?? 0)} 个来源切片
                          </span>
                          <span className="font-mono text-slate-700 font-medium tabular-nums">
                            {formatNumber(warehouse.rows)} 行 · 当前快照文件
                          </span>
                          {warehouse.source_run_id && (
                            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                              来源运行: {warehouse.source_run_id.slice(0, 8)}…
                            </code>
                          )}
                        </>
                      ) : activeProfile.isRequestPartitions ? (
                        <>
                          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                            {formatNumber(
                              warehouse.partitions ?? warehouse.months.length,
                            )}{" "}
                            个请求分区 · 记录含 {formatNumber(warehouse.days)}{" "}
                            个{activeProfile.dayUnitLabel === "记录周期数" ? "周期标签" : "不同日期"}（非覆盖证明）
                          </span>
                          <span className="font-mono text-slate-700 font-medium tabular-nums">
                            {formatNumber(warehouse.rows)} 行 ·{" "}
                            {warehouse.first_date && warehouse.last_date
                              ? `${activeProfile.dateColumn || "end_date"}: ${warehouse.first_date} ~ ${warehouse.last_date} · `
                              : ""}
                            {formatNumber(warehouse.months.length)} 个请求分区文件
                            {statusVariants.length > 0
                              ? ` · ${statusVariants.length} 个变体`
                              : ""}
                          </span>
                        </>
                      ) : activeProfile.isPeriodBar ? (
                        <>
                          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                            已检开市请求日 {formatNumber(warehouse.days)}（含空日，非实际周期数
                            {typeof warehouse.days_with_rows === "number"
                              ? ` · 有记录周期日 ${formatNumber(warehouse.days_with_rows)}`
                              : ""}
                            ）
                          </span>
                          <span className="font-mono text-slate-700 font-medium tabular-nums">
                            {formatNumber(warehouse.rows)} 行 ·{" "}
                            {warehouse.first_date && warehouse.last_date
                              ? `${activeProfile.dateColumn || "trade_date"}: ${warehouse.first_date} ~ ${warehouse.last_date} · `
                              : ""}
                            {warehouse.months.length} 个月分区
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                            {formatNumber(warehouse.days)} 个{activeProfile.dayUnitLabel}
                            {typeof warehouse.days_with_rows === "number" &&
                            warehouse.days_with_rows !== warehouse.days
                              ? `（有记录 ${formatNumber(warehouse.days_with_rows)} 日）`
                              : ""}
                            {warehouse.first_date && warehouse.last_date
                              ? ` · ${activeProfile.dateColumn || "trade_date"}: ${warehouse.first_date} ~ ${warehouse.last_date}`
                              : ""}
                          </span>
                          <span className="font-mono text-slate-700 font-medium tabular-nums">
                            {formatNumber(warehouse.rows)} 行 · {warehouse.months.length} 个月分区
                          </span>
                        </>
                      )}
                      {warehouse.created_at && (
                        <span className="text-[11px] text-slate-400">
                          发布于 {formatDateTime(warehouse.created_at)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] text-slate-600">
                      尚未发布首个快照（empty）
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowPartitions((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                  >
                    {showPartitions ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    {activeProfile.partitionToggleLabel}
                  </button>
                </div>
              </div>

              {/* Honest Invariants Notice */}
              <details className="rounded-lg border border-slate-100 p-2 text-xs">
                <summary className="cursor-pointer font-medium text-slate-600">
                  数据语义与技术存储说明
                </summary>
              <div className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600 ring-1 ring-inset ring-slate-200/70">
                <Info className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
                <span>
                  {activeProfile.semanticNote ? <>{activeProfile.semanticNote}</> : activeProfile.isCurrentSnapshot ? (
                    <>
                      当前表为证券列表当前完整快照（
                      <code className="font-mono">current_snapshot</code>
                      ），按业务键{" "}
                      <code className="font-mono">
                        {mandatoryKeyColumns.join(" + ")}
                      </code>{" "}
                      核验，严格取自同一次完整成功的预置{" "}
                      <code className="font-mono">stock_basic</code>{" "}
                      运行（15 个交易所 × 上市状态切片）；非历史股票池（
                      <code className="font-mono text-slate-700">
                        not_historical_universe
                      </code>
                      ），不支持起止日期或伪装按{" "}
                      <code className="font-mono">list_date</code>{" "}
                      回溯历史截面。
                    </>
                  ) : activeProfile.isRequestPartitions ? (
                    <>
                      当前表存储形态为请求分区（
                      <code className="font-mono">
                        storage_layout=request_partitions
                      </code>{" "}
                      / <code className="font-mono">{activeProfile.grain}</code>
                      ），按完整原请求分区发布 Parquet 并原样保留所有返回行（不做 PIT、不跨报告期合并去重）；所有日期筛选按{" "}
                      <code className="font-mono">
                        {activeProfile.dateColumn || "end_date"}
                      </code>{" "}
                      解释，<code className="font-mono">days={formatNumber(warehouse.days)}</code>{" "}
                      表示已发布记录中出现的不同日期数（
                      <code className="font-mono">
                        record_dates_not_coverage
                      </code>
                      ），不代表交易日连续覆盖；导出锁定的{" "}
                      <code className="font-mono">
                        {mandatoryKeyColumns.join(" + ")}
                      </code>{" "}
                      仅为<strong>定位字段</strong>，绝不宣称为唯一主键。
                    </>
                  ) : activeProfile.isPeriodBar ? (
                    <>
                      当前表为周期 K 线（
                      <code className="font-mono">period_bar</code>
                      ），返回记录日期为周期结束日{" "}
                      <code className="font-mono">
                        {activeProfile.dateColumn || "trade_date"}
                      </code>
                      ，按业务键{" "}
                      <code className="font-mono">
                        {mandatoryKeyColumns.join(" + ")}
                      </code>{" "}
                      核验；<code className="font-mono">days</code>{" "}
                      统计的是已检查开市请求日数（含非周期末空响应日），不等于表中实际交易周/月周期数（有记录周期结束日见{" "}
                      <code className="font-mono">
                        days_with_rows={formatNumber(warehouse.days_with_rows ?? 0)}
                      </code>
                      ）。
                    </>
                  ) : activeProfile.isPositioningOnlyKeys ? (
                    <>
                      当前表数据形态为{" "}
                      <code className="font-mono">{activeProfile.grain}</code>
                      ，所有日期筛选与月分区均按{" "}
                      <code className="font-mono">
                        {activeProfile.dateColumn || "trade_date"}
                      </code>
                      （
                      {activeProfile.calendarBasis === "calendar_day"
                        ? "自然日口径"
                        : "开市日口径"}
                      ）解释；
                      {activeProfile.preservesDuplicateRows
                        ? "原样保留同日多条或重复原始明细（preserves_duplicate_rows=true，不做自动去重）；"
                        : ""}
                      导出锁定的{" "}
                      <code className="font-mono">
                        {mandatoryKeyColumns.join(" + ")}
                      </code>{" "}
                      仅为<strong>定位字段</strong>，绝不宣称为唯一主键；Int64 整数列按精确字符串无损传输。
                    </>
                  ) : (
                    <>
                      当前表为{" "}
                      <code className="font-mono">{activeProfile.grain}</code>
                      ，按日期列{" "}
                      <code className="font-mono">
                        {activeProfile.dateColumn || "trade_date"}
                      </code>{" "}
                      与业务键{" "}
                      <code className="font-mono">
                        {mandatoryKeyColumns.join(" + ")}
                      </code>{" "}
                      核验；已纳入切片通过 SHA256 核验，删除源 Raw 不会删除已发布仓库快照；Int64 整数列按精确文本无损传输。
                    </>
                  )}
                </span>
              </div>
              </details>

              {showPartitions && (
                <div className="space-y-3 border-t border-slate-100 pt-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] font-mono text-slate-600">
                    <div className="rounded-lg bg-slate-50 p-2.5 break-all ring-1 ring-inset ring-slate-200/70">
                      <div className="font-sans text-[10px] font-semibold text-slate-500 mb-0.5">
                        独立仓库托管地址（按 dataset_id 与 Raw 目录哈希隔离，非外部导入目录）
                      </div>
                      {warehouse.repository_root}
                    </div>
                    <div className="rounded-lg bg-slate-50 p-2.5 break-all ring-1 ring-inset ring-slate-200/70">
                      <div className="font-sans text-[10px] font-semibold text-slate-500 mb-0.5">
                        原子指针 current.json 路径
                      </div>
                      {warehouse.current_manifest_path}
                    </div>
                  </div>

                  {activeProfile.isCurrentSnapshot ? (
                    <div className="space-y-1.5">
                      <div className="text-xs font-semibold text-slate-700">
                        当前快照文件与来源切片（同一次完整成功运行：
                        <code className="ml-1 font-mono text-slate-600">
                          {warehouse.source_run_id || "未发布"}
                        </code>{" "}
                        · 来源切片数：{formatNumber(warehouse.partitions ?? 0)}）
                      </div>
                      {warehouse.months.length > 0 ? (
                        <div className="space-y-1.5">
                          {warehouse.months.map((m) => (
                            <div
                              key={m.month}
                              className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs space-y-0.5"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded bg-teal-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-teal-900">
                                  {m.month}
                                </span>
                                <span className="font-mono text-[11px] text-slate-700 tabular-nums">
                                  {formatNumber(warehouse.partitions ?? 0)} 个来源切片 ·{" "}
                                  {formatNumber(m.rows)} 行记录
                                </span>
                              </div>
                              <div className="font-mono text-[11px] text-slate-500 break-all">
                                快照文件：{m.file}
                              </div>
                              {m.sha256 && (
                                <div className="font-mono text-[10px] text-slate-400 break-all">
                                  SHA256：{m.sha256}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-slate-400">
                          当前尚未生成快照文件
                        </div>
                      )}
                    </div>
                  ) : activeProfile.isRequestPartitions ? (
                    warehouse.months.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-xs font-semibold text-slate-700">
                          已发布请求分区文件（共{" "}
                          {formatNumber(warehouse.months.length)} 个请求分区文件
                          {warehouse.months.length >
                          MAX_VISIBLE_REQUEST_PARTITIONS
                            ? `，为避免成千文件卡顿当前仅展示前 ${MAX_VISIBLE_REQUEST_PARTITIONS} 项`
                            : ""}
                          ；非自然月份分区）
                        </div>
                        <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto p-1">
                          {warehouse.months
                            .slice(0, MAX_VISIBLE_REQUEST_PARTITIONS)
                            .map((m) => (
                              <div
                                key={m.month}
                                title={
                                  m.sha256
                                    ? `分区标识：${m.label || m.month}\n文件：${m.file}\nSHA256：${m.sha256}`
                                    : `分区标识：${m.label || m.month}\n文件：${m.file}`
                                }
                                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs"
                              >
                                <span className="font-mono font-semibold text-slate-900">
                                  {m.label || `${m.month.slice(0, 12)}…`}
                                </span>
                                <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                                  {m.days}个记录日 · {formatNumber(m.rows)}行
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )
                  ) : (
                    warehouse.months.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-xs font-semibold text-slate-700">
                          已发布月度 Parquet 分区（按{" "}
                          <code className="font-mono">
                            {activeProfile.dateColumn || "trade_date"}
                          </code>{" "}
                          归属 YYYYMM，共 {warehouse.months.length} 个月，点击月份可快速筛选下方读表范围）
                        </div>
                        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto p-1">
                          {warehouse.months.map((m) => (
                            <button
                              key={m.month}
                              type="button"
                              onClick={() => {handleSelectMonthRange(m.month); setSnapshotOpen(false);}}
                              title={
                                m.sha256
                                  ? `文件：${m.file}\nSHA256：${m.sha256}`
                                  : `文件：${m.file}`
                              }
                              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs hover:border-teal-500 hover:bg-teal-50/50 transition-colors"
                            >
                              <span className="font-mono font-semibold text-slate-900">
                                {m.month}
                              </span>
                              <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                                {m.days}日 · {formatNumber(m.rows)}行
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
            </WorkspaceDrawer>
          )}

          {/* Variant Isolation Selector for request_partitions engines */}
          {isWarehouseReady &&
            activeProfile.supportsVariants &&
            statusVariants.length > 0 && (
              <div
                className={clsx(
                  "rounded-xl border p-4 shadow-sm space-y-2.5",
                  requiresVariantChoice
                    ? "border-amber-300 bg-amber-50/40"
                    : "border-violet-200 bg-white",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Layers className="h-4 w-4 text-violet-600" />
                    <span className="font-semibold text-slate-900">
                      请求变体选择（严格按选项维度隔离，不跨变体混表）
                    </span>
                    {statusVariants.length === 1 ? (
                      <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                        单变体已自动选中
                      </span>
                    ) : effectiveVariantId ? (
                      <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-800 ring-1 ring-inset ring-violet-600/20">
                        已选 1 / {statusVariants.length} 个变体（切换变体保持当前固定快照）
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-900">
                        共 {statusVariants.length} 个变体 · 必须先选择 1 个变体后再加载或导出
                      </span>
                    )}
                  </div>
                  {activeVariantObj && (
                    <code className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600">
                      variant_id: {activeVariantObj.id.slice(0, 12)}…
                    </code>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {statusVariants.map((v) => {
                    const selected = effectiveVariantId === v.id;
                    const label = formatWarehouseVariantLabel(v);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => handleSelectVariant(v.id)}
                        className={clsx(
                          "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-all",
                          selected
                            ? "border-violet-600 bg-violet-600 text-white shadow-sm"
                            : "border-slate-200 bg-white text-slate-800 hover:border-violet-400 hover:bg-violet-50/40",
                        )}
                      >
                        <span className="font-mono font-semibold">{label}</span>
                        <span
                          className={clsx(
                            "font-mono text-[10px] tabular-nums",
                            selected ? "text-violet-100" : "text-slate-500",
                          )}
                        >
                          {formatNumber(v.partitions)} 分区 ·{" "}
                          {formatNumber(v.rows)} 行
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

          {/* Slide-Over Bundle Exporter Drawer (no longer pushes data table off-screen) */}
          {isWarehouseReady && exportPanelOpen && warehouse && (
            <WorkspaceDrawer open={exportPanelOpen} title={`导出数据 · ${activeTitle}`}
              label={`裁剪导出 ${activeTitle} Bundle`} busy={exportBusy} onClose={() => setExportPanelOpen(false)}
              description={`固定快照 ${(pinnedSnapshotId || warehouse.snapshot_id)?.slice(0, 12)}… · ${activeProfile.isCurrentSnapshot ? "当前快照，不提供历史回溯。" : activeProfile.isRequestPartitions ? "仅导出所选变体，不做 PIT 合并。" : "按日期、代码与字段裁剪，不修改仓库。"}`}
              bodyClassName="flex min-h-0 flex-1 flex-col">
                <form
                  onSubmit={handleExportBundle}
                  className="flex flex-1 flex-col overflow-hidden"
                >
                  <div className="flex-1 overflow-y-auto p-5 space-y-4">
                    <button type="button" disabled={exportBusy} onClick={handleSyncReaderToExport}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 disabled:opacity-50">带入当前读表筛选条件</button>
                    <fieldset disabled={exportBusy} className="space-y-3 rounded-lg border border-slate-200 p-3 text-xs">
                      <legend className="px-1 font-semibold">文件组织与排序</legend>
                      <label className="flex items-center gap-2">文件组织
                        <select aria-label="导出文件组织" value={exportFileLayout}
                          onChange={event => {
                            const value = event.target.value;
                            setExportFileLayout(value === "grouped" ? "grouped" : value === "single" ? "single" : "partitioned");
                          }}
                          className="rounded border border-slate-300 p-2">
                          <option value="partitioned">多文件（不排序时保留源分区）</option>
                          <option value="single">合并为单个 Parquet</option>
                          <option value="grouped">按字段值拆分（每值一份）</option>
                        </select>
                      </label>
                      {exportFileLayout === "grouped" && (
                        <label className="flex flex-wrap items-center gap-2">拆分维度
                          <select aria-label="导出拆分维度" value={exportSplitBy}
                            onChange={event => setExportSplitBy(event.target.value)}
                            className="min-w-0 max-w-full rounded border border-slate-300 p-2">
                            <option value="">选择一个导出字段</option>
                            {exportSplitBy && !selectedColumns.has(exportSplitBy) && !mandatoryKeyColumns.includes(exportSplitBy) && (
                              <option value={exportSplitBy}>{exportSplitBy}（请勾选导出列）</option>
                            )}
                            {availableColumns.filter(column => selectedColumns.has(column) || mandatoryKeyColumns.includes(column)).map(column => (
                              <option key={column} value={column}>{column}{getFieldLabel(column) ? ` · ${getFieldLabel(column)}` : ""}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <p className="text-slate-600">
                        {exportFileLayout === "grouped"
                          ? "相同字段值跨源分区合成一份文件，空值独立一份，不再按百万行拆开。先按拆分字段排列文件（默认升序，可在排序中设降序），其他排序在各文件内生效，不保证其他字段跨文件全局有序。最多 10,000 组；请选择低基数维度，或缩小导出范围。"
                          : "按字段类型进行全局排序，空值放最后。排序多文件按连续行范围分片。"}
                        {" "}保留重复行，按清单 file_order 读取；清单记录拆分值与来源。重组使用临时磁盘空间，不修改源仓库。
                      </p>
                      {exportSortBy.map((key, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <span>{index + 1}.</span>
                          <select aria-label={`排序字段 ${index + 1}`} value={key.column}
                            onChange={event => setExportSortBy(keys => keys.map((item, i) => i === index ? {...item, column: event.target.value} : item))}
                            className="min-w-0 flex-1 rounded border p-2">
                            {!selectedColumns.has(key.column) && <option value={key.column}>{key.column}（请勾选导出列）</option>}
                            {availableColumns.filter(column => selectedColumns.has(column) && (column === key.column || !exportSortBy.some(item => item.column === column))).map(column => <option key={column} value={column}>{column}</option>)}
                          </select>
                          <select aria-label={`排序方向 ${index + 1}`} value={key.direction}
                            onChange={event => setExportSortBy(keys => keys.map((item, i) => i === index ? {...item, direction: event.target.value === "desc" ? "desc" : "asc"} : item))}
                            className="rounded border p-2">
                            <option value="asc">升序</option><option value="desc">降序</option>
                          </select>
                          <button type="button" onClick={() => setExportSortBy(keys => keys.filter((_, i) => i !== index))} className="rounded border px-2 py-2">移除</button>
                        </div>
                      ))}
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={exportSortBy.length >= 10 || !availableColumns.some(column => selectedColumns.has(column) && !exportSortBy.some(key => key.column === column))}
                          onClick={() => {
                            const column = availableColumns.find(column => selectedColumns.has(column) && !exportSortBy.some(key => key.column === column));
                            if (column) setExportSortBy(keys => [...keys, {column, direction: "asc"}]);
                          }} className="rounded border px-3 py-2 disabled:opacity-50">添加排序字段</button>
                        <button type="button" onClick={() => setExportSortBy([])} className="rounded border px-3 py-2">不额外排序</button>
                        {activeProfile.dateColumn && selectedColumns.has("ts_code") && selectedColumns.has(activeProfile.dateColumn) && <>
                          <button type="button" onClick={() => setExportSortBy([{column: activeProfile.dateColumn!, direction: "asc"}, {column: "ts_code", direction: "asc"}])} className="rounded border px-3 py-2">日期 → 股票代码</button>
                          <button type="button" onClick={() => setExportSortBy([{column: "ts_code", direction: "asc"}, {column: activeProfile.dateColumn!, direction: "asc"}])} className="rounded border px-3 py-2">股票代码 → 日期</button>
                        </>}
                      </div>
                    </fieldset>
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div
                    className={
                      activeProfile.supportsDateFilter
                        ? "md:col-span-6"
                        : "md:col-span-7"
                    }
                  >
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      目标导出根目录（绝对路径）
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={exportDestination}
                        disabled={exportBusy}
                        onChange={(e) => setExportDestination(e.target.value)}
                        placeholder="/Users/.../exports"
                        className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono text-slate-900"
                      />
                      <button
                        type="button"
                        disabled={pickingDir || exportBusy}
                        onClick={handlePickExportDir}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        {pickingDir ? "选择中…" : "选择目录"}
                      </button>
                    </div>
                  </div>

                  {activeProfile.supportsDateFilter ? (
                    <>
                      <div className="md:col-span-3">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          {activeProfile.startDateFieldLabel} (YYYYMMDD
                          {activeProfile.isRequestPartitions ? "，可选" : ""})
                        </label>
                        <input
                          type="text"
                          value={exportStartDate}
                          disabled={exportBusy}
                          onChange={(e) => setExportStartDate(e.target.value)}
                          placeholder={
                            warehouse.first_date ||
                            (activeProfile.isRequestPartitions
                              ? "留空导出全部"
                              : "20180101")
                          }
                          className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
                        />
                      </div>

                      <div className="md:col-span-3">
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          {activeProfile.endDateFieldLabel} (YYYYMMDD
                          {activeProfile.isRequestPartitions ? "，可选" : ""})
                        </label>
                        <input
                          type="text"
                          value={exportEndDate}
                          disabled={exportBusy}
                          onChange={(e) => setExportEndDate(e.target.value)}
                          placeholder={
                            warehouse.last_date ||
                            (activeProfile.isRequestPartitions
                              ? "留空导出全部"
                              : "20261116")
                          }
                          className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
                        />
                      </div>
                    </>
                  ) : (
                    <div className="md:col-span-5 flex items-end">
                      <div className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                        当前完整快照无起止日期参数（导出不传{" "}
                        <code className="font-mono">start_date / end_date</code>
                        ，不按 <code className="font-mono">list_date</code>{" "}
                        伪装历史股票池筛选）
                      </div>
                    </div>
                  )}
                </div>

                {activeProfile.supportsCodeFilter ? (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-700">
                        {activeProfile.exportCodeLabel}
                      </label>
                      {exportTsCodesText && (
                        <button
                          type="button"
                          onClick={() => setExportTsCodesText("")}
                          className="text-[11px] text-slate-500 hover:text-slate-800"
                        >
                          清空（恢复全部）
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={exportTsCodesText}
                      disabled={exportBusy}
                      onChange={(e) => setExportTsCodesText(e.target.value)}
                      placeholder={activeProfile.exportTsCodesPlaceholder}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
                    />
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                    当前表不含证券/板块代码筛选（
                    <code className="font-mono">code_filter=none</code>
                    ），导出请求不传 <code className="font-mono">ts_codes</code>{" "}
                    参数。
                  </div>
                )}

                {/* Dynamic Column Projection Selector with Presets & Large-Schema Search */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-700">
                      导出字段选择（已选{" "}
                      <code className="font-mono">
                        {
                          availableColumns.filter(
                            (c) =>
                              mandatoryKeyColumns.includes(c) ||
                              selectedColumns.has(c),
                          ).length
                        }
                        /{availableColumns.length}
                      </code>{" "}
                      · {activeProfile.mandatoryKeysTitle}{" "}
                      <code className="font-mono">
                        {mandatoryKeyColumns.join(" / ")}
                      </code>{" "}
                      {activeProfile.mandatoryKeysHint}）
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      {availableColumns.length > 20 && (
                        <input
                          type="search"
                          value={exportColumnQuery}
                          onChange={(e) => setExportColumnQuery(e.target.value)}
                          placeholder={`过滤 ${availableColumns.length} 个字段…`}
                          aria-label="过滤导出字段"
                          className="w-40 rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-800"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedColumns(new Set(availableColumns))
                        }
                        className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-100"
                      >
                        全选全部列 ({availableColumns.length})
                      </button>
                      {columnPresets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() =>
                            setSelectedColumns(
                              new Set(
                                availableColumns.filter(
                                  (c) =>
                                    mandatoryKeyColumns.includes(c) ||
                                    preset.columns.includes(c),
                                ),
                              ),
                            )
                          }
                          className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-100"
                        >
                          {preset.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedColumns(new Set(mandatoryKeyColumns))
                        }
                        className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700 hover:bg-slate-100"
                      >
                        {activeProfile.resetMandatoryButtonLabel}
                      </button>
                    </div>
                  </div>

                  <div className="max-h-80 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                    {filteredExportColumns.map((col) => {
                      const locked = mandatoryKeyColumns.includes(col);
                      const checked = locked || selectedColumns.has(col);
                      const dtype = formatFieldDtype(fieldMetaMap.get(col));
                      const fieldLabel = getFieldLabel(col);
                      return (
                        <label
                          key={col}
                          className={clsx(
                            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs select-none transition-colors",
                            locked
                              ? "border-slate-300 bg-slate-100 text-slate-800 cursor-not-allowed"
                              : checked
                                ? "border-teal-500/50 bg-teal-50/70 text-teal-950 cursor-pointer"
                                : "border-slate-200 bg-white text-slate-600 cursor-pointer hover:bg-slate-50",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked || exportBusy}
                            onChange={() => toggleExportColumn(col)}
                            className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600"
                          />
                          <div className="min-w-0 flex-1 truncate">
                            <div className="font-mono text-[11px] font-semibold flex items-center gap-1">
                              <span className="truncate">{col}</span>
                              {locked && (
                                <Lock className="h-2.5 w-2.5 shrink-0 text-slate-400" />
                              )}
                            </div>
                            <div className="flex items-center gap-1 text-[10px] text-slate-500 truncate">
                              {fieldLabel && (
                                <span className="truncate" title={fieldLabel}>
                                  {fieldLabel}
                                </span>
                              )}
                              {dtype.label && (
                                <span
                                  className={clsx(
                                    "shrink-0 font-mono text-[9px]",
                                    dtype.isInt64
                                      ? "text-indigo-600 font-semibold"
                                      : "text-slate-400",
                                  )}
                                >
                                  {dtype.label}
                                </span>
                              )}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {exportError && (
                  <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
                    {exportError}
                  </div>
                )}

                {exportResult && (
                  <div className="rounded-xl bg-emerald-50 p-3.5 text-xs text-emerald-950 ring-1 ring-inset ring-emerald-600/20 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                        <span>
                          {(
                            <>
                              已生成「{exportResult.name || activeTitle}」独立导出 Bundle：共{" "}
                              {formatNumber(exportResult.files)} 份 Parquet ·{" "}
                              {formatNumber(exportResult.rows)} 行
                            </>
                          )}
                        </span>
                      </div>
                      <code className="rounded bg-white/90 px-2 py-0.5 font-mono text-[11px] text-emerald-800 ring-1 ring-emerald-600/20">
                        源快照：{exportResult.snapshot_id}
                      </code>
                    </div>

                    <div className="rounded-lg bg-white/80 p-2.5 font-mono text-[11px] text-emerald-900 space-y-1 break-all">
                      <div>
                        数据集：{exportResult.dataset_id || activeDatasetId} · Bundle ID：
                        {exportResult.bundle_id}
                        {exportResult.variant_id
                          ? ` · variant_id：${exportResult.variant_id}`
                          : ""}
                      </div>
                      <div>
                        导出结果目录：{exportResult.directory}（后处理请直接读取组内{" "}
                        {exportResult.file_layout === "single" ? "data/data.parquet" : "data/*.parquet（顺序见清单 file_order）"}
                        ，勿混读根级元数据清单）
                      </div>
                      <div>
                        文件组织：{exportResult.file_layout === "grouped" ? `按 ${exportResult.split_by} 拆分（每值一份）` : exportResult.file_layout === "single" ? "单文件" : "多文件"} · {exportResult.file_layout === "grouped" ? "组内排序" : "排序"}：{exportResult.sort_by?.length ? exportResult.sort_by.map(key => `${key.column} ${key.direction === "asc" ? "升序" : "降序"}`).join(" → ") : "不额外排序"}
                      </div>
                      <div>
                        清单路径：{exportResult.manifest_path}（附带{" "}
                        source_snapshot.json 快照溯源）
                      </div>
                      <div>
                        {activeProfile.isCurrentSnapshot
                          ? "数据形态：当前完整快照（无起止日期）"
                          : exportResult.start_date || exportResult.end_date
                            ? `${activeProfile.dateAxisLabel}：${exportResult.start_date || "起点"} ~ ${exportResult.end_date || "终点"}`
                            : `${activeProfile.dateAxisLabel}：当前变体全部分区`}{" "}
                        · 字段 (
                        {exportResult.columns.length > 0
                          ? exportResult.columns.length
                          : availableColumns.length}
                        )：
                        {(exportResult.columns.length > 0
                          ? exportResult.columns
                          : availableColumns
                        ).join(", ")}
                      </div>
                    </div>
                  </div>
                )}

                  </div>

                  <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/90 px-5 py-3.5 shrink-0">
                    <button
                      type="button"
                      disabled={exportBusy}
                      onClick={() => setExportPanelOpen(false)}
                      className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      收起面板
                    </button>
                    <button
                      type="submit"
                      disabled={exportBusy || requiresVariantChoice}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
                    >
                      <HardDriveDownload className="h-3.5 w-3.5" />
                      {exportBusy
                        ? "正在筛选投影并导出 Bundle…"
                        : requiresVariantChoice
                          ? "请先在上方选择 1 个变体后再导出"
                          : `导出「${activeTitle}」${exportFileLayout === "grouped" ? "按维度拆分" : exportFileLayout === "single" ? "单文件" : "多文件"} Parquet Bundle`}
                    </button>
                  </div>
                </form>
            </WorkspaceDrawer>
          )}

          {/* Main Warehouse Table Reader */}
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            {(!warehouse || loadedDatasetId !== activeDatasetId) &&
            statusLoading ? (
              <div className="flex h-80 items-center justify-center gap-2 text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
                正在读取「{activeTitle}」本地仓库状态…
              </div>
            ) : !isWarehouseReady ? (
              <div className="flex h-80 flex-col items-center justify-center p-6 text-center space-y-3">
                <Database className="h-9 w-9 text-slate-300" />
                <div className="text-sm font-semibold text-slate-800">
                  {warehouse && loadedDatasetId === activeDatasetId
                    ? activeProfile.isCurrentSnapshot &&
                      (warehouse.available_source_partitions ?? 0) > 0
                      ? `检测到本地已有完整成功运行的 ${formatNumber(warehouse.available_source_partitions ?? 0)} 个「${activeTitle}」来源切片，尚未整理建仓`
                      : activeProfile.isRequestPartitions &&
                          (warehouse.available_source_partitions ?? 0) > 0
                        ? `检测到本地已有 ${formatNumber(warehouse.available_source_partitions ?? 0)} 个「${activeTitle}」请求分区归档，尚未整理建仓`
                        : !activeProfile.isCurrentSnapshot &&
                            !activeProfile.isRequestPartitions &&
                            warehouse.available_source_days > 0
                          ? `检测到本地已有 ${formatNumber(warehouse.available_source_days)} 个${activeProfile.dayUnitLabel}的「${activeTitle}」预置归档，尚未整理建仓`
                          : `「${activeTitle} (${activeApiName})」本地仓库尚无已发布快照`
                    : `「${activeTitle} (${activeApiName})」本地仓库尚无已发布快照`}
                </div>
                <p className="max-w-lg text-xs text-slate-500 leading-relaxed">
                  发布快照后才能查询。打开“更新数据”，按需检查补采并离线整理；不会自动请求 Tushare。
                </p>
                <button type="button" onClick={() => setMaintenanceOpen(true)}
                  className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-medium text-white">准备数据</button>
              </div>
            ) : (
              <div className="flex flex-col">
                {/* Reader Filter Bar */}
                <div className="border-b border-slate-200 bg-slate-50/70 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileSpreadsheet className="h-4 w-4 text-teal-600" />
                      <h3 className="text-sm font-semibold text-slate-900">本地记录</h3>
                      {activeProfile.isRequestPartitions && <span className="text-[11px] text-slate-500">按 {activeProfile.dateColumn || "end_date"} 过滤，不做 PIT 合并</span>}
                      {activeVariantObj && (
                        <span className="rounded-full bg-violet-50 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-violet-800 ring-1 ring-inset ring-violet-600/20">
                          变体：{formatWarehouseVariantLabel(activeVariantObj)}
                        </span>
                      )}
                      {rowsPage?.hash_verified && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {activeProfile.isCurrentSnapshot
                            ? "快照文件 SHA256 已核验"
                            : activeProfile.isRequestPartitions
                              ? "请求分区 SHA256 已核验"
                              : "月分区 SHA256 已核验"}
                        </span>
                      )}
                      {(rowsPage?.snapshot_id || pinnedSnapshotId) && (
                        <code className="rounded bg-white px-2 py-0.5 font-mono text-[11px] text-slate-600 ring-1 ring-slate-200">
                          读取固定快照：
                          {(rowsPage?.snapshot_id || pinnedSnapshotId)?.slice(
                            0,
                            10,
                          )}
                          …
                        </code>
                      )}
                      {hasNewerSnapshot && (
                        <button
                          type="button"
                          onClick={() => {
                            if (
                              !warehouse?.snapshot_id ||
                              !hasWarehouseSnapshotOwnership(
                                activeDatasetId, selectedDatasetRef.current, loadedWarehouse, pinnedSnapshot,
                              )
                            ) return;
                            setPinnedSnapshot({
                              datasetId: activeDatasetId,
                              epoch: selectedDatasetRef.current.epoch,
                              snapshotId: warehouse.snapshot_id,
                            });
                            setRowOffset(0);
                          }}
                          className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-200"
                        >
                          切换到最新快照读取
                        </button>
                      )}
                    </div>

                    {activeProfile.supportsDateFilter && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="text-slate-500">快捷区间：</span>
                        {(activeProfile.isRequestPartitions
                          ? ([
                              [
                                "all",
                                `全部${activeProfile.dateShortLabel || "日期"}`,
                              ],
                              ["latest", "最新日"],
                              ["1m", "近1月"],
                              ["3m", "近3月"],
                              ["1y", "近1年"],
                              ["ytd", "今年以来"],
                            ] as const)
                          : ([
                              [
                                "all",
                                `全部${activeProfile.dateShortLabel || "日期"}`,
                              ],
                              ["latest", "最新日"],
                              ["1m", "近1月"],
                              ["3m", "近3月"],
                              ["1y", "近1年"],
                              ["ytd", "今年以来"],
                              ["20d", "近20已检日"],
                            ] as const)
                        ).map(([k, label]) => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => handleQuickRange(k)}
                            className="rounded border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 hover:bg-slate-100"
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <form
                    onSubmit={handleReaderSubmit}
                    className="flex flex-wrap items-center gap-2"
                  >
                    {activeProfile.supportsCodeFilter ? (
                      <div className="relative min-w-44 flex-1 max-w-xs">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="text"
                          value={tsCodeInput}
                          onChange={(e) => setTsCodeInput(e.target.value)}
                          placeholder={activeProfile.tsCodePlaceholder}
                          aria-label={`查询${activeProfile.codeEntityLabel || "代码"}`}
                          className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                    ) : (
                      <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-500">
                        无代码筛选（仅按 {activeProfile.dateColumn || "trade_date"} 查询）
                      </span>
                    )}

                    {activeProfile.supportsDateFilter && (
                      <>
                        <input
                          type="text"
                          value={startDateInput}
                          onChange={(e) => setStartDateInput(e.target.value)}
                          placeholder={`${activeProfile.startDateFieldLabel} ${warehouse?.first_date || "YYYYMMDD"}`}
                          aria-label={`查询${activeProfile.startDateFieldLabel}`}
                          className="w-44 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono"
                        />
                        <span className="text-xs text-slate-400">至</span>
                        <input
                          type="text"
                          value={endDateInput}
                          onChange={(e) => setEndDateInput(e.target.value)}
                          placeholder={`${activeProfile.endDateFieldLabel} ${warehouse?.last_date || "YYYYMMDD"}`}
                          aria-label={`查询${activeProfile.endDateFieldLabel}`}
                          className="w-44 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono"
                        />
                      </>
                    )}

                    <select
                      value={rowLimit}
                      onChange={(e) => {
                        setRowLimit(Number(e.target.value));
                        setInspectedRowIndex(null);
                        setRowOffset(0);
                      }}
                      aria-label="每页显示行数"
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono"
                    >
                      <option value={50}>50 行/页</option>
                      <option value={100}>100 行/页</option>
                      <option value={200}>200 行/页</option>
                    </select>

                    <button
                      type="submit"
                      disabled={rowsLoading}
                      className="rounded-lg bg-navy-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-navy-800 disabled:opacity-50"
                    >
                      查询记录
                    </button>

                    {(appliedFilters.tsCode ||
                      appliedFilters.startDate ||
                      appliedFilters.endDate) && (
                      <button
                        type="button"
                        onClick={() => applyReaderQuery("", "", "", true)}
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                      >
                        重置筛选
                      </button>
                    )}

                    {/* Wide-Table Instant Column Filter */}
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <div className="relative w-52">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input
                          type="search"
                          value={readerColumnQuery}
                          onChange={(e) => setReaderColumnQuery(e.target.value)}
                          placeholder={`过滤显示列（共 ${rowsPage?.columns.length ?? availableColumns.length} 列）…`}
                          aria-label="过滤直读表格显示列"
                          className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2.5 py-1.5 text-xs text-slate-900 focus:border-teal-600 focus:outline-none"
                        />
                      </div>
                      {visibleReaderColumnResult.isFiltered && (
                        <>
                          <span className="rounded-md bg-teal-50 px-2 py-1 font-mono text-[11px] font-medium text-teal-800 ring-1 ring-inset ring-teal-600/20 tabular-nums">
                            显示 {visibleReaderColumnResult.visibleCount}/
                            {visibleReaderColumnResult.total} 列
                          </span>
                          <button
                            type="button"
                            onClick={() => setReaderColumnQuery("")}
                            className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                          >
                            全部列
                          </button>
                        </>
                      )}
                    </div>
                  </form>
                </div>

                {rowsError && (
                  <div className="p-4 text-xs text-rose-700 bg-rose-50 border-b border-rose-100">
                    {rowsError}
                  </div>
                )}

                {/* Data Table */}
                <div className="overflow-x-auto max-h-[34rem]">
                  {requiresVariantChoice ? (
                    <div className="flex h-64 flex-col items-center justify-center gap-3 p-6 text-center">
                      <Layers className="h-8 w-8 text-amber-500" />
                      <div className="space-y-1 max-w-lg">
                        <div className="text-sm font-semibold text-slate-900">
                          请先选择 1 个请求变体后再加载「{activeTitle}」记录
                        </div>
                        <p className="text-xs text-slate-600 leading-relaxed">
                          当前固定快照包含 {statusVariants.length} 个互斥请求变体（例如不同分类、频率或交易所参数）。为保证语义纯粹，系统绝不自动混表或默认合并，请点击选择其中一个变体：
                        </p>
                      </div>
                      <div className="flex flex-wrap justify-center gap-2 pt-1">
                        {statusVariants.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => handleSelectVariant(v.id)}
                            className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-3.5 py-1.5 text-xs font-semibold text-violet-900 hover:bg-violet-100"
                          >
                            <span className="font-mono">
                              {formatWarehouseVariantLabel(v)}
                            </span>
                            <span className="font-mono text-[10px] font-normal text-violet-700">
                              {formatNumber(v.partitions)} 分区 ·{" "}
                              {formatNumber(v.rows)} 行
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : rowsLoading && !rowsPage ? (
                    <div className="flex h-64 items-center justify-center gap-2 text-xs text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
                      {activeProfile.isCurrentSnapshot
                        ? `正在核验读取「${activeTitle}」当前快照记录…`
                        : activeProfile.isRequestPartitions
                          ? `正在跨请求分区核验读取「${activeTitle}」记录…`
                          : `正在跨月分区核验读取「${activeTitle}」记录…`}
                    </div>
                  ) : rowsPage ? (
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 sticky top-0 z-20">
                        <tr>
                          <th className="sticky-col-idx-head px-3 py-2 text-right font-mono text-[10px] text-slate-400 bg-slate-50">
                            #
                          </th>
                          {visibleReaderColumnResult.indices.map(
                            (colIdx, visIdx) => {
                              const col = rowsPage.columns[colIdx]!;
                              const dtype = formatFieldDtype(
                                fieldMetaMap.get(col),
                              );
                              const fieldLabel = getFieldLabel(col);
                              return (
                                <th
                                  key={col}
                                  className={clsx(
                                    "px-3 py-2 text-left font-semibold text-slate-700 whitespace-nowrap bg-slate-50",
                                    visIdx === 0 && "sticky-col-first-head",
                                  )}
                                >
                                  <div className="flex items-center gap-1 font-mono">
                                    <span>{col}</span>
                                    {dtype.label && (
                                      <span
                                        className={clsx(
                                          "rounded px-1 py-0.2 text-[9px] font-normal",
                                          dtype.isInt64
                                            ? "bg-indigo-50 text-indigo-700 font-semibold"
                                            : "bg-slate-100 text-slate-500",
                                        )}
                                      >
                                        {dtype.label}
                                      </span>
                                    )}
                                  </div>
                                  {fieldLabel && (
                                    <div className="text-[10px] font-normal text-slate-400">
                                      {fieldLabel}
                                    </div>
                                  )}
                                </th>
                              );
                            },
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                        {rowsPage.rows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={
                                visibleReaderColumnResult.indices.length + 1
                              }
                              className="py-12 text-center font-sans text-slate-400"
                            >
                              {activeProfile.isCurrentSnapshot
                                ? `当前股票代码筛选条件下没有匹配的「${activeTitle}」记录`
                                : !activeProfile.supportsCodeFilter
                                  ? `当前日期（${activeProfile.dateColumn || "trade_date"}）筛选条件下没有匹配的「${activeTitle}」记录`
                                  : `当前日期（${activeProfile.dateColumn || "trade_date"}）或${activeProfile.codeEntityLabel || "代码"}筛选条件下没有匹配的「${activeTitle}」记录`}
                            </td>
                          </tr>
                        ) : (
                          rowsPage.rows.map((row, rIdx) => (
                            <tr
                              key={rIdx}
                              onClick={() => setInspectedRowIndex(rIdx)}
                              title="点击查看此行全部字段纵向详情与复制"
                              className="group cursor-pointer hover:bg-slate-50"
                            >
                              <td className="sticky-col-idx-cell bg-white group-hover:bg-slate-50 px-3 py-1.5 text-right text-slate-400 group-hover:text-teal-700 tabular-nums underline-offset-2 group-hover:underline">
                                {rowsPage.offset + rIdx + 1}
                              </td>
                              {visibleReaderColumnResult.indices.map(
                                (colIdx, visIdx) => {
                                  const cell = row[colIdx];
                                  const colName = rowsPage.columns[colIdx];
                                  const isNull =
                                    cell === null || cell === undefined;
                                  const formatted = isNull
                                    ? "NULL"
                                    : cellText(cell);
                                  const isFilterableCode =
                                    !isNull &&
                                    activeProfile.supportsCodeFilter &&
                                    colName === activeProfile.codeColumn;
                                  return (
                                    <td
                                      key={colIdx}
                                      className={clsx(
                                        "px-3 py-1.5 whitespace-nowrap max-w-xs truncate tabular-nums",
                                        visIdx === 0 &&
                                          "sticky-col-first-cell bg-white group-hover:bg-slate-50",
                                        isNull
                                          ? "italic text-slate-300"
                                          : visIdx === 0
                                            ? "font-semibold text-slate-900"
                                            : "text-slate-800",
                                      )}
                                    >
                                      {isFilterableCode ? (
                                        <span className="inline-flex items-center gap-1.5">
                                          <span>{formatted}</span>
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              applyReaderQuery(
                                                appliedFilters.startDate,
                                                appliedFilters.endDate,
                                                formatted,
                                                false,
                                              );
                                            }}
                                            title={`仅筛选 ${formatted}`}
                                            className="hidden group-hover:inline-flex rounded bg-teal-50 px-1 py-0.2 font-sans text-[10px] font-medium text-teal-700 ring-1 ring-inset ring-teal-600/20 hover:bg-teal-100"
                                          >
                                            筛此码
                                          </button>
                                        </span>
                                      ) : (
                                        formatted
                                      )}
                                    </td>
                                  );
                                },
                              )}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  ) : null}
                </div>

                {/* Pagination Footer (always preserves pinned snapshot_id) */}
                {rowsPage && (
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
                    <span className="font-mono tabular-nums">
                      匹配 {formatNumber(rowsPage.matching_rows)} / 快照总计{" "}
                      {formatNumber(rowsPage.total_rows)} 行（当前显示{" "}
                      {rowsPage.rows.length > 0 ? rowsPage.offset + 1 : 0}–
                      {rowsPage.offset + rowsPage.rows.length}）
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={rowsLoading || rowOffset === 0}
                        onClick={() => {
                          setInspectedRowIndex(null);
                          setRowOffset(Math.max(0, rowOffset - rowLimit));
                        }}
                        className="rounded border border-slate-200 bg-white px-2.5 py-1 disabled:opacity-40"
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        disabled={rowsLoading || rowsPage.next_offset === null}
                        onClick={() => {
                          setInspectedRowIndex(null);
                          setRowOffset(rowsPage.next_offset ?? rowOffset);
                        }}
                        className="rounded border border-slate-200 bg-white px-2.5 py-1 disabled:opacity-40"
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                )}

                {rowsPage &&
                  inspectedRowIndex !== null &&
                  rowsPage.rows[inspectedRowIndex] && (
                    <RowDetailDrawer
                      open={true}
                      title={`${activeTitle} (${activeApiName})`}
                      subtitle={`快照 ${(rowsPage.snapshot_id || pinnedSnapshotId || "").slice(0, 12)}…`}
                      rowNumber={rowsPage.offset + inspectedRowIndex + 1}
                      canPrev={inspectedRowIndex > 0}
                      canNext={inspectedRowIndex < rowsPage.rows.length - 1}
                      onPrev={() =>
                        setInspectedRowIndex((prev) =>
                          prev !== null && prev > 0 ? prev - 1 : prev,
                        )
                      }
                      onNext={() =>
                        setInspectedRowIndex((prev) =>
                          prev !== null && prev < rowsPage.rows.length - 1
                            ? prev + 1
                            : prev,
                        )
                      }
                      onClose={() => setInspectedRowIndex(null)}
                      columns={readerColumnsMeta}
                      values={rowsPage.rows[inspectedRowIndex]!}
                      codeColumnName={
                        activeProfile.supportsCodeFilter
                          ? activeProfile.codeColumn
                          : null
                      }
                      onFilterByCode={
                        activeProfile.supportsCodeFilter
                          ? (codeVal) =>
                              applyReaderQuery(
                                appliedFilters.startDate,
                                appliedFilters.endDate,
                                codeVal,
                                false,
                              )
                          : undefined
                      }
                    />
                  )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
