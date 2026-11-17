import {
  normalizeWorkspaceHash as rawNormalizeWorkspaceHash,
  datasetEvidence as rawDatasetEvidence,
  runOutcome as rawRunOutcome,
  runRecovery as rawRunRecovery,
  assertDraftSafe as rawAssertDraftSafe,
  canGuide as rawCanGuide,
  cellText as rawCellText,
  collectionScope as rawCollectionScope,
  commonAPIs as rawCommonAPIs,
  datasetPresentation as rawDatasetPresentation,
  datasetRuleLabel as rawDatasetRuleLabel,
  errorMessage as rawErrorMessage,
  filteredEntries as rawFilteredEntries,
  parameterChoices as rawParameterChoices,
  parameterLabels as rawParameterLabels,
  parameterText as rawParameterText,
  parseObject as rawParseObject,
  parseValues as rawParseValues,
  states as rawStates,
  stockCategoryGroups as rawStockCategoryGroups,
  taskTemplate as rawTaskTemplate,
  advanceActivityCursor as rawAdvanceActivityCursor,
  matchesPermissionFilter as rawMatchesPermissionFilter,
  formatPermissionRpm as rawFormatPermissionRpm,
  formatPermissionThreshold as rawFormatPermissionThreshold,
  describeWorkerSettingState as rawDescribeWorkerSettingState,
  BUSINESS_DOMAIN_ORDER as rawBusinessDomainOrder,
  resolveArchiveSourceType as rawResolveArchiveSourceType,
  archiveSourceLabel as rawArchiveSourceLabel,
  formatRequestCondition as rawFormatRequestCondition,
  groupNavigationEntriesByDomain as rawGroupNavigationEntriesByDomain,
  EXPORT_LAYOUT_OPTIONS as rawExportLayoutOptions,
  normalizeExportLayout as rawNormalizeExportLayout,
  summarizeExportResult as rawSummarizeExportResult,
  DAILY_WAREHOUSE_KEY_COLUMNS as rawDailyWarehouseKeyColumns,
  STOCK_BASIC_KEY_COLUMNS as rawStockBasicKeyColumns,
  DIVIDEND_POSITION_COLUMNS as rawDividendPositionColumns,
  SUPPORTED_WAREHOUSE_DATASETS as rawSupportedWarehouseDatasets,
  DAILY_WAREHOUSE_DEFAULT_COLUMNS as rawDailyWarehouseDefaultColumns,
  WAREHOUSE_FIELD_LABELS as rawWarehouseFieldLabels,
  DAILY_FIELD_LABELS as rawDailyFieldLabels,
  WAREHOUSE_COLUMN_PRESETS as rawWarehouseColumnPresets,
  BUSINESS_DOMAIN_NAMES as rawBusinessDomainNames,
  normalizeCompactDate as rawNormalizeCompactDate,
  normalizeWarehouseTsCode as rawNormalizeWarehouseTsCode,
  parseTsCodeList as rawParseTsCodeList,
  resolveWarehouseFieldLabel as rawResolveWarehouseFieldLabel,
  buildWarehouseExportColumns as rawBuildWarehouseExportColumns,
  resolvePinnedSnapshotId as rawResolvePinnedSnapshotId,
  resolveSelectedVariantId as rawResolveSelectedVariantId,
  formatWarehouseVariantLabel as rawFormatWarehouseVariantLabel,
  resolveWarehouseProfile as rawResolveWarehouseProfile,
  buildWarehouseRowsQuery as rawBuildWarehouseRowsQuery,
  buildWarehouseExportPayload as rawBuildWarehouseExportPayload,
  filterAndGroupWarehouseCatalog as rawFilterAndGroupWarehouseCatalog,
  filterVisibleTableColumns as rawFilterVisibleTableColumns,
  computeAnchorQuickRange as rawComputeAnchorQuickRange,
} from "../../../src/collector/static/helpers.js";
import type {
  ActivityWorker,
  ApiAccess,
  ArchiveSourceType,
  Catalog,
  CatalogCategory,
  CatalogEntry,
  DatasetItem,
  DatasetMode,
  DatasetPartition,
  DatasetPlan,
  DatasetReturnDraft,
  ExportLayout,
  ExportResult,
  LocalDataDomainSummary,
  LocalDataItem,
  LocalDataNavigation,
  LocalDataNavigationEntry,
  TaskConfigPayload,
  WarehouseCatalogEntry,
  WorkerSettings,
  DailyWarehouseStatus,
  RunSummary,
  SliceItem,
} from "../types";

