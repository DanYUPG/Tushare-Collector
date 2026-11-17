import clsx from "clsx";
import {
  CheckCircle2,
  FolderOpen,
  FolderTree,
  HardDriveDownload,
  Info,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { collectorApi } from "../lib/api";
import {
  EXPORT_LAYOUT_OPTIONS,
  normalizeExportLayout,
  summarizeExportResult,
} from "../lib/helpers";
import type { ExportLayout, ExportResult } from "../types";

interface ExportModalProps {
  target: {
    runId: string;
    sliceId?: string | null;
    title: string;
  } | null;
  defaultDirectory: string;
  onClose: () => void;
  onExported: (result: ExportResult) => void;
}

export function ExportModal({
  target,
  defaultDirectory,
  onClose,
  onExported,
}: ExportModalProps) {
  const [destination, setDestination] = useState(defaultDirectory);
  const [layout, setLayout] = useState<ExportLayout>("raw");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [prevTarget, setPrevTarget] = useState(target);

  if (target !== prevTarget) {
    setPrevTarget(target);
    if (target) {
      setDestination(defaultDirectory);
      setLayout("raw");
      setError(null);
      setResult(null);
    }
  }

  useEffect(() => {
    if (target && !destination) {
      setDestination(defaultDirectory);
    }
  }, [target, destination, defaultDirectory]);

  if (!target) return null;

  const handlePickDir = async () => {
    setPicking(true);
    setError(null);
    try {
      const picked = await collectorApi.selectDirectory(destination || null);
      if (!picked.cancelled && picked.path) {
        setDestination(picked.path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法打开目录选择器");
    } finally {
      setPicking(false);
    }
  };

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!destination.trim()) {
      setError("请填写导出的目标绝对路径");
      return;
    }
    const chosenLayout = normalizeExportLayout(layout);
    setBusy(true);
    setError(null);
    try {
      const exported = await collectorApi.exportRunOrSlice(
        target.runId,
        destination.trim(),
        target.sliceId,
        chosenLayout,
      );
      setResult(exported);
      onExported(exported);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setBusy(false);
    }
  };

  const resultSummary = result ? summarizeExportResult(result, layout) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[1px] p-4">
      <div className="w-full max-w-xl rounded-xl bg-white shadow-xl ring-1 ring-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700">
              <HardDriveDownload className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900">校验并导出本地归档</h2>
              <p className="text-xs text-slate-500 truncate max-w-md" title={target.title}>
                {target.title}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleExport} className="p-5 space-y-4 overflow-y-auto">
          {/* Shared Layout Mode Selector */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700">
              导出包目录布局模式
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {EXPORT_LAYOUT_OPTIONS.map((opt) => {
                const selected = layout === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={busy || Boolean(result)}
                    onClick={() => setLayout(opt.id)}
                    aria-pressed={selected}
                    className={clsx(
                      "rounded-xl border p-3 text-left transition-colors space-y-1 disabled:opacity-60",
                      selected
                        ? "border-teal-600 bg-teal-50/70 ring-1 ring-teal-600/30"
                        : "border-slate-200 bg-white hover:bg-slate-50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span
                        className={clsx(
                          "text-xs font-semibold",
                          selected ? "text-teal-900" : "text-slate-800",
                        )}
                      >
                        {opt.title}
                      </span>
                      <span
                        className={clsx(
                          "h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center",
                          selected
                            ? "border-teal-600 bg-teal-600"
                            : "border-slate-300 bg-white",
                        )}
                      >
                        {selected && (
                          <span className="h-1.5 w-1.5 rounded-full bg-white" />
                        )}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-snug">
                      {opt.subtitle}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Layout-Specific Structure & Honesty Notice */}
          {layout === "organized" ? (
            <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-3 text-[11px] text-slate-700 space-y-1.5 leading-relaxed">
              <div className="flex items-center gap-1.5 font-semibold text-teal-900">
                <FolderTree className="h-3.5 w-3.5 text-teal-700 shrink-0" />
                后处理友好布局（organized）读取约定
              </div>
              <ul className="list-disc pl-4 space-y-1 text-slate-600">
                <li>
                  <strong className="text-slate-800">按清单读取分组数据</strong>：从{" "}
                  <code className="font-mono text-slate-800">manifest.json</code>{" "}
                  的 <code className="font-mono">groups[].data_directory</code> 定位数据目录
                  （两个 <code className="font-mono">pro_bar</code> 入口按{" "}
                  <code className="font-mono">entry_id</code> 独立隔离），组内{" "}
                  <code className="font-mono text-teal-800">d/</code> 集中存放数据文件、
                  <code className="font-mono text-slate-700">m/</code>{" "}
                  隔离存放原 <code className="font-mono">meta.json</code>，避免元数据混入下游读表扫描。
                </li>
                <li>
                  <strong className="text-slate-800">完整原文件副本、不合并去重</strong>：导出不受当前页面搜索、列筛选或分页影响；目录与文件名使用内部短标识，完整接口、请求条件和原始切片标识保留在清单中，不代表实际数据覆盖。
                </li>
                <li>
                  <strong className="text-slate-800">字段结构核验与 JSON 隔离</strong>：Parquet 先复制校验 SHA256 再读取文件真实列结构分组（有归档声明则强制比对一致，旧 Parquet 无声明亦可读取真实结构）；无字段声明的 HTTP / 旧 JSON 标注为{" "}
                  <code className="font-mono">schema_status=unknown</code> 并与 Parquet 隔离，JSON 仍保持原始响应结构不转换，需下游自行解析，不可直接当作统一业务表联合读取。
                </li>
                <li>
                  <strong className="text-slate-800">统一清单 manifest.json</strong>：在新建{" "}
                  <code className="font-mono">export-&lt;UUID&gt;/</code>{" "}
                  包内汇总 <code className="font-mono">layout</code>、血缘来源、请求参数、登记行数、字段结构与分组目录，重复导出生成新包不覆盖，且绝不改动源 Raw 归档。
                </li>
              </ul>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600 leading-relaxed ring-1 ring-inset ring-slate-200/80">
              <Info className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
              <div>
                导出过程逐文件重算核对 SHA256 指纹，在目标目录{" "}
                <code className="font-mono text-slate-800">
                  tushare_exports/export-&lt;UUID&gt;/
                </code>{" "}
                下按原切片序号子目录生成完整原文件副本与{" "}
                <code className="font-mono text-slate-800">manifest.json</code>
                （不受当前页面搜索、列筛选或分页影响；重复导出不覆盖，不影响源 Raw 归档；JSON 仍保持原响应格式）。
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              目标导出根目录（绝对路径）
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={destination}
                disabled={busy || Boolean(result)}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="导出目录的绝对路径"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20 disabled:bg-slate-50"
              />
              <button
                type="button"
                onClick={handlePickDir}
                disabled={picking || busy || Boolean(result)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {picking ? "选择中…" : "选择目录"}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
              {error}
            </div>
          )}

          {resultSummary && (
            <div className="rounded-lg bg-emerald-50 p-3.5 text-xs text-emerald-900 ring-1 ring-inset ring-emerald-600/20 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  <span>
                    已完成哈希核验并导出 {resultSummary.exportedSlices} 份切片
                    {resultSummary.skippedSlices !== null
                      ? `（跳过未成功切片 ${resultSummary.skippedSlices} 份）`
                      : ""}
                  </span>
                </div>
                <span className="rounded-full bg-white/90 px-2.5 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-emerald-600/20">
                  布局：{resultSummary.layoutLabel}
                </span>
              </div>

              <div className="space-y-1 font-mono text-[11px] break-all text-emerald-800 bg-white/70 rounded-lg p-2.5">
                <div>导出目录：{resultSummary.directory}</div>
                {resultSummary.manifestPath && (
                  <div>清单路径：{resultSummary.manifestPath}</div>
                )}
              </div>

              {resultSummary.layout === "organized" && (
                <div className="text-[11px] text-emerald-800">
                  下游读取提示：请按 <code className="font-mono">manifest.json</code> 中{" "}
                  <code className="font-mono">groups</code> 读取各组{" "}
                  <code className="font-mono">data/</code> 子目录（原{" "}
                  <code className="font-mono">meta.json</code> 已分离至{" "}
                  <code className="font-mono">metadata/</code>）。
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {result ? "完成" : "取消"}
            </button>
            {!result && (
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
              >
                {busy
                  ? "正在校验并导出…"
                  : target.sliceId
                    ? "导出此切片"
                    : "导出整次运行"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

