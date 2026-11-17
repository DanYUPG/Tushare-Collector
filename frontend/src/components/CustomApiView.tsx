import clsx from "clsx";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FolderOpen,
  Play,
  Save,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { collectorApi } from "../lib/api";
import { PermissionNotice } from "./PermissionNotice";
import {
  assertDraftSafe,
  canGuide,
  collectionScope,
  commonAPIs,
  filteredEntries,
  formatNumber,
  parameterChoices,
  parameterLabels,
  parseObject,
  parseValues,
  readStoredDrafts,
  states,
  taskTemplate,
  writeStoredDrafts,
} from "../lib/helpers";
import type {
  Catalog,
  CatalogEntry,
  PlanPreview,
  RunSummary,
  SavedConfig,
  TaskConfigPayload,
} from "../types";
import { patchLocationState, readLocationState } from "../lib/navigation";

interface CustomApiViewProps {
  catalog: Catalog | null;
  defaultRawRoot: string;
  databasePath: string;
  editingConfig: SavedConfig | null;
  sourceConfig?: TaskConfigPayload | null;
  onClearSourceConfig?: () => void;
  focusEntryId?: string | null;
  onClearFocusEntry?: () => void;
  onClearEditing: () => void;
  onSavedOrLaunched: (run?: RunSummary) => Promise<void>;
  onPreviewSlice: (runId: string, sliceId: string) => void;
  onOpenPermissionAudit?: (entryId?: string) => void;
}

function todayShanghaiIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts;
}