export function normalizeWorkspaceHash(hash: string): string {
  return rawNormalizeWorkspaceHash(hash);
}

export function datasetEvidence(dataset: DatasetItem, warehouse?: DailyWarehouseStatus | null): {
  execution: string; freshness: string; quality: string; timeliness: string;
} {
  return rawDatasetEvidence(dataset, warehouse);
}

export function runOutcome(run: RunSummary): string {
  return rawRunOutcome(run);
}

export function runRecovery(run: RunSummary, slices: SliceItem[] = []): {
  kind: string; label: string; retry: boolean;
} | null {
  return rawRunRecovery(run, slices);
}

export const states: Record<string, string> = rawStates;
export const commonAPIs: Set<string> = rawCommonAPIs;
export const parameterLabels: Record<string, string> = rawParameterLabels;
export const parameterChoices =
  rawParameterChoices as unknown as Record<string, Array<[string, string]>>;

export interface DatasetPresentation {
  status: string;
  kind: "active" | "attention" | "ready" | "empty" | "unknown";
  action: string;
}

export function datasetPresentation(dataset: DatasetItem): DatasetPresentation {
  return rawDatasetPresentation(dataset) as DatasetPresentation;
}

export function datasetRuleLabel(dataset: Partial<DatasetItem>): string {
  return rawDatasetRuleLabel(dataset);
}

export function cellText(value: unknown): string {
  return rawCellText(value);
}

export function parameterText(params: Record<string, unknown>): string {
  return rawParameterText(params);
}

export function collectionScope(config: TaskConfigPayload): string[] {
  return rawCollectionScope(config);
}

export function canGuide(entry: CatalogEntry, params: Record<string, unknown>): boolean {
  return rawCanGuide(entry, params);
}

export function taskTemplate(
  apiName: string,
  kind: "day" | "range",
  today: string,
): {
  params: Record<string, string>;
  mode: "single" | "date_range";
  start_date: string;
  end_date: string;
  label: string;
} {
  return rawTaskTemplate(apiName, kind, today) as {
    params: Record<string, string>;
    mode: "single" | "date_range";
    start_date: string;
    end_date: string;
    label: string;
  };
}

export function assertDraftSafe(paramsText: string): void {
  rawAssertDraftSafe(paramsText);
}

export function parseObject(text: string): Record<string, unknown> {
  return rawParseObject(text) as Record<string, unknown>;
}

export function parseValues(text: string): Array<string | number | boolean> {
  return rawParseValues(text) as Array<string | number | boolean>;
}

export function errorMessage(detail: unknown): string {
  return rawErrorMessage(detail);
}

export function filteredEntries(
  entries: CatalogEntry[],
  category: string,
  search: string,
): CatalogEntry[] {
  return rawFilteredEntries(entries, category, search) as CatalogEntry[];
}

export function stockCategoryGroups(
  catalog: Catalog,
  entries?: CatalogEntry[],
): Array<CatalogCategory & { entries: CatalogEntry[] }> {
  return rawStockCategoryGroups(catalog, entries) as Array<
    CatalogCategory & { entries: CatalogEntry[] }
  >;
}

export function advanceActivityCursor(
  currentCursor: number,
  events: Array<{ seq: number }>,
  latestSeq: number,
  limit: number,
): number {
  return rawAdvanceActivityCursor(currentCursor, events, latestSeq, limit);
}

export type PermissionFilterKey =
  | "all"
  | "points_satisfied"
  | "independent"
  | "insufficient_points"
  | "unknown_rpm"
  | "daily_limit"
  | "has_conflict_or_note"
  | "undocumented";

export function matchesPermissionFilter(
  entry: ApiAccess,
  filterKey: PermissionFilterKey | "",
): boolean {
  return rawMatchesPermissionFilter(entry, filterKey || "all");
}

export function formatPermissionRpm(entry?: ApiAccess | null): {
  documentedLabel: string;
  configuredLabel: string;
  isFallback: boolean;
} {
  return rawFormatPermissionRpm(entry);
}

export function formatPermissionThreshold(entry?: ApiAccess | null): string {
  return rawFormatPermissionThreshold(entry);
}

export function describeWorkerSettingState(
  settings?: Partial<WorkerSettings> | null,
  worker?: Partial<ActivityWorker> | null,
): {
  configured: number;
  effective: number;
  max: number;
  activeRun: boolean;
  pendingNextRun: boolean;
  summary: string;
} {
  return rawDescribeWorkerSettingState(settings, worker);
}

