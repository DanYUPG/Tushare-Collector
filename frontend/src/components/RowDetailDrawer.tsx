import clsx from "clsx";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Filter,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cellText } from "../lib/helpers";

export interface RowDetailColumnMeta {
  name: string;
  label?: string;
  type?: string;
  isInt64?: boolean;
  isKey?: boolean;
}

interface RowDetailDrawerProps {
  open: boolean;
  title: string;
  subtitle?: string;
  rowNumber: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  columns: RowDetailColumnMeta[];
  values: unknown[];
  codeColumnName?: string | null;
  onFilterByCode?: (codeValue: string) => void;
}

export function RowDetailDrawer({
  open,
  title,
  subtitle,
  rowNumber,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onClose,
  columns,
  values,
  codeColumnName,
  onFilterByCode,
}: RowDetailDrawerProps) {
  const [fieldQuery, setFieldQuery] = useState("");
  const [hideNulls, setHideNulls] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        onClose();
        return;
      }
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (ev.key === "ArrowLeft" && canPrev) {
        ev.preventDefault();
        onPrev();
      } else if (ev.key === "ArrowRight" && canNext) {
        ev.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, canPrev, canNext, onPrev, onNext, onClose]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1400);
    } catch {
      // clipboard unavailable in non-secure context; ignore gracefully
    }
  };

  const nonNullCount = useMemo(() => {
    let count = 0;
    for (let i = 0; i < columns.length; i += 1) {
      const v = values[i];
      if (v !== null && v !== undefined && v !== "") count += 1;
    }
    return count;
  }, [columns, values]);

  const visibleEntries = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    return columns
      .map((col, idx) => {
        const rawVal = values[idx];
        const isNull = rawVal === null || rawVal === undefined;
        const formatted = isNull ? "NULL" : cellText(rawVal);
        return { col, idx, rawVal, isNull, formatted };
      })
      .filter((item) => {
        if (hideNulls && item.isNull && !item.col.isKey) return false;
        if (!q) return true;
        return (
          item.col.name.toLowerCase().includes(q) ||
          (item.col.label || "").toLowerCase().includes(q) ||
          item.formatted.toLowerCase().includes(q)
        );
      });
  }, [columns, values, fieldQuery, hideNulls]);

  if (!open) return null;

  const handleCopyRowJson = () => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      obj[col.name] = values[idx] ?? null;
    });
    void copyText("__row_json__", JSON.stringify(obj, null, 2));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/35 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 第 ${rowNumber} 行字段详情`}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl border-l border-slate-200"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50/90 px-5 py-3.5 shrink-0">
          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-navy-900 px-2 py-0.5 font-mono text-[11px] font-semibold text-white tabular-nums">
                行 #{rowNumber}
              </span>
              <h3 className="truncate text-sm font-semibold text-slate-900">
                {title}
              </h3>
              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                非空 {nonNullCount} / {columns.length} 列
              </span>
            </div>
            {subtitle && (
              <p className="truncate text-[11px] text-slate-500 font-mono">
                {subtitle}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={!canPrev}
              onClick={onPrev}
              title="上一行 (←)"
              className="inline-flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              上一行
            </button>
            <button
              type="button"
              disabled={!canNext}
              onClick={onNext}
              title="下一行 (→)"
              className="inline-flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              下一行
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭单行详情抽屉"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-white px-5 py-2.5 shrink-0">
          <div className="relative flex-1 min-w-44">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={fieldQuery}
              onChange={(e) => setFieldQuery(e.target.value)}
              placeholder={`搜索当前行 ${columns.length} 个字段名 / 中文说明 / 值…`}
              aria-label="搜索单行字段"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-2.5 py-1.5 text-xs text-slate-900 focus:border-teal-600 focus:bg-white focus:outline-none"
            />
          </div>

          <button
            type="button"
            onClick={() => setHideNulls((v) => !v)}
            className={clsx(
              "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
              hideNulls
                ? "border-teal-600 bg-teal-50 text-teal-800"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            {hideNulls ? "已隐藏 NULL" : "隐藏 NULL"}
          </button>

          <button
            type="button"
            onClick={handleCopyRowJson}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {copiedKey === "__row_json__" ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-600" />
                <span className="text-emerald-700">已复制 JSON</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 text-slate-500" />
                <span>复制整行 JSON</span>
              </>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 px-5">
          {visibleEntries.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">
              当前过滤条件下没有匹配的字段
            </div>
          ) : (
            visibleEntries.map(({ col, isNull, formatted }) => {
              const isCodeCol =
                Boolean(onFilterByCode) &&
                !isNull &&
                codeColumnName === col.name;
              const isCopied = copiedKey === col.name;
              return (
                <div
                  key={col.name}
                  className="group flex items-start justify-between gap-3 py-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono font-semibold text-slate-800">
                        {col.name}
                      </code>
                      {col.isKey && (
                        <span className="rounded bg-teal-50 px-1.5 py-0.2 text-[10px] font-medium text-teal-800 ring-1 ring-inset ring-teal-600/20">
                          定位/键
                        </span>
                      )}
                      {col.type && (
                        <span
                          className={clsx(
                            "rounded px-1.5 py-0.2 font-mono text-[10px]",
                            col.isInt64
                              ? "bg-indigo-50 font-semibold text-indigo-700"
                              : "bg-slate-100 text-slate-500",
                          )}
                        >
                          {col.type}
                        </span>
                      )}
                    </div>
                    {col.label && (
                      <div className="text-[11px] text-slate-500">
                        {col.label}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 max-w-[58%]">
                    <span
                      className={clsx(
                        "break-all text-right font-mono tabular-nums",
                        isNull
                          ? "italic text-slate-300"
                          : "font-medium text-slate-900",
                      )}
                    >
                      {formatted}
                    </span>

                    {isCodeCol && onFilterByCode && (
                      <button
                        type="button"
                        onClick={() => {
                          onFilterByCode(formatted);
                          onClose();
                        }}
                        title={`在表格中仅筛选 ${formatted}`}
                        className="shrink-0 rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10px] font-medium text-teal-800 hover:bg-teal-100"
                      >
                        <Filter className="h-3 w-3 inline mr-0.5" />
                        筛此代码
                      </button>
                    )}

                    {!isNull && (
                      <button
                        type="button"
                        onClick={() => void copyText(col.name, formatted)}
                        title={`复制 ${col.name} 的值`}
                        className="shrink-0 rounded p-1 text-slate-400 opacity-70 hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100"
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
