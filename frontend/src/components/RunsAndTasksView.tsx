import clsx from "clsx";
import {
  BookmarkPlus,
  CheckSquare,
  Download,
  Edit3,
  Layers,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { patchLocationState, readLocationState } from "../lib/navigation";
import { collectorApi } from "../lib/api";
import { WorkspaceDrawer, WorkspaceMenu, WorkspaceToolbar } from "./WorkspaceLayout";
import {
  formatDateTime,
  formatNumber,
  stateBadgeClass,
  states,
  runOutcome,
  runRecovery,
} from "../lib/helpers";
import type {
  BatchItem,
  BatchPlan,
  Catalog,
  RunSummary,
  SavedConfig,
  SavedGroup,
} from "../types";

interface RunsAndTasksViewProps {
  catalog: Catalog | null;
  runs: RunSummary[];
  configs: SavedConfig[];
  groups: SavedGroup[];
  batches: BatchItem[];
  onOpenRunDetail: (runId: string) => void;
  onRequestExport: (target: {
    runId: string;
    sliceId?: string | null;
    title: string;
  }) => void;
  onEditConfig: (config: SavedConfig) => void;
  onNewCustomTask: () => void;
  onConfigureRun: (run: RunSummary) => void;
  onOpenPermissionAudit: (entryId?: string) => void;
  onMutated: () => Promise<void>;
}

export function RunsAndTasksView({
  catalog,
  runs,
  configs,
  groups,
  batches,
  onOpenRunDetail,
  onRequestExport,
  onEditConfig,
  onNewCustomTask,
  onConfigureRun,
  onOpenPermissionAudit,
  onMutated,
}: RunsAndTasksViewProps) {
  const [subTab, setSubTab] = useState<"runs" | "configs" | "batches">("runs");
  const [runStateFilter, setRunStateFilter] = useState("");
  const [runSourceFilter, setRunSourceFilter] = useState<
    "" | "dataset" | "custom" | "preview"
  >("");
  const [runSearch, setRunSearch] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [datasetFilter, setDatasetFilter] = useState(() => readLocationState().get("dataset"));
  const [filtersReady, setFiltersReady] = useState(false);

  useEffect(() => {
    const restore = () => {
      const params = readLocationState();
      const state = params.get("run_state") || "";
      setRunStateFilter(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"].includes(state) ? state : "");
      const source = params.get("run_source");
      setRunSourceFilter(source === "dataset" || source === "custom" || source === "preview" ? source : "");
      setRunSearch(params.get("run_q") ?? "");
      const tab = params.get("run_tab");
      setSubTab(tab === "configs" || tab === "batches" ? tab : "runs");
      setDatasetFilter(params.get("dataset"));
      setFiltersReady(true);
    };
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
    if (filtersReady) patchLocationState({
      run_state: runStateFilter || null, run_source: runSourceFilter || null,
      run_q: runSearch || null, run_tab: subTab,
    });
  }, [runStateFilter, runSourceFilter, runSearch, subTab, filtersReady]);

  // Config selection & batch planning
  const [selectedConfigIds, setSelectedConfigIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [newGroupName, setNewGroupName] = useState("");
  const [batchPlan, setBatchPlan] = useState<BatchPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entryMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of catalog?.entries ?? []) m.set(e.id, e.api_name);
    return m;
  }, [catalog]);

  const filteredRuns = useMemo(() => {
    const q = runSearch.trim().toLowerCase();
    return runs.filter((r) => {
      if (datasetFilter && r.dataset_id !== datasetFilter) return false;
      if (runStateFilter && r.state !== runStateFilter) return false;
      if (runSourceFilter === "dataset" && !r.dataset_id) return false;
      if (runSourceFilter === "preview" && !r.is_preview) return false;
      if (runSourceFilter === "custom" && (r.dataset_id || r.is_preview))
        return false;
      if (q) {
        const apiName = entryMap.get(r.config.entry_id) || "";
        const hay = `${r.config.name} ${apiName} ${r.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [runs, runStateFilter, runSourceFilter, runSearch, entryMap, datasetFilter]);

  const toggleConfig = (id: string) => {
    setBatchPlan(null);
    setSelectedConfigIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCancelRun = async (runId: string) => {
    setError(null);
    try {
      await collectorApi.cancelRun(runId);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消运行失败");
    }
  };

  const handleResumeRun = async (runId: string) => {
    setError(null);
    try {
      await collectorApi.resumeRun(runId);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "续跑失败");
    }
  };

  const handleLaunchSingleConfig = async (cfg: SavedConfig) => {
    setBusy(true);
    setError(null);
    try {
      const run = await collectorApi.launchConfigRun(cfg.id, cfg.revision);
      await onMutated();
      onOpenRunDetail(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveTaskGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim() || selectedConfigIds.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await collectorApi.createGroup(newGroupName.trim(), [...selectedConfigIds]);
      setNewGroupName("");
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存任务组失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTaskGroup = async (groupId: string) => {
    setError(null);
    try {
      await collectorApi.deleteGroup(groupId);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除任务组失败");
    }
  };

  const handleCheckBatch = async () => {
    if (selectedConfigIds.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await collectorApi.planBatch([...selectedConfigIds]);
      setBatchPlan(plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览批量任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmBatch = async () => {
    if (!batchPlan) return;
    setBusy(true);
    setError(null);
    try {
      await collectorApi.launchBatch(
        batchPlan.tasks.map((t) => t.id),
        batchPlan.expected_revisions,
      );
      setBatchPlan(null);
      setSubTab("runs");
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "批量提交失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {datasetFilter && (
        <div className="text-xs">
          <span className="inline-flex items-center gap-2 rounded-md bg-white px-2.5 py-0.5 font-medium text-slate-800 ring-1 ring-inset ring-amber-300">
            筛选数据集：<code className="font-mono text-teal-800">{datasetFilter}</code>
            <button
              type="button"
              onClick={() => patchLocationState({ dataset: null }, "push")}
              className="text-teal-700 hover:underline"
            >
              清除筛选
            </button>
          </span>
        </div>)}
      <WorkspaceToolbar label="运行记录分类">
        <div className="flex items-center gap-2">
          {(
            [
              ["runs", `运行历史 (${runs.length})`],
              ["configs", `常用任务配置 (${configs.length})`],
              ["batches", `批次执行记录 (${batches.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={subTab === id}
              onClick={() => setSubTab(id)}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                subTab === id
                  ? "bg-navy-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
        {subTab === "configs" && <button
          type="button"
          onClick={onNewCustomTask}
          className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-teal-700"
        >
          <Plus className="h-3.5 w-3.5" />
          新建自定义采集任务
        </button>}
        <WorkspaceMenu>
          {subTab !== "configs" && <button type="button" onClick={onNewCustomTask}
            className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100">新建自定义采集任务</button>}
          <button type="button" onClick={() => setHelpOpen(true)}
            className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-100">运行状态说明</button>
        </WorkspaceMenu>
        </div>
      </WorkspaceToolbar>
      <WorkspaceDrawer open={helpOpen} onClose={() => setHelpOpen(false)} title="运行状态说明">
        <p className="text-sm leading-relaxed text-slate-600">进度仅表示请求处理情况，不是市场覆盖证明。成功但没有返回记录的请求会单独标注。未知异常须先查看详情、核查原因，不自动盲目重试。</p>
        <p className="text-sm leading-relaxed text-slate-600">查看详情可检查切片、原始错误与恢复建议。停止、续跑和导出仍需手动操作。</p>
      </WorkspaceDrawer>

      {error && (
        <div className="rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
          {error}
        </div>
      )}

      {subTab === "runs" ? (
        <div className="space-y-3">
          {/* Runs Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <div className="relative flex-1 min-w-56 max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={runSearch}
                onChange={(e) => setRunSearch(e.target.value)}
                placeholder="搜索运行名称、接口或运行 ID…"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 py-1.5 text-xs"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                value={runSourceFilter}
                onChange={(e) =>
                  setRunSourceFilter(
                    e.target.value as "" | "dataset" | "custom" | "preview",
                  )
                }
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-slate-700"
              >
                <option value="">全部来源</option>
                <option value="dataset">预置数据集运行</option>
                <option value="custom">自定义配置运行</option>
                <option value="preview">单次即时预览</option>
              </select>

              <select
                value={runStateFilter}
                onChange={(e) => setRunStateFilter(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-slate-700"
              >
                <option value="">全部状态</option>
                <option value="running">执行中</option>
                <option value="queued">排队中</option>
                <option value="succeeded">归档成功</option>
                <option value="failed">失败</option>
                <option value="cancelled">已取消</option>
                <option value="interrupted">已中断</option>
              </select>
            </div>
          </div>

          {/* Runs Table with Sticky Header */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="max-h-[calc(100vh-18rem)] overflow-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600 shadow-xs">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">运行任务</th>
                    <th className="px-4 py-2.5 text-left font-medium">状态</th>
                    <th className="px-4 py-2.5 text-left font-medium w-48">切片进度</th>
                    <th className="px-4 py-2.5 text-right font-medium">总行数</th>
                    <th className="px-4 py-2.5 text-left font-medium">创建时间</th>
                    <th className="px-4 py-2.5 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredRuns.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-400">
                        暂无符合条件的运行记录
                      </td>
                    </tr>
                  ) : (
                    filteredRuns.map((run) => {
                      const apiName = entryMap.get(run.config.entry_id) || "";
                      const canCancel =
                        run.state === "queued" || run.state === "running";
                      const recovery = runRecovery(run);
                      const canResume = recovery?.retry;
                      return (
                        <tr key={run.id} className="hover:bg-slate-50/80">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-semibold text-slate-900">
                                {run.config.name}
                              </span>
                              {apiName && (
                                <code className="rounded bg-slate-100 px-1.5 py-0.2 text-[10px] font-mono text-slate-600">
                                  {apiName}
                                </code>
                              )}
                              {Boolean(run.is_preview) && (
                                <span className="rounded bg-sky-50 px-1.5 py-0.2 text-[10px] text-sky-700">
                                  即时预览
                                </span>
                              )}
                            </div>
                            {run.error && (
                              <div className="mt-0.5 text-[11px] text-rose-600 max-w-md truncate" title={run.error}>
                                {run.error}
                              </div>
                            )}
                          </td>

                          <td className="px-4 py-3">
                            <span
                              className={clsx(
                                "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                                stateBadgeClass(run.state),
                              )}
                            >
                              {runOutcome(run)}
                            </span>
                          </td>

                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <progress
                                className={clsx(
                                  "collector-progress",
                                  run.state === "failed" && "collector-progress-rose",
                                )}
                                value={(run.completed || 0) + (run.failed || 0)}
                                max={Math.max(run.total, 1)}
                              />
                              <div className="flex justify-between font-mono text-[10px] text-slate-500 tabular-nums">
                                <span>
                                  {run.completed}/{run.total} 请求成功
                                </span>
                                {run.failed > 0 && (
                                  <span className="text-rose-600">
                                    {run.failed} 失败
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>

                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                            {formatNumber(run.rows)}
                          </td>

                          <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                            {formatDateTime(run.created_at)}
                          </td>

                          <td className="px-4 py-3 text-right whitespace-nowrap space-x-1.5">
                            <button
                              type="button"
                              onClick={() => onOpenRunDetail(run.id)}
                              className="rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                            >
                              查看详情
                            </button>
                            {canCancel && (
                              <button
                                type="button"
                                onClick={() => handleCancelRun(run.id)}
                                className="rounded bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
                              >
                                停止
                              </button>
                            )}
                            {canResume && (
                              <button
                                type="button"
                                onClick={() => handleResumeRun(run.id)}
                                className="rounded bg-teal-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-teal-700"
                              >
                                {recovery?.label}
                              </button>
                            )}
                            {recovery && !canResume && <button type="button"
                              onClick={() => recovery.kind === "config" ? onConfigureRun(run)
                                : recovery.kind === "permission" || recovery.kind === "quota" ? onOpenPermissionAudit(run.config.entry_id)
                                : onOpenRunDetail(run.id)}
                              className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs text-amber-900">
                              {recovery.label}
                            </button>}
                            {run.completed > 0 && !canCancel && (
                              <button
                                type="button"
                                onClick={() =>
                                  onRequestExport({
                                    runId: run.id,
                                    sliceId: null,
                                    title: `导出整次运行：${run.config.name}`,
                                  })
                                }
                                className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                              >
                                <Download className="h-3 w-3" />
                                导出
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : subTab === "configs" ? (
        <div className="space-y-4">
          {/* Task Groups & Multi-select Bar */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
            {groups.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-500">任务组：</span>
                {groups.map((g) => (
                  <div
                    key={g.id}
                    className="inline-flex items-center rounded-lg bg-slate-100 text-xs text-slate-700 ring-1 ring-inset ring-slate-200"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setBatchPlan(null);
                        setSelectedConfigIds(new Set(g.config_ids));
                      }}
                      className="px-2.5 py-1 font-medium hover:text-teal-700"
                    >
                      {g.name} ({g.config_ids.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteTaskGroup(g.id)}
                      className="border-l border-slate-200 px-1.5 py-1 text-slate-400 hover:text-rose-600"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-600">
                已勾选 <strong className="text-slate-900">{selectedConfigIds.size}</strong>{" "}
                项常用任务配置
              </div>

              {selectedConfigIds.size > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <form onSubmit={handleSaveTaskGroup} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="新建任务组名称…"
                      className="w-36 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                    />
                    <button
                      type="submit"
                      disabled={busy || !newGroupName.trim()}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      <BookmarkPlus className="h-3.5 w-3.5" />
                      保存任务组
                    </button>
                  </form>

                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleCheckBatch}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    预览批量执行计划
                  </button>
                </div>
              )}
            </div>

            {/* Batch Plan Confirmation Card */}
            {batchPlan && (
              <div className="rounded-xl border border-teal-300 bg-teal-50/40 p-4 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-teal-900">
                    批量计划确认：共 {batchPlan.total_runs} 项任务 ·{" "}
                    {formatNumber(batchPlan.total_slices)} 个请求切片
                  </span>
                  {batchPlan.estimated_seconds !== null && (
                    <span className="font-mono text-slate-600">
                      限流估算 {(batchPlan.estimated_seconds / 60).toFixed(1)} 分钟
                    </span>
                  )}
                </div>
                <div className="divide-y divide-slate-200/70 rounded-lg bg-white p-2.5 ring-1 ring-slate-200">
                  {batchPlan.tasks.map((t) => (
                    <div key={t.id} className="py-1.5 flex justify-between">
                      <span>
                        <strong>{t.config.name}</strong>{" "}
                        <code className="text-[11px] text-slate-500">({t.api_name})</code>{" "}
                        · v{t.revision}
                      </span>
                      <span className="font-mono">{t.total_slices} 切片</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">{batchPlan.estimate_note}</p>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setBatchPlan(null)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-slate-600"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleConfirmBatch}
                    className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3.5 py-1.5 font-semibold text-white hover:bg-teal-700"
                  >
                    <Play className="h-3.5 w-3.5" />
                    确认批量入队执行
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Saved Configs Table */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="w-10 px-4 py-2.5 text-left font-medium">选择</th>
                  <th className="px-4 py-2.5 text-left font-medium">任务名称</th>
                  <th className="px-4 py-2.5 text-left font-medium">接口 / 传输</th>
                  <th className="px-4 py-2.5 text-left font-medium">切片规则</th>
                  <th className="px-4 py-2.5 text-left font-medium">更新时间</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {configs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-slate-400">
                      尚无已保存的自定义任务配置，可在「高级工具 → 自定义 API」向导中创建保存
                    </td>
                  </tr>
                ) : (
                  configs.map((cfg) => {
                    const checked = selectedConfigIds.has(cfg.id);
                    const apiName = entryMap.get(cfg.config.entry_id) || cfg.config.entry_id;
                    return (
                      <tr key={cfg.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            onClick={() => toggleConfig(cfg.id)}
                            className="text-slate-400 hover:text-teal-600"
                          >
                            {checked ? (
                              <CheckSquare className="h-4 w-4 text-teal-600" />
                            ) : (
                              <Square className="h-4 w-4" />
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-slate-900">{cfg.name}</div>
                          <div className="text-[11px] text-slate-400 font-mono">
                            v{cfg.revision} · {cfg.config.raw_root}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-700">
                          {apiName} · {cfg.config.transport.toUpperCase()} ·{" "}
                          {cfg.config.requests_per_minute} RPM
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {cfg.config.mode === "date_range"
                            ? `${cfg.config.start_date} → ${cfg.config.end_date}`
                            : "单次条件"}
                          {cfg.config.split_param
                            ? ` × ${cfg.config.split_param} (${cfg.config.split_values.length})`
                            : ""}
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          {formatDateTime(cfg.updated_at)}
                        </td>
                        <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => onEditConfig(cfg)}
                            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <Edit3 className="h-3 w-3" />
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleLaunchSingleConfig(cfg)}
                            className="inline-flex items-center gap-1 rounded bg-navy-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-navy-800"
                          >
                            <Play className="h-3 w-3" />
                            运行
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Batches Sub-tab */
        <div className="space-y-3">
          {batches.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white py-12 text-center text-xs text-slate-400">
              暂无批量执行记录
            </div>
          ) : (
            batches.map((b) => (
              <div
                key={b.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-2.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <div className="font-semibold text-slate-900">
                    批次 {b.id.slice(0, 8)} · 共 {b.total_tasks} 个任务 /{" "}
                    {formatNumber(b.total_slices)} 个切片
                  </div>
                  <span className="text-slate-500">{formatDateTime(b.created_at)}</span>
                </div>
                <div className="divide-y divide-slate-100 text-xs">
                  {b.runs.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={clsx(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium",
                            stateBadgeClass(r.state),
                          )}
                        >
                          {states[r.state] || r.state}
                        </span>
                        <span className="font-medium text-slate-800">{r.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-slate-500 tabular-nums">
                          {r.completed}/{r.total} 切片 · {formatNumber(r.rows)} 行
                        </span>
                        <button
                          type="button"
                          onClick={() => onOpenRunDetail(r.id)}
                          className="rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-50"
                        >
                          详情
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
