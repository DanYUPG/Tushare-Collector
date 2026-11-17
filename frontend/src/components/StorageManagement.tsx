import { HardDrive, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { collectorApi } from "../lib/api";
import { formatDateTime, formatNumber } from "../lib/helpers";
import type { StoragePolicyStatus } from "../types";
import { GlobalWarehouseCleanupPanel } from "./GlobalWarehouseCleanupPanel";

const LABELS: Record<string, string> = {
  daily: "日线行情", daily_basic: "每日指标", adj_factor: "复权因子",
  running: "执行中 / 等待空闲", succeeded: "本轮检查完成", blocked: "已停止，需要处理", paused: "已暂停",
  pending: "等待检查", prepared: "已登记释放批次", skipped: "跳过并保留",
};

function draftFor(policy: StoragePolicyStatus) {
  return {
    retention: String(policy.spec.retention_days), hour: String(policy.spec.update_hour),
    checkMode: policy.spec.check_mode, enabled: policy.enabled, revision: policy.revision,
  };
}

function StorageDialog({onClose}: {onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const acting = useRef(false);
  const [policy, setPolicy] = useState<StoragePolicyStatus | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof draftFor> | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const busy = saving || manualBusy;
  const active = policy?.jobs.some(job => job.state === "running") ?? false;
  const conflict = policy && draft && policy.revision !== draft.revision;

  const load = useCallback(async () => {
    if (acting.current) return;
    const request = ++epoch.current;
    try {
      const value = await collectorApi.getStoragePolicy();
      if (mounted.current && epoch.current === request) {
        setPolicy(value); setDraft(current => current ?? draftFor(value)); setLoadError(null);
      }
    } catch (reason) {
      if (mounted.current && epoch.current === request) {
        setLoadError(reason instanceof Error ? reason.message : "无法读取存储策略");
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    element?.showModal();
    void load();
    const timer = window.setInterval(() => {if (!document.hidden) void load();}, 5000);
    return () => {mounted.current = false; window.clearInterval(timer); element?.close();};
  }, [load]);

  async function perform(action: () => Promise<StoragePolicyStatus>) {
    if (acting.current || manualBusy) return;
    acting.current = true; ++epoch.current; setSaving(true); setError(null);
    try {
      const value = await action();
      if (mounted.current) {
        setPolicy(value); setDraft(draftFor(value)); setAuthorized(false); setLoadError(null);
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "存储策略操作失败");
    } finally {acting.current = false; if (mounted.current) setSaving(false);}
  }

  function save() {
    if (!draft || conflict || active) return;
    if (
      !/^\d+$/.test(draft.retention) || Number(draft.retention) < 1 || Number(draft.retention) > 36500
      || !/^\d+$/.test(draft.hour) || Number(draft.hour) > 23
    ) {
      setError("自动保留期须为 1 至 36500 天，每日小时须为 0 至 23 的整数"); return;
    }
    if (draft.enabled && !authorized) return;
    void perform(() => collectorApi.saveStoragePolicy({
      retention_days: Number(draft.retention), update_hour: Number(draft.hour),
      check_mode: draft.checkMode, enabled: draft.enabled,
      authorize_delete: draft.enabled && authorized, expected_revision: draft.revision,
    }));
  }

  return <dialog ref={dialog} aria-labelledby="storage-management-title"
    onCancel={event => {event.preventDefault(); if (!busy) onClose();}}
    className="m-auto max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50">
    <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
      <div><h2 id="storage-management-title" className="font-semibold">存储管理</h2>
        <p className="mt-1 text-xs text-slate-600">全局保留策略与中间文件释放；不删除仓库数据，不取消数据需求。</p></div>
      <button type="button" aria-label="关闭存储管理" disabled={busy} onClick={onClose}
        className="rounded p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"><X className="h-4 w-4" /></button>
    </div>
    <div className="space-y-5 p-5 text-sm">
      <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
        打开此窗口只读取策略与历史，不扫描文件。自动释放只处理日线、每日指标、复权因子中，已发布且具有来源全字段保留证明、仓库写后回读校验记录的文件。
        旧来源、未入仓数据、其他接口和交易日历等规划依赖不会自动删除。保留期按归档观察时间计算，不按交易日期。
      </p>
      {loadError && <p role="alert" className="text-rose-800">{loadError}
        <button type="button" onClick={() => void load()} className="ml-3 underline">重新读取策略</button></p>}
      {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-rose-800">{error}</p>}
      {!policy && !loadError && <p className="text-slate-500">正在读取存储策略…</p>}
      {policy && draft && <section aria-label="自动存储策略" className="space-y-4 rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-semibold">按策略安全释放</h3>
            <p className="mt-1 text-xs text-slate-600">
              {policy.enabled ? policy.last_error ? "自动释放已遇阻，后续执行已停止" : "自动释放已授权" : "自动释放未启用"}
              {policy.enabled && !policy.last_error && policy.next_attempt_at && <> · 下次检查 {formatDateTime(policy.next_attempt_at)}</>}
            </p></div>
          {(policy.enabled || active) && <button type="button" disabled={busy}
            onClick={() => void perform(() => collectorApi.pauseStoragePolicy(policy.revision))}
            className="rounded border border-amber-300 px-3 py-2 text-xs text-amber-900 disabled:opacity-50">暂停自动释放</button>}
        </div>
        {policy.last_error && <p role="alert" className="rounded bg-rose-50 p-3 text-xs text-rose-800">{policy.last_error}。请核查；重新启用须再次授权。未完成的旧批次可在下方手动检查后确认重试。</p>}
        {conflict && <p role="alert" className="text-xs text-amber-900">其他窗口已修改策略，当前表单不可提交。
          <button type="button" disabled={busy} onClick={() => {setDraft(draftFor(policy)); setAuthorized(false);}}
            className="ml-2 underline">载入最新策略</button></p>}
        <fieldset disabled={busy || active || Boolean(conflict)} className="space-y-4 disabled:opacity-60">
          <div className="flex flex-wrap gap-4">
            <label className="text-xs">保留最近
              <input aria-label="自动释放保留天数" type="number" min={1} max={36500} value={draft.retention}
                onChange={event => {setDraft({...draft, retention: event.target.value}); setAuthorized(false);}}
                className="mx-2 w-24 rounded border border-slate-300 p-2" />天归档
            </label>
            <label className="text-xs">每日检查（北京时间）
              <input aria-label="自动释放每日小时" type="number" min={0} max={23} value={draft.hour}
                onChange={event => {setDraft({...draft, hour: event.target.value}); setAuthorized(false);}}
                className="mx-2 w-20 rounded border border-slate-300 p-2" />时
            </label>
            <label className="text-xs">检查方式
              <select aria-label="自动释放检查方式" value={draft.checkMode}
                onChange={event => {setDraft({...draft, checkMode: event.target.value === "deep" ? "deep" : "fast"}); setAuthorized(false);}}
                className="ml-2 rounded border border-slate-300 p-2">
                <option value="fast">快速检查（默认）</option><option value="deep">深度检查（较慢）</option>
              </select>
            </label>
          </div>
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={draft.enabled}
            onChange={event => {setDraft({...draft, enabled: event.target.checked}); setAuthorized(false);}} />
            启用自动释放（首次立即尝试，以后每日检查；仅在服务运行且采集空闲时执行）</label>
          {draft.enabled && <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
            <input aria-label="授权自动释放中间文件" type="checkbox" checked={authorized}
              onChange={event => setAuthorized(event.target.checked)} />
            我授权按上述保留期和检查方式永久释放符合安全条件的中间文件。此操作不可撤销；服务重启后仍有效。
            快速检查不重新计算数据文件哈希，不能发现所有内容损坏。
          </label>}
          <button type="button" disabled={draft.enabled && !authorized} onClick={save}
            className="rounded bg-teal-700 px-4 py-2 text-xs font-medium text-white disabled:opacity-50">
            {saving ? "正在保存…" : draft.enabled ? "保存并授权自动释放" : "仅保存策略（不自动删除）"}
          </button>
        </fieldset>
        <p className="text-xs leading-relaxed text-slate-600">
          每批最多检查 {policy.batch_size} 个来源；批次之间优先执行采集。暂停在当前小批次结束后阻止后续释放。
          重启只恢复仍启用且版本一致的已登记批次；失败停止，不自动接管旧手动清理。目录或字段改变须重新授权。
        </p>
      </section>}
      {!!policy?.jobs.length && <section aria-label="存储策略执行记录" className="space-y-3">
        <h3 className="font-semibold">最近执行记录</h3>
        {policy.jobs.map(job => <details key={job.id} open={job.state === "running" || job.state === "blocked"}
          className="rounded-lg border border-slate-200 p-3 text-xs">
          <summary className="cursor-pointer">
            {LABELS[job.state]} · 确认完成 {formatNumber(job.steps.reduce((total, step) => total + step.deleted + (step.batch?.partial_deleted ?? 0), 0))} 个切片
            <span className="ml-3 text-slate-500">{formatDateTime(job.created_at)} · 策略版本 {job.policy_revision}</span>
          </summary>
          {job.error && <p className="mt-2 text-rose-800">{job.error}</p>}
          <ul className="mt-3 space-y-2">{job.steps.map(step => <li key={step.dataset_id}>
            {LABELS[step.dataset_id] || step.dataset_id} · {LABELS[step.state]} · 已完成 {formatNumber(step.deleted + (step.batch?.partial_deleted ?? 0))} 个切片
            · 跳过 {formatNumber(step.skipped)} 个来源
            {step.reason && <p className="mt-1 text-slate-600">保留 / 跳过原因样例：{step.reason}</p>}
          </li>)}</ul>
        </details>)}
      </section>}
      {active && <p className="text-xs text-amber-900">策略作业进行时不同时提交手动清理；需要手动处理时请先暂停自动释放。</p>}
      <fieldset disabled={saving || active}>
        <GlobalWarehouseCleanupPanel onBusyChange={setManualBusy} />
      </fieldset>
    </div>
  </dialog>;
}

export function StorageManagement() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-100">
      <HardDrive className="h-4 w-4" />存储管理
    </button>
    {open && createPortal(<StorageDialog onClose={() => setOpen(false)} />, document.body)}
  </>;
}
