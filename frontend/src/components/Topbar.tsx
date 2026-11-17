import clsx from "clsx";
import {
  ArrowUpLeft,
  Cpu,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import { describeWorkerSettingState } from "../lib/helpers";
import { WorkspaceMenu } from "./WorkspaceLayout";
import type {
  ActivityWorker,
  DatasetReturnDraft,
  NavTab,
  ServerStatus,
  WorkerSettings,
} from "../types";

interface TopbarProps {
  activeTab: NavTab;
  status: ServerStatus | null;
  worker: ActivityWorker | null;
  workerSettings: WorkerSettings | null;
  refreshing: boolean;
  logDockOpen: boolean;
  pendingReturn: DatasetReturnDraft | null;
  pendingReturnDatasetName: string;
  onReturnToDataset: () => void;
  onRefresh: () => void;
  onOpenCredential: () => void;
  onOpenWorkerSettings: () => void;
  onToggleLogDock: () => void;
  onOpenRunDetail: (runId: string) => void;
  onOpenCommandPalette: () => void;
}

const VIEW_META: Record<NavTab, { title: string; subtitle: string }> = {
  needs: {
    title: "我的数据",
    subtitle: "声明长期数据需求，授权后自动准备依赖、采集、校验和发布",
  },
  datasets: {
    title: "预置采集",
    subtitle: "按日历与股票池规划增量采集，独立归档原始 Parquet 切片",
  },
  warehouse: {
    title: "数据浏览",
    subtitle: "多形态离线标准表快照直读、变体隔离与按需字段裁剪导出",
  },
  permissions: {
    title: "接口权限与限流",
    subtitle: "核验股票目录接口官方链接、申报分档门槛、独立授权与本地节流速率",
  },
  "local-data": {
    title: "原始归档",
    subtitle: "离线浏览 Raw Parquet / JSON 切片并实时校验 SHA256",
  },
  runs: {
    title: "运行记录",
    subtitle: "管理常用配置、任务组调度、中断续跑与切片明细",
  },
  custom: {
    title: "自定义 API",
    subtitle: "浏览目录文档，支持单次即时验证或 3 步切片采集向导",
  },
};

export function Topbar({
  activeTab,
  status,
  worker,
  workerSettings,
  refreshing,
  logDockOpen,
  pendingReturn,
  pendingReturnDatasetName,
  onReturnToDataset,
  onRefresh,
  onOpenCredential,
  onOpenWorkerSettings,
  onToggleLogDock,
  onOpenRunDetail,
  onOpenCommandPalette,
}: TopbarProps) {
  const meta = VIEW_META[activeTab];
  const activeRun = worker?.active_run ?? null;
  const queued = worker?.queued_runs ?? 0;
  const tokenConfigured = worker?.token_configured ?? status?.token_configured ?? false;
  const threadInfo = describeWorkerSettingState(
    workerSettings ?? {
      collection_threads: status?.collection_threads ?? 1,
      effective_collection_threads: status?.effective_collection_threads ?? 1,
      max_collection_threads: status?.max_collection_threads ?? 16,
      applies_to: "next_run",
    },
    worker,
  );
  const busyWorkers = worker?.busy_workers ?? (activeRun ? 1 : 0);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 title={meta.subtitle} className="truncate text-base font-semibold text-slate-900">{meta.title}</h1>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5">
        {/* Dependency Auto-Return Pill */}
        {pendingReturn && (
          <button
            type="button"
            onClick={onReturnToDataset}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/25 hover:bg-amber-100 transition-colors"
          >
            <ArrowUpLeft className="h-3.5 w-3.5" />
            返回继续「{pendingReturnDatasetName}」采集
          </button>
        )}

        {/* Live Execution Status Capsule (only when active or queued; idle dot merges into Console button) */}
        {activeRun ? (
          <div className="inline-flex items-center rounded-full bg-teal-50 pl-3 pr-1.5 py-1 text-xs font-medium text-teal-900 ring-1 ring-inset ring-teal-600/30">
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-teal-600" />
            <button
              type="button"
              onClick={onToggleLogDock}
              className="truncate max-w-52 text-left hover:underline"
              title="点击展开或收起实时运行日志台"
            >
              {activeRun.api_name} ({activeRun.succeeded}/{activeRun.total})
            </button>
            {worker?.pacing && worker.next_request_in_ms > 0 && (
              <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-mono text-amber-800 tabular-nums">
                节流 {(worker.next_request_in_ms / 1000).toFixed(1)}s
              </span>
            )}
            <button
              type="button"
              onClick={() => onOpenRunDetail(activeRun.id)}
              className="ml-2 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-teal-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
            >
              详情
            </button>
          </div>
        ) : queued > 0 ? (
          <button
            type="button"
            onClick={onToggleLogDock}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-500/30 transition-colors"
          >
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            队列待执行 {queued} 项
          </button>
        ) : null}

        {/* Token Warning or Shortcut */}
        {!tokenConfigured && (
          <button
            type="button"
            onClick={onOpenCredential}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-amber-600 transition-colors"
          >
            <KeyRound className="h-3.5 w-3.5" />
            设置 Token
          </button>
        )}

        {/* Global Cmd/Ctrl+K Quick Jump Button */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-label="打开全局快速跳转命令面板"
          title="搜索任意接口或页面并快速跳转 (⌘K / Ctrl+K)"
          className="inline-flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-100 hover:text-slate-900 transition-colors"
        >
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <span className="hidden md:inline">快速跳转</span>
          <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.2 font-mono text-[10px] text-slate-500">
            ⌘K
          </kbd>
        </button>

        <WorkspaceMenu label="工具与设置">
        <button type="button" onClick={onOpenCredential}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-100">
          <KeyRound className="h-3.5 w-3.5" />接口凭证{status?.token_persisted ? "（明文已保存）" : tokenConfigured ? "（已配置）" : "（未配置）"}
        </button>
        <button
          type="button"
          onClick={onOpenWorkerSettings}
          className={clsx(
            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left tabular-nums",
            threadInfo.pendingNextRun
              ? "bg-amber-50 text-amber-800 hover:bg-amber-100"
              : "hover:bg-slate-100",
          )}
          title={threadInfo.summary}
        >
          <Cpu className="h-3.5 w-3.5 text-teal-600" />
          <span>
            {activeRun
              ? `并发 ${busyWorkers}/${threadInfo.effective}`
              : `线程 ${threadInfo.effective}`}
            {threadInfo.pendingNextRun ? ` (下次 ${threadInfo.configured})` : ""}
          </span>
        </button>

        <button
          type="button"
          onClick={onToggleLogDock}
          className={clsx(
            "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left",
            logDockOpen
              ? "bg-navy-900 text-white"
              : "hover:bg-slate-100",
          )}
          aria-pressed={logDockOpen}
        >
          <Terminal className="h-3.5 w-3.5" />
          {logDockOpen ? "收起运行日志" : "展开运行日志"}
        </button>

        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-100 disabled:opacity-50"
          title="立即同步工作台状态"
        >
          <RefreshCw className={clsx("h-3.5 w-3.5", refreshing && "animate-spin")} />
          刷新工作台状态
        </button>
        {status?.catalog_version?.trim() && <p className="border-t border-slate-100 px-3 pt-2 font-mono text-[10px] text-slate-400">目录 v{status.catalog_version}</p>}
        </WorkspaceMenu>
      </div>
    </header>
  );
}