export const BUSINESS_DOMAIN_ORDER: string[] = rawBusinessDomainOrder;

export function resolveArchiveSourceType(
  item?: Partial<LocalDataItem> | null,
): ArchiveSourceType {
  return rawResolveArchiveSourceType(item) as ArchiveSourceType;
}

export function archiveSourceLabel(
  itemOrSourceType?: Partial<LocalDataItem> | ArchiveSourceType | string | null,
): string {
  return rawArchiveSourceLabel(itemOrSourceType);
}

export function formatRequestCondition(
  params?: Record<string, unknown> | null,
): string {
  return rawFormatRequestCondition(params);
}

export function groupNavigationEntriesByDomain(
  navigation?: LocalDataNavigation | null,
): Array<LocalDataDomainSummary & { entries: LocalDataNavigationEntry[] }> {
  return rawGroupNavigationEntriesByDomain(navigation) as Array<
    LocalDataDomainSummary & { entries: LocalDataNavigationEntry[] }
  >;
}

export interface ExportLayoutOption {
  id: ExportLayout;
  title: string;
  shortLabel: string;
  subtitle: string;
}

export const EXPORT_LAYOUT_OPTIONS =
  rawExportLayoutOptions as ExportLayoutOption[];

export function normalizeExportLayout(layout?: unknown): ExportLayout {
  return rawNormalizeExportLayout(layout) as ExportLayout;
}

export interface ExportResultSummary {
  exportId: string;
  layout: ExportLayout;
  layoutLabel: string;
  directory: string;
  destinationRoot: string;
  manifestPath: string;
  exportedSlices: number;
  skippedSlices: number | null;
}

export function summarizeExportResult(
  result?: Partial<ExportResult> | null,
  fallbackLayout: ExportLayout = "raw",
): ExportResultSummary {
  return rawSummarizeExportResult(result, fallbackLayout) as ExportResultSummary;
}

export const DAILY_WAREHOUSE_KEY_COLUMNS: string[] = rawDailyWarehouseKeyColumns;
export const STOCK_BASIC_KEY_COLUMNS: string[] = rawStockBasicKeyColumns;
export const DIVIDEND_POSITION_COLUMNS: string[] = rawDividendPositionColumns;
export const SUPPORTED_WAREHOUSE_DATASETS: string[] =
  rawSupportedWarehouseDatasets;
export const DAILY_WAREHOUSE_DEFAULT_COLUMNS: string[] =
  rawDailyWarehouseDefaultColumns;
export const WAREHOUSE_FIELD_LABELS: Record<string, string> =
  rawWarehouseFieldLabels;
export const DAILY_FIELD_LABELS: Record<string, string> = rawDailyFieldLabels;
export const WAREHOUSE_COLUMN_PRESETS: Record<
  string,
  Array<{ id: string; label: string; columns: string[] }>
> = rawWarehouseColumnPresets;
export const BUSINESS_DOMAIN_NAMES: Record<string, string> =
  rawBusinessDomainNames;

export function normalizeCompactDate(input: unknown, label = "日期"): string {
  return rawNormalizeCompactDate(input, label);
}

export function normalizeWarehouseTsCode(
  input: unknown,
  options?: {
    codeFilter?: "stock" | "board" | "identifier" | "none" | string;
    codeColumn?: string | null;
    allowHistoricalTSh?: boolean;
    datasetId?: string;
  },
): string {
  return rawNormalizeWarehouseTsCode(input, options);
}

export function parseTsCodeList(
  input: unknown,
  options?: {
    codeFilter?: "stock" | "board" | "identifier" | "none" | string;
    codeColumn?: string | null;
    allowHistoricalTSh?: boolean;
    datasetId?: string;
  },
): string[] {
  return rawParseTsCodeList(input, options);
}

export function resolveWarehouseFieldLabel(
  columnName: string,
  warehouseField?: { description?: string | null } | null,
  catalogField?: { description?: string | null } | null,
  datasetId = "",
): string {
  const fn = rawResolveWarehouseFieldLabel as (
    col: string,
    wf: { description?: string | null } | null,
    cf: { description?: string | null } | null,
    dsId: string,
  ) => string;
  return fn(columnName, warehouseField ?? null, catalogField ?? null, datasetId);
}

export function buildWarehouseExportColumns(
  allColumns: string[],
  selectedColumns: Iterable<string>,
  keyColumns: string[] = DAILY_WAREHOUSE_KEY_COLUMNS,
): string[] {
  return rawBuildWarehouseExportColumns(
    allColumns,
    [...selectedColumns],
    keyColumns,
  );
}

