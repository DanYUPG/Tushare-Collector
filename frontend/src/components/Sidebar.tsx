import clsx from "clsx";
import {
  Archive,
  BookOpenCheck,
  ChevronDown,
  Database,
  FolderSearch,
  History,
  KeyRound,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ActivityWorker,
  DailyWarehouseStatus,
  NavTab,
  ServerStatus,
} from "../types";

const ADVANCED_TABS: NavTab[] = ["datasets", "custom", "local-data", "permissions"];

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  status: ServerStatus | null;
  worker: ActivityWorker | null;
  dailyWarehouse: DailyWarehouseStatus | null;
  supportedWarehouseCount?: number | null;
  readyWarehouseCount?: number;
  refreshNeededWarehouseCount?: number;
  datasetStats: { covered: number; total: number; attention: number };
  permissionsStats: { total: number; specialCount: number };
  localArchiveCount: number | null;
  pendingDeletionCount: number;
  activeOrQueuedRuns: number;
  onOpenCredential: () => void;
}

export function Sidebar({
  activeTab,
  onSelectTab,
  status,
  worker,
  dailyWarehouse,
  supportedWarehouseCount = null,
  readyWarehouseCount = 0,
  refreshNeededWarehouseCount = 0,
  datasetStats,
  permissionsStats,
  localArchiveCount,
  pendingDeletionCount,
  activeOrQueuedRuns,
  onOpenCredential,
}: SidebarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_TABS.includes(activeTab));
  useEffect(() => {
    if (ADVANCED_TABS.includes(activeTab)) setAdvancedOpen(true);
  }, [activeTab]);
  const tokenOk = worker?.token_configured ?? status?.token_configured ?? false;
  const hasWarehouseRefreshNeeded =
    refreshNeededWarehouseCount > 0 || Boolean(dailyWarehouse?.refresh_needed);

  const navItems: Array<{
    id: NavTab;
    label: string;
    subtitle: string;
    icon: typeof Database;
    badge?: string;
    badgeTone?: "teal" | "amber" | "slate";
  }> = [
    {
      id: "needs",
      label: "我的数据",
      subtitle: "声明需求 · 自动维护 · 存储管理",
      icon: Database,
    },
    {
      id: "datasets",
      label: "预置采集",
      subtitle: "股票目录 · 预置采集归档",
      icon: Database,
      badge: `归档 ${datasetStats.covered}/${datasetStats.total || 102}`,
      badgeTone: datasetStats.attention > 0 ? "amber" : "slate",
    },
    {
      id: "warehouse",
      label: "数据浏览",
      subtitle: "本地仓库 · 查询筛选 · 导出",
      icon: Archive,
      badge:
        supportedWarehouseCount != null
          ? readyWarehouseCount > 0
            ? `已建 ${readyWarehouseCount}/${supportedWarehouseCount}`
            : `支持 ${supportedWarehouseCount} 表`
          : hasWarehouseRefreshNeeded
            ? "待整理"
            : undefined,
      badgeTone: hasWarehouseRefreshNeeded
        ? "amber"
        : readyWarehouseCount > 0
          ? "teal"
          : "slate",
    },
    {
      id: "permissions",
      label: "接口权限与限流",
      subtitle: "官方链接 · 8000分档核定",
      icon: BookOpenCheck,
      badge:
        permissionsStats.total > 0
          ? `${permissionsStats.total} 项`
          : undefined,
      badgeTone: permissionsStats.specialCount > 0 ? "amber" : "slate",
    },
    {
      id: "local-data",
      label: "原始归档",
      subtitle: "Raw 切片校验与预览",
      icon: FolderSearch,
      badge:
        pendingDeletionCount > 0
          ? `${pendingDeletionCount} 待清理`
          : localArchiveCount !== null
            ? `${localArchiveCount.toLocaleString()} 档`
            : undefined,
      badgeTone: pendingDeletionCount > 0 ? "amber" : "slate",
    },
    {
      id: "runs",
      label: "运行记录",
      subtitle: "执行进度 · 错误恢复 · 历史",
      icon: History,
      badge: activeOrQueuedRuns > 0 ? `${activeOrQueuedRuns} 活动` : undefined,
      badgeTone: "teal",
    },
    {
      id: "custom",
      label: "自定义 API",
      subtitle: "单次查询与 3 步向导",
      icon: SlidersHorizontal,
    },
  ];

  function renderNavItem(item: typeof navItems[number]) {
    const Icon = item.icon;
    const active = activeTab === item.id;
    return (
      <button
        key={item.id}
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelectTab(item.id)}
        className={clsx(
          "group flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors",
          active
            ? "bg-teal-600/15 text-white ring-1 ring-inset ring-teal-500/35"
            : "text-slate-300 hover:bg-navy-800 hover:text-white",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon
            className={clsx(
              "h-4 w-4 shrink-0 transition-colors",
              active ? "text-teal-400" : "text-slate-400 group-hover:text-slate-200",
            )}
          />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{item.label}</div>
            <div className="truncate text-[11px] text-slate-400">{item.subtitle}</div>
          </div>
        </div>
        {item.badge && (
          <span
            className={clsx(
              "ml-2 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums",
              item.badgeTone === "teal" && "bg-teal-500/20 text-teal-300",
              item.badgeTone === "amber" && "bg-amber-500/20 text-amber-300",
              item.badgeTone === "slate" && "bg-navy-700 text-slate-300",
            )}
          >
            {item.badge}
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-navy-900 text-slate-200 select-none border-r border-navy-800">
      {/* Brand Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-navy-800/90">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-600/20 text-teal-400 ring-1 ring-inset ring-teal-500/30">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight text-white">
            Tushare Collector
          </div>
          <div className="truncate text-[11px] text-slate-400">
            本地股票数据工作台
          </div>
        </div>
      </div>

      {/* Primary Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto" aria-label="主导航">
        <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          数据工作区
        </div>
        <div role="group" aria-label="主要页面" className="space-y-1">
          {navItems.filter(item => !ADVANCED_TABS.includes(item.id)).map(renderNavItem)}
        </div>
        <div className="pt-4">
          <button type="button" aria-expanded={advancedOpen} aria-controls="advanced-navigation"
            onClick={() => setAdvancedOpen(open => !open)}
            className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-slate-400 hover:bg-navy-800 hover:text-white">
            高级工具
            <ChevronDown className={clsx("h-4 w-4 transition-transform", advancedOpen && "rotate-180")} />
          </button>
          <div id="advanced-navigation" role="group" aria-label="高级工具" hidden={!advancedOpen}>
            {ADVANCED_TABS.map(tab => navItems.find(item => item.id === tab)).map(item => item && renderNavItem(item))}
          </div>
        </div>
      </nav>

      {/* Compact Credential & Storage Root Footer (engine/thread/log live in Topbar & Bottom Dock) */}
      <div className="border-t border-navy-800 p-3 bg-navy-950/50 space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-slate-400">Tushare 凭证</span>
          <button
            type="button"
            onClick={onOpenCredential}
            title={status?.token_persisted ? "Token 已明文保存在本机；文件权限和 Git 忽略规则不是加密，请勿分享或同步凭证文件" : "当前进程有效；可在凭证设置中选择记住 Token"}
            className={clsx(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
              tokenOk
                ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                : "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30",
            )}
          >
            <KeyRound className="h-3 w-3" />
            {tokenOk ? status?.token_persisted ? "已配置 (明文保存)" : "已配置 (进程有效)" : "配置 Token"}
          </button>
        </div>
        {status?.default_raw_root && (
          <div
            className="truncate font-mono text-[10px] text-slate-500"
            title={`默认归档根目录：${status.default_raw_root}`}
          >
            目录：{status.default_raw_root}
          </div>
        )}
      </div>
    </aside>
  );
}
