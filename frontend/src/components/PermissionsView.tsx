import clsx from "clsx";
import {
  AlertTriangle,
  BookOpenCheck,
  ExternalLink,
  FileSearch,
  Info,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { patchLocationState, readLocationState } from "../lib/navigation";
import {
  QUOTA_WINDOW_LABELS,
  RATE_SOURCE_LABELS,
  accountAccessBadge,
  formatDateTime,
  formatNumber,
  formatPermissionRpm,
  formatPermissionThreshold,
  matchesPermissionFilter,
  type PermissionFilterKey,
} from "../lib/helpers";
import type { Catalog, PermissionEntry, PermissionsCatalog } from "../types";

interface PermissionsViewProps {
  catalog: Catalog | null;
  permissions: PermissionsCatalog | null;
  focusEntryId?: string | null;
  onClearFocusEntry?: () => void;
  onJumpToDataset?: (entryId: string) => void;
  onJumpToCustom?: (entryId: string) => void;
}

const FILTER_PILLS: Array<{ key: PermissionFilterKey; label: string }> = [
  { key: "all", label: "全部入口" },
  { key: "points_satisfied", label: "申报积分满足" },
  { key: "independent", label: "需独立授权" },
  { key: "insufficient_points", label: "申报积分不足" },
  { key: "unknown_rpm", label: "官方未公布分钟频次" },
  { key: "daily_limit", label: "有日调用上限" },
  { key: "has_conflict_or_note", label: "文档冲突 / 特殊边界" },
  { key: "undocumented", label: "未公布积分门槛" },
];

export function PermissionsView({
  catalog,
  permissions,
  focusEntryId,
  onClearFocusEntry,
  onJumpToDataset,
  onJumpToCustom,
}: PermissionsViewProps) {
  const [categoryFilter, setCategoryFilter] = useState("");
  const [accessFilter, setAccessFilter] = useState<PermissionFilterKey>("all");
  const [search, setSearch] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [filtersReady, setFiltersReady] = useState(false);

  useEffect(() => {
    if (!catalog) return;
    const restore = () => {
      const params = readLocationState();
      const category = params.get("perm_category");
      setCategoryFilter(catalog.categories.some(item => item.id === category) ? category! : "");
      setAccessFilter(FILTER_PILLS.find(item => item.key === params.get("perm_access"))?.key ?? "all");
      setSearch(params.get("perm_q") || "");
      const entry = params.get("perm_entry");
      setSelectedEntryId(catalog.entries.some(item => item.id === entry) ? entry : null);
      setFiltersReady(true);
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [catalog]);

  useEffect(() => {
    if (filtersReady) patchLocationState({
      perm_category: categoryFilter || null, perm_access: accessFilter,
      perm_q: search || null, perm_entry: selectedEntryId,
    });
  }, [categoryFilter, accessFilter, search, selectedEntryId, filtersReady]);

  const catalogById = useMemo(() => {
    const map = new Map<
      string,
      { category: string; category_name: string; row_limit: number | null; status?: string }
    >();
    for (const entry of catalog?.entries ?? []) {
      map.set(entry.id, {
        category: entry.category,
        category_name: entry.category_name,
        row_limit: entry.row_limit,
        status: entry.status,
      });
    }
    return map;
  }, [catalog]);

  const enrichedEntries = useMemo(() => {
    const list = permissions?.entries ?? [];
    return list.map((entry) => {
      const cat = catalogById.get(entry.id);
      return {
        entry,
        category: cat?.category ?? "",
        categoryName: cat?.category_name ?? "未分类",
        rowLimit: cat?.row_limit ?? null,
        status: cat?.status,
      };
    });
  }, [permissions, catalogById]);

  useEffect(() => {
    if (focusEntryId) {
      setCategoryFilter("");
      setAccessFilter("all");
      setSearch("");
      setSelectedEntryId(focusEntryId);
      onClearFocusEntry?.();
    }
  }, [focusEntryId, onClearFocusEntry]);

  const summary = useMemo(() => {
    const entries = permissions?.entries ?? [];
    let independent = 0;
    let insufficient = 0;
    let unknownRpm = 0;
    let dailyLimit = 0;
    let conflictOrNote = 0;
    let undocumented = 0;
    let satisfied = 0;

    for (const e of entries) {
      if (e.account_access === "points_satisfied") satisfied += 1;
      if (matchesPermissionFilter(e, "independent")) independent += 1;
      if (matchesPermissionFilter(e, "insufficient_points")) insufficient += 1;
      if (matchesPermissionFilter(e, "unknown_rpm")) unknownRpm += 1;
      if (matchesPermissionFilter(e, "daily_limit")) dailyLimit += 1;
      if (matchesPermissionFilter(e, "has_conflict_or_note")) conflictOrNote += 1;
      if (matchesPermissionFilter(e, "undocumented")) undocumented += 1;
    }
    return {
      total: entries.length,
      satisfied,
      independent,
      insufficient,
      unknownRpm,
      dailyLimit,
      conflictOrNote,
      undocumented,
    };
  }, [permissions]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of enrichedEntries) {
      if (!matchesPermissionFilter(item.entry, accessFilter)) continue;
      counts[item.category] = (counts[item.category] ?? 0) + 1;
    }
    return counts;
  }, [enrichedEntries, accessFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enrichedEntries.filter(({ entry, category, categoryName }) => {
      if (categoryFilter && category !== categoryFilter) return false;
      if (!matchesPermissionFilter(entry, accessFilter)) return false;
      if (q) {
        const hay = [
          entry.id,
          entry.name,
          entry.api_name,
          categoryName,
          entry.independent_permission || "",
          entry.note || "",
          ...(entry.evidence || []),
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enrichedEntries, categoryFilter, accessFilter, search]);

  const selectedDetail: {
    entry: PermissionEntry;
    categoryName: string;
    rowLimit: number | null;
  } | null = useMemo(() => {
    if (!selectedEntryId) return null;
    const found = enrichedEntries.find((item) => item.entry.id === selectedEntryId);
    if (!found) return null;
    return {
      entry: found.entry,
      categoryName: found.categoryName,
      rowLimit: found.rowLimit,
    };
  }, [enrichedEntries, selectedEntryId]);

  if (!permissions) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-xs text-slate-500 shadow-sm">
        正在加载已审核的 102 项股票接口权限与限流台账…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Audit Scope & Honest Declaration Banner */}
      <div className="rounded-xl border border-teal-200 bg-white p-4 shadow-sm space-y-2.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <BookOpenCheck className="h-4 w-4 text-teal-600" />
              <h2 className="text-sm font-semibold text-slate-900">
                Tushare 股票接口官方权限、频次与日额度核定台账（{permissions.entries.length} 项）
              </h2>
              <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-500/25">
                当前按用户申报 {formatNumber(permissions.account_points)} 积分比对 · 未经供应商在线校验
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              核定原则：接口文档专页限制优先于常规积分总表；<strong>官方未公布 8000 分档分钟频次的接口绝不冒充为官方 30 次/分</strong>，仅按本地保守 30 RPM 限流；日额度由本采集器按<strong>滚动 24 小时窗口（含失败重试）</strong>独立统计。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs shrink-0">
            <a
              href={permissions.general_doc_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-medium text-teal-700 hover:bg-slate-100"
            >
              官方权限总表 (doc_id=290)
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <a
              href={permissions.overview_doc_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 font-medium text-teal-700 hover:bg-slate-100"
            >
              积分与权限说明 (doc_id=108)
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>

        <details className="group border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          <summary className="cursor-pointer list-none flex flex-wrap items-center justify-between gap-2 hover:text-slate-700">
            <span className="inline-flex items-center gap-1 font-medium">
              <span className="group-open:rotate-90 transition-transform">▸</span>
              台账版本 {permissions.version} · 核验于 {formatDateTime(permissions.verified_at)}（展开查看规则编码与基准文档指纹）
            </span>
          </summary>
          <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-600 space-y-1">
            <div>
              判定优先级编码：{permissions.precedence} · 积分来源：{permissions.account_points_source}
            </div>
            <div className="text-[10px] text-slate-500 break-all">
              基准文档 SHA256：{" "}
              {permissions.sources
                .map((s) => `${s.url.split("doc_id=")[1] || "doc"}:${s.sha256.slice(0, 12)}`)
                .join(" · ")}
            </div>
          </div>
        </details>
      </div>

      {/* Quick Diagnostic KPI Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <button
          type="button"
          onClick={() => setAccessFilter(accessFilter === "points_satisfied" ? "all" : "points_satisfied")}
          className={clsx(
            "rounded-xl border p-3.5 text-left shadow-sm transition-colors",
            accessFilter === "points_satisfied"
              ? "border-teal-500 bg-teal-50/40"
              : "border-slate-200 bg-white hover:border-slate-300",
          )}
        >
          <div className="text-[11px] font-medium text-slate-500">满足申报 8000 分档</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-semibold text-teal-700 tabular-nums">
              {summary.satisfied}
            </span>
            <span className="text-[11px] text-slate-400">/ {summary.total} 项</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-500">仅按申报分比对，未在线验证</div>
        </button>

        <button
          type="button"
          onClick={() => setAccessFilter(accessFilter === "independent" ? "all" : "independent")}
          className={clsx(
            "rounded-xl border p-3.5 text-left shadow-sm transition-colors",
            accessFilter === "independent"
              ? "border-amber-500 bg-amber-50/40"
              : "border-slate-200 bg-white hover:border-slate-300",
          )}
        >
          <div className="text-[11px] font-medium text-slate-500">需单独开通独立授权</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-semibold text-amber-700 tabular-nums">
              {summary.independent}
            </span>
            <span className="text-[11px] text-amber-700">积分不自动解锁</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-500">分钟、盘前股本、实时快照等</div>
        </button>

        <button
          type="button"
          onClick={() =>
            setAccessFilter(accessFilter === "insufficient_points" ? "all" : "insufficient_points")
          }
          className={clsx(
            "rounded-xl border p-3.5 text-left shadow-sm transition-colors",
            accessFilter === "insufficient_points"
              ? "border-rose-500 bg-rose-50/40"
              : "border-slate-200 bg-white hover:border-slate-300",
          )}
        >
          <div className="text-[11px] font-medium text-slate-500">申报积分不足 / 未公布门槛</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-semibold text-rose-600 tabular-nums">
              {summary.insufficient}
            </span>
            <span className="text-[11px] text-slate-500">
              另有 {summary.undocumented} 项未公布门槛
            </span>
          </div>
          <div className="mt-1 text-[10px] text-slate-500">点击定位 10000 分档接口</div>
        </button>

        <button
          type="button"
          onClick={() => setAccessFilter(accessFilter === "unknown_rpm" ? "all" : "unknown_rpm")}
          className={clsx(
            "rounded-xl border p-3.5 text-left shadow-sm transition-colors",
            accessFilter === "unknown_rpm"
              ? "border-amber-500 bg-amber-50/40"
              : "border-slate-200 bg-white hover:border-slate-300",
          )}
        >
          <div className="text-[11px] font-medium text-slate-500">官方未公布 8000 档频次</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-semibold text-slate-900 tabular-nums">
              {summary.unknownRpm}
            </span>
            <span className="text-[11px] font-mono text-amber-700">本地保守 30 RPM</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-500">绝不标为官方公布 30 次/分</div>
        </button>

        <button
          type="button"
          onClick={() =>
            setAccessFilter(accessFilter === "has_conflict_or_note" ? "all" : "has_conflict_or_note")
          }
          className={clsx(
            "rounded-xl border p-3.5 text-left shadow-sm transition-colors",
            accessFilter === "has_conflict_or_note"
              ? "border-teal-600 bg-teal-50/40"
              : "border-slate-200 bg-white hover:border-slate-300",
          )}
        >
          <div className="text-[11px] font-medium text-slate-500">文档口径冲突 / 日上限</div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-xl font-semibold text-slate-900 tabular-nums">
              {summary.conflictOrNote}
            </span>
            <span className="text-[11px] text-slate-500">{summary.dailyLimit} 项含日额度</span>
          </div>
          <div className="mt-1 text-[10px] text-slate-500">接口页与总表冲突已逐条留痕</div>
        </button>
      </div>

      {/* Category & Condition Filter Bar (Sticky) */}
      <div className="sticky -top-5 lg:-top-6 z-20 rounded-xl border border-slate-200/90 bg-white/95 p-3.5 shadow-sm backdrop-blur-sm space-y-2.5">
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
            全部 Tushare 分类 ({enrichedEntries.filter((x) => matchesPermissionFilter(x.entry, accessFilter)).length})
          </button>
          {(catalog?.categories ?? []).map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategoryFilter(categoryFilter === cat.id ? "" : cat.id)}
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

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-60 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="按接口名、api_name、doc_id、独立权限名称或文档证据搜索…"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 py-1.5 text-xs text-slate-900 focus:border-teal-600 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {FILTER_PILLS.map((pill) => (
              <button
                key={pill.key}
                type="button"
                onClick={() => setAccessFilter(pill.key)}
                className={clsx(
                  "rounded-lg px-2.5 py-1 font-medium transition-colors",
                  accessFilter === pill.key
                    ? "bg-teal-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
                )}
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Split Table + Evidence Drawer/Panel */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        <div
          className={clsx(
            "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm",
            selectedDetail ? "xl:col-span-7" : "xl:col-span-12",
          )}
        >
          <div className="max-h-[calc(100vh-17.5rem)] overflow-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="sticky top-0 z-10 bg-slate-50 text-slate-600 shadow-xs">
                <tr>
                  <th className="px-3.5 py-2.5 text-left font-medium">分类 / 接口</th>
                  <th className="px-3.5 py-2.5 text-left font-medium">准入门槛与状态</th>
                  <th className="px-3.5 py-2.5 text-left font-medium">官方频次 vs 本地保守</th>
                  <th className="px-3.5 py-2.5 text-left font-medium">日额度 / 冲突说明</th>
                  <th className="px-3.5 py-2.5 text-right font-medium">文档与证据</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-slate-400">
                      当前筛选条件下没有匹配的股票目录入口
                    </td>
                  </tr>
                ) : (
                  filtered.map(({ entry, categoryName }) => {
                    const badge = accountAccessBadge(entry);
                    const rpmInfo = formatPermissionRpm(entry);
                    const isSelected = selectedEntryId === entry.id;
                    return (
                      <tr
                        key={entry.id}
                        onClick={() =>
                          setSelectedEntryId(isSelected ? null : entry.id)
                        }
                        className={clsx(
                          "cursor-pointer transition-colors",
                          isSelected ? "bg-teal-50/60" : "hover:bg-slate-50/90",
                        )}
                      >
                        <td className="px-3.5 py-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-slate-900">{entry.name}</span>
                            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                              {entry.api_name}
                            </code>
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-400">
                            {categoryName} · doc_id={entry.id}
                          </div>
                        </td>

                        <td className="px-3.5 py-3 space-y-1">
                          <div>
                            <span
                              className={clsx(
                                "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                                badge.cls,
                              )}
                            >
                              {badge.shortLabel}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatPermissionThreshold(entry)}
                          </div>
                        </td>

                        <td className="px-3.5 py-3">
                          <div
                            className={clsx(
                              "font-mono font-medium",
                              rpmInfo.isFallback ? "text-amber-700" : "text-slate-900",
                            )}
                          >
                            {rpmInfo.documentedLabel}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {rpmInfo.configuredLabel} ·{" "}
                            {RATE_SOURCE_LABELS[entry.rate_source] || entry.rate_source}
                          </div>
                        </td>

                        <td className="px-3.5 py-3 max-w-xs">
                          {entry.daily_limit !== null ? (
                            <div className="font-mono text-[11px] font-medium text-amber-800">
                              日限 {formatNumber(entry.daily_limit)} 次（本采集器滚动 24h 含重试）
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400">无单独日上限</div>
                          )}
                          {entry.note && (
                            <div
                              className="mt-0.5 flex items-start gap-1 text-[11px] text-amber-800 line-clamp-2"
                              title={entry.note}
                            >
                              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5 text-amber-600" />
                              <span>{entry.note}</span>
                            </div>
                          )}
                        </td>

                        <td
                          className="px-3.5 py-3 text-right whitespace-nowrap space-x-1.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <a
                            href={entry.doc_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-teal-700 hover:bg-slate-50"
                          >
                            官方文档
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedEntryId(isSelected ? null : entry.id)
                            }
                            className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                          >
                            <FileSearch className="h-3 w-3" />
                            证据
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

        {/* Right Detailed Audit Evidence Inspector */}
        {selectedDetail && (
          <aside className="xl:col-span-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4 sticky top-4">
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3.5">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-semibold text-slate-900">
                    {selectedDetail.entry.name}
                  </h3>
                  <code className="rounded bg-teal-50 px-2 py-0.5 font-mono text-xs text-teal-800">
                    {selectedDetail.entry.api_name}
                  </code>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  分类：{selectedDetail.categoryName} · 目录 ID：{selectedDetail.entry.id} · 单次行数上限：
                  {selectedDetail.rowLimit !== null
                    ? `${formatNumber(selectedDetail.rowLimit)} 行`
                    : "文档未声明"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEntryId(null)}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50"
              >
                收起
              </button>
            </div>

            {/* Status & Honesty Notice */}
            <div className="rounded-lg bg-slate-50 p-3 space-y-2 text-xs ring-1 ring-inset ring-slate-200/70">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">申报积分核定状态</span>
                <span
                  className={clsx(
                    "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                    accountAccessBadge(selectedDetail.entry).cls,
                  )}
                >
                  {accountAccessBadge(selectedDetail.entry).label}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-500">权限类型 (permission_kind)</span>
                <span className="font-mono text-slate-800">
                  {selectedDetail.entry.permission_kind}
                  {selectedDetail.entry.independent_permission
                    ? ` (${selectedDetail.entry.independent_permission})`
                    : ""}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-500">官方公布分钟频次</span>
                <span className="font-mono font-medium text-slate-900">
                  {selectedDetail.entry.documented_rpm !== null
                    ? `${selectedDetail.entry.documented_rpm} 次/分钟`
                    : selectedDetail.entry.permission_kind === "derived"
                      ? "无独立 HTTP 频次"
                      : "未公布（绝不推断为官方 30）"}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-500">本采集器本地限流基准</span>
                <span className="font-mono text-teal-800 font-semibold">
                  {selectedDetail.entry.configured_rpm} RPM（
                  {RATE_SOURCE_LABELS[selectedDetail.entry.rate_source] ||
                    selectedDetail.entry.rate_source}
                  ）
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-slate-500">日调用额度与统计范围</span>
                <span className="font-mono text-slate-800">
                  {selectedDetail.entry.daily_limit !== null
                    ? `${formatNumber(selectedDetail.entry.daily_limit)} 次（${
                        QUOTA_WINDOW_LABELS[selectedDetail.entry.quota_window || ""] ||
                        selectedDetail.entry.quota_window ||
                        "滚动 24h"
                      }）`
                    : "无单独日额度限制"}
                </span>
              </div>

              <div className="flex items-center justify-between text-[11px]">
                <span className="text-slate-500">在线权限验证状态</span>
                <span className="text-amber-700 font-medium">
                  permission_verified = {String(selectedDetail.entry.permission_verified)}（仅依据用户声明 8000 积分离线比对）
                </span>
              </div>
            </div>

            {selectedDetail.entry.note && (
              <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/25 space-y-1">
                <div className="font-semibold flex items-center gap-1.5">
                  <ShieldAlert className="h-4 w-4 text-amber-600" />
                  文档冲突与特殊口径说明
                </div>
                <p className="leading-relaxed">{selectedDetail.entry.note}</p>
              </div>
            )}

            {/* Verbatim Evidence */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-slate-700">
                官方文档原文证据摘录 ({selectedDetail.entry.evidence.length})
              </div>
              {selectedDetail.entry.evidence.length === 0 ? (
                <div className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-400">
                  接口文档未包含明确的权限/限量原文段落
                </div>
              ) : (
                <div className="space-y-1.5">
                  {selectedDetail.entry.evidence.map((line, idx) => (
                    <blockquote
                      key={idx}
                      className="rounded-lg border-l-4 border-l-teal-500 bg-slate-50 p-2.5 font-mono text-[11px] text-slate-700 leading-relaxed"
                    >
                      {line}
                    </blockquote>
                  ))}
                </div>
              )}
            </div>

            {/* Clickable Official Links & Document SHA256 */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-slate-700">
                核验来源链接与文档快照指纹
              </div>
              <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 text-xs">
                {selectedDetail.entry.sources.map((url) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between px-3 py-2 text-teal-700 hover:bg-slate-50 font-mono text-[11px]"
                  >
                    <span className="truncate">{url}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 ml-2" />
                  </a>
                ))}
                <div className="px-3 py-2 text-[11px] font-mono text-slate-500 break-all bg-slate-50/60">
                  接口页 SHA256: {selectedDetail.entry.document_sha256}
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500 flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-slate-400" />
              <span>
                日额度统计范围（<code className="font-mono">{selectedDetail.entry.quota_scope}</code>）：包含失败重试请求，按保守滚动 24 小时统计，无法得知同一账号在其他终端或程序中的调用消耗。
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1 border-t border-slate-100">
              {onJumpToDataset && (
                <button
                  type="button"
                  onClick={() => onJumpToDataset(selectedDetail.entry.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <ShieldCheck className="h-3.5 w-3.5 text-teal-600" />
                  在预置采集中定位
                </button>
              )}
              {onJumpToCustom && (
                <button
                  type="button"
                  onClick={() => onJumpToCustom(selectedDetail.entry.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  打开自定义接口向导
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
