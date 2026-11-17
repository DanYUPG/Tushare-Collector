import clsx from "clsx";
import {
  AlertTriangle,
  ArrowRight,
  BookmarkPlus,
  CheckSquare,
  ExternalLink,
  FolderSearch,
  Layers,
  LayoutGrid,
  List,
  Play,
  Search,
  Square,
  Table2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { patchLocationState, readLocationState } from "../lib/navigation";
import {
  DATASET_MODES,
  accountAccessBadge,
  datasetPresentation,
  datasetEvidence,
  datasetRuleLabel,
  formatDateTime,
  formatNumber,
  formatPermissionRpm,
  matchesPermissionFilter,
  stateBadgeClass,
  states,
  type PermissionFilterKey,
} from "../lib/helpers";
import type {
  Catalog,
  DatasetBundleRecord,
  DatasetGroup,
  DatasetItem,
  DatasetMode,
  DailyWarehouseStatus,
} from "../types";

interface DatasetsViewProps {
  catalog: Catalog | null;
  datasets: DatasetItem[];
  focusDatasetId?: string | null;
  warehouseEvidence?: Record<string, DailyWarehouseStatus>;
  warehouseEvidenceError?: string | null;
  onFocusDataset: (id: string | null) => void;
  onShowDatasetRuns: (id: string) => void;
  datasetGroups: DatasetGroup[];
  datasetBundles: DatasetBundleRecord[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectMany: (ids: string[]) => void;
  onClearSelection: () => void;
  onSaveGroup: (name: string, ids: string[]) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onOpenDatasetDrawer: (
    datasetId: string,
    mode?: DatasetMode,
    tab?: "plan" | "coverage",
  ) => void;
  onOpenBundleDrawer: (options?: {
    datasetIds?: string[];
    mode?: "full" | "incremental" | "retry";
    endDate?: string;
    continuationId?: string | null;
  }) => void;
  onOpenRunDetail: (runId: string) => void;
  onJumpLocalData: (entryId: string) => void;
  onOpenPermissionAudit?: (entryId: string) => void;
  supportedWarehouseIds?: ReadonlySet<string>;
  onOpenWarehouse?: (datasetId: string) => void;
}

const DEFAULT_WAREHOUSE_SET: ReadonlySet<string> = new Set();

export function DatasetsView({
  catalog,
  datasets,
  focusDatasetId,
  warehouseEvidence = {},
  warehouseEvidenceError,
  onFocusDataset,
  onShowDatasetRuns,
  datasetGroups,
  datasetBundles,
  selectedIds,
  onToggleSelect,
  onSelectMany,
  onClearSelection,
  onSaveGroup,
  onDeleteGroup,
  onOpenDatasetDrawer,
  onOpenBundleDrawer,
  onOpenRunDetail,
  onJumpLocalData,
  onOpenPermissionAudit,
  supportedWarehouseIds = DEFAULT_WAREHOUSE_SET,
  onOpenWarehouse,
}: DatasetsViewProps) {
  const [categoryFilter, setCategoryFilter] = useState(() => readLocationState().get("category") ?? "");
  const [statusFilter, setStatusFilter] = useState<
    "" | "empty" | "ready" | "attention" | "active" | "unknown"
  >("");
  const [permFilter, setPermFilter] = useState<PermissionFilterKey>("all");
  const [search, setSearch] = useState(() => readLocationState().get("q") ?? "");
  const [viewMode, setViewMode] = useState<"grid" | "table">(
    () => readLocationState().get("ds_layout") === "grid" ? "grid" : "table");
  const [groupName, setGroupName] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [showBundles, setShowBundles] = useState(false);
  const [filtersReady, setFiltersReady] = useState(false);
  const [filterWarning, setFilterWarning] = useState<string | null>(null);

  useEffect(() => {
    const restore = () => {
      const params = readLocationState();
      const category = params.get("category") ?? "";
      setFilterWarning(category && !catalog?.categories.some(item => item.id === category)
        ? "链接中的目录分类不存在，已清除该筛选。" : null);
      setCategoryFilter(catalog?.categories.some(item => item.id === category) ? category : "");
      setSearch(params.get("q") ?? "");
      const state = params.get("ds_state");
      setStatusFilter(state === "empty" || state === "ready" || state === "attention" || state === "active" || state === "unknown" ? state : "");
      const permission = params.get("ds_permission");
      setPermFilter(permission === "points_satisfied" || permission === "independent" || permission === "insufficient_points" || permission === "unknown_rpm" ? permission : "all");
      setViewMode(params.get("ds_layout") === "grid" ? "grid" : "table");
      setFiltersReady(true);
    };
    if (!catalog) return;
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [catalog]);

  useEffect(() => {
    if (!filtersReady) return;
    patchLocationState({
      category: categoryFilter || null, q: search || null, ds_state: statusFilter || null,
      ds_permission: permFilter === "all" ? null : permFilter, ds_layout: viewMode,
    });
  }, [categoryFilter, search, statusFilter, permFilter, viewMode, filtersReady]);

  const entryMap = useMemo(() => {
    const map = new Map<
      string,
      { api_name: string; category: string; category_name: string }
    >();
    for (const entry of catalog?.entries ?? []) {
      map.set(entry.id, {
        api_name: entry.api_name,
        category: entry.category,
        category_name: entry.category_name,
      });
    }
    return map;
  }, [catalog]);

  const enriched = useMemo(() => {
    return datasets.map((ds) => {
      const entryInfo = entryMap.get(ds.entry_id);
      const presentation = datasetPresentation(ds);
      const ruleText = datasetRuleLabel(ds);
      return {
        dataset: ds,
        apiName: entryInfo?.api_name ?? ds.id,
        category: entryInfo?.category ?? "",
        categoryName: entryInfo?.category_name ?? "股票数据",
        presentation,
        ruleText,
      };
    });
  }, [datasets, entryMap]);

  const kpis = useMemo(() => {
    let covered = 0;
    let totalPartitions = 0;
    let attention = 0;
    let rowLimitCount = 0;
    let activeCount = 0;
    for (const item of enriched) {
      if ((item.dataset.covered_partitions ?? 0) > 0) covered += 1;
      totalPartitions += item.dataset.covered_partitions ?? 0;
      if (item.presentation.kind === "attention") attention += 1;
      if ((item.dataset.row_limit_partitions ?? 0) > 0) rowLimitCount += 1;
      if (item.dataset.active_run) activeCount += 1;
    }
    return { covered, totalPartitions, attention, rowLimitCount, activeCount };
  }, [enriched]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of enriched) {
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    }
    return counts;
  }, [enriched]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter((item) => {
      if (categoryFilter && item.category !== categoryFilter) return false;
      if (statusFilter && item.presentation.kind !== statusFilter) return false;
      if (
        permFilter !== "all" &&
        (!item.dataset.access || !matchesPermissionFilter(item.dataset.access, permFilter))
      ) {
        return false;
      }
      if (q) {
        const hay =
          `${item.dataset.name} ${item.apiName} ${item.categoryName} ${item.ruleText} ${item.dataset.access?.independent_permission || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enriched, categoryFilter, statusFilter, permFilter, search]);

  const handlePrimaryAction = (ds: DatasetItem, kind: string) => {
    if (ds.active_run) {
      onOpenRunDetail(ds.active_run);
      return;
    }
    if ((ds.row_limit_partitions ?? 0) > 0) {
      onOpenDatasetDrawer(ds.id, "split", "plan");
      return;
    }
    if (kind === "empty") {
      onOpenDatasetDrawer(ds.id, "full", "plan");
    } else if (kind === "attention" && (ds.unfinished_partitions ?? 0) > 0) {
      onOpenDatasetDrawer(ds.id, "retry", "plan");
    } else {
      onOpenDatasetDrawer(ds.id, "incremental", "plan");
    }
  };

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim() || selectedIds.size === 0) return;
    setSavingGroup(true);
    setGroupError(null);
    try {
      await onSaveGroup(groupName.trim(), [...selectedIds]);
      setGroupName("");
    } catch (err) {
      setGroupError(err instanceof Error ? err.message : "保存组合失败");
    } finally {
      setSavingGroup(false);
    }
  };

  const datasetNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const ds of datasets) m.set(ds.id, ds.name);
    return m;
  }, [datasets]);
  const focus = enriched.find(item => item.dataset.id === focusDatasetId);
  return (
    <div className="space-y-5">
      {filterWarning && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{filterWarning}</p>}
      {warehouseEvidenceError && <p role="alert" className="text-xs text-rose-700">{warehouseEvidenceError}</p>}

      {focusDatasetId && <section className="rounded-xl border border-teal-200 bg-white p-4 shadow-sm" aria-label="数据集上下文">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{focus ? `${focus.dataset.name} · ${focus.apiName}` : "链接中的数据集不存在"}</h2>
          <button type="button" onClick={() => onFocusDataset(null)} className="text-xs text-slate-600">关闭详情</button>
        </div>
        {focus && <>
          <p className="my-3 text-sm text-slate-700">{datasetEvidence(focus.dataset, warehouseEvidence[focus.dataset.id]).execution} · {datasetEvidence(focus.dataset, warehouseEvidence[focus.dataset.id]).freshness}</p>
          <div className="flex flex-wrap gap-2 text-xs">
            {supportedWarehouseIds.has(focus.dataset.id) && <button className="rounded bg-teal-700 px-3 py-2 text-white" onClick={() => onOpenWarehouse?.(focus.dataset.id)}>仓库查询 / 字段导出</button>}
            <button className="rounded border px-3 py-2" onClick={() => handlePrimaryAction(focus.dataset, focus.presentation.kind)}>采集 / 检查更新</button>
            <button className="rounded border px-3 py-2" onClick={() => onOpenDatasetDrawer(focus.dataset.id, "incremental", "coverage")}>覆盖台账 / 未完成请求</button>
            <button className="rounded border px-3 py-2" onClick={() => onJumpLocalData(focus.dataset.entry_id)}>原始文件追溯</button>
            <button className="rounded border px-3 py-2" onClick={() => onShowDatasetRuns(focus.dataset.id)}>运行记录</button>
          </div>
        </>}
      </section>}
      {/* KPI Summary Cards */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium text-slate-500">预置股票数据集</div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-2xl font-semibold text-slate-900 tabular-nums">
              {datasets.length}
            </span>
            <span className="text-xs text-slate-500">
              {catalog?.categories.length ?? 8} 大目录分类
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-400">
            核验日期：{formatDateTime(catalog?.verified_at)}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setStatusFilter(statusFilter === "ready" ? "" : "ready")}
          className={clsx(
            "rounded-xl border p-4 text-left shadow-sm transition-colors",
            statusFilter === "ready"
              ? "border-teal-500 bg-teal-50/40"
              : "border-slate-200 bg-white hover:border-slate-300",
          )}
        >
          <div className="text-xs font-medium text-slate-500">已有预置采集归档</div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-2xl font-semibold text-teal-700 tabular-nums">
              {kpis.covered}
            </span>
            <span className="text-xs font-mono text-slate-600 tabular-nums">
              {formatNumber(kpis.totalPartitions)} 分区已登记
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            点击筛选已有成功归档的数据集
          </div>
        </button>

        <button
          type="button"
          onClick={() =>
            setStatusFilter(statusFilter === "attention" ? "" : "attention")
          }
          className={clsx(
            "rounded-xl border p-4 text-left shadow-sm transition-colors",
            statusFilter === "attention"
              ? "border-rose-500 bg-rose-50/40"
              : "border-slate-200 bg-white hover:border-slate-300",
          )}
        >
          <div className="text-xs font-medium text-slate-500">需要处理 / 行数触顶</div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span
              className={clsx(
                "text-2xl font-semibold tabular-nums",
                kpis.attention > 0 ? "text-rose-600" : "text-slate-900",
              )}
            >
              {kpis.attention}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              其中 {kpis.rowLimitCount} 项含触顶切片
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            点击定位失败、中断或需拆分范围的数据集
          </div>
        </button>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>组合调度与阶段记录</span>
            {datasetBundles.length > 0 && (
              <button
                type="button"
                onClick={() => setShowBundles((v) => !v)}
                className="text-teal-600 hover:text-teal-700 font-semibold"
              >
                {showBundles ? "收起记录" : `查看阶段 (${datasetBundles.length})`}
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-2xl font-semibold text-slate-900 tabular-nums">
              {kpis.activeCount}
            </span>
            <span className="text-xs text-slate-500 tabular-nums">
              采集中 · {datasetGroups.length} 个已存组合
            </span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            多选卡片可组合检查依赖并分阶段批量采集
          </div>
        </div>
      </div>

      {/* Saved Dataset Groups & Selection Action Bar */}
      {(datasetGroups.length > 0 || selectedIds.size > 0) && (
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm space-y-3">
          {datasetGroups.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-500 mr-1">快捷组合：</span>
              {datasetGroups.map((g) => (
                <div
                  key={g.id}
                  className="inline-flex items-center rounded-lg bg-slate-100 text-xs text-slate-700 ring-1 ring-inset ring-slate-200"
                >
                  <button
                    type="button"
                    onClick={() => onSelectMany(g.dataset_ids)}
                    className="px-2.5 py-1 font-medium hover:text-teal-700"
                  >
                    {g.name} ({g.dataset_ids.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteGroup(g.id)}
                    className="border-l border-slate-200 px-1.5 py-1 text-slate-400 hover:text-rose-600"
                    title="删除此组合（保留各数据集设置与归档）"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-100">
              <div className="flex items-center gap-2.5 text-xs">
                <span className="rounded-md bg-teal-50 px-2.5 py-1 font-semibold text-teal-800 ring-1 ring-inset ring-teal-600/20">
                  已选 {selectedIds.size} 个数据集
                </span>
                <button
                  type="button"
                  onClick={onClearSelection}
                  className="text-slate-500 hover:text-slate-800"
                >
                  清空选择
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <form onSubmit={handleCreateGroup} className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="保存为新组合名称…"
                    className="w-40 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs focus:border-teal-600 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={savingGroup || !groupName.trim()}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    保存组合
                  </button>
                </form>

                <button
                  type="button"
                  onClick={() =>
                    onOpenBundleDrawer({
                      datasetIds: [...selectedIds],
                      mode: "incremental",
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-teal-700"
                >
                  <Layers className="h-3.5 w-3.5" />
                  检查组合采集计划
                </button>
              </div>
            </div>
          )}

          {groupError && <div className="text-xs text-rose-600">{groupError}</div>}
        </div>
      )}

      {/* Multi-Stage Bundle History Panel */}
      {showBundles && datasetBundles.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-800">
              最近组合阶段记录（支持依赖完成后继续正式阶段）
            </h3>
            <button
              type="button"
              onClick={() => setShowBundles(false)}
              className="text-xs text-slate-400 hover:text-slate-600"
            >
              关闭
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {datasetBundles.slice(0, 8).map((bundle) => {
              const prog = bundle.progress;
              const depReadyForNext =
                bundle.stage === "dependencies" &&
                bundle.batch &&
                !bundle.next_stage_created &&
                prog &&
                prog.pending === 0 &&
                prog.running === 0 &&
                prog.failed === 0;
              return (
                <div
                  key={bundle.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-xs"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={clsx(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          bundle.stage === "dependencies"
                            ? "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-500/25"
                            : "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-500/25",
                        )}
                      >
                        {bundle.stage === "dependencies" ? "第 1 阶段：依赖准备" : "正式数据阶段"}
                      </span>
                      <span className="font-medium text-slate-800">
                        {DATASET_MODES[bundle.mode]} · 截止 {bundle.end_date}
                      </span>
                      <span className="text-slate-400">{formatDateTime(bundle.created_at)}</span>
                    </div>
                    <div className="text-slate-500 truncate">
                      本阶段执行：
                      {bundle.stage_ids
                        .map((id) => datasetNameById.get(id) || id)
                        .join("、")}{" "}
                      · 共 {bundle.total_slices} 个切片
                      {prog
                        ? `（已完成 ${prog.completed}/${prog.total}，失败 ${prog.failed}）`
                        : "（尚未提交启动）"}
                    </div>
                  </div>
                  {depReadyForNext && (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenBundleDrawer({
                          datasetIds: bundle.dataset_ids,
                          mode: bundle.mode,
                          endDate: bundle.end_date,
                          continuationId: bundle.id,
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700"
                    >
                      检查并继续下一阶段 <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter & View Mode Toolbar (Sticky) */}
      <div className="sticky -top-5 lg:-top-6 z-20 rounded-xl border border-slate-200/90 bg-white/95 p-3.5 shadow-sm backdrop-blur-sm space-y-2.5">
        {/* Category Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setCategoryFilter("")}
            className={clsx(
              "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              categoryFilter === ""
                ? "bg-navy-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
            )}
          >
            全部分类 ({datasets.length})
          </button>
          {(catalog?.categories ?? []).map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() =>
                setCategoryFilter(categoryFilter === cat.id ? "" : cat.id)
              }
              className={clsx(
                "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                categoryFilter === cat.id
                  ? "bg-navy-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
              )}
            >
              {cat.name} ({categoryCounts[cat.id] ?? 0})
            </button>
          ))}
        </div>

        {/* Search + Status Filter + Select Filtered + Grid/Table Switch */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap flex-1 items-center gap-2 min-w-64">
            <div className="relative flex-1 max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索数据集名称、api_name（如 daily、income）…"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 py-1.5 text-xs text-slate-900 focus:border-teal-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs">
              {(
                [
                  ["", "全部状态"],
                  ["empty", "未采集"],
                  ["ready", "已有采集归档"],
                  ["attention", "需要处理"],
                  ["active", "采集中"],
                  ["unknown", "状态未知"],
                ] as const
              ).map(([val, label]) => (
                <button
                  key={val || "all"}
                  type="button"
                  onClick={() => setStatusFilter(val)}
                  className={clsx(
                    "rounded-md px-2.5 py-1 font-medium transition-colors",
                    statusFilter === val
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <select
              value={permFilter}
              onChange={(e) => setPermFilter(e.target.value as PermissionFilterKey)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
              aria-label="按接口权限与限流筛选"
            >
              <option value="all">全部权限档位</option>
              <option value="points_satisfied">满足申报 8000 分档</option>
              <option value="independent">需单独开通独立授权</option>
              <option value="insufficient_points">申报积分不足</option>
              <option value="unknown_rpm">官方未公布 8000 档频次</option>
              <option value="daily_limit">含日调用上限</option>
              <option value="has_conflict_or_note">有文档冲突 / 说明</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectMany(filtered.map((f) => f.dataset.id))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <CheckSquare className="h-3.5 w-3.5" />
              全选当前 ({filtered.length})
            </button>

            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={clsx(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                  viewMode === "grid"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800",
                )}
                title="卡片视图"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                卡片
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={clsx(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                  viewMode === "table"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800",
                )}
                title="紧凑表格视图"
              >
                <List className="h-3.5 w-3.5" />
                列表
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Dataset Grid or Table */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white py-14 text-center text-sm text-slate-500">
          没有匹配当前筛选条件的股票数据集
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 2xl:grid-cols-3">
          {filtered.map(({ dataset: ds, apiName, categoryName, presentation, ruleText }) => {
            const isSelected = selectedIds.has(ds.id);
            const hasCoverage = (ds.covered_partitions ?? 0) > 0;
            const hasRowLimit = (ds.row_limit_partitions ?? 0) > 0;
            return (
              <article
                key={ds.id}
                className={clsx(
                  "flex flex-col justify-between rounded-xl border bg-white p-4 shadow-sm transition-all",
                  isSelected
                    ? "border-teal-500 ring-2 ring-teal-500/15"
                    : "border-slate-200 hover:border-slate-300",
                )}
              >
                <div className="space-y-2.5">
                  {/* Card Top Row */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <button
                        type="button"
                        onClick={() => onToggleSelect(ds.id)}
                        className="mt-0.5 text-slate-400 hover:text-teal-600"
                        aria-label={`选择 ${ds.name}`}
                      >
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4 text-teal-600" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <h3 className="truncate text-sm font-semibold text-slate-900">
                            <button type="button" onClick={() => onFocusDataset(ds.id)} className="hover:underline">
                            {ds.name}
                            </button>
                          </h3>
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-mono text-slate-700">
                            {apiName}
                          </code>
                          {ds.doc_url && (
                            <a
                              href={ds.doc_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-slate-400 hover:text-teal-700"
                              title="打开官方接口文档"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-[11px] text-slate-500">
                          <span>{categoryName}</span>
                          <span>·</span>
                          <span>{ruleText}</span>
                        </div>
                        {ds.access && ds.access.account_access !== "points_satisfied" && (
                          <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[10px]">
                            <button
                              type="button"
                              onClick={() => onOpenPermissionAudit?.(ds.entry_id)}
                              className={clsx(
                                "rounded px-1.5 py-0.5 font-medium hover:opacity-85",
                                accountAccessBadge(ds.access).cls,
                              )}
                              title="点击查看官方权限证据与限流核定"
                            >
                              {accountAccessBadge(ds.access).shortLabel}
                            </button>
                            <span className="font-mono text-slate-500">
                              {formatPermissionRpm(ds.access).documentedLabel}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <span
                      className={clsx(
                        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        stateBadgeClass(presentation.kind),
                      )}
                    >
                      {presentation.status}
                    </span>
                  </div>

                  {/* Coverage Metrics Strip */}
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs space-y-1 ring-1 ring-inset ring-slate-200/60">
                    {ds.settings_error ? (
                      <div className="text-rose-600 font-medium">{ds.settings_error}</div>
                    ) : hasCoverage ? (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500">已登记成功分区</span>
                          <span className="font-mono font-semibold text-slate-900 tabular-nums">
                            {formatNumber(ds.covered_partitions)} 个
                            {(ds.unfinished_partitions ?? 0) > 0 && (
                              <span className="ml-1.5 text-rose-600">
                                ({ds.unfinished_partitions} 未完成)
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span>请求分区跨度（非数据覆盖）</span>
                          <span className="font-mono text-slate-700 truncate max-w-48">
                            {ds.first_partition} → {ds.last_partition}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center justify-between text-slate-500">
                        <span>默认起点 {ds.settings.start_date}</span>
                        <span className="font-mono text-[11px]">
                          上限至 {ds.available_through}
                        </span>
                      </div>
                    )}

                    <div className="space-y-1 pt-1 text-xs text-slate-700">
                      <p>{datasetEvidence(ds, warehouseEvidence[ds.id]).execution} · {datasetEvidence(ds, warehouseEvidence[ds.id]).freshness}</p>
                    </div>
                    {hasRowLimit && (
                      <div className="flex items-center gap-1 text-[11px] text-amber-700 font-medium pt-0.5">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        {ds.row_limit_partitions} 个分区触及行数上限，建议检查拆分方案
                      </div>
                    )}

                    {ds.last_run && (
                      <div className="text-[11px] text-slate-400 truncate">
                        最近运行：{states[ds.last_run.state] || ds.last_run.state} ·{" "}
                        {formatDateTime(ds.last_run.created_at)}
                      </div>
                    )}
                  </div>

                  {/* Progressive Disclosure Rule Note */}
                  <details className="group text-[11px] text-slate-500">
                    <summary className="cursor-pointer list-none font-medium text-slate-500 hover:text-slate-700 flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform">▸</span>
                      查看采集口径与增量边界说明
                    </summary>
                    <p className="mt-1.5 rounded-lg bg-slate-50/80 p-2 leading-relaxed text-slate-600">
                      {ds.scope_note} {ds.incremental_note}
                    </p>
                  </details>
                </div>

                {/* Card Footer Actions: Unified Warehouse + Collection Semantics */}
                <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-slate-100">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <details className="relative text-xs">
                      <summary className="cursor-pointer list-none rounded-lg border border-slate-200 px-2.5 py-1.5 font-medium text-slate-600 hover:bg-slate-50">
                        更多
                      </summary>
                      <div className="absolute left-0 bottom-full z-20 mb-2 flex w-48 flex-col items-stretch gap-0.5 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
                        <button
                          type="button"
                          onClick={() => onFocusDataset(ds.id)}
                          className="rounded px-2.5 py-1.5 text-left text-slate-700 hover:bg-slate-100"
                        >
                          概览与运行记录
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenDatasetDrawer(ds.id, "incremental", "coverage")}
                          className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-slate-700 hover:bg-slate-100"
                        >
                          <Table2 className="h-3.5 w-3.5 text-slate-400" />
                          分区覆盖台账
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenPermissionAudit?.(ds.entry_id)}
                          className="rounded px-2.5 py-1.5 text-left text-slate-700 hover:bg-slate-100"
                        >
                          接口权限与频次
                        </button>
                        {hasCoverage && (
                          <button
                            type="button"
                            onClick={() => onJumpLocalData(ds.entry_id)}
                            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-slate-700 hover:bg-slate-100"
                          >
                            <FolderSearch className="h-3.5 w-3.5 text-slate-400" />
                            浏览原始归档
                          </button>
                        )}
                      </div>
                    </details>

                    {supportedWarehouseIds.has(ds.id) && onOpenWarehouse && (
                      <button
                        type="button"
                        onClick={() => onOpenWarehouse(ds.id)}
                        className={clsx(
                          "inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                          warehouseEvidence[ds.id]?.state === "ready"
                            ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-600/25 hover:bg-emerald-100"
                            : "bg-teal-50/70 text-teal-800 ring-1 ring-inset ring-teal-600/20 hover:bg-teal-100",
                        )}
                      >
                        {warehouseEvidence[ds.id]?.state === "ready" ? "查询 / 导出" : "本地仓库"}
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => handlePrimaryAction(ds, presentation.kind)}
                    className={clsx(
                      "inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      presentation.kind === "active"
                        ? "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-600/30 hover:bg-teal-100"
                        : presentation.kind === "attention" || (hasRowLimit && !ds.active_run)
                          ? "bg-amber-600 text-white hover:bg-amber-700"
                          : "bg-navy-900 text-white hover:bg-navy-800",
                    )}
                  >
                    <Play className="h-3 w-3" />
                    {hasRowLimit && !ds.active_run ? "拆分触顶范围" : presentation.action}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        /* Compact Table View with Sticky Header */
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="max-h-[calc(100vh-16.5rem)] overflow-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600 shadow-xs">
                <tr>
                  <th className="w-10 px-3 py-2.5 text-left font-medium">选择</th>
                  <th className="px-3 py-2.5 text-left font-medium">数据集 / 接口</th>
                  <th className="px-3 py-2.5 text-left font-medium">分类与规则</th>
                  <th className="px-3 py-2.5 text-left font-medium">状态</th>
                  <th className="px-3 py-2.5 text-right font-medium">成功分区</th>
                  <th className="px-3 py-2.5 text-left font-medium">记录截至</th>
                  <th className="px-3 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map(
                  ({ dataset: ds, apiName, categoryName, presentation, ruleText }) => {
                    const isSelected = selectedIds.has(ds.id);
                    return (
                      <tr
                        key={ds.id}
                        className={clsx(
                          "hover:bg-slate-50/80 transition-colors",
                          isSelected && "bg-teal-50/30",
                        )}
                      >
                        <td className="px-3 py-2.5">
                          <button
                            type="button"
                            onClick={() => onToggleSelect(ds.id)}
                            className="text-slate-400 hover:text-teal-600"
                          >
                            {isSelected ? (
                              <CheckSquare className="h-4 w-4 text-teal-600" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </button>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <button type="button" onClick={() => onFocusDataset(ds.id)} className="text-left font-semibold text-slate-900 hover:underline">{ds.name}</button>
                            {ds.doc_url && (
                              <a
                                href={ds.doc_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-slate-400 hover:text-teal-700"
                                title="打开官方接口文档"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                            <code className="text-[11px] font-mono text-slate-500">
                              {apiName}
                            </code>
                            {ds.access && ds.access.account_access !== "points_satisfied" && (
                              <button
                                type="button"
                                onClick={() => onOpenPermissionAudit?.(ds.entry_id)}
                                className={clsx(
                                  "rounded px-1.5 py-0.2 text-[10px] font-medium",
                                  accountAccessBadge(ds.access).cls,
                                )}
                              >
                                {accountAccessBadge(ds.access).shortLabel}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">
                          <div>{categoryName}</div>
                          <div className="text-[11px] text-slate-400">{ruleText}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={clsx(
                              "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                              stateBadgeClass(presentation.kind),
                            )}
                          >
                            {presentation.status}
                          </span>
                          <div className="mt-1 text-xs text-slate-600">{datasetEvidence(ds, warehouseEvidence[ds.id]).execution}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-800">
                          {formatNumber(ds.covered_partitions)}
                          {(ds.unfinished_partitions ?? 0) > 0 && (
                            <span className="ml-1 text-rose-600">
                              ({ds.unfinished_partitions} 异常)
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-[11px] text-slate-600">
                          <div>{datasetEvidence(ds, warehouseEvidence[ds.id]).freshness}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right space-x-1.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() =>
                              onOpenDatasetDrawer(ds.id, "incremental", "coverage")
                            }
                            className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                          >
                            台账
                          </button>
                          {(ds.covered_partitions ?? 0) > 0 && (
                            <button
                              type="button"
                              onClick={() => onJumpLocalData(ds.entry_id)}
                              className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                            >
                              阅读
                            </button>
                          )}
                          {supportedWarehouseIds.has(ds.id) && onOpenWarehouse && (
                            <button
                              type="button"
                              onClick={() => onOpenWarehouse(ds.id)}
                              className={clsx(
                                "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                                warehouseEvidence[ds.id]?.state === "ready"
                                  ? "border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                                  : "border border-teal-200 bg-teal-50/70 text-teal-800 hover:bg-teal-100",
                              )}
                            >
                              {warehouseEvidence[ds.id]?.state === "ready" ? "查询 / 导出" : "本地仓库"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handlePrimaryAction(ds, presentation.kind)}
                            className={clsx(
                              "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
                              presentation.kind === "active"
                                ? "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-600/30 hover:bg-teal-100"
                                : presentation.kind === "attention" || ((ds.row_limit_partitions ?? 0) > 0 && !ds.active_run)
                                  ? "bg-amber-600 text-white hover:bg-amber-700"
                                  : "bg-navy-900 text-white hover:bg-navy-800",
                            )}
                          >
                            {(ds.row_limit_partitions ?? 0) > 0 && !ds.active_run
                              ? "拆分触顶范围"
                              : presentation.action}
                          </button>
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
