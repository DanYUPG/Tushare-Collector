import clsx from "clsx";
import {
  Archive,
  ArrowRight,
  Compass,
  Database,
  FolderSearch,
  History,
  Search,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../lib/helpers";
import type {
  Catalog,
  DailyWarehouseStatus,
  DatasetItem,
  NavTab,
  WarehouseCatalog,
} from "../types";

interface CommandPaletteModalProps {
  open: boolean;
  onClose: () => void;
  catalog: Catalog | null;
  warehouseCatalog: WarehouseCatalog | null;
  warehouseEvidence: Record<string, DailyWarehouseStatus>;
  datasets: DatasetItem[];
  onNavigateTab: (tab: NavTab) => void;
  onOpenWarehouse: (datasetId: string) => void;
  onOpenDatasetPlan: (datasetId: string) => void;
  onOpenCustomEntry: (entryId: string) => void;
  onOpenRawEntry: (entryId: string) => void;
  onOpenPermissionEntry: (entryId: string) => void;
}

interface PaletteItem {
  key: string;
  kind: "view" | "entry";
  title: string;
  subtitle: string;
  apiName?: string;
  entryId?: string;
  datasetId?: string | null;
  warehouseSupported?: boolean;
  warehouseReadyRows?: number | null;
  hasPresetDataset?: boolean;
  tab?: NavTab;
}

const WORKSPACE_VIEW_ITEMS: Array<{
  tab: NavTab;
  title: string;
  subtitle: string;
  keywords: string;
}> = [
  {
    tab: "needs",
    title: "我的数据",
    subtitle: "声明长期需求，自动采集入库并查询导出",
    keywords: "needs 数据需求 自动维护 同步",
  },
  {
    tab: "warehouse",
    title: "数据浏览",
    subtitle: "81 张标准仓库表快照直读、变体切换与按需字段裁剪导出",
    keywords: "warehouse 本地数据仓库 本地仓库 快照 parquet 导出 直读",
  },
  {
    tab: "runs",
    title: "运行记录",
    subtitle: "查看采集历史、失败恢复、常用配置与任务组批次",
    keywords: "runs 运行与任务 任务与运行历史 运行 历史 任务 批次 恢复",
  },
  {
    tab: "datasets",
    title: "预置采集",
    subtitle: "高级工具 · 预置股票数据集增量检查、覆盖范围与批量采集",
    keywords: "datasets 预置数据集 接口目录与采集 采集 增量 股票",
  },
  {
    tab: "custom",
    title: "自定义 API",
    subtitle: "高级工具 · 单次即时参数验证或自定义日期/枚举切片采集向导",
    keywords: "custom 自定义接口采集 自定义 接口 向导 调试",
  },
  {
    tab: "local-data",
    title: "原始归档",
    subtitle: "高级工具 · 按业务域浏览 Raw 归档文件并实时核验单文件 SHA256",
    keywords: "local raw 本地数据阅读 本地归档阅读器 原始归档 切片 阅读 sha256",
  },
  {
    tab: "permissions",
    title: "接口权限与限流",
    subtitle: "高级工具 · 核对 102 项股票接口积分门槛、独立授权与每分钟限流",
    keywords: "permissions 权限与限流台账 权限 积分 限流 rpm",
  },
];

export function CommandPaletteModal({
  open,
  onClose,
  catalog,
  warehouseCatalog,
  warehouseEvidence,
  datasets,
  onNavigateTab,
  onOpenWarehouse,
  onOpenDatasetPlan,
  onOpenCustomEntry,
  onOpenRawEntry,
  onOpenPermissionEntry,
}: CommandPaletteModalProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const datasetByEntryId = useMemo(() => {
    const map = new Map<string, DatasetItem>();
    for (const ds of datasets) {
      map.set(ds.entry_id, ds);
    }
    return map;
  }, [datasets]);

  const warehouseEntryById = useMemo(() => {
    const map = new Map<
      string,
      NonNullable<WarehouseCatalog["entries"]>[number]
    >();
    for (const entry of warehouseCatalog?.entries ?? []) {
      map.set(entry.entry_id, entry);
    }
    return map;
  }, [warehouseCatalog]);

  const filteredItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const items: PaletteItem[] = [];

    for (const v of WORKSPACE_VIEW_ITEMS) {
      const hay = `${v.title} ${v.subtitle} ${v.keywords}`.toLowerCase();
      if (!q || hay.includes(q)) {
        items.push({
          key: `view:${v.tab}`,
          kind: "view",
          title: v.title,
          subtitle: v.subtitle,
          tab: v.tab,
        });
      }
    }

    const rawEntries = catalog?.entries ?? [];
    const matchedEntries: Array<{ item: PaletteItem; score: number }> = [];

    for (const entry of rawEntries) {
      const whEntry = warehouseEntryById.get(entry.id);
      const presetDs = datasetByEntryId.get(entry.id);
      const datasetId = whEntry?.dataset_id || presetDs?.id || null;
      const whSupported = Boolean(
        whEntry?.warehouse_supported || whEntry?.warehouse_status === "supported",
      );
      const whStatus = datasetId ? warehouseEvidence[datasetId] : undefined;
      const readyRows = whStatus?.state === "ready" ? whStatus.rows : null;
      const domainLabel =
        whEntry?.business_domain_name || entry.category || "股票接口";

      const hay =
        `${entry.name} ${entry.api_name} ${entry.id} ${domainLabel} ${datasetId || ""} ${whEntry?.grain || ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;

      let score = 0;
      if (q) {
        if (entry.api_name.toLowerCase() === q || entry.id === q) score += 100;
        else if (entry.api_name.toLowerCase().startsWith(q)) score += 60;
        else if (entry.name.toLowerCase().includes(q)) score += 40;
      }
      if (readyRows !== null) score += 30;
      else if (whSupported) score += 10;

      matchedEntries.push({
        score,
        item: {
          key: `entry:${entry.id}`,
          kind: "entry",
          title: entry.name,
          subtitle: `${domainLabel} · #${entry.id}`,
          apiName: entry.api_name,
          entryId: entry.id,
          datasetId,
          warehouseSupported: whSupported,
          warehouseReadyRows: readyRows,
          hasPresetDataset: Boolean(presetDs),
        },
      });
    }

    matchedEntries.sort((a, b) => b.score - a.score);
    const limit = q ? 30 : 12;
    for (const m of matchedEntries.slice(0, limit)) {
      items.push(m.item);
    }

    return items;
  }, [query, catalog, warehouseEntryById, datasetByEntryId, warehouseEvidence]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const executePrimaryAction = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind === "view" && item.tab) {
      onNavigateTab(item.tab);
      onClose();
      return;
    }
    if (item.warehouseSupported && item.datasetId) {
      onOpenWarehouse(item.datasetId);
      onClose();
      return;
    }
    if (item.entryId) {
      onOpenRawEntry(item.entryId);
      onClose();
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setActiveIndex((prev) =>
          filteredItems.length === 0 ? 0 : (prev + 1) % filteredItems.length,
        );
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setActiveIndex((prev) =>
          filteredItems.length === 0
            ? 0
            : (prev - 1 + filteredItems.length) % filteredItems.length,
        );
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        executePrimaryAction(filteredItems[activeIndex]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filteredItems, activeIndex]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 pt-16 px-4 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="全局快速跳转命令面板"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3">
          <Search className="h-4 w-4 text-teal-600 shrink-0" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入接口名、api_name（如 income / fina_indicator / trade_cal）或视图名称快速跳转…"
            aria-label="全局搜索接口或视图"
            className="flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
          />
          <kbd className="hidden sm:inline-block rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
            ESC
          </kbd>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭命令面板"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
          {filteredItems.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              未找到匹配的接口或工作台页面
            </div>
          ) : (
            filteredItems.map((item, idx) => {
              const active = idx === activeIndex;
              if (item.kind === "view") {
                return (
                  <div
                    key={item.key}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => executePrimaryAction(item)}
                    className={clsx(
                      "flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-xs transition-colors",
                      active ? "bg-teal-50/70" : "bg-white hover:bg-slate-50",
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Compass className="h-4 w-4 text-teal-600 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 truncate">
                          切换页面：{item.title}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {item.subtitle}
                        </div>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 shrink-0">
                      前往 <ArrowRight className="h-3 w-3" />
                    </span>
                  </div>
                );
              }

              return (
                <div
                  key={item.key}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => executePrimaryAction(item)}
                  className={clsx(
                    "flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs transition-colors",
                    active ? "bg-teal-50/70" : "bg-white hover:bg-slate-50",
                  )}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-slate-900">
                        {item.title}
                      </span>
                      {item.apiName && (
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                          {item.apiName}
                        </code>
                      )}
                      {item.warehouseReadyRows !== null &&
                      item.warehouseReadyRows !== undefined ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.2 text-[10px] font-semibold text-emerald-800 tabular-nums">
                          已建仓 · {formatNumber(item.warehouseReadyRows)} 行
                        </span>
                      ) : item.warehouseSupported ? (
                        <span className="rounded-full bg-slate-100 px-2 py-0.2 text-[10px] font-medium text-slate-600">
                          支持建仓
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2 py-0.2 text-[10px] font-medium text-amber-800">
                          仅 Raw 阅读
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {item.subtitle}
                    </div>
                  </div>

                  <div
                    className="flex flex-wrap items-center gap-1.5 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.warehouseSupported && item.datasetId && (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenWarehouse(item.datasetId!);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 rounded-md bg-teal-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-teal-700"
                      >
                        <Archive className="h-3 w-3" />
                        查仓库
                      </button>
                    )}

                    {item.hasPresetDataset && item.datasetId ? (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenDatasetPlan(item.datasetId!);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Database className="h-3 w-3 text-slate-500" />
                        配采集
                      </button>
                    ) : item.entryId ? (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenCustomEntry(item.entryId!);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Wrench className="h-3 w-3 text-slate-500" />
                        自定义采集
                      </button>
                    ) : null}

                    {item.entryId && (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenRawEntry(item.entryId!);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <FolderSearch className="h-3 w-3 text-slate-500" />
                        看 Raw
                      </button>
                    )}

                    {item.entryId && (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenPermissionEntry(item.entryId!);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        title="查看积分门槛与限流规则"
                      >
                        <ShieldCheck className="h-3 w-3 text-slate-500" />
                        权限
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-500">
          <span>
            快捷键：<kbd className="font-mono">↑↓</kbd> 选择 ·{" "}
            <kbd className="font-mono">Enter</kbd> 默认直达 ·{" "}
            <kbd className="font-mono">⌘K / Ctrl+K</kbd> 随时呼出
          </span>
          <span className="inline-flex items-center gap-1 font-mono tabular-nums">
            <History className="h-3 w-3" />
            匹配 {filteredItems.length} 项
          </span>
        </div>
      </div>
    </div>
  );
}
