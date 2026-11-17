import clsx from "clsx";
import { Layers, Play, Search, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { collectorApi } from "../lib/api";
import { DATASET_MODES, formatNumber } from "../lib/helpers";
import type { BatchItem, DatasetBundlePlan, DatasetItem } from "../types";

interface DatasetBundleDrawerProps {
  request: {
    datasetIds: string[];
    mode: "full" | "incremental" | "retry";
    endDate?: string;
    continuationId?: string | null;
  } | null;
  datasets: DatasetItem[];
  defaultEndDate: string;
  onClose: () => void;
  onLaunched: (batch: BatchItem) => Promise<void>;
}

export function DatasetBundleDrawer({
  request,
  datasets,
  defaultEndDate,
  onClose,
  onLaunched,
}: DatasetBundleDrawerProps) {
  const [mode, setMode] = useState<"full" | "incremental" | "retry">("incremental");
  const [endDate, setEndDate] = useState(defaultEndDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundlePlan, setBundlePlan] = useState<DatasetBundlePlan | null>(null);

  useEffect(() => {
    if (!request) return;
    setMode(request.mode);
    setEndDate(request.endDate || defaultEndDate);
    setBundlePlan(null);
    setError(null);
  }, [request, defaultEndDate]);

  if (!request) return null;

  const selectedDatasets = request.datasetIds
    .map((id) => datasets.find((d) => d.id === id))
    .filter((d): d is DatasetItem => Boolean(d));

  const handleCheckBundle = async () => {
    setBusy(true);
    setError(null);
    setBundlePlan(null);
    try {
      const plan = await collectorApi.planDatasetBundle({
        dataset_ids: request.datasetIds,
        mode,
        end_date: endDate || undefined,
        continuation_id: request.continuationId ?? null,
      });
      setBundlePlan(plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : "检查组合计划失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchBundle = async () => {
    if (!bundlePlan) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await collectorApi.launchDatasetBundle(bundlePlan.id);
      await onLaunched(batch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交组合批次失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-[1px]">
      <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl ring-1 ring-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {request.continuationId ? "组合采集 · 继续下一阶段" : "多数据集组合采集计划"}
              </h2>
              <p className="text-xs text-slate-500">
                共选定 {selectedDatasets.length} 个预置数据集 · 自动识别前置依赖阶段
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Selected Datasets Chips */}
          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-slate-700">包含数据集</div>
            <div className="flex flex-wrap gap-1.5">
              {selectedDatasets.map((ds) => (
                <span
                  key={ds.id}
                  className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
                >
                  {ds.name} <code className="text-[10px] text-slate-500">({ds.id})</code>
                </span>
              ))}
            </div>
          </div>

          {/* Strategy & End Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                组合采集模式
              </label>
              <select
                value={mode}
                disabled={Boolean(request.continuationId)}
                onChange={(e) => {
                  setMode(e.target.value as "full" | "incremental" | "retry");
                  setBundlePlan(null);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
              >
                <option value="incremental">增量更新（补缺口+近期回查）</option>
                <option value="full">全量初始化</option>
                <option value="retry">仅补采未完成切片</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                统一截止日
              </label>
              <input
                type="date"
                max={defaultEndDate}
                disabled={Boolean(request.continuationId)}
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setBundlePlan(null);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={handleCheckBundle}
              className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-4 py-2 text-xs font-medium text-white hover:bg-navy-800 disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              {busy ? "正在分析阶段依赖…" : "检查本阶段组合计划"}
            </button>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20 flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {bundlePlan && (
            <div
              className={clsx(
                "rounded-xl border p-4 space-y-4",
                bundlePlan.stage === "dependencies"
                  ? "border-amber-300 bg-amber-50/40"
                  : "border-teal-300 bg-teal-50/30",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={clsx(
                    "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                    bundlePlan.stage === "dependencies"
                      ? "bg-amber-100 text-amber-900"
                      : "bg-teal-100 text-teal-900",
                  )}
                >
                  {bundlePlan.stage === "dependencies"
                    ? "第 1 阶段：前置依赖准备（日历 / 股票池）"
                    : "正式数据采集阶段"}
                </span>
                <span className="font-mono text-xs text-slate-600">
                  共 {formatNumber(bundlePlan.total_slices)} 切片 · 约{" "}
                  {(bundlePlan.estimated_seconds / 60).toFixed(1)} 分钟
                </span>
              </div>

              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">本阶段数据集</th>
                      <th className="px-3 py-2 text-left font-medium">模式</th>
                      <th className="px-3 py-2 text-right font-medium">待执行切片</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {bundlePlan.plans.map((p) => (
                      <tr key={p.id}>
                        <td className="px-3 py-2 font-medium text-slate-900">
                          {p.recipe.name}{" "}
                          <code className="text-[10px] text-slate-500">({p.dataset_id})</code>
                        </td>
                        <td className="px-3 py-2 text-slate-600">{DATASET_MODES[p.mode]}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {formatNumber(p.total_slices)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="list-disc pl-4 text-[11px] text-slate-600 space-y-1">
                {bundlePlan.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>

              <div className="flex justify-end">
                {bundlePlan.total_slices === 0 ? (
                  <span className="text-xs font-medium text-emerald-700">
                    本阶段所有分区均已就绪，无需重复请求
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleLaunchBundle}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    确认提交本阶段批次 ({bundlePlan.total_slices} 切片)
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