export function CustomApiView({
  catalog,
  defaultRawRoot,
  databasePath,
  editingConfig,
  sourceConfig,
  onClearSourceConfig,
  focusEntryId,
  onClearFocusEntry,
  onClearEditing,
  onSavedOrLaunched,
  onPreviewSlice,
  onOpenPermissionAudit,
}: CustomApiViewProps) {
  const [flowMode, setFlowMode] = useState<"wizard" | "quick-preview">("wizard");
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Catalog browser
  const [catFilter, setCatFilter] = useState(() => readLocationState().get("custom_category") || "");
  const [entrySearch, setEntrySearch] = useState(() => readLocationState().get("custom_q") || "");
  const [selectedEntryId, setSelectedEntryId] = useState("25");

  // Task configuration state
  const [editingMeta, setEditingMeta] = useState<{
    id: string;
    revision: number;
  } | null>(null);
  const [name, setName] = useState("股票列表 · 自定义采集");
  const [paramEditorMode, setParamEditorMode] = useState<"guided" | "json">(
    "json",
  );
  const [guidedParams, setGuidedParams] = useState<Record<string, string>>({});
  const [paramsText, setParamsText] = useState("{}");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [transport, setTransport] = useState<"sdk" | "http">("sdk");
  const [rawRoot, setRawRoot] = useState(defaultRawRoot);
  const [rpm, setRpm] = useState(500);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  const [rowLimitText, setRowLimitText] = useState("");
  const [allowEmpty, setAllowEmpty] = useState(false);

  // Slicing
  const [sliceMode, setSliceMode] = useState<"single" | "date_range">("single");
  const [dateParam, setDateParam] = useState("trade_date");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [splitParam, setSplitParam] = useState("");
  const [splitValuesText, setSplitValuesText] = useState("");

  // Plan / Preview status
  const [planPreview, setPlanPreview] = useState<PlanPreview | null>(null);
  const [confirmedConfig, setConfirmedConfig] =
    useState<TaskConfigPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftWarning, setDraftWarning] = useState<string | null>(null);
  const [livePreviewRun, setLivePreviewRun] = useState<RunSummary | null>(null);

  const entries = catalog?.entries ?? [];
  const selectedEntry: CatalogEntry | null = useMemo(
    () => entries.find((e) => e.id === selectedEntryId) ?? entries[0] ?? null,
    [entries, selectedEntryId],
  );

  useEffect(() => {
    if (!rawRoot && defaultRawRoot) setRawRoot(defaultRawRoot);
  }, [defaultRawRoot]);

  // Restore stored draft on mount if not editing
  useEffect(() => {
    if (!databasePath || editingConfig || sourceConfig) return;
    const stored = readStoredDrafts(databasePath);
    const d = stored.customDraft;
    if (!d) return;
    setSelectedEntryId(d.entryId || "25");
    setName(d.name);
    setParamsText(d.paramsText);
    setSelectedFields(
      d.fields
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    setTransport(d.transport);
    setRawRoot(d.rawRoot || defaultRawRoot);
    setRpm(d.rpm);
    setMaxAttempts(d.maxAttempts);
    setTimeoutSeconds(d.timeoutSeconds);
    setRowLimitText(d.rowLimit);
    setAllowEmpty(d.allowEmpty);
    setSliceMode(d.mode);
    setDateParam(d.dateParam);
    setStartDate(d.startDate);
    setEndDate(d.endDate);
    setSplitParam(d.splitParam);
    setSplitValuesText(d.splitValuesText);
  }, [databasePath]);

  // Load editingConfig when passed from RunsAndTasksView
  useEffect(() => {
    const c = editingConfig?.config ?? sourceConfig;
    if (!c) return;
    setFlowMode("wizard");
    setStep(2);
    setEditingMeta(editingConfig ? { id: editingConfig.id, revision: editingConfig.revision } : null);
    setSelectedEntryId(c.entry_id);
    setName(c.name);
    setParamsText(JSON.stringify(c.params, null, 2));
    setParamEditorMode("json");
    setSelectedFields(
      c.fields
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    setTransport(c.transport);
    setRawRoot(c.raw_root);
    setRpm(c.requests_per_minute);
    setMaxAttempts(c.max_attempts);
    setTimeoutSeconds(c.timeout_seconds);
    setRowLimitText(c.row_limit !== null ? String(c.row_limit) : "");
    setAllowEmpty(c.allow_empty);
    setSliceMode(c.mode);
    setDateParam(c.date_param);
    setStartDate(c.start_date || "");
    setEndDate(c.end_date || "");
    setSplitParam(c.split_param || "");
    setSplitValuesText(
      c.split_values.length ? JSON.stringify(c.split_values) : "",
    );
    setPlanPreview(null);
    setError(null);
  }, [editingConfig, sourceConfig]);

  // Save draft safely on edits
  useEffect(() => {
    if (!databasePath) return;
    try {
      assertDraftSafe(paramsText);
      setDraftWarning(null);
      const current = readStoredDrafts(databasePath);
      writeStoredDrafts(databasePath, {
        ...current,
        customDraft: {
          editingId: editingMeta?.id ?? null,
          editingRevision: editingMeta?.revision ?? null,
          name,
          entryId: selectedEntryId,
          paramsText,
          fields: selectedFields.join(","),
          transport,
          rawRoot,
          rpm,
          maxAttempts,
          timeoutSeconds,
          rowLimit: rowLimitText,
          allowEmpty,
          mode: sliceMode,
          dateParam,
          startDate,
          endDate,
          splitParam,
          splitValuesText,
        },
      });
    } catch (err) {
      setDraftWarning(
        err instanceof Error ? err.message : "草稿未保存",
      );
    }
  }, [
    databasePath,
    name,
    selectedEntryId,
    paramsText,
    selectedFields,
    transport,
    rawRoot,
    rpm,
    maxAttempts,
    timeoutSeconds,
    rowLimitText,
    allowEmpty,
    sliceMode,
    dateParam,
    startDate,
    endDate,
    splitParam,
    splitValuesText,
  ]);

  // Poll live single-shot preview run until done
  useEffect(() => {
    if (!livePreviewRun) return;
    if (
      livePreviewRun.state !== "queued" &&
      livePreviewRun.state !== "running"
    ) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const updated = await collectorApi.getRunDetail(livePreviewRun.id);
        setLivePreviewRun(updated);
        if (updated.state === "succeeded") {
          const sliceList = await collectorApi.getRunSlices(updated.id, {
            limit: 1,
          });
          if (sliceList.items[0]) {
            onPreviewSlice(updated.id, sliceList.items[0].id);
          }
        }
      } catch {
        // ignore transient poll error
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [livePreviewRun?.id, livePreviewRun?.state]);

  const visibleEntries = useMemo(() => {
    const pool =
      flowMode === "quick-preview"
        ? entries.filter((e) => e.status !== "sdk_only")
        : entries;
    return filteredEntries(pool, catFilter, entrySearch);
  }, [entries, flowMode, catFilter, entrySearch]);

  const handleSelectEntry = (entry: CatalogEntry) => {
    onClearSourceConfig?.();
    setSelectedEntryId(entry.id);
    if (!editingMeta) {
      setName(`${entry.name} · ${entry.api_name}`);
    }
    if (entry.status === "sdk_only") {
      setTransport("sdk");
    }
    setSelectedFields([]);
    const dateCandidates = entry.params.filter((p) => p.name.endsWith("date"));
    if (dateCandidates.length > 0) {
      setDateParam(dateCandidates[0].name);
    }
    if (commonAPIs.has(entry.api_name)) {
      setParamEditorMode("guided");
      setGuidedParams({});
      setParamsText("{}");
    } else {
      setParamEditorMode("json");
    }
    setPlanPreview(null);
  };

  useEffect(() => {
    if (!focusEntryId || !catalog || editingConfig || sourceConfig) return;
    const found = catalog.entries.find((e) => e.id === focusEntryId);
    if (found) {
      setStep(1);
      setCatFilter("");
      setEntrySearch("");
      if (readStoredDrafts(databasePath).customDraft?.entryId === found.id) {
        setSelectedEntryId(found.id);
      } else if (selectedEntryId !== found.id) {
        handleSelectEntry(found);
      }
      onClearFocusEntry?.();
    }
  }, [focusEntryId, catalog, editingConfig, sourceConfig]);

  useEffect(() => {
    if (!catalog || focusEntryId && focusEntryId !== selectedEntryId) return;
    if (readLocationState().get("entry") !== selectedEntryId) {
      patchLocationState({ entry: selectedEntryId });
    }
  }, [selectedEntryId, catalog, focusEntryId]);

  useEffect(() => {
    const restore = () => {
      const params = readLocationState();
      setCatFilter(catalog?.categories.some(item => item.id === params.get("custom_category"))
        ? params.get("custom_category")! : "");
      setEntrySearch(params.get("custom_q") || "");
    };
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [catalog]);

  useEffect(() => {
    patchLocationState({ custom_category: catFilter || null, custom_q: entrySearch || null });
  }, [catFilter, entrySearch]);

  const applyTemplate = (kind: "day" | "range") => {
    if (!selectedEntry) return;
    try {
      const tpl = taskTemplate(
        selectedEntry.api_name,
        kind,
        todayShanghaiIso(),
      );
      setParamsText(JSON.stringify(tpl.params, null, 2));
      setGuidedParams(tpl.params);
      setSliceMode(tpl.mode);
      setStartDate(tpl.start_date);
      setEndDate(tpl.end_date);
      setName(`${selectedEntry.name} · ${tpl.label}`);
      setPlanPreview(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "应用模板失败");
    }
  };

  const buildConfigPayload = (): TaskConfigPayload => {
    if (!selectedEntry) throw new Error("请先选择一个股票接口");
    const parsedParams =
      paramEditorMode === "guided"
        ? Object.fromEntries(
            Object.entries(guidedParams).filter(([, v]) => v.trim() !== ""),
          )
        : parseObject(paramsText);
    const splitValues = parseValues(splitValuesText);
    return {
      name: name.trim() || `${selectedEntry.name} · 自定义`,
      entry_id: selectedEntry.id,
      params: parsedParams,
      fields: selectedFields.join(","),
      transport: selectedEntry.status === "sdk_only" ? "sdk" : transport,
      raw_root: rawRoot.trim(),
      requests_per_minute: Number(rpm),
      max_attempts: Number(maxAttempts),
      timeout_seconds: Number(timeoutSeconds),
      row_limit: rowLimitText.trim() ? Number(rowLimitText.trim()) : null,
      allow_empty: allowEmpty,
      mode: sliceMode,
      date_param: dateParam,
      start_date: sliceMode === "date_range" ? startDate : null,
      end_date: sliceMode === "date_range" ? endDate : null,
      split_param: splitParam || null,
      split_values: splitValues,
    };
  };

  const handlePreviewPlan = async () => {
    setBusy(true);
    setError(null);
    try {
      const cfg = buildConfigPayload();
      const preview = await collectorApi.planTask(cfg);
      setConfirmedConfig(cfg);
      setPlanPreview(preview);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成切片计划失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSaveConfig = async (launchImmediately: boolean) => {
    if (!confirmedConfig) return;
    setBusy(true);
    setError(null);
    try {
      const saved = editingMeta
        ? await collectorApi.updateConfig(
            editingMeta.id,
            editingMeta.revision,
            confirmedConfig,
          )
        : await collectorApi.createConfig(confirmedConfig);
      setEditingMeta({ id: saved.id, revision: saved.revision });
      if (launchImmediately) {
        const run = await collectorApi.launchConfigRun(
          saved.id,
          saved.revision,
        );
        await onSavedOrLaunched(run);
      } else {
        await onSavedOrLaunched();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存或启动任务失败");
    } finally {
      setBusy(false);
    }
  };

  const handleRunQuickPreview = async () => {
    if (!selectedEntry) return;
    setBusy(true);
    setError(null);
    try {
      const parsedParams =
        paramEditorMode === "guided"
          ? Object.fromEntries(
              Object.entries(guidedParams).filter(([, v]) => v.trim() !== ""),
            )
          : parseObject(paramsText);
      const run = await collectorApi.createLivePreview({
        entry_id: selectedEntry.id,
        params: parsedParams,
        fields: selectedFields.join(","),
        raw_root: rawRoot.trim(),
      });
      setLivePreviewRun(run);
      await onSavedOrLaunched();
    } catch (err) {
      setError(err instanceof Error ? err.message : "发起单次查询失败");
    } finally {
      setBusy(false);
    }
  };

  const handlePickDir = async () => {
    try {
      const res = await collectorApi.selectDirectory(rawRoot || null);
      if (!res.cancelled && res.path) setRawRoot(res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "选择目录失败");
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Mode Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setFlowMode("wizard")}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
              flowMode === "wizard"
                ? "bg-navy-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
            )}
          >
            <Sparkles className="h-3.5 w-3.5" />
            分步切片采集向导
          </button>
          <button
            type="button"
            onClick={() => setFlowMode("quick-preview")}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
              flowMode === "quick-preview"
                ? "bg-navy-900 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200/70",
            )}
          >
            <Zap className="h-3.5 w-3.5" />
            单次即时查询验证
          </button>
        </div>

        {flowMode === "wizard" && (
          <div className="flex items-center gap-2 text-xs">
            {(
              [
                [1, "1. 选择股票接口"],
                [2, "2. 参数与切片规则"],
                [3, "3. 预览确认与启动"],
              ] as const
            ).map(([s, label]) => (
              <button
                key={s}
                type="button"
                disabled={s === 3 && !planPreview}
                onClick={() => setStep(s)}
                className={clsx(
                  "rounded-full px-3 py-1 font-medium transition-colors",
                  step === s
                    ? "bg-teal-600 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-40",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {editingMeta && (
          <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 px-2.5 py-1 rounded-lg">
            <span>正在编辑已保存配置 (v{editingMeta.revision})</span>
            <button
              type="button"
              onClick={() => {
                setEditingMeta(null);
                onClearEditing();
              }}
              className="underline font-medium"
            >
              退出编辑改为新建
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
          {error}
        </div>
      )}

      {draftWarning && (
        <div className="rounded-xl bg-amber-50 px-4 py-2.5 text-xs text-amber-800 ring-1 ring-inset ring-amber-500/25">
          {draftWarning}
        </div>
      )}

      {/* Step 1 or Quick Preview Left/Right Catalog Selector */}
      {(flowMode === "quick-preview" || step === 1) && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Left Entry Directory */}
          <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="border-b border-slate-100 bg-slate-50/70 p-3.5 space-y-2.5">
              <select
                value={catFilter}
                onChange={(e) => setCatFilter(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
              >
                <option value="">全部股票目录分类 ({visibleEntries.length})</option>
                {(catalog?.categories ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={entrySearch}
                  onChange={(e) => setEntrySearch(e.target.value)}
                  placeholder="搜索接口中文名或 api_name…"
                  className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-xs"
                />
              </div>
            </div>

            <div className="divide-y divide-slate-100 max-h-[30rem] overflow-y-auto">
              {visibleEntries.map((entry) => {
                const active = selectedEntry?.id === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => handleSelectEntry(entry)}
                    className={clsx(
                      "w-full px-4 py-2.5 text-left transition-colors flex items-center justify-between gap-2",
                      active
                        ? "bg-teal-50/70 border-l-4 border-l-teal-600"
                        : "hover:bg-slate-50",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-slate-900">
                        {entry.name}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {entry.category_name}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-mono text-slate-700">
                        {entry.api_name}
                      </code>
                      {entry.status === "sdk_only" && (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                          仅 SDK
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Entry Documentation & Quick Preview / Next Step */}
          <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            {selectedEntry && (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-slate-900">
                        {selectedEntry.name}
                      </h2>
                      <code className="rounded bg-teal-50 px-2 py-0.5 text-xs font-mono text-teal-800">
                        {selectedEntry.api_name}
                      </code>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      分类：{selectedEntry.category_name} · 单次上限：
                      {selectedEntry.row_limit
                        ? `${formatNumber(selectedEntry.row_limit)} 行`
                        : "目录未声明明确上限"}{" "}
                      · 方式：{states[selectedEntry.status || "http"] || "HTTP / SDK"}
                    </p>
                  </div>

                  {flowMode === "wizard" && (
                    <button
                      type="button"
                      onClick={() => setStep(2)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-700"
                    >
                      下一步：配置参数与切片 <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Parameter Schema Table */}
                <PermissionNotice
                  access={selectedEntry.access}
                  permission={selectedEntry.permission}
                  docUrl={selectedEntry.doc_url}
                  onOpenFullAudit={() => onOpenPermissionAudit?.(selectedEntry.id)}
                />
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-slate-700">
                    输入参数定义 ({selectedEntry.params.length})
                  </div>
                  <div className="overflow-hidden rounded-lg border border-slate-200">
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium">参数名</th>
                          <th className="px-3 py-1.5 text-left font-medium">类型</th>
                          <th className="px-3 py-1.5 text-left font-medium">必填</th>
                          <th className="px-3 py-1.5 text-left font-medium">说明</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {selectedEntry.params.map((p) => (
                          <tr key={p.name}>
                            <td className="px-3 py-1.5 font-mono text-slate-900">
                              {p.name}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-slate-500">
                              {p.type}
                            </td>
                            <td className="px-3 py-1.5">
                              {p.required ? (
                                <span className="text-rose-600 font-semibold">是</span>
                              ) : (
                                <span className="text-slate-400">可选</span>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-slate-600">
                              {p.description}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Quick Single-Shot Preview Form */}
                {flowMode === "quick-preview" ? (
                  <div className="rounded-xl border border-teal-200 bg-teal-50/30 p-4 space-y-3">
                    <div className="text-xs font-semibold text-teal-900">
                      发起单次即时查询（结果自动归档校验并跳转本地阅读器）
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        请求参数 (JSON 对象)
                      </label>
                      <textarea
                        rows={3}
                        value={paramsText}
                        onChange={(e) => {
                          setParamEditorMode("json");
                          setParamsText(e.target.value);
                        }}
                        placeholder='例如 {"trade_date": "20261112"} 或 {"ts_code": "600000.SH"}'
                        className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-xs font-mono"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-slate-500 truncate max-w-xs">
                        归档至：{rawRoot}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleRunQuickPreview}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
                      >
                        <Play className="h-3.5 w-3.5" />
                        {busy ? "正在提交查询…" : "执行单次查询并预览"}
                      </button>
                    </div>

                    {livePreviewRun && (
                      <div className="rounded-lg bg-white p-2.5 text-xs ring-1 ring-slate-200 flex items-center justify-between">
                        <span>
                          即时预览状态：
                          <strong className="ml-1">
                            {states[livePreviewRun.state] || livePreviewRun.state}
                          </strong>
                          {livePreviewRun.error ? ` — ${livePreviewRun.error}` : ""}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <details className="text-xs text-slate-600">
                    <summary className="cursor-pointer font-semibold text-slate-700">
                      查看目录输出字段 ({selectedEntry.fields.length} 列，默认拉取全部)
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1.5 max-h-40 overflow-y-auto p-2 rounded-lg bg-slate-50">
                      {selectedEntry.fields.map((f) => (
                        <span
                          key={f.name}
                          className="rounded bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200"
                          title={f.description}
                        >
                          {f.name}
                        </span>
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Wizard Step 2: Parameters, Slicing & Storage */}
      {flowMode === "wizard" && step === 2 && selectedEntry && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                配置任务：{selectedEntry.name} ({selectedEntry.api_name})
              </h2>
              <p className="text-xs text-slate-500">
                支持单次请求、按自然日范围切片与枚举参数笛卡尔积切片（最多 20,000 个切片）
              </p>
            </div>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              更换股票接口
            </button>
          </div>

          {/* Quick Templates for Common APIs */}
          {commonAPIs.has(selectedEntry.api_name) && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-teal-50/50 px-3.5 py-2.5 text-xs ring-1 ring-inset ring-teal-600/15">
              <span className="font-medium text-teal-900">快速填充模板：</span>
              {selectedEntry.api_name === "stock_basic" ? (
                <button
                  type="button"
                  onClick={() => applyTemplate("day")}
                  className="rounded bg-white px-2.5 py-1 font-medium text-teal-700 ring-1 ring-teal-200 hover:bg-teal-50"
                >
                  上市股票清单 (list_status=L)
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => applyTemplate("day")}
                    className="rounded bg-white px-2.5 py-1 font-medium text-teal-700 ring-1 ring-teal-200 hover:bg-teal-50"
                  >
                    单日全市场模板
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate("range")}
                    className="rounded bg-white px-2.5 py-1 font-medium text-teal-700 ring-1 ring-teal-200 hover:bg-teal-50"
                  >
                    逐日日期范围模板
                  </button>
                </>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                任务名称
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Raw 归档根目录
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={rawRoot}
                  onChange={(e) => setRawRoot(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono"
                />
                <button
                  type="button"
                  onClick={handlePickDir}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 hover:bg-slate-100"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  选择
                </button>
              </div>
            </div>
          </div>

          {/* Base Parameters: Guided vs JSON */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-700">
                基础固定参数
              </label>
              {commonAPIs.has(selectedEntry.api_name) && (
                <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        const obj = parseObject(paramsText);
                        if (canGuide(selectedEntry, obj)) {
                          setGuidedParams(obj as Record<string, string>);
                          setParamEditorMode("guided");
                        } else {
                          setError("当前 JSON 含非字符串或特殊值，保持 JSON 编辑模式");
                        }
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "JSON 格式错误");
                      }
                    }}
                    className={clsx(
                      "rounded-md px-2.5 py-0.5 font-medium",
                      paramEditorMode === "guided"
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500",
                    )}
                  >
                    表单引导
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const clean = Object.fromEntries(
                        Object.entries(guidedParams).filter(([, v]) => v !== ""),
                      );
                      setParamsText(JSON.stringify(clean, null, 2));
                      setParamEditorMode("json");
                    }}
                    className={clsx(
                      "rounded-md px-2.5 py-0.5 font-medium",
                      paramEditorMode === "json"
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-500",
                    )}
                  >
                    JSON 编辑
                  </button>
                </div>
              )}
            </div>

            {paramEditorMode === "guided" && commonAPIs.has(selectedEntry.api_name) ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
                {selectedEntry.params.map((p) => {
                  const choices = parameterChoices[p.name];
                  return (
                    <div key={p.name}>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        {parameterLabels[p.name] || p.name} ({p.name})
                      </label>
                      {choices ? (
                        <select
                          value={guidedParams[p.name] || ""}
                          onChange={(e) =>
                            setGuidedParams((prev) => ({
                              ...prev,
                              [p.name]: e.target.value,
                            }))
                          }
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                        >
                          <option value="">不限定</option>
                          {choices.map(([val, label]) => (
                            <option key={val} value={val}>
                              {label} ({val})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={guidedParams[p.name] || ""}
                          onChange={(e) =>
                            setGuidedParams((prev) => ({
                              ...prev,
                              [p.name]: e.target.value,
                            }))
                          }
                          placeholder={p.name.endsWith("date") ? "YYYYMMDD" : p.description}
                          className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <textarea
                rows={4}
                value={paramsText}
                onChange={(e) => setParamsText(e.target.value)}
                className="w-full rounded-lg border border-slate-300 p-3 text-xs font-mono"
                placeholder='{"ts_code": "600000.SH"}'
              />
            )}
          </div>

          {/* Slicing Rules */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                日期与枚举自动切片
              </span>
              <div className="inline-flex rounded-lg bg-white p-0.5 text-xs ring-1 ring-slate-200">
                <button
                  type="button"
                  onClick={() => setSliceMode("single")}
                  className={clsx(
                    "rounded-md px-2.5 py-1 font-medium",
                    sliceMode === "single"
                      ? "bg-navy-900 text-white"
                      : "text-slate-600",
                  )}
                >
                  单次日期 / 条件
                </button>
                <button
                  type="button"
                  onClick={() => setSliceMode("date_range")}
                  className={clsx(
                    "rounded-md px-2.5 py-1 font-medium",
                    sliceMode === "date_range"
                      ? "bg-navy-900 text-white"
                      : "text-slate-600",
                  )}
                >
                  按自然日范围切片
                </button>
              </div>
            </div>

            {sliceMode === "date_range" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    日期参数名
                  </label>
                  <select
                    value={dateParam}
                    onChange={(e) => setDateParam(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                  >
                    {selectedEntry.params.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    起始日期
                  </label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    结束日期
                  </label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  枚举参数名（可选）
                </label>
                <select
                  value={splitParam}
                  onChange={(e) => setSplitParam(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                >
                  <option value="">不使用枚举切片</option>
                  {selectedEntry.params.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  枚举值 JSON 数组（如 [&quot;SSE&quot;, &quot;SZSE&quot;]）
                </label>
                <input
                  type="text"
                  value={splitValuesText}
                  onChange={(e) => setSplitValuesText(e.target.value)}
                  placeholder='["SSE", "SZSE", "BSE"]'
                  className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-mono"
                />
              </div>
            </div>
          </div>

          {/* Advanced Execution Controls */}
          <details className="rounded-xl border border-slate-200 p-4 text-xs">
            <summary className="cursor-pointer font-semibold text-slate-700">
              高级执行参数（传输方式、限流 RPM、重试次数、字段裁剪）
            </summary>
            <div className="mt-3 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    传输方式
                  </label>
                  <select
                    value={selectedEntry.status === "sdk_only" ? "sdk" : transport}
                    disabled={selectedEntry.status === "sdk_only"}
                    onChange={(e) => setTransport(e.target.value as "sdk" | "http")}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono"
                  >
                    <option value="sdk">SDK Parquet</option>
                    <option value="http">HTTP JSON</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    限流 RPM
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={rpm}
                    onChange={(e) => setRpm(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    最大尝试次数
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={maxAttempts}
                    onChange={(e) => setMaxAttempts(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    超时秒数
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={timeoutSeconds}
                    onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">
                    自定义行数阈值
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={rowLimitText}
                    onChange={(e) => setRowLimitText(e.target.value)}
                    placeholder="默认按目录"
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono"
                  />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={allowEmpty}
                  onChange={(e) => setAllowEmpty(e.target.checked)}
                  className="rounded border-slate-300 text-teal-600"
                />
                允许接口返回 0 行空表（如非交易日或无事件日期不记为失败）
              </label>
            </div>
          </details>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={handlePreviewPlan}
              className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-5 py-2 text-xs font-semibold text-white hover:bg-navy-800 disabled:opacity-50"
            >
              预览切片计划 <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Wizard Step 3: Plan Confirmation & Launch */}
      {flowMode === "wizard" && step === 3 && planPreview && confirmedConfig && (
        <div className="rounded-xl border border-teal-300 bg-white p-6 shadow-sm space-y-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-teal-600" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  确认自定义采集计划：{confirmedConfig.name}
                </h2>
                <p className="text-xs text-slate-500">
                  共生成 <strong>{formatNumber(planPreview.total)}</strong> 个请求切片
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回修改参数
            </button>
          </div>

          <div className="rounded-xl bg-slate-50 p-4 space-y-1.5 text-xs text-slate-700 ring-1 ring-inset ring-slate-200/80">
            {collectionScope(confirmedConfig).map((line, idx) => (
              <div key={idx}>{line}</div>
            ))}
          </div>

          {planPreview.date_semantics === "calendar_days" && (
            <div className="rounded-lg bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 ring-1 ring-inset ring-amber-500/25">
              提示：自定义日期范围按自然日逐天生成参数（含周末与节假日）；如需严格按沪深开市日增量管理，请优先使用「高级工具 → 预置采集」。
            </div>
          )}

          <div className="space-y-1.5">
            <div className="text-xs font-semibold text-slate-700">
              前 {planPreview.samples.length} 个切片参数示例
            </div>
            <pre className="rounded-lg bg-navy-950 p-3.5 text-[11px] font-mono text-teal-200 overflow-x-auto">
              {JSON.stringify(planPreview.samples, null, 2)}
            </pre>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => handleSaveConfig(false)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {editingMeta ? "保存配置修改" : "仅保存为常用任务"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => handleSaveConfig(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              保存并立即启动采集 ({planPreview.total} 切片)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