export function resolvePinnedSnapshotId(
  currentPinned: string | null | undefined,
  latestSnapshotId: string | null | undefined,
  forceReset = false,
): string | null {
  return rawResolvePinnedSnapshotId(currentPinned, latestSnapshotId, forceReset);
}

export function resolveSelectedVariantId(
  currentSelectedId: string | null | undefined,
  variants: Array<{ id: string }> | null | undefined,
  supportsVariants = false,
): string | null {
  const fn = rawResolveSelectedVariantId as (
    cur: string | null | undefined,
    vars: Array<{ id: string }> | null | undefined,
    sup: boolean,
  ) => string | null;
  return fn(currentSelectedId, variants, supportsVariants);
}

export function formatWarehouseVariantLabel(
  variant?: {
    id?: string;
    params?: Record<string, unknown> | null;
  } | null,
): string {
  const fn = rawFormatWarehouseVariantLabel as (v: unknown) => string;
  return fn(variant ?? null);
}

export interface WarehouseProfile {
  datasetId: string;
  storageLayout: string;
  isRequestPartitions: boolean;
  supportsVariants: boolean;
  dateCountKind: string | null;
  dateSemantics: string;
  atomicFullRun: boolean;
  semanticNote: string;
  grain: string;
  codeFilter: "stock" | "board" | "identifier" | "none";
  codeColumn: string;
  isConstituentCode: boolean;
  supportsCodeFilter: boolean;
  calendarBasis: "trading_day" | "calendar_day" | null;
  isCurrentSnapshot: boolean;
  isPeriodBar: boolean;
  isAnnouncementEvent: boolean;
  isDateRecords: boolean;
  isBoardRecords: boolean;
  isAggregateSeries: boolean;
  isFinancialRecords: boolean;
  isCalendarRecords: boolean;
  isPartitionRecords: boolean;
  isDateCrossSection: boolean;
  isPositioningOnlyKeys: boolean;
  allowsHistoricalTSh: boolean;
  dateColumn: string | null;
  supportsDateFilter: boolean;
  preservesDuplicateRows: boolean;
  keyColumns: string[];
  grainLabel: string;
  grainBadge: string;
  dateShortLabel: string;
  dateAxisLabel: string;
  startDateFieldLabel: string;
  endDateFieldLabel: string;
  dayUnitLabel: string;
  daysWithRowsLabel: string;
  mandatoryKeysTitle: string;
  mandatoryKeysHint: string;
  resetMandatoryButtonLabel: string;
  partitionToggleLabel: string;
  codeEntityLabel: string;
  tsCodePlaceholder: string;
  exportCodeLabel: string;
  exportTsCodesPlaceholder: string;
  phase1PrimaryMode: DatasetMode;
  phase1PrimaryLabel: string;
  showForceRangeButton: boolean;
}

export function resolveWarehouseProfile(
  meta?: {
    dataset_id?: string | null;
    storage_layout?: string | null;
    supports_variants?: boolean | null;
    date_count_kind?: string | null;
    date_semantics?: string | null;
    atomic_full_run?: boolean | null;
    semantic_note?: string | null;
    grain?: string | null;
    code_filter?: string | null;
    code_column?: string | null;
    calendar_basis?: string | null;
    date_column?: string | null;
    key_columns?: string[] | null;
    preserves_duplicate_rows?: boolean | null;
  } | null,
  datasetIdFallback = "",
): WarehouseProfile {
  return rawResolveWarehouseProfile(meta ?? {}, datasetIdFallback) as WarehouseProfile;
}

export function buildWarehouseRowsQuery(
  profile: WarehouseProfile,
  params: {
    snapshotId?: string | null;
    variantId?: string | null;
    startDate?: string;
    endDate?: string;
    tsCode?: string;
    offset?: number;
    limit?: number;
  } = {},
): {
  snapshot_id?: string;
  variant_id?: string;
  start_date?: string;
  end_date?: string;
  ts_code?: string;
  offset: number;
  limit: number;
} {
  return rawBuildWarehouseRowsQuery(profile, params);
}

