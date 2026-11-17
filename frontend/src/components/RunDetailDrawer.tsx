import clsx from "clsx";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { collectorApi } from "../lib/api";
import {
  formatDateTime,
  formatNumber,
  formatParamsCompact,
  stateBadgeClass,
  states,
  runOutcome,
  runRecovery,
} from "../lib/helpers";
import type { DatasetMode, RunDetail, RunSummary, SlicePage } from "../types";

interface RunDetailDrawerProps {
  runId: string | null;
  onClose: () => void;
  onMutated: () => Promise<void>;
  onPreviewSlice: (runId: string, sliceId: string) => void;
  onRequestExport: (target: {
    runId: string;
    sliceId?: string | null;
    title: string;
  }) => void;
  onOpenDatasetSplit: (datasetId: string, mode: DatasetMode) => void;
  onConfigureRun: (run: RunSummary) => void;
  onOpenPermissionAudit: (entryId?: string) => void;
}

export function RunDetailDrawer({
  runId,
  onClose,
  onMutated,
  onPreviewSlice,
  onRequestExport,
  onOpenDatasetSplit,
  onConfigureRun,
  onOpenPermissionAudit,
}: RunDetailDrawerProps) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [slicePage, setSlicePage] = useState<SlicePage | null>(null);
  const [sliceState, setSliceState] = useState("");
  const [sliceQuery, setSliceQuery] = useState("");
  const [sliceNumberText, setSliceNumberText] = useState("");
  const [sliceOffset, setSliceOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualResumeChecked, setManualResumeChecked] = useState(false);

  const fetchRunAndSlices = async (targetRunId: string, offsetOverride?: number) => {
    setLoading(true);
    try {
      const parsedNum = sliceNumberText.trim()
        ? Number(sliceNumberText.trim())
        : undefined;
      const [detail, slices] = await Promise.all([
        collectorApi.getRunDetail(targetRunId),
        collectorApi.getRunSlices(targetRunId, {
          offset: offsetOverride !== undefined ? offsetOverride : sliceOffset,
          limit: 50,
          q: sliceQuery.trim(),
          state: sliceState || undefined,
          number: parsedNum && Number.isFinite(parsedNum) ? parsedNum : undefined,
        }),
      ]);
      setRun(detail);
      setSlicePage(slices);
    } catch (err) {
      setError(err instanceof Error ? err.message : "读取运行详情失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!runId) {
      setRun(null);
      setSlicePage(null);
      return;
    }
    setError(null);
    setManualResumeChecked(false);
    setSliceOffset(0);
    void fetchRunAndSlices(runId, 0);
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    void fetchRunAndSlices(runId);
  }, [sliceState, sliceOffset]);

  // Auto-refresh while active
  useEffect(() => {
    if (!runId || !run) return;
    if (run.state !== "queued" && run.state !== "running") return;
    const timer = window.setInterval(() => {
      void fetchRunAndSlices(runId);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [runId, run?.state, sliceState, sliceOffset, sliceQuery, sliceNumberText]);

  if (!runId) return null;

  const handleCancel = async () => {
    setActionBusy(true);
    setError(null);
    try {
      await collectorApi.cancelRun(runId);
      await fetchRunAndSlices(runId);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消运行失败");
    } finally {
      setActionBusy(false);
    }
  };

  const handleResume = async () => {
    setActionBusy(true);
    setError(null);
    try {
      await collectorApi.resumeRun(runId);
      await fetchRunAndSlices(runId);
      await onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "续跑失败");
    } finally {
      setActionBusy(false);
    }
  };

  const canCancel = run && (run.state === "queued" || run.state === "running");
  const recovery = run ? runRecovery(run, run.slices ?? []) : null;
  const canResume =
    run &&
    ["failed", "cancelled", "interrupted"].includes(run.state) &&
    run.deleted_archives === 0 && (recovery?.retry || recovery?.kind === "inspect" || recovery?.kind === "wait");

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-[1px]">
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl ring-1 ring-slate-200">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-slate-900 truncate">
                {run?.config.name || "运行详情"}
              </h2>
              {run && (
                <span
                  className={clsx(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    stateBadgeClass(run.state),
                  )}
                >
                  {runOutcome(run)}
                </span>
              )}
            </div>
            <p className="mt-1 font-mono text-[11px] text-slate-500">
              ID: {runId} {run?.entry ? `· ${run.entry.api_name} (${run.config.transport.toUpperCase()})` : ""}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
              {error}
            </div>
          )}

          {run && (
            <>
              {/* Progress & Action Card */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-700">
                    完成 {formatNumber(run.completed)} / {formatNumber(run.total)} 切片 · 失败{" "}
                    <strong className={run.failed > 0 ? "text-rose-600" : "text-slate-700"}>
                      {formatNumber(run.failed)}
                    </strong>{" "}
                    · 累计 {formatNumber(run.successful_rows ?? run.rows)} 行
                  </span>
                  <span className="text-slate-500">{formatDateTime(run.created_at)}</span>
                </div>

                <progress
                  className={clsx(
                    "collector-progress",
                    run.state === "failed" && "collector-progress-rose",
                  )}
                  value={(run.completed || 0) + (run.failed || 0)}
                  max={Math.max(run.total, 1)}
                />
                <p className="text-xs font-medium text-slate-600">请求执行进度</p>

                {run.error && (
                  <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {run.error}
                  </div>
                )}
                {recovery && <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <p>{recovery.label}{recovery.kind === "inspect" ? "：现有错误未可靠分类，请先核对原始错误和配置。" : ""}</p>
                  {recovery.kind === "config" && <button type="button" className="underline" onClick={() => onConfigureRun(run)}>修改配置后重新检查</button>}
                  {(recovery.kind === "permission" || recovery.kind === "quota" || recovery.kind === "wait") && <button type="button" className="underline" onClick={() => onOpenPermissionAudit(run.config.entry_id)}>查看授权、限流与额度说明</button>}
                  {recovery.kind === "quota" && <p>等待额度释放或核对限流设置后再操作；调整线程数不会增加接口额度。当前不自动倒计时或续跑。</p>}
                  {recovery.kind === "split" && !run.dataset_id && <button type="button" className="underline" onClick={() => onConfigureRun(run)}>修改日期范围或切片参数</button>}
                  {(recovery.kind === "inspect" || recovery.kind === "wait") && run.deleted_archives === 0 && <label className="flex items-center gap-2">
                    <input type="checkbox" checked={manualResumeChecked} onChange={event => setManualResumeChecked(event.target.checked)} />
                    我已核对原始错误和配置，确认继续未完成请求
                  </label>}
                </div>}

                {run.row_limit_failures > 0 && run.dataset_id && (
                  <div className="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/25">
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                      {run.row_limit_failures} 个切片触及行数上限，可按股票或折半日期拆分
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenDatasetSplit(run.dataset_id!, "split");
                      }}
                      className="inline-flex items-center gap-1 rounded bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700"
                    >
                      检查拆分方案 <ExternalLink className="h-3 w-3" />
                    </button>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="font-mono text-[11px] text-slate-500 truncate max-w-xs">
                    目录：{run.config.raw_root}
                  </span>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fetchRunAndSlices(runId)}
                      disabled={loading}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />
                      刷新
                    </button>

                    {canCancel && (
                      <button
                        type="button"
                        disabled={actionBusy || Boolean(run.cancel_requested)}
                        onClick={handleCancel}
                        className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        <Square className="h-3 w-3" />
                        {run.cancel_requested ? "停止请求已发出" : "停止运行"}
                      </button>
                    )}

                    {canResume && (
                      <button
                        type="button"
                        disabled={actionBusy || (recovery?.kind === "inspect" || recovery?.kind === "wait") && !manualResumeChecked}
                        onClick={handleResume}
                        className="inline-flex items-center gap-1 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                      >
                        <Play className="h-3 w-3" />
                        {recovery?.retry ? recovery.label : "核查后继续未完成请求"}
                      </button>
                    )}

                    {run.completed > 0 &&
                      run.state !== "queued" &&
                      run.state !== "running" && (
                        <button
                          type="button"
                          onClick={() =>
                            onRequestExport({
                              runId: run.id,
                              sliceId: null,
                              title: `导出整次运行：${run.config.name}`,
                            })
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Download className="h-3.5 w-3.5" />
                          导出运行
                        </button>
                      )}
                  </div>
                </div>
              </div>

              {/* Slice Browser */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-800">
                    请求切片清单（共 {formatNumber(slicePage?.run_total ?? run.total)} 项）
                  </h3>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setSliceOffset(0);
                    void fetchRunAndSlices(runId, 0);
                  }}
                  className="flex flex-wrap items-center gap-2"
                >
                  <div className="relative flex-1 min-w-40">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="search"
                      value={sliceQuery}
                      onChange={(e) => setSliceQuery(e.target.value)}
                      placeholder="按参数搜索（如 20261112、600000.SH）…"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-2.5 py-1.5 text-xs"
                    />
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={sliceNumberText}
                    onChange={(e) => setSliceNumberText(e.target.value)}
                    placeholder="序号 #"
                    className="w-20 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-mono"
                  />
                  <select
                    value={sliceState}
                    onChange={(e) => {
                      setSliceState(e.target.value);
                      setSliceOffset(0);
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
                  >
                    <option value="">全部状态</option>
                    <option value="succeeded">成功</option>
                    <option value="failed">失败</option>
                    <option value="running">执行中</option>
                    <option value="pending">待执行</option>
                  </select>
                  <button
                    type="submit"
                    className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
                  >
                    筛选
                  </button>
                </form>

                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">#</th>
                        <th className="px-3 py-2 text-left font-medium">切片参数</th>
                        <th className="px-3 py-2 text-left font-medium">状态</th>
                        <th className="px-3 py-2 text-right font-medium">行数</th>
                        <th className="px-3 py-2 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {!slicePage || slicePage.items.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-10 text-center text-slate-400">
                            无匹配切片
                          </td>
                        </tr>
                      ) : (
                        slicePage.items.map((item) => (
                          <tr key={item.id} className="hover:bg-slate-50">
                            <td className="px-3 py-2 font-mono text-slate-500 tabular-nums">
                              #{item.ordinal + 1}
                            </td>
                            <td className="px-3 py-2 font-mono text-[11px] text-slate-800">
                              <div>{formatParamsCompact(item.params)}</div>
                              {item.error && (
                                <div className="mt-0.5 font-sans text-[11px] text-rose-600">
                                  {item.error}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={clsx(
                                  "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
                                  stateBadgeClass(item.state),
                                )}
                              >
                                {item.archive_deleted
                                  ? "归档已删"
                                  : states[item.state] || item.state}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                              {formatNumber(item.rows)}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap space-x-1">
                              {item.raw_path && !item.archive_deleted && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      onClose();
                                      onPreviewSlice(run.id, item.id);
                                    }}
                                    className="rounded bg-teal-50 px-2 py-1 text-[11px] font-medium text-teal-700 hover:bg-teal-100"
                                  >
                                    预览表
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onRequestExport({
                                        runId: run.id,
                                        sliceId: item.id,
                                        title: `导出切片 #${item.ordinal + 1}`,
                                      })
                                    }
                                    className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                                  >
                                    导出
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {slicePage && (sliceOffset > 0 || slicePage.next_offset !== null) && (
                  <div className="flex items-center justify-between text-xs">
                    <button
                      type="button"
                      disabled={sliceOffset === 0}
                      onClick={() => setSliceOffset(Math.max(0, sliceOffset - 50))}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
                    >
                      上一页
                    </button>
                    <span className="font-mono text-slate-500">
                      {sliceOffset + 1}–
                      {Math.min(sliceOffset + slicePage.items.length, slicePage.total)} /{" "}
                      {slicePage.total}
                    </span>
                    <button
                      type="button"
                      disabled={slicePage.next_offset === null}
                      onClick={() =>
                        setSliceOffset(slicePage.next_offset ?? sliceOffset)
                      }
                      className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
                    >
                      下一页
                    </button>
                  </div>
                )}
              </div>

              {/* Recent Attempts */}
              {run.attempts && run.attempts.length > 0 && (
                <details className="rounded-xl border border-slate-200 p-3.5 text-xs">
                  <summary className="cursor-pointer font-semibold text-slate-700">
                    最近请求尝试审计记录 ({run.attempts.length})
                  </summary>
                  <div className="mt-2.5 divide-y divide-slate-100 max-h-48 overflow-y-auto font-mono text-[11px]">
                    {run.attempts.map((att) => (
                      <div
                        key={att.id}
                        className="py-1.5 flex items-center justify-between gap-2"
                      >
                        <span className="text-slate-600 truncate">
                          [{att.state}] {formatDateTime(att.started_at)}
                          {att.error ? ` — ${att.error}` : ""}
                        </span>
                        {att.response_sha256 && (
                          <span className="text-emerald-600 shrink-0">
                            sha256:{att.response_sha256.slice(0, 10)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
