import clsx from "clsx";
import {
  AlertTriangle,
  ExternalLink,
  FileCheck2,
  Info,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  QUOTA_WINDOW_LABELS,
  RATE_SOURCE_LABELS,
  accountAccessBadge,
  formatNumber,
  formatPermissionRpm,
  formatPermissionThreshold,
} from "../lib/helpers";
import type { ApiAccess } from "../types";

export function PermissionNotice({
  access,
  permission,
  docUrl,
  onOpenFullAudit,
}: {
  access?: ApiAccess;
  permission?: string;
  docUrl?: string;
  onOpenFullAudit?: (entryId?: string) => void;
}) {
  if (!access) return null;

  const badge = accountAccessBadge(access);
  const rpmInfo = formatPermissionRpm(access);
  const threshold = formatPermissionThreshold(access);
  const resolvedDocUrl = docUrl || access.doc_url;
  const extraSources = (access.sources ?? []).filter((u) => u !== resolvedDocUrl);
  const hasConflictOrNote = Boolean(access.note && access.note.trim());

  const containerCls =
    badge.tone === "rose"
      ? "border-rose-200 bg-rose-50/50"
      : badge.tone === "amber"
        ? "border-amber-200 bg-amber-50/50"
        : badge.tone === "slate"
          ? "border-slate-200 bg-slate-50"
          : "border-teal-200/80 bg-teal-50/25";

  return (
    <div className={clsx("rounded-xl border p-3.5 text-xs space-y-2.5", containerCls)}>
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {badge.tone === "emerald" || badge.tone === "sky" ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-teal-600" />
          ) : (
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
          )}
          <span className="font-semibold text-slate-900">官方接口权限与频次核定</span>
          <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", badge.cls)}>
            {badge.label}
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          {resolvedDocUrl && (
            <a
              href={resolvedDocUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[11px] font-medium text-teal-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
            >
              官方接口文档
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {onOpenFullAudit && (
            <button
              type="button"
              onClick={() => onOpenFullAudit(access.id)}
              className="text-[11px] font-medium text-slate-600 underline hover:text-slate-900"
            >
              全部 102 项台账
            </button>
          )}
        </div>
      </div>

      {/* Structured Key Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg bg-white/90 p-2.5 ring-1 ring-inset ring-slate-200/70">
        <div>
          <div className="text-[10px] text-slate-500">官方准入门槛</div>
          <div className="mt-0.5 font-medium text-slate-900">{threshold}</div>
          <div className="text-[10px] text-slate-400">
            基于用户声明 {access.account_points} 积分 · 未在线验证授权
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-500">分钟频次（官方公布 vs 本地保守）</div>
          <div className="mt-0.5 font-mono font-medium text-slate-900">
            {rpmInfo.documentedLabel}
          </div>
          <div
            className={clsx(
              "text-[10px]",
              rpmInfo.isFallback ? "text-amber-700 font-medium" : "text-slate-500",
            )}
          >
            {rpmInfo.configuredLabel} · {RATE_SOURCE_LABELS[access.rate_source] || access.rate_source}
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-500">日调用上限与计数口径</div>
          {access.daily_limit !== null && access.daily_limit !== undefined ? (
            <>
              <div className="mt-0.5 font-mono font-medium text-amber-800">
                {formatNumber(access.daily_limit)} 次 / 24h
              </div>
              <div className="text-[10px] text-slate-500">
                {access.quota_window
                  ? QUOTA_WINDOW_LABELS[access.quota_window] || access.quota_window
                  : "本采集器按保守滚动 24h 计入重试"}
              </div>
            </>
          ) : (
            <>
              <div className="mt-0.5 font-medium text-slate-700">无单独日上限声明</div>
              <div className="text-[10px] text-slate-400">
                实际频率取 min(全局, 任务, 接口配置)
              </div>
            </>
          )}
        </div>
      </div>

      {/* Conflict or Special Boundary Note */}
      {hasConflictOrNote && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-100/70 px-3 py-2 text-[11px] text-amber-900 ring-1 ring-inset ring-amber-500/25">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-700" />
          <div>
            <span className="font-semibold">文档口径差异 / 边界说明：</span>
            {access.note}
          </div>
        </div>
      )}

      {/* Collapsible Raw Evidence, SHA256 & Source URLs */}
      {((access.evidence && access.evidence.length > 0) ||
        extraSources.length > 0 ||
        permission) && (
        <details className="group text-[11px] text-slate-600">
          <summary className="cursor-pointer list-none font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1">
            <FileCheck2 className="h-3.5 w-3.5 text-slate-400" />
            <span className="group-open:underline">
              查看官方原文证据、来源链接与口径边界
            </span>
          </summary>
          <div className="mt-2 space-y-1.5 rounded-lg bg-white/80 p-2.5 ring-1 ring-inset ring-slate-200/70">
            {permission && (
              <div className="text-slate-700">
                <span className="font-medium text-slate-500">后端核定摘要：</span>
                {permission}
              </div>
            )}
            {access.evidence && access.evidence.length > 0 && (
              <div className="space-y-1">
                <div className="font-medium text-slate-500">官方文档原文摘录：</div>
                {access.evidence.map((ev, i) => (
                  <blockquote
                    key={i}
                    className="border-l-2 border-teal-500 pl-2 font-mono text-[10px] text-slate-700"
                  >
                    {ev}
                  </blockquote>
                ))}
              </div>
            )}
            {extraSources.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <span className="font-medium text-slate-500">关联规则来源：</span>
                {extraSources.map((srcUrl) => (
                  <a
                    key={srcUrl}
                    href={srcUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-mono text-[10px] text-teal-700 underline hover:text-teal-900"
                  >
                    {srcUrl}
                    <ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ))}
              </div>
            )}
            {access.document_sha256 && (
              <div className="font-mono text-[10px] text-slate-400">
                接口文档快照 SHA256: {access.document_sha256.slice(0, 16)}…
              </div>
            )}
            <div className="flex items-start gap-1 text-[10px] text-slate-500 pt-0.5 border-t border-slate-100">
              <Info className="h-3 w-3 shrink-0 mt-0.5 text-slate-400" />
              <span>
                日额度含失败重试，由本采集器按保守滚动 24 小时统计，不代表账号全局剩余额度；多切片并发共享同一套全局/每接口/每任务/日额度准入，不会扩大供应商配额。
              </span>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

