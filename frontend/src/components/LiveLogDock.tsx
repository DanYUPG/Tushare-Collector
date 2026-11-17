import clsx from "clsx";
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  ExternalLink,
  Pause,
  Play,
  Radio,
  Square,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  WORKER_PHASE_LABELS,
  describeWorkerSettingState,
  formatNumber,
  formatParamsCompact,
  formatShortTime,
} from "../lib/helpers";
import type {
  ActivityEvent,
  ActivityLevel,
  ActivityWorker,
  WorkerSettings,
} from "../types";

interface LiveLogDockProps {
  open: boolean;
  onToggleOpen: () => void;
  worker: ActivityWorker | null;
  workerSettings: WorkerSettings | null;
  events: ActivityEvent[];
  latestSeq: number;
  levelFilter: ActivityLevel | "";
  onChangeLevelFilter: (level: ActivityLevel | "") => void;
  onlyActiveRun: boolean;
  onToggleOnlyActiveRun: () => void;
  paused: boolean;
  onTogglePaused: () => void;
  onOpenWorkerSettings: () => void;
  onCancelActiveRun: (runId: string) => void;
  onOpenRunDetail: (runId: string) => void;
  onPreviewSlice: (runId: string, sliceId: string) => void;
}

const LEVEL_PILLS: Array<{ value: ActivityLevel | ""; label: string }> = [
  { value: "", label: "全部" },
  { value: "ok", label: "成功" },
  { value: "info", label: "常规" },
  { value: "warn", label: "警告" },
  { value: "error", label: "错误" },
];

