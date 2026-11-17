import clsx from "clsx";
import { Cpu, Info, Layers, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { collectorApi } from "../lib/api";
import { describeWorkerSettingState, WORKER_PHASE_LABELS } from "../lib/helpers";
import type { ActivityWorker, WorkerSettings } from "../types";

interface WorkerSettingsModalProps {
  open: boolean;
  settings: WorkerSettings | null;
  worker: ActivityWorker | null;
  onClose: () => void;
  onSaved: (updated: WorkerSettings) => void;
}

export function WorkerSettingsModal({
  open,
  settings,
  worker,
  onClose,
  onSaved,
}: WorkerSettingsModalProps) {
  const stateInfo = describeWorkerSettingState(settings, worker);
  const [threads, setThreads] = useState<number>(stateInfo.configured);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setThreads(stateInfo.configured);
      setError(null);
    }
  }, [open, stateInfo.configured]);

  if (!open) return null;

  const maxThreads = stateInfo.max || 16;
  const presets = [1, 2, 4, 8, 12, 16].filter((n) => n <= maxThreads);
  const workerSlots = worker?.workers ?? [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clamped = Math.max(1, Math.min(maxThreads, Math.trunc(Number(threads) || 1)));
    setSaving(true);
    setError(null);
    try {
      const updated = await collectorApi.updateWorkerSettings(clamped);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "保存采集线程设置失败（请确认后端已上线 /api/worker/settings）",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[1px]">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-50 text-teal-600 ring-1 ring-inset ring-teal-500/20">
              <Cpu className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                单运行切片并发线程池设置
              </h2>
              <p className="text-[11px] text-slate-500">
                单协调器进程内多线程并发 · SQLite 持久化免重启
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {/* Effective vs Next-Run Status Comparison */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] text-slate-500">当前生效线程数 (Effective)</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-xl font-semibold font-mono text-slate-900 tabular-nums">
                  {stateInfo.effective}
                </span>
                <span className="text-[11px] text-slate-500">
                  线程{worker?.busy_workers !== undefined ? `（活跃 ${worker.busy_workers}）` : ""}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-slate-400">
                {stateInfo.activeRun ? "正在执行的运行保持启动时线程数不变" : "当前空闲"}
              </div>
            </div>

            <div
              className={clsx(
                "rounded-xl border p-3",
                stateInfo.pendingNextRun
                  ? "border-amber-300 bg-amber-50/50"
                  : "border-teal-200 bg-teal-50/30",
              )}
            >
              <div className="text-[11px] text-slate-500">已保存下次生效 (Next Run)</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="text-xl font-semibold font-mono text-teal-800 tabular-nums">
                  {stateInfo.configured}
                </span>
                <span className="text-[11px] text-slate-500">/ 最大 {maxThreads}</span>
              </div>
              <div className="mt-1 text-[10px] text-slate-500">
                {stateInfo.pendingNextRun
                  ? "将于下一个新运行/续跑启动时生效"
                  : "与当前生效配置一致"}
              </div>
            </div>
          </div>

          {/* Thread Number Picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="collection-threads-input"
                className="font-semibold text-slate-800"
              >
                配置采集线程数（1 – {maxThreads}）
              </label>
              <span className="font-mono text-[11px] text-slate-500">
                applies_to: next_run
              </span>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="collection-threads-input"
                type="number"
                min={1}
                max={maxThreads}
                step={1}
                value={threads}
                onChange={(e) => setThreads(Number(e.target.value))}
                className="w-24 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm font-semibold text-slate-900 focus:border-teal-600 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1.5">
                {presets.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setThreads(n)}
                    className={clsx(
                      "rounded-lg px-2.5 py-1.5 font-mono text-xs font-medium transition-colors",
                      threads === n
                        ? "bg-navy-900 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                    )}
                  >
                    {n} 线程
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Live Worker Slots Preview when active */}
          {workerSlots.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-semibold text-slate-700">
                <span className="inline-flex items-center gap-1">
                  <Layers className="h-3.5 w-3.5 text-teal-600" />
                  实时工作线程槽位 ({workerSlots.length})
                </span>
                <span className="font-mono text-slate-500">
                  共享限流 {worker?.effective_requests_per_minute ?? "—"} RPM
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-32 overflow-y-auto">
                {workerSlots.map((slot) => {
                  const phaseMeta = WORKER_PHASE_LABELS[slot.phase] || {
                    label: slot.phase,
                    cls: "bg-slate-200 text-slate-700",
                  };
                  return (
                    <div
                      key={slot.worker_id}
                      className="flex items-center justify-between rounded-lg bg-navy-900 px-2.5 py-1.5 text-[11px] text-slate-200 font-mono"
                    >
                      <span className="truncate">
                        {slot.worker_id} · {slot.api_name}#{slot.ordinal + 1}
                      </span>
                      <span
                        className={clsx(
                          "ml-1.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-sans ring-1 ring-inset",
                          phaseMeta.cls,
                        )}
                      >
                        {phaseMeta.label}
                        {slot.next_request_in_ms > 0
                          ? ` ${(slot.next_request_in_ms / 1000).toFixed(1)}s`
                          : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Safety & Rate Limit Sharing Rules */}
          <div className="rounded-xl bg-slate-50 p-3.5 space-y-1.5 text-[11px] text-slate-600 ring-1 ring-inset ring-slate-200/80">
            <div className="flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-teal-600 mt-0.5" />
              <div>
                <strong>共享原子准入，绝不放大供应商额度：</strong>
                同一服务进程内所有切片工作线程共享全局 RPM、每接口配置 RPM、每任务 RPM 与滚动 24 小时日调用上限。调高线程数主要降低网络 RTT 等待开销，不会突破官方文档限流上限。
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 shrink-0 text-slate-400 mt-0.5" />
              <div>
                <strong>执行语义保持串行运行队列：</strong>
                不同运行与前置依赖阶段仍按队列顺序依次执行；仅当同一次运行包含多个切片时由线程池并发拉取归档。在任务运行期间修改此数值，仅对<strong>下一个启动的运行</strong>生效。
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-teal-600 px-4 py-1.5 font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存线程配置"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
