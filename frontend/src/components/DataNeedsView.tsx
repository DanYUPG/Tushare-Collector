import { useCallback, useEffect, useRef, useState } from "react";
import { collectorApi } from "../lib/api";
import { formatNumber, formatDateTime } from "../lib/helpers";
import { patchLocationState, readLocationState } from "../lib/navigation";
import type { DataNeed, DataNeedCapability, DataNeedJob, DataNeedSpec } from "../types";
import { DataNeedDatasetPicker } from "./DataNeedDatasetPicker";
import { StorageManagement } from "./StorageManagement";
import { WorkspaceDrawer, WorkspaceHeader, WorkspaceMenu, WorkspaceToolbar } from "./WorkspaceLayout";

const LABELS: Record<string, string> = {
  pending: "待处理", planning: "准备与规划", collecting: "采集中", publishing: "校验入库",
  succeeded: "本轮处理完成", blocked: "需要处理", paused: "已暂停",
};
const ACTIVE = new Set(["planning", "collecting", "publishing"]);
const INITIAL: DataNeedSpec = {
  name: "日常研究数据", dataset_ids: [],
  start_date: "2020-01-01", end_date: null, update_hour: 20,
  lookback_days: 7, requests_per_minute: 100, max_requests: 30000,
};

function JobProgress({job, onRun, entries, hideError = false}: {
  job: DataNeedJob; onRun: (id: string) => void; entries: DataNeedCapability[]; hideError?: boolean;
}) {
  return <div className="space-y-2 text-xs">
    <p className="font-medium">{LABELS[job.state]} · 已登记请求 {formatNumber(job.requests_sent)} / {formatNumber(job.request_limit)}
      <span className="ml-3 font-normal text-slate-500">{formatDateTime(job.created_at)}</span>
    </p>
    {job.error && !hideError && <p className="text-rose-800">{job.error}</p>}
    <ul className="space-y-2">{job.steps.map(step => <li key={step.dataset_id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="w-40">{entries.find(entry => entry.dataset_id === step.dataset_id)?.name || step.dataset_id}</span>
      <span>{step.state === "succeeded" ? step.result?.role === "planning_dependency"
        || step.publish === false || step.publish === undefined && step.dataset_id === "trade_cal"
        ? "依赖已准备" : "已发布可查询" : LABELS[step.state]}</span>
      {step.result?.snapshot_id && <span className="text-slate-600">
        {formatNumber(step.result.rows ?? 0)} 行 · {entries.find(entry => entry.dataset_id === step.dataset_id)?.date_mode === "snapshot"
          ? "当前轮次快照（非历史截面）" : `记录截至 ${step.result.last_date || "未知"}`} · {step.result.changed ? "本轮写入已回读校验" : "复用已有快照"}
      </span>}
      {step.run_id && <button type="button" className="text-teal-800 underline" onClick={() => onRun(step.run_id!)}>运行详情</button>}
    </li>)}</ul>
  </div>;
}

function NeedQuery({need, entries, onOpen}: {
  need: DataNeed; entries: DataNeedCapability[]; onOpen: (id: string, start: string | null, end: string | null) => void;
}) {
  const [datasetId, setDatasetId] = useState(need.spec.dataset_ids[0] || "");
  const selected = need.spec.dataset_ids.includes(datasetId) ? datasetId : need.spec.dataset_ids[0] || "";
  const snapshot = entries.find(entry => entry.dataset_id === selected)?.date_mode === "snapshot";
  return <div className="flex flex-wrap items-center gap-2">
    {need.spec.dataset_ids.length > 1 && <select aria-label={`查询数据集 ${need.spec.name}`}
      value={selected} onChange={event => {
        const value = need.spec.dataset_ids.find(id => id === event.target.value);
        if (value) setDatasetId(value);
      }}
      className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs">
      {need.spec.dataset_ids.map(id => <option key={id} value={id}>{entries.find(entry => entry.dataset_id === id)?.name || id}</option>)}
    </select>}
    <button type="button" disabled={!selected || !entries.length} onClick={() => onOpen(
      selected, snapshot ? null : need.spec.start_date,
      snapshot ? null : need.spec.end_date || need.jobs[0]?.steps.find(step => step.dataset_id === selected)?.target || null,
    )} className="rounded-lg bg-teal-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
      查询 / 导出{need.spec.dataset_ids.length === 1 ? ` · ${entries.find(entry => entry.dataset_id === selected)?.name || selected}` : ""}
    </button>
  </div>;
}

export function DataNeedsView({tokenConfigured, workerRunning, onOpenWarehouse, onOpenRun}: {
  tokenConfigured: boolean; workerRunning: boolean;
  onOpenWarehouse: (datasetId: string, startDate: string | null, endDate: string | null) => void;
  onOpenRun: (runId: string) => void;
}) {
  const [needs, setNeeds] = useState<DataNeed[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<DataNeedCapability[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [editingRevision, setEditingRevision] = useState(0);
  const [spec, setSpec] = useState<DataNeedSpec>(INITIAL);
  const [enabled, setEnabled] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [syncAuthorized, setSyncAuthorized] = useState(false);
  const [syncRevision, setSyncRevision] = useState(0);
  const [selectedId, setSelectedId] = useState(() => readLocationState().get("need"));
  const [detailTab, setDetailTab] = useState("overview");
  const mounted = useRef(true);
  const loadEpoch = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    try {
      const values = await collectorApi.getDataNeeds();
      if (mounted.current && loadEpoch.current === epoch) {setNeeds(values); setLoadError(null);}
    } catch (reason) {
      if (mounted.current && loadEpoch.current === epoch) setLoadError(reason instanceof Error ? reason.message : "无法读取数据需求");
    } finally {if (mounted.current && loadEpoch.current === epoch) setLoading(false);}
  }, []);
  const loadCatalog = useCallback(async () => {
    try {
      const catalog = await collectorApi.getDataNeedCatalog();
      if (mounted.current) {setEntries(catalog.entries); setCatalogError(null);}
    } catch (reason) {
      if (mounted.current) setCatalogError(reason instanceof Error ? reason.message : "无法读取需求接口目录");
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    void loadCatalog();
    const interval = window.setInterval(() => {if (!document.hidden) void load();}, 5000);
    const restore = () => {
      const nextId = readLocationState().get("need");
      setSelectedId(nextId);
      setEditing(current => current && current !== "new" && current === nextId ? current : null);
    };
    window.addEventListener("collector:navigation", restore);
    window.addEventListener("hashchange", restore);
    window.addEventListener("popstate", restore);
    return () => {
      mounted.current = false; window.clearInterval(interval);
      window.removeEventListener("collector:navigation", restore);
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("popstate", restore);
    };
  }, [load, loadCatalog]);
  useEffect(() => {
    setDetailTab("overview"); setConfirmId(null); setSyncAuthorized(false);
  }, [selectedId]);
  function updateSpec(patch: Partial<DataNeedSpec>) {
    setSpec(current => ({...current, ...patch})); setAuthorized(false);
  }

  function edit(need?: DataNeed) {
    setEditing(need?.id || "new");
    setEditingRevision(need?.revision ?? 0);
    setSpec(need ? {...need.spec, dataset_ids: [...need.spec.dataset_ids]} : {...INITIAL});
    setEnabled(need?.enabled ?? false); setAuthorized(false); setError(null);
    if (need) patchLocationState({need: need.id}, "push");
  }
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {await action(); await load();}
    catch (reason) {setError(reason instanceof Error ? reason.message : "操作失败");}
    finally {setBusy(false);}
  }
  async function save() {
    await perform(async () => {
      const saved = await collectorApi.saveDataNeed({
        spec, enabled, authorize_network: enabled && authorized, expected_revision: editingRevision,
      }, editing === "new" || !editing ? undefined : editing);
      setEditing(null); patchLocationState({need: saved.id}, "push");
    });
  }
  function closeDetail() {
    setConfirmId(null); setSyncAuthorized(false);
    patchLocationState({need: null}, "push");
  }
  const selectedNeed = needs.find(need => need.id === selectedId);
  const editingStale = editing !== null && editing !== "new"
    && needs.find(need => need.id === editing)?.revision !== editingRevision;
  const inputClass = "rounded border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-50";
  const snapshotOnly = (value: DataNeedSpec) => value.dataset_ids.length > 0
    && value.dataset_ids.every(id => entries.find(entry => entry.dataset_id === id)?.date_mode === "snapshot");
  const rangeLabel = (value: DataNeedSpec) => snapshotOnly(value) ? "当前快照（不回放历史）"
    : `${value.start_date} 至 ${value.end_date || "上海时间昨天"}`;
  const invalidOptions = Object.values(spec.dataset_options || {}).some(options => Object.values(options).some(values => !values.length));

  return <div className="space-y-5">
    <WorkspaceHeader title="数据需求" description="声明需要的股票数据，按接口规则维护本地仓库。保存不会联网。"
      actions={<>
        <button type="button" onClick={() => edit()} disabled={busy || !entries.length} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">新增数据需求</button>
        <WorkspaceMenu><StorageManagement /></WorkspaceMenu>
      </>} />
    {(!tokenConfigured || !workerRunning) && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
      {!tokenConfigured ? "尚未配置凭证。可以保存需求，已授权的维护会等待凭证就绪。" : "执行引擎未运行。可以保存需求，当前不会发送采集请求。"}
    </p>}
    {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {loadError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{loadError}</p>}
    {catalogError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{catalogError}
      <button type="button" className="ml-3 underline" onClick={() => void loadCatalog()}>重读接口目录</button></p>}
    <WorkspaceDrawer open={Boolean(editing)} title={editing === "new" ? "新增数据需求" : "修改数据需求"}
      label="数据需求配置" busy={busy} onClose={() => setEditing(null)}
      description="声明需要什么数据。仅保存不会联网，也不会删除已有数据。"
      footer={<div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => setEditing(null)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">取消配置</button>
        <button type="button" disabled={busy || editingStale || !entries.length || invalidOptions || !spec.dataset_ids.length || !spec.name.trim() || enabled && !authorized}
          onClick={() => void save()} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "正在保存…" : enabled ? "保存并授权启用" : "仅保存需求（不联网）"}
        </button>
      </div>}>
      {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {loadError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{loadError}</p>}
      {editingStale && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">需求已在其他窗口修改。当前草稿不可提交；请关闭配置并重新打开，载入最新版本。</p>}
      <section aria-label="需求参数" className="space-y-4">
      <fieldset disabled={busy} className="space-y-4">
      <label className="grid gap-2 text-sm">需求名称<input aria-label="需求名称" value={spec.name} maxLength={100}
        onChange={event => updateSpec({name: event.target.value})} className={`${inputClass} w-full`} /></label>
      <DataNeedDatasetPicker entries={entries} spec={spec} onChange={updateSpec} />
      <div className="grid gap-4 sm:grid-cols-2">
        {!snapshotOnly(spec) && <><label className="grid gap-2 text-sm">历史起点<input aria-label="需求历史起点" type="date" value={spec.start_date}
          onChange={event => updateSpec({start_date: event.target.value})} className={inputClass} /></label>
        <label className="grid gap-2 text-sm">固定截止日<input aria-label="需求固定截止日" type="date" value={spec.end_date || ""}
          onChange={event => updateSpec({end_date: event.target.value || null})} className={inputClass} />
          <span className="text-xs text-slate-500">留空则滚动到昨天；不适用于当前快照</span></label></>}
        <label className="text-sm">每日尝试时间（北京时间）
          <input aria-label="每日尝试小时" type="number" min={0} max={23} value={spec.update_hour}
            onChange={event => updateSpec({update_hour: Number(event.target.value)})} className={`${inputClass} mx-2 w-20`} />时
        </label>
      </div>
      <p className="text-xs text-slate-600">{snapshotOnly(spec) ? "仅拉取执行时的当前快照，不支持历史回放。"
        : "历史范围按各接口的交易日、公告日或报告期规则解释，详见已选接口。当前快照始终更新到执行当天；停更接口只补历史，不追新日期。"}</p>
      <details className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm text-slate-700">更新与请求预算（可选）</summary>
        <div className="mt-3 grid gap-4">
        <label className="text-sm">近期修订回查
          <input aria-label="需求回查天数" type="number" min={1} max={366} value={spec.lookback_days}
            onChange={event => updateSpec({lookback_days: Number(event.target.value)})} className={`${inputClass} mx-2 w-24`} />自然日
        </label>
        <label className="text-sm">每分钟最多请求
          <input aria-label="需求每分钟请求数" type="number" min={1} max={500} value={spec.requests_per_minute}
            onChange={event => updateSpec({requests_per_minute: Number(event.target.value)})} className={`${inputClass} mx-2 w-24`} />
        </label>
        <label className="text-sm">每轮最多请求
          <input aria-label="需求每轮请求预算" type="number" min={1} max={100000} value={spec.max_requests}
            onChange={event => updateSpec({max_requests: Number(event.target.value)})} className={`${inputClass} mx-2 w-28`} />
        </label>
        </div>
      </details>
      <p className="text-xs text-slate-600">请求预算包含日历、股票列表、板块代码池等依赖及重试。暂时性请求失败按现有规则最多尝试 3 次；失败耗尽、权限不足、触顶或发布异常时停止自动执行，等待核查。各数据集保留当前存储目录，缩小需求范围不删除旧数据。</p>
      <p className="text-xs text-slate-500">保存全部声明字段。当前代码池不证明历史股票池或全市场完整；执行时间不代表供应商已发布。自动释放文件仍仅适用于原有三个日频数据集，其他接口保留中间文件。</p>
      <p className="text-xs text-slate-500">实时接口每次维护只取当前一轮，不持续盯盘；分钟、实时等独立权限须自行开通。复权重述接口每轮整段重拉，仍受请求预算与行数上限约束。</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled}
        onChange={event => {setEnabled(event.target.checked); setAuthorized(false);}} />启用自动维护（保存后立即开始，以后每日尝试）</label>
      {enabled && <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
        <input aria-label="授权自动维护" type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} />
        我授权系统在上述范围和分类参数、预算内联网采集、准备所需依赖并自动入库；未完成的已授权作业会在服务重启后恢复。
      </label>}
      </fieldset>
      </section>
    </WorkspaceDrawer>
    {loading && <p className="text-sm text-slate-500">正在读取需求…</p>}
    {!loading && !needs.length && <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600">
      还没有长期数据需求。已有仓库和任务保持不变，不会自动迁移或发起采集。新增后可先保存，再决定是否授权执行。
    </div>}
    {needs.map(need => {
      const latest = need.jobs[0];
      const active = latest && ACTIVE.has(latest.state);
      return <section key={need.id} aria-label={`数据需求 ${need.spec.name}`}
        className={`space-y-3 rounded-xl border bg-white p-4 ${selectedId === need.id ? "border-teal-500" : "border-slate-200"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><button type="button" className="font-semibold text-slate-900" onClick={() => patchLocationState({need: need.id}, "push")}>{need.spec.name}</button>
            <p className="mt-1 text-xs text-slate-600">{rangeLabel(need.spec)} · {need.enabled ? need.last_error ? "自动维护遇阻" : "已授权自动维护" : "未启用自动维护"}
              {need.enabled && !need.last_error && need.next_attempt_at && <> · 下次尝试 {formatDateTime(need.next_attempt_at)}</>}
            </p><p className="mt-1 text-xs text-slate-500">{need.spec.dataset_ids.length} 个接口 · {need.spec.dataset_ids.slice(0, 4).map(id => entries.find(entry => entry.dataset_id === id)?.name || id).join(" · ")}
              {need.spec.dataset_ids.length > 4 && " 等"}</p></div>
          <span className={`rounded-full px-2.5 py-1 text-xs ${need.last_error || latest?.state === "blocked" ? "bg-rose-50 text-rose-800" : active ? "bg-teal-50 text-teal-800" : "bg-slate-100 text-slate-600"}`}>
            {latest ? LABELS[latest.state] || latest.state : "尚未执行"}
          </span>
        </div>
        {need.last_error && <p role="alert" className="rounded bg-rose-50 p-3 text-sm text-rose-800">自动执行已停止：{need.last_error}</p>}
        {latest?.error && latest.error !== need.last_error && <p role="alert" className="rounded bg-rose-50 p-3 text-sm text-rose-800">{latest.error}</p>}
        {active && <p role="status" className="text-xs text-teal-800">
          {LABELS[latest.state]} · 完成 {latest.steps.filter(step => step.state === "succeeded").length}/{latest.steps.length} 项
          · 已登记请求 {formatNumber(latest.requests_sent)} / {formatNumber(latest.request_limit)}
        </p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <NeedQuery need={need} entries={entries} onOpen={onOpenWarehouse} />
          <div className="flex flex-wrap gap-2 text-xs">
            {active && <button type="button" disabled={busy}
              onClick={() => void perform(() => collectorApi.pauseDataNeed(need.id, need.revision))}
              className="rounded border border-amber-300 px-3 py-2 text-amber-900">暂停维护与当前作业</button>}
            <button type="button" onClick={() => patchLocationState({need: need.id}, "push")}
              className="rounded-lg border border-slate-200 px-3 py-2 text-slate-700">查看详情</button>
          </div>
        </div>
      </section>;
    })}
    {selectedNeed && <WorkspaceDrawer open={!editing} title={selectedNeed.spec.name}
      label="数据需求详情" busy={busy} onClose={closeDetail}
      description={`${rangeLabel(selectedNeed.spec)} · ${selectedNeed.enabled ? "已授权自动维护" : "未启用自动维护"}`}>
      {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
      {loadError && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{loadError}</p>}
      {selectedNeed.last_error && <p role="alert" className="rounded bg-rose-50 p-3 text-sm text-rose-800">自动执行已停止：{selectedNeed.last_error}</p>}
      {selectedNeed.jobs[0]?.error && selectedNeed.jobs[0].error !== selectedNeed.last_error &&
        <p role="alert" className="rounded bg-rose-50 p-3 text-sm text-rose-800">{selectedNeed.jobs[0].error}</p>}
      <details open={confirmId === selectedNeed.id ? true : undefined} className="rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm">声明范围与分类参数（{selectedNeed.spec.dataset_ids.length} 个接口）</summary>
        <ul className="mt-3 space-y-2 text-xs text-slate-600">{selectedNeed.spec.dataset_ids.map(id => {
          const entry = entries.find(item => item.dataset_id === id);
          return <li key={id}>{entry?.name || id} · {entry?.date_mode === "snapshot" ? "仅当前快照" : entry?.date_label}
            {Object.entries(entry?.options || {}).map(([key, definition]) => <span key={key}>
              {" · "}{key}: {(selectedNeed.spec.dataset_options?.[id]?.[key] ?? definition.default).join("、")}
            </span>)}
          </li>;
        })}</ul>
        <p className="mt-3 text-xs text-slate-500">按规则准备所需日历、股票列表或板块代码池，依赖计入预算。
          当前快照不回放历史；其他接口遵循各自日期规则及停更边界。中间文件释放须另行授权。</p>
      </details>
      <WorkspaceToolbar label="需求操作">
        <NeedQuery need={selectedNeed} entries={entries} onOpen={onOpenWarehouse} />
        <button type="button" disabled={busy || !entries.length || Boolean(selectedNeed.jobs[0] && ACTIVE.has(selectedNeed.jobs[0].state))}
          onClick={() => edit(selectedNeed)} className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50">修改需求</button>
        <button type="button" disabled={busy || !entries.length || Boolean(selectedNeed.jobs[0] && ACTIVE.has(selectedNeed.jobs[0].state)) || !tokenConfigured || !workerRunning}
          onClick={() => {setConfirmId(selectedNeed.id); setSyncRevision(selectedNeed.revision); setSyncAuthorized(false);}}
          className="rounded-lg border border-teal-700 px-3 py-2 text-xs text-teal-800 disabled:opacity-50">
          {selectedNeed.last_error ? "核查后重新同步" : "立即同步"}
        </button>
        {(selectedNeed.enabled || selectedNeed.jobs[0] && ACTIVE.has(selectedNeed.jobs[0].state)) &&
          <button type="button" disabled={busy}
            onClick={() => void perform(() => collectorApi.pauseDataNeed(selectedNeed.id, selectedNeed.revision))}
            className="rounded-lg border border-amber-300 px-3 py-2 text-xs text-amber-900">暂停维护与当前作业</button>}
      </WorkspaceToolbar>
      {confirmId === selectedNeed.id && <div className="space-y-3 rounded bg-amber-50 p-3 text-sm text-amber-900">
          {syncRevision !== selectedNeed.revision && <p role="alert">需求已在其他窗口修改。请重新点击同步，核对最新范围后再授权。</p>}
          <label className="flex items-start gap-2"><input aria-label="授权本次同步" type="checkbox" checked={syncAuthorized}
            onChange={event => setSyncAuthorized(event.target.checked)} />我授权本轮最多 {formatNumber(selectedNeed.spec.max_requests)} 次联网请求（含依赖与重试），完成后自动校验入库；中断后会在服务重启时恢复。不会删除已有数据。</label>
          <button type="button" disabled={busy || !entries.length || !syncAuthorized || syncRevision !== selectedNeed.revision} onClick={() => void perform(async () => {
            await collectorApi.syncDataNeed(selectedNeed.id, syncRevision); setConfirmId(null);
          })} className="mr-3 rounded bg-teal-700 px-3 py-2 text-white disabled:opacity-50">确认联网同步</button>
          <button type="button" disabled={busy} onClick={() => setConfirmId(null)}>取消同步</button>
        </div>}
      <div role="group" aria-label="需求详情分类" className="flex gap-2 border-b border-slate-200 pb-2">
        {[["overview", "最近进度"], ["history", "执行记录"], ["storage", "存储与字段"]].map(([key, title]) =>
          <button type="button" key={key} aria-pressed={detailTab === key} onClick={() => setDetailTab(key)}
            className={`rounded-lg px-3 py-2 text-xs ${detailTab === key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{title}</button>)}
      </div>
      {detailTab === "overview" && <>
        {selectedNeed.enabled && !selectedNeed.last_error && selectedNeed.next_attempt_at &&
          <p className="text-xs text-slate-600">下次尝试 {formatDateTime(selectedNeed.next_attempt_at)}（不代表供应商发布时间）</p>}
        {selectedNeed.jobs[0] ? <JobProgress job={selectedNeed.jobs[0]} onRun={onOpenRun} entries={entries}
          hideError={selectedNeed.last_error === selectedNeed.jobs[0].error} /> :
          <p className="text-sm text-slate-500">尚未执行。保存需求不代表数据已采集或入库。</p>}
      </>}
      {detailTab === "history" && <div className="space-y-5">
        <p className="text-xs text-slate-500">最近 {selectedNeed.jobs.length} 轮，最多展示 10 轮。</p>
        {selectedNeed.jobs.map(job => <JobProgress key={job.id} job={job} onRun={onOpenRun} entries={entries} />)}
      </div>}
      {detailTab === "storage" && <div className="space-y-3 text-xs leading-relaxed text-slate-600">
          {Object.entries(selectedNeed.bindings).map(([id, binding]) => <p key={id} className="break-all">
            {entries.find(entry => entry.dataset_id === id)?.name || id} · 保存 {binding.schema.length} 个声明字段 · 采集目录 <code>{binding.raw_root}</code>
            {Object.entries(selectedNeed.spec.dataset_options?.[id] || {}).map(([key, values]) => <span key={key}> · {key}: {values.join("、")}</span>)}
          </p>)}
          <p>目录、分类参数或字段契约改变时停止自动执行，须重新保存需求确认。新增历史未采字段需要补采；缩小需求不会删除已有仓库数据。</p>
          <p>按各接口规则保存返回记录的全部声明字段，查询时再选列。不承诺全市场完整；窗口外修订不会自动发现。</p>
          <p>中间文件默认保留；可在“我的数据 → 更多 → 存储管理”中单独授权安全释放。</p>
      </div>}
    </WorkspaceDrawer>}
  </div>;
}