export function buildWarehouseExportPayload(
  profile: WarehouseProfile,
  params: {
    destination: string;
    startDate?: string;
    endDate?: string;
    tsCodesText?: string;
    tsCodes?: string[];
    allColumns: string[];
    selectedColumns: Iterable<string>;
    snapshotId?: string | null;
    variantId?: string | null;
    variantCount?: number;
  },
): {
  destination: string;
  start_date?: string;
  end_date?: string;
  columns: string[];
  ts_codes?: string[];
  snapshot_id?: string;
  variant_id?: string;
} {
  return rawBuildWarehouseExportPayload(profile, {
    ...params,
    selectedColumns: [...params.selectedColumns],
  });
}

export interface WarehouseDomainGroup {
  id: string;
  name: string;
  supportedCount: number;
  totalCount: number;
  entries: WarehouseCatalogEntry[];
}

export function filterAndGroupWarehouseCatalog(
  entries: WarehouseCatalogEntry[],
  options: {
    includeRawOnly?: boolean;
    businessDomain?: string;
    grain?: string;
    search?: string;
  } = {},
): {
  domains: WarehouseDomainGroup[];
  visibleEntries: WarehouseCatalogEntry[];
  supportedTotal: number;
  definedTotal: number;
} {
  return rawFilterAndGroupWarehouseCatalog(entries, options) as {
    domains: WarehouseDomainGroup[];
    visibleEntries: WarehouseCatalogEntry[];
    supportedTotal: number;
    definedTotal: number;
  };
}

export const RATE_SOURCE_LABELS: Record<string, string> = {
  interface_document: "接口专页明确频次",
  regular_points_table: "常规积分频次总表",
  independent_permission_table: "独立权限频次总表",
  not_documented_for_8000: "官方未公布 8000 档频次（本地取保守值 30）",
  insufficient_points: "超出申报积分档位（本地取保守值 30）",
  derived_subrequests: "SDK 派生（按行情与复权因子子请求分别限流）",
};

export const QUOTA_WINDOW_LABELS: Record<string, string> = {
  rolling_24h: "官方文档：滚动 24 小时",
  calendar_day: "官方文档：自然日（采集器按保守滚动 24h 计数）",
};

export const WORKER_PHASE_LABELS: Record<string, { label: string; cls: string }> = {
  request: { label: "请求中", cls: "bg-teal-500/20 text-teal-300 ring-teal-500/30" },
  pacing: { label: "节流等待", cls: "bg-amber-500/20 text-amber-300 ring-amber-500/30" },
  retry_wait: { label: "退避重试", cls: "bg-rose-500/20 text-rose-300 ring-rose-500/30" },
  archiving: { label: "归档校验", cls: "bg-sky-500/20 text-sky-300 ring-sky-500/30" },
};

export function accountAccessBadge(access?: ApiAccess | null): {
  label: string;
  shortLabel: string;
  tone: "emerald" | "amber" | "rose" | "slate" | "sky";
  cls: string;
} {
  if (!access) {
    return {
      label: "权限未登记",
      shortLabel: "未登记",
      tone: "slate",
      cls: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-400/20",
    };
  }
  if (access.permission_kind === "derived") {
    return {
      label: "SDK 派生 · 随子接口限流（未验证）",
      shortLabel: "SDK 派生",
      tone: "sky",
      cls: "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/20",
    };
  }
  switch (access.account_access) {
    case "points_satisfied":
      return {
        label: `满足申报 ${access.account_points} 分档（未在线验证）`,
        shortLabel: access.minimum_points ? `≥${access.minimum_points}分·申报满足` : "申报分满足",
        tone: "emerald",
        cls: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
      };
    case "requires_independent_permission":
      return {
        label: `需单独开通「${access.independent_permission || "独立权限"}」`,
        shortLabel: `独立授权·${access.independent_permission || "单独开通"}`,
        tone: "amber",
        cls: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/25",
      };
    case "insufficient_points":
      return {
        label: `申报 ${access.account_points} 分不足（需 ${access.minimum_points ?? "?"} 分）`,
        shortLabel: `积分不足（需${access.minimum_points ?? "?"}）`,
        tone: "rose",
        cls: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/25",
      };
    case "undocumented":
    default:
      return {
        label: "官方未公布积分门槛（不推断免费）",
        shortLabel: "门槛未公布",
        tone: "slate",
        cls: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-500/25",
      };
  }
}

export const DATASET_MODES: Record<DatasetMode, string> = {
  incremental: "增量更新",
  full: "全量初始化",
  retry: "补采未完成切片",
  split: "拆分触顶范围",
};

export const PARTITION_REASONS: Record<string, string> = {
  full: "全量",
  missing: "缺口",
  retry: "重试",
  refresh: "回查",
  split: "拆分",
};