function levelTag(level: ActivityLevel) {
  switch (level) {
    case "ok":
      return { text: "OK", cls: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/30" };
    case "warn":
      return { text: "WARN", cls: "bg-amber-500/20 text-amber-300 ring-amber-500/30" };
    case "error":
      return { text: "ERR", cls: "bg-rose-500/20 text-rose-300 ring-rose-500/30" };
    default:
      return { text: "INFO", cls: "bg-sky-500/20 text-sky-300 ring-sky-500/30" };
  }
}

export function LiveLogDock({
  open,
  onToggleOpen,
  worker,
  workerSettings,
  events,
  latestSeq,
  levelFilter,
  onChangeLevelFilter,
  onlyActiveRun,
  onToggleOnlyActiveRun,
  paused,
  onTogglePaused,
  onOpenWorkerSettings,
  onCancelActiveRun,
  onOpenRunDetail,
  onPreviewSlice,
}: LiveLogDockProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);
  const [dockSize, setDockSize] = useState<"compact" | "normal" | "tall">("compact");
  const dockHeightClass =
    dockSize === "compact" ? "h-44" : dockSize === "normal" ? "h-64" : "h-96";

  const activeRun = worker?.active_run ?? null;
  const activeSlices =
    activeRun?.current_slices && activeRun.current_slices.length > 0
      ? activeRun.current_slices
      : activeRun?.current_slice
        ? [activeRun.current_slice]
        : [];
  const workerSlots = worker?.workers ?? [];
  const threadInfo = describeWorkerSettingState(workerSettings, worker);
  const busyWorkers = worker?.busy_workers ?? (workerSlots.length || activeSlices.length);
  const filteredEvents = events.filter((ev) => {
    if (levelFilter && ev.level !== levelFilter) return false;
    if (onlyActiveRun && activeRun && ev.run_id !== activeRun.id) return false;
    return true;
  });

  useEffect(() => {
    if (!open || paused || !stickBottomRef.current || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [filteredEvents.length, latestSeq, open, paused]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
    stickBottomRef.current = nearBottom;
  };

  const latestEvent = events.at(-1) ?? null;
  const completedSlices = activeRun ? activeRun.succeeded + activeRun.failed : 0;

  return (
    <section
      aria-label="实时运行状态与日志控制台"
      className="shrink-0 border-t border-navy-800 bg-navy-950 text-slate-200 select-none"
    >
      {/* Always-visible Status & Control Strip */}
      <div className={clsx("flex items-center justify-between gap-3 px-4 bg-navy-900 border-b border-navy-800/80", open ? "h-9" : "h-8")}>
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-xs"
        >
          <Terminal className="h-3.5 w-3.5 shrink-0 text-teal-400" />
          <span className="font-semibold text-white shrink-0">运行日志</span>

          {activeRun ? (
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-slate-300">
              <span className="inline-flex items-center gap-1 rounded bg-teal-500/20 px-1.5 py-0.5 font-mono text-teal-300">
                <Radio className="h-3 w-3 animate-pulse" />
                {activeRun.api_name}
              </span>
              <span className="truncate font-medium text-slate-200">{activeRun.name}</span>
              <span className="font-mono text-teal-300 tabular-nums shrink-0">
                {activeRun.succeeded}/{activeRun.total} 切片 · {formatNumber(activeRun.rows)} 行
              </span>
              {activeRun.failed > 0 && <span className="shrink-0 text-rose-300">{activeRun.failed} 失败</span>}
              {open && (activeSlices.length > 1 ? (
                <span className="hidden lg:inline truncate font-mono text-slate-400">
                  并发执行 {activeSlices.length} 切片 (
                  {activeSlices
                    .slice(0, 3)
                    .map((s) => `#${s.ordinal + 1}`)
                    .join(", ")}
                  {activeSlices.length > 3 ? "…" : ""})
                </span>
              ) : activeSlices[0] ? (
                <span className="hidden lg:inline truncate font-mono text-slate-400">
                  当前 #{activeSlices[0].ordinal + 1} (
                  {formatParamsCompact(activeSlices[0].params)}) · 尝试{" "}
                  {activeSlices[0].attempt}/{activeSlices[0].max_attempts}
                </span>
              ) : null)}
            </div>
          ) : latestEvent && (open || latestEvent.level === "error" || latestEvent.level === "warn") ? (
            <span className={clsx("truncate text-[11px] font-mono", latestEvent.level === "error" ? "text-rose-300" : latestEvent.level === "warn" ? "text-amber-300" : "text-slate-400")}>
              最新 #{latestEvent.seq} [{formatShortTime(latestEvent.timestamp)}]{" "}
              {latestEvent.api_name} — {latestEvent.message}
            </span>
          ) : (
            <span className="truncate text-[11px] text-slate-400">
              {worker?.queued_runs ? `排队 ${worker.queued_runs} 项` : worker?.worker_running ? "当前无采集运行" : worker ? "执行引擎未运行" : "正在读取运行状态…"}
            </span>
          )}
        </button>

        {/* Right Controls */}
        <div className="flex shrink-0 items-center gap-2 text-[11px]">
          {open && <button
            type="button"
            onClick={onOpenWorkerSettings}
            className={clsx(
              "hidden sm:inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono tabular-nums transition-colors",
              threadInfo.pendingNextRun
                ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                : "bg-navy-800 text-teal-300 hover:bg-navy-700",
            )}
            title={threadInfo.summary}
          >
            <Cpu className="h-3 w-3" />
            线程 {busyWorkers}/{threadInfo.effective}
            {threadInfo.pendingNextRun ? `→${threadInfo.configured}` : ""}
          </button>}

          {open && worker && (
            <span
              className={clsx(
                "hidden sm:inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono tabular-nums",
                worker.pacing
                  ? "bg-amber-500/20 text-amber-300"
                  : "bg-navy-800 text-slate-300",
              )}
            >
              {worker.pacing
                ? `RPM 节流等待 ${(worker.next_request_in_ms / 1000).toFixed(1)}s`
                : `RPM ${worker.effective_requests_per_minute}/min`}
              {worker.queued_runs > 0 ? ` · 排队 ${worker.queued_runs}` : ""}
            </span>
          )}

          {open && (
            <>
              <div className="hidden md:flex items-center rounded bg-navy-800 p-0.5">
                {LEVEL_PILLS.map((pill) => (
                  <button
                    key={pill.value || "all"}
                    type="button"
                    onClick={() => onChangeLevelFilter(pill.value)}
                    className={clsx(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                      levelFilter === pill.value
                        ? "bg-teal-600 text-white"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                  >
                    {pill.label}
                  </button>
                ))}
              </div>

              {activeRun && (
                <button
                  type="button"
                  onClick={onToggleOnlyActiveRun}
                  className={clsx(
                    "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                    onlyActiveRun
                      ? "bg-teal-600/30 text-teal-200 ring-1 ring-inset ring-teal-500/40"
                      : "bg-navy-800 text-slate-400 hover:text-slate-200",
                  )}
                >
                  仅当前运行
                </button>
              )}

              <button
                type="button"
                onClick={onTogglePaused}
                className={clsx(
                  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium",
                  paused
                    ? "bg-amber-500/25 text-amber-300"
                    : "bg-navy-800 text-slate-300 hover:text-white",
                )}
                title={paused ? "恢复实时滚动刷新" : "暂停日志流"}
              >
                {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                {paused ? "已暂停" : "实时"}
              </button>

              <div
                className="hidden sm:inline-flex items-center rounded bg-navy-800 p-0.5 text-[10px]"
                aria-label="日志面板高度"
              >
                {(
                  [
                    ["compact", "紧凑"],
                    ["normal", "标准"],
                    ["tall", "加高"],
                  ] as const
                ).map(([sz, label]) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => setDockSize(sz)}
                    className={clsx(
                      "rounded px-1.5 py-0.5 font-medium transition-colors",
                      dockSize === sz
                        ? "bg-navy-700 text-white"
                        : "text-slate-400 hover:text-slate-200",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={onToggleOpen}
            className="inline-flex items-center gap-1 rounded bg-navy-800 px-2 py-0.5 text-slate-300 hover:bg-navy-700 hover:text-white"
          >
            {open ? (
              <>
                收起 <ChevronDown className="h-3.5 w-3.5" />
              </>
            ) : (
              <>
                展开 ({events.length}) <ChevronUp className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </div>
      </div>

      {/* Expanded Live Console */}
      {open && (
        <div className={clsx("flex flex-col", dockHeightClass)}>
          {/* Active Run Progress & Multi-Worker Sub-banner */}
          {activeRun && (
            <div className="border-b border-navy-800 bg-navy-900/60 px-4 py-2 text-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="w-40 shrink-0">
                    <progress
                      className={clsx(
                        "collector-progress collector-progress-dark",
                        activeRun.failed > 0 && "collector-progress-amber",
                      )}
                      value={completedSlices}
                      max={Math.max(activeRun.total, 1)}
                    />
                  </div>
                  <span className="font-mono text-[11px] text-slate-300 tabular-nums">
                    成功 {activeRun.succeeded} · 执行中 {activeRun.running} · 失败 {activeRun.failed} · 待执行{" "}
                    {activeRun.pending} / 共 {activeRun.total}
                  </span>
                  {threadInfo.pendingNextRun && (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                      本次实际 {threadInfo.effective} 线程 · 下次生效 {threadInfo.configured} 线程
                    </span>
                  )}
                  {activeRun.cancel_requested && (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                      正在等待活跃线程安全停止…
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenRunDetail(activeRun.id)}
                    className="inline-flex items-center gap-1 rounded bg-navy-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-navy-700"
                  >
                    <ExternalLink className="h-3 w-3" />
                    运行切片明细
                  </button>
                  {!activeRun.cancel_requested && (
                    <button
                      type="button"
                      onClick={() => onCancelActiveRun(activeRun.id)}
                      className="inline-flex items-center gap-1 rounded bg-rose-500/20 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/30"
                    >
                      <Square className="h-3 w-3" />
                      停止运行
                    </button>
                  )}
                </div>
              </div>

              {/* Concurrent Worker Slots Strip */}
              {(workerSlots.length > 0 || activeSlices.length > 1) && (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-[10px] font-semibold text-slate-400 mr-1">
                    活跃线程槽位：
                  </span>
                  {workerSlots.length > 0
                    ? workerSlots.map((slot) => {
                        const phaseMeta = WORKER_PHASE_LABELS[slot.phase] || {
                          label: slot.phase,
                          cls: "bg-navy-800 text-slate-300 ring-slate-600/30",
                        };
                        const matchingSlice = activeSlices.find(
                          (s) => s.slice_id === slot.slice_id,
                        );
                        return (
                          <div
                            key={slot.worker_id}
                            className="inline-flex items-center gap-1.5 rounded bg-navy-950/90 px-2 py-0.5 font-mono text-[10px] text-slate-200 ring-1 ring-inset ring-navy-700"
                          >
                            <span className="text-teal-400">{slot.worker_id}</span>
                            <span>
                              {slot.api_name}#{slot.ordinal + 1}
                            </span>
                            {matchingSlice && (
                              <span className="text-slate-400 max-w-36 truncate">
                                ({formatParamsCompact(matchingSlice.params)})
                              </span>
                            )}
                            <span
                              className={clsx(
                                "rounded px-1 py-0.2 font-sans text-[9px] ring-1 ring-inset",
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
                      })
                    : activeSlices.map((s) => (
                        <div
                          key={s.slice_id}
                          className="inline-flex items-center gap-1 rounded bg-navy-950/90 px-2 py-0.5 font-mono text-[10px] text-slate-200 ring-1 ring-inset ring-navy-700"
                        >
                          <span className="text-teal-300">#{s.ordinal + 1}</span>
                          <span className="text-slate-400 max-w-40 truncate">
                            {formatParamsCompact(s.params)}
                          </span>
                          <span className="text-slate-500">
                            尝试 {s.attempt}/{s.max_attempts}
                          </span>
                        </div>
                      ))}
                </div>
              )}
            </div>
          )}

          {/* Event Log Stream */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto px-4 py-2 font-mono text-[11px] leading-relaxed select-text space-y-1"
          >
            {filteredEvents.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-500 font-sans">
                {events.length === 0
                  ? "当前暂无实时活动事件（新触发的采集、切片归档、限流退避与重试将实时在此输出）"
                  : "当前筛选条件下没有匹配的日志事件"}
              </div>
            ) : (
              filteredEvents.map((ev) => {
                const badge = levelTag(ev.level);
                const paramSummary = formatParamsCompact(ev.params);
                return (
                  <div
                    key={ev.seq}
                    className="group flex items-start gap-2.5 rounded px-2 py-1 hover:bg-navy-900/90 transition-colors"
                  >
                    <span className="shrink-0 text-slate-500 tabular-nums">
                      {formatShortTime(ev.timestamp)}
                    </span>
                    <span className="shrink-0 w-10 text-right text-slate-600 tabular-nums">
                      #{ev.seq}
                    </span>
                    <span
                      className={clsx(
                        "shrink-0 w-11 text-center rounded px-1 py-0.2 text-[10px] font-semibold ring-1 ring-inset",
                        badge.cls,
                      )}
                    >
                      {badge.text}
                    </span>
                    <span className="shrink-0 text-teal-300 font-medium">
                      {ev.api_name}
                      {ev.ordinal !== null ? `#${ev.ordinal + 1}` : ""}
                    </span>
                    <span className="min-w-0 flex-1 text-slate-200 break-all">
                      {ev.message}
                      {paramSummary && paramSummary !== "默认参数" && (
                        <span className="ml-2 text-slate-400">[{paramSummary}]</span>
                      )}
                      {ev.duration_ms !== null && (
                        <span className="ml-2 text-slate-500 tabular-nums">
                          {ev.duration_ms}ms
                        </span>
                      )}
                      {ev.raw_sha256 && (
                        <span className="ml-2 text-emerald-400/80">
                          sha256:{ev.raw_sha256.slice(0, 8)}
                        </span>
                      )}
                    </span>
                    <div className="shrink-0 opacity-0 group-hover:opacity-100 flex items-center gap-1.5 transition-opacity font-sans">
                      {ev.slice_id && ev.level === "ok" && (
                        <button
                          type="button"
                          onClick={() => onPreviewSlice(ev.run_id, ev.slice_id!)}
                          className="rounded bg-teal-600/25 px-1.5 py-0.5 text-[10px] text-teal-300 hover:bg-teal-600/40"
                        >
                          预览表
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onOpenRunDetail(ev.run_id)}
                        className="rounded bg-navy-800 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-navy-700"
                      >
                        运行详情
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </section>
  );
}
