import clsx from "clsx";
import {
  AlertTriangle,
  ArrowUpLeft,
  CheckCircle2,
  FolderOpen,
  Play,
  Save,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { collectorApi } from "../lib/api";
import { PermissionNotice } from "./PermissionNotice";
import {
  DATASET_MODES,
  datasetPartitionLabel,
  formatDateTime,
  formatNumber,
  OPTION_LABELS,
  OPTION_VALUE_DESCRIPTIONS,
  stateBadgeClass,
  states,
} from "../lib/helpers";
import type {
  DatasetCoveragePage,
  DatasetItem,
  DatasetMode,
  DatasetReturnDraft,
  DatasetReview,
  DatasetSettings,
  RunSummary,
} from "../types";

interface DatasetPlanDrawerProps {
  dataset: DatasetItem | null;
  initialMode: DatasetMode;
  initialTab: "plan" | "coverage";
  presetSettings?: Partial<DatasetSettings> | null;
  presetEndDate?: string | null;
  autoCheckSignal?: number;
  pendingReturn: DatasetReturnDraft | null;
  onClose: () => void;
  onSavedSettings: () => Promise<void>;
  onLaunchedRun: (
    run: RunSummary,
    dependencyOrigin?: Omit<DatasetReturnDraft, "runId"> | null,
  ) => Promise<void>;
  onReturnToOrigin: () => void;
  onPreviewSlice: (runId: string, sliceId: string) => void;
  onOpenPermissionAudit?: (entryId?: string) => void;
}

function yearsAgoIso(endIso: string, years: number, minIso: string): string {
  const base = new Date(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(base.getTime())) return minIso;
  base.setUTCFullYear(base.getUTCFullYear() - years);
  const candidate = base.toISOString().slice(0, 10);
  return candidate < minIso ? minIso : candidate;
}

export function DatasetPlanDrawer({
  dataset,
  initialMode,
  initialTab,
  presetSettings,
  presetEndDate,
  autoCheckSignal,
  pendingReturn,
  onClose,
  onSavedSettings,
  onLaunchedRun,
  onReturnToOrigin,
  onPreviewSlice,
  onOpenPermissionAudit,
}: DatasetPlanDrawerProps) {
  const [tab, setTab] = useState<"plan" | "coverage">(initialTab);
  const [mode, setMode] = useState<DatasetMode>(initialMode);
  const [rawRoot, setRawRoot] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [lookbackDays, setLookbackDays] = useState(7);
  const [rpm, setRpm] = useState(500);
  const [options, setOptions] = useState<Record<string, string[]>>({});
  const [revision, setRevision] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<DatasetReview | null>(null);

  // Coverage ledger state
  const [covPage, setCovPage] = useState<DatasetCoveragePage | null>(null);
  const [covQuery, setCovQuery] = useState("");
  const [covState, setCovState] = useState("");
  const [covOffset, setCovOffset] = useState(0);
  const [covLoading, setCovLoading] = useState(false);

  useEffect(() => {
    if (!dataset) return;
    setTab(initialTab);
    const merged: DatasetSettings = {
      ...dataset.settings,
      ...(presetSettings ?? {}),
    };
    let effectiveMode = initialMode;
    if (
      effectiveMode === "incremental" &&
      !dataset.revision &&
      !dataset.covered_partitions &&
      !presetSettings
    ) {
      effectiveMode = "full";
    }
    setMode(effectiveMode);
    setRawRoot(merged.raw_root);
    setStartDate(merged.start_date || dataset.start);
    setEndDate(presetEndDate || dataset.available_through);
    setLookbackDays(merged.lookback_days);
    setRpm(merged.requests_per_minute);

    const optInit: Record<string, string[]> = {};
    for (const [optKey, def] of Object.entries(dataset.rule?.options ?? {})) {
      optInit[optKey] = merged.options?.[optKey] ?? def.default;
    }
    setOptions(optInit);
    setRevision(dataset.revision);
    setReview(null);
    setError(null);
    setNotice(null);
    setCovOffset(0);
  }, [dataset?.id, initialMode, initialTab, presetSettings, presetEndDate]);

  const buildSettingsPayload = (): DatasetSettings => {
    const payload: DatasetSettings = {
      raw_root: rawRoot.trim(),
      start_date: startDate,
      lookback_days: Number(lookbackDays),
      requests_per_minute: Number(rpm),
      options,
    };
    for (const [optKey] of Object.entries(dataset?.rule?.options ?? {})) {
      if (!payload.options?.[optKey]?.length) {
        throw new Error(`请至少选择一个「${OPTION_LABELS[optKey] || optKey}」选项`);
      }
    }
    return payload;
  };

  const runPlanCheck = async (
    targetDataset: DatasetItem,
    currentRev: number,
    overrideMode?: DatasetMode,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setReview(null);
    try {
      const settings = buildSettingsPayload();
      const chosenMode = overrideMode ?? mode;
      const res = await collectorApi.reviewDatasetPlan(targetDataset.id, {
        settings,
        expected_revision: currentRev,
        mode: chosenMode,
        end_date: targetDataset.kind === "snapshot" ? undefined : endDate,
      });
      setReview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "检查计划失败");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!dataset || !autoCheckSignal) return;
    void runPlanCheck(dataset, dataset.revision);
  }, [autoCheckSignal]);

  useEffect(() => {
    if (!dataset || tab !== "coverage") return;
    let cancelled = false;
    setCovLoading(true);
    collectorApi
      .getDatasetCoverage(dataset.id, {
        offset: covOffset,
        limit: 50,
        q: covQuery,
        state: covState || undefined,
      })
      .then((res) => {
        if (!cancelled) setCovPage(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载覆盖台账失败");
        }
      })
      .finally(() => {
        if (!cancelled) setCovLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataset?.id, tab, covOffset, covQuery, covState]);

  if (!dataset) return null;

  const isSnapshot = dataset.kind === "snapshot";
  const splitSupported =
    Boolean(dataset.rule) || ["financial", "daily", "event"].includes(dataset.kind);
  const optionEntries = Object.entries(dataset.rule?.options ?? {});

  const handlePickDir = async () => {
    setError(null);
    try {
      const res = await collectorApi.selectDirectory(rawRoot || null);
      if (!res.cancelled && res.path) {
        setRawRoot(res.path);
        setReview(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "选择目录失败");
    }
  };

  const handleSaveSettingsOnly = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const settings = buildSettingsPayload();
      const saved = await collectorApi.saveDatasetSettings(
        dataset.id,
        settings,
        revision,
      );
      setRevision(saved.revision);
      setReview(null);
      await onSavedSettings();
      setNotice(`长期设置已保存（版本 v${saved.revision}）`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存设置失败");
    } finally {
      setBusy(false);
    }
  };

  const handleLaunch = async () => {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const plan = review.plan;
      const run = await collectorApi.launchDatasetRun(plan.dataset_id, plan.id);
      let depOrigin: Omit<DatasetReturnDraft, "runId"> | null = null;
      if (review.stage === "dependencies") {
        depOrigin = {
          id: dataset.id,
          mode,
          settings: buildSettingsPayload(),
          endDate,
          dependencyId: plan.dataset_id,
        };
      }
      await onLaunchedRun(run, depOrigin);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动采集失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleOptionValue = (optKey: string, val: string) => {
    setReview(null);
    setOptions((prev) => {
      const current = prev[optKey] ?? [];
      const next = current.includes(val)
        ? current.filter((x) => x !== val)
        : [...current, val];
      return { ...prev, [optKey]: next };
    });
  };

  const plan = review?.plan ?? null;
  const isDependencyStage = review?.stage === "dependencies";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40 backdrop-blur-[1px]">
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl ring-1 ring-slate-200">
        {/* Drawer Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-900 truncate">
                {dataset.name}
              </h2>
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-700">
                {dataset.id}
              </code>
              <span className="text-xs text-slate-400">设置 v{revision}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500 line-clamp-2">
              {dataset.scope_note}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭数据集抽屉"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sub-navigation Tabs */}
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-6">
          <div className="flex gap-5">
            <button
              type="button"
              onClick={() => setTab("plan")}
              className={clsx(
                "border-b-2 py-2.5 text-xs font-semibold transition-colors",
                tab === "plan"
                  ? "border-teal-600 text-teal-700"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              采集计划与设置
            </button>
            <button
              type="button"
              onClick={() => setTab("coverage")}
              className={clsx(
                "border-b-2 py-2.5 text-xs font-semibold transition-colors",
                tab === "coverage"
                  ? "border-teal-600 text-teal-700"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              分区覆盖台账 ({formatNumber(dataset.covered_partitions ?? 0)})
            </button>
          </div>

          {pendingReturn && pendingReturn.dependencyId === dataset.id && (
            <button
              type="button"
              onClick={onReturnToOrigin}
              className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-800"
            >
              <ArrowUpLeft className="h-3.5 w-3.5" />
              返回原任务
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {tab === "plan" ? (
            <>
              <PermissionNotice
                access={dataset.access}
                permission={dataset.permission}
                docUrl={dataset.doc_url}
                onOpenFullAudit={() => onOpenPermissionAudit?.(dataset.entry_id)}
              />
              {/* Mode Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  采集策略模式
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {(["incremental", "full", "retry", "split"] as DatasetMode[]).map(
                    (m) => {
                      const disabled = m === "split" && !splitSupported;
                      return (
                        <button
                          key={m}
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            setMode(m);
                            setReview(null);
                          }}
                          className={clsx(
                            "rounded-lg border px-3 py-2 text-xs font-medium text-left transition-colors",
                            mode === m
                              ? "border-teal-600 bg-teal-50/60 text-teal-900 ring-1 ring-teal-600/20"
                              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                            disabled && "opacity-40 cursor-not-allowed",
                          )}
                        >
                          {DATASET_MODES[m]}
                        </button>
                      );
                    },
                  )}
                </div>
              </div>

              {/* Date Range & Shortcuts */}
              {!isSnapshot && (
                <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-700">
                      历史范围与回查窗口
                    </span>
                    <div className="flex flex-wrap items-center gap-1 text-[11px]">
                      {[
                        [
                          "近 1 年",
                          yearsAgoIso(dataset.available_through, 1, dataset.start),
                        ],
                        [
                          "近 3 年",
                          yearsAgoIso(dataset.available_through, 3, dataset.start),
                        ],
                        [
                          "近 5 年",
                          yearsAgoIso(dataset.available_through, 5, dataset.start),
                        ],
                        [
                          "2010 起",
                          "2010-01-01" < dataset.start ? dataset.start : "2010-01-01",
                        ],
                        ["接口起点", dataset.start],
                      ].map(([label, val]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => {
                            setStartDate(val);
                            setReview(null);
                          }}
                          className="rounded bg-white px-2 py-0.5 text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-teal-50 hover:text-teal-700"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        历史起点 (start_date)
                      </label>
                      <input
                        type="date"
                        min="1990-12-19"
                        max={dataset.available_through}
                        value={startDate}
                        onChange={(e) => {
                          setStartDate(e.target.value);
                          setReview(null);
                        }}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        本次截止日 (≤ {dataset.available_through})
                      </label>
                      <input
                        type="date"
                        min="1990-12-19"
                        max={dataset.available_through}
                        value={endDate}
                        onChange={(e) => {
                          setEndDate(e.target.value);
                          setReview(null);
                        }}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        增量回查自然日
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={366}
                        value={lookbackDays}
                        onChange={(e) => {
                          setLookbackDays(Number(e.target.value));
                          setReview(null);
                        }}
                        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Rule Options (freq / adj / type etc.) */}
              {optionEntries.length > 0 && (
                <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                  <div className="text-xs font-semibold text-slate-700">
                    接口细分选项（不同选项组合独立计算覆盖范围）
                  </div>
                  {optionEntries.map(([optKey, def]) => {
                    const selected = options[optKey] ?? [];
                    return (
                      <div key={optKey} className="space-y-1.5">
                        <div className="text-[11px] font-medium text-slate-600">
                          {OPTION_LABELS[optKey] || optKey}（<code>{optKey}</code>，可多选）
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {def.values.map((val) => {
                            const checked = selected.includes(val);
                            return (
                              <label
                                key={val}
                                className={clsx(
                                  "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs",
                                  checked
                                    ? "border-teal-600 bg-teal-50 text-teal-900 font-medium"
                                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                                )}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleOptionValue(optKey, val)}
                                  className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                                />
                                {OPTION_VALUE_DESCRIPTIONS[val] || val}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Storage Directory & RPM */}
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div className="sm:col-span-3">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Raw 归档保存根目录
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={rawRoot}
                      onChange={(e) => {
                        setRawRoot(e.target.value);
                        setReview(null);
                      }}
                      className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono"
                    />
                    <button
                      type="button"
                      onClick={handlePickDir}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      选择
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    数据集限流 (RPM)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={rpm}
                    onChange={(e) => {
                      setRpm(Number(e.target.value));
                      setReview(null);
                    }}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
              </div>

              {/* Action Buttons: Save Settings vs Check Plan */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSaveSettingsOnly}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  仅保存长期设置
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => runPlanCheck(dataset, revision)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-navy-800 disabled:opacity-50"
                >
                  <Search className="h-3.5 w-3.5" />
                  {busy ? "正在本地核验日历与覆盖台账…" : "检查依赖与采集计划（不发请求）"}
                </button>
              </div>

              {error && (
                <div className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20 flex items-start gap-2">
                  <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {notice && (
                <div className="rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800 ring-1 ring-inset ring-emerald-600/20 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span>{notice}</span>
                </div>
              )}

              {/* Plan Review Result Card */}
              {plan && (
                <div
                  className={clsx(
                    "rounded-xl border p-4 space-y-3.5",
                    isDependencyStage
                      ? "border-amber-300 bg-amber-50/40"
                      : "border-teal-300 bg-teal-50/30",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={clsx(
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                            isDependencyStage
                              ? "bg-amber-100 text-amber-900"
                              : "bg-teal-100 text-teal-900",
                          )}
                        >
                          {isDependencyStage ? "前置依赖准备阶段" : "可执行计划已冻结"}
                        </span>
                        <h3 className="text-sm font-semibold text-slate-900">
                          {isDependencyStage
                            ? `需先准备依赖：${plan.recipe.name}`
                            : `${plan.recipe.name} · ${DATASET_MODES[plan.mode]}`}
                        </h3>
                      </div>
                      {isDependencyStage && review?.reason && (
                        <p className="mt-1.5 text-xs text-amber-900 font-medium">
                          原因：{review.reason}
                        </p>
                      )}
                      {isDependencyStage && review?.note && (
                        <p className="mt-0.5 text-[11px] text-amber-800">{review.note}</p>
                      )}
                    </div>
                  </div>

                  {/* Plan KPI Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 rounded-lg bg-white p-3 ring-1 ring-inset ring-slate-200/80 text-xs">
                    <div>
                      <div className="text-[11px] text-slate-500">待采集切片</div>
                      <div className="font-mono text-base font-semibold text-slate-900 tabular-nums">
                        {formatNumber(plan.total_slices)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">供应商请求数</div>
                      <div className="font-mono text-base font-semibold text-slate-900 tabular-nums">
                        {formatNumber(plan.supplier_requests ?? plan.total_slices)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">候选覆盖进度</div>
                      <div className="font-mono text-base font-semibold text-slate-900 tabular-nums">
                        {plan.covered_partitions}/{plan.candidate_partitions}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">限流理论耗时</div>
                      <div className="font-mono text-base font-semibold text-slate-900 tabular-nums">
                        {(plan.estimated_seconds / 60).toFixed(1)} 分钟
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-700 space-y-1">
                    <div>
                      构成明细：全量 <strong>{plan.counts.full}</strong> · 缺口{" "}
                      <strong>{plan.counts.missing}</strong> · 重试{" "}
                      <strong>{plan.counts.retry}</strong> · 近期回查{" "}
                      <strong>{plan.counts.refresh}</strong> · 拆分{" "}
                      <strong>{plan.counts.split}</strong>
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      范围：{plan.start_date} → {plan.end_date} · 生效限流{" "}
                      {plan.effective_rpm} RPM · 指纹 {plan.fingerprint.slice(0, 12)}
                    </div>
                  </div>

                  {/* Expandable Partitions & Warnings */}
                  <details className="text-xs text-slate-600">
                    <summary className="cursor-pointer font-medium text-teal-700 hover:text-teal-800">
                      查看本次 {plan.total_slices} 个具体请求范围与边界提示
                    </summary>
                    <div className="mt-2 space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200 max-h-48 overflow-y-auto">
                      <div className="font-mono text-[11px] text-slate-700 leading-relaxed break-all">
                        {plan.partitions.length > 0
                          ? plan.partitions
                              .slice(0, 300)
                              .map((item) => datasetPartitionLabel(plan, item))
                              .join("、") +
                            (plan.partitions.length > 300
                              ? ` … 等共 ${plan.partitions.length} 项`
                              : "")
                          : "当前范围均已覆盖，无待执行请求切片。"}
                      </div>
                      <ul className="list-disc pl-4 text-[11px] text-slate-500 space-y-0.5">
                        {plan.warnings.map((w, idx) => (
                          <li key={idx}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  </details>

                  {/* Launch CTA */}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    {plan.total_slices === 0 ? (
                      <span className="text-xs font-medium text-emerald-700">
                        当前范围内无缺失或待更新切片，无需创建空运行
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleLaunch}
                        className={clsx(
                          "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-white shadow-sm disabled:opacity-50",
                          isDependencyStage
                            ? "bg-amber-600 hover:bg-amber-700"
                            : "bg-teal-600 hover:bg-teal-700",
                        )}
                      >
                        <Play className="h-3.5 w-3.5" />
                        {isDependencyStage
                          ? `确认先准备「${plan.recipe.name}」(${plan.total_slices} 个请求)`
                          : `确认保存设置并启动采集 (${plan.total_slices} 个切片)`}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Tab 2: Partition Coverage Ledger */
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="relative flex-1 min-w-48">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={covQuery}
                    onChange={(e) => {
                      setCovQuery(e.target.value);
                      setCovOffset(0);
                    }}
                    placeholder="搜索分区键（如 20261112、600000.SH）…"
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 py-1.5 text-xs"
                  />
                </div>
                <select
                  value={covState}
                  onChange={(e) => {
                    setCovState(e.target.value);
                    setCovOffset(0);
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
                >
                  <option value="">全部状态</option>
                  <option value="succeeded">归档成功</option>
                  <option value="failed">失败 / 触顶</option>
                  <option value="running">执行中</option>
                  <option value="pending">待执行</option>
                </select>
              </div>

              {covPage && (
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    已登记总分区：{formatNumber(covPage.registered_partitions)} · 当前筛选{" "}
                    {formatNumber(covPage.total)} 条
                  </span>
                  <span className="font-mono text-[11px] truncate max-w-64">
                    {covPage.raw_root}
                  </span>
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">分区键</th>
                      <th className="px-3 py-2 text-left font-medium">最新状态</th>
                      <th className="px-3 py-2 text-right font-medium">行数</th>
                      <th className="px-3 py-2 text-left font-medium">更新时间</th>
                      <th className="px-3 py-2 text-right font-medium">数据</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {covLoading ? (
                      <tr>
                        <td colSpan={5} className="py-10 text-center text-slate-400">
                          正在加载覆盖台账…
                        </td>
                      </tr>
                    ) : !covPage || covPage.items.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-10 text-center text-slate-400">
                          当前目录下暂无已登记分区记录
                        </td>
                      </tr>
                    ) : (
                      covPage.items.map((item) => {
                        const targetRunId = item.has_data
                          ? item.run_id
                          : item.successful_run_id;
                        const targetSliceId = item.has_data
                          ? item.slice_id
                          : item.successful_slice_id;
                        return (
                          <tr key={item.key} className="hover:bg-slate-50">
                            <td className="px-3 py-2 font-mono text-slate-900">
                              {item.key}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={clsx(
                                  "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium",
                                  stateBadgeClass(item.state),
                                )}
                              >
                                {states[item.state] || item.state}
                              </span>
                              {item.error_kind === "row_limit" && (
                                <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-amber-700">
                                  <AlertTriangle className="h-3 w-3" />
                                  触顶
                                </span>
                              )}
                              {item.error && (
                                <div className="mt-0.5 text-[10px] text-rose-600 max-w-52 truncate" title={item.error}>
                                  {item.error}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700">
                              {formatNumber(item.rows ?? item.successful_rows)}
                            </td>
                            <td className="px-3 py-2 text-[11px] text-slate-500">
                              {formatDateTime(item.last_updated)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {targetRunId && targetSliceId ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onPreviewSlice(targetRunId, targetSliceId)
                                  }
                                  className="rounded bg-teal-50 px-2 py-1 text-[11px] font-medium text-teal-700 hover:bg-teal-100"
                                >
                                  预览表格
                                </button>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {covPage && (covOffset > 0 || covPage.next_offset !== null) && (
                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    disabled={covOffset === 0}
                    onClick={() => setCovOffset(Math.max(0, covOffset - 50))}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <span className="text-slate-500 font-mono">
                    第 {covOffset + 1} –{" "}
                    {Math.min(covOffset + covPage.items.length, covPage.total)} 条
                  </span>
                  <button
                    type="button"
                    disabled={covPage.next_offset === null}
                    onClick={() => setCovOffset(covPage.next_offset ?? covOffset)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