export const OPTION_LABELS: Record<string, string> = {
  freq: "频度",
  adj: "复权方式",
  type: "数据类型",
  idx_type: "板块类型",
  content_type: "板块类型",
  limit_type: "涨跌停类型",
  market: "市场 / 榜单",
  is_new: "快照版本",
  tag: "涨停标签",
  exchange: "交易所",
  exchange_id: "交易所",
  market_type: "沪深通道",
  suspend_type: "停复牌",
  trade_type: "增减持",
  holder_type: "股东类型",
  hot_type: "热榜类型",
};

export const OPTION_VALUE_DESCRIPTIONS: Record<string, string> = {
  none: "不复权",
  hfq: "后复权",
  qfq: "前复权 · 每次整段重算",
  Y: "最新快照 Y",
  N: "日内快照 N",
};

export function datasetPartitionLabel(plan: DatasetPlan, item: DatasetPartition): string {
  const reason = PARTITION_REASONS[item.reason] || item.reason;
  if (plan.recipe.kind === "calendar") {
    return `${item.key} (${reason})`;
  }
  if (plan.recipe.kind === "snapshot") {
    return `${item.key}`;
  }
  return `${item.key} [${reason}]`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatShortTime(iso: string | null | undefined): string {
  if (!iso) return "--:--:--";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN");
}

export function formatParamsCompact(params: Record<string, unknown> | null | undefined): string {
  if (!params) return "";
  const entries = Object.entries(params);
  if (!entries.length) return "默认参数";
  return entries.map(([k, v]) => `${k}=${cellText(v)}`).join(" · ");
}

export function stateBadgeClass(state: string): string {
  switch (state) {
    case "succeeded":
    case "ready":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20";
    case "running":
    case "active":
      return "bg-teal-50 text-teal-700 ring-1 ring-inset ring-teal-600/25";
    case "queued":
    case "pending":
      return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/25";
    case "failed":
    case "attention":
      return "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20";
    case "cancelled":
    case "interrupted":
      return "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-500/20";
    default:
      return "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-400/20";
  }
}

export interface StoredDrafts {
  customDraft?: {
    editingId?: string | null;
    editingRevision?: number | null;
    name: string;
    entryId: string;
    paramsText: string;
    fields: string;
    transport: "sdk" | "http";
    rawRoot: string;
    rpm: number;
    maxAttempts: number;
    timeoutSeconds: number;
    rowLimit: string;
    allowEmpty: boolean;
    mode: "single" | "date_range";
    dateParam: string;
    startDate: string;
    endDate: string;
    splitParam: string;
    splitValuesText: string;
  };
  datasetReturns?: DatasetReturnDraft[];
}

function draftStorageKey(databasePath: string): string {
  return `tushare-collector:drafts:v2:${databasePath}`;
}

export function readStoredDrafts(databasePath: string): StoredDrafts {
  if (!databasePath) return {};
  try {
    const raw = window.localStorage.getItem(draftStorageKey(databasePath));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredDrafts;
    if (parsed.customDraft?.paramsText) {
      assertDraftSafe(parsed.customDraft.paramsText);
    }
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStoredDrafts(databasePath: string, drafts: StoredDrafts): void {
  if (!databasePath) return;
  if (drafts.customDraft?.paramsText) {
    assertDraftSafe(drafts.customDraft.paramsText);
  }
  window.localStorage.setItem(draftStorageKey(databasePath), JSON.stringify(drafts));
}

export interface TableColumnFilterItem {
  name: string;
  label?: string;
  type?: string;
}

export interface VisibleTableColumnsResult {
  indices: number[];
  total: number;
  visibleCount: number;
  isFiltered: boolean;
}

export function filterVisibleTableColumns(
  columns: Array<string | TableColumnFilterItem>,
  query = "",
  options: { pinnedNames?: string[]; keepFirst?: boolean } = {},
): VisibleTableColumnsResult {
  return rawFilterVisibleTableColumns(
    columns,
    query,
    options,
  ) as VisibleTableColumnsResult;
}

export type AnchorQuickRangeKind =
  | "all"
  | "latest"
  | "1m"
  | "3m"
  | "1y"
  | "ytd";

export function computeAnchorQuickRange(
  anchorDate: string | null | undefined,
  kind: AnchorQuickRangeKind,
  firstDate = "",
): { startDate: string; endDate: string } {
  return rawComputeAnchorQuickRange(anchorDate ?? "", kind, firstDate) as {
    startDate: string;
    endDate: string;
  };
}
