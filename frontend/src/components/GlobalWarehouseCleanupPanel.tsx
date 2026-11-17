import { useEffect, useState } from "react";
import { collectorApi } from "../lib/api";
import { formatNumber } from "../lib/helpers";
import type { GlobalWarehouseCleanupPreview, GlobalWarehouseCleanupResult, WarehouseCleanupCheckMode } from "../types";

export function GlobalWarehouseCleanupPanel({onBusyChange}: {onBusyChange?: (busy: boolean) => void}) {
  const [retention, setRetention] = useState("0");
  const [checkMode, setCheckMode] = useState<WarehouseCleanupCheckMode>("fast");
  const [preview, setPreview] = useState<GlobalWarehouseCleanupPreview | null>(null);
  const [result, setResult] = useState<GlobalWarehouseCleanupResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {onBusyChange?.(busy);}, [busy, onBusyChange]);

  async function check() {
    if (busy) return;
    setError(null); setResult(null); setPreview(null); setConfirmed(false);
    if (!/^\d+$/.test(retention) || Number(retention) > 36500) {
      setError("保留天数须为 0 至 36500 的整数"); return;
    }
    setBusy(true);
    try { setPreview(await collectorApi.previewGlobalWarehouseCleanup(Number(retention), checkMode)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "全局检查失败"); }
    finally { setBusy(false); }
  }

  async function clean() {
    if (busy || !preview || !confirmed) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const value = await collectorApi.cleanupGlobalWarehouseRaw({
        retention_days: preview.retention_days, fingerprint: preview.fingerprint,
        check_mode: preview.check_mode,
      });
      setResult(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "全局清理未完成，请重新检查");
    } finally { setBusy(false); setConfirmed(false); setPreview(null); }
  }

  return <details className="rounded-xl border border-slate-300 bg-white p-4 text-xs">
    <summary className="cursor-pointer text-sm font-semibold text-slate-900">手动释放中间文件（全部接口）</summary>
    <div className="mt-3 space-y-3">
      <p className="text-slate-600">一次检查全部已适配接口，汇总已入仓 Raw 后统一确认清理，不需要逐个接口操作。未建仓、未入仓、采集依赖和无法安全核验的内容会跳过并说明原因。默认快速检查登记、路径、文件属性与仓库页脚，不重算 Raw 和仓库数据文件哈希；深度检查可能需要数分钟。</p>
      <p className="text-amber-900">永久删除不可撤销，仓库未保留的 Raw 字段将丢失。保留仓库、来源登记与清理记录，不自动补采。执行按接口顺序进行，并非全有或全无；部分失败可重新检查，统一重试此前未完成的清理。</p>
      <div className="flex flex-wrap items-center gap-3">
        <label>检查模式
          <select aria-label="全局 Raw 清理检查模式" value={checkMode} disabled={busy}
            onChange={event => {setCheckMode(event.target.value === "deep" ? "deep" : "fast"); setPreview(null); setConfirmed(false); setResult(null);}}
            className="ml-2 rounded border border-slate-300 p-2">
            <option value="fast">快速检查（默认）</option>
            <option value="deep">深度检查（重新计算数据文件哈希，较慢）</option>
          </select>
        </label>
        <label>保留最近
          <input aria-label="全局 Raw 保留天数" type="number" min="0" max="36500" value={retention} disabled={busy}
            onChange={event => {setRetention(event.target.value); setPreview(null); setConfirmed(false); setResult(null);}}
            className="mx-2 w-24 rounded border border-slate-300 p-2" />
          天归档（按归档时间，0 表示不额外保留）
        </label>
        <button type="button" disabled={busy} onClick={check} className="rounded border border-slate-300 px-3 py-2 disabled:opacity-50">
          {busy ? "正在校验和处理，请稍候…" : "检查全部接口可清理范围"}
        </button>
      </div>
      {preview && <div className="space-y-3 rounded bg-slate-50 p-3">
        <p className="font-semibold">预计可清理 {formatNumber(preview.count)} 个切片 · {formatNumber(preview.files)} 个文件 · 约 {(preview.bytes / 1024 / 1024).toFixed(2)} MiB；另有 {preview.pending} 批此前未完成的清理</p>
        <p className="text-slate-600">本次{preview.check_mode === "deep" ? "深度" : "快速"}检查不代表入仓内容正确性认证。快速预览不读取 Raw 内容，执行前另行核验元数据。未完成批次沿用其原始快照、保留期与检查模式，不会自动降级校验。</p>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left">
            <thead><tr><th className="p-2">接口</th><th className="p-2">可清理切片 / 文件</th><th className="p-2">空间</th><th className="p-2">保留 / 排除 / 重试</th></tr></thead>
            <tbody>{preview.datasets.map(item => <tr key={item.dataset_id} className="border-t border-slate-200">
              <td className="p-2">{item.name}<code className="ml-2">{item.dataset_id}</code></td>
              <td className="p-2">{formatNumber(item.count)} / {formatNumber(item.files)}</td>
              <td className="p-2">{(item.bytes / 1024 / 1024).toFixed(2)} MiB</td>
              <td className="p-2">{formatNumber(item.excluded_count ?? 0)} 项保留 / 排除；{item.pending_cleanups?.length ?? 0} 批重试
                {item.pending_cleanups?.map(pending => <p key={pending.fingerprint}>待重试 {pending.remaining} 个切片 · 原{pending.check_mode === "fast" ? "快速" : "深度"}检查</p>)}
                {!!item.excluded_count && <details><summary className="cursor-pointer">查看原因</summary>
                  {item.excluded?.slice(0, 5).map((excluded, index) => <p key={index}>{excluded.reason}</p>)}
                </details>}
                {!!item.count && <details><summary className="cursor-pointer">查看文件样例</summary>
                  {item.candidates.slice(0, 5).flatMap(candidate => candidate.files.map(file => <p key={file.path} className="break-all font-mono">{file.path}</p>))}
                  <p>仅展示前 5 个切片；确认范围为上方全部计数。</p>
                </details>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>
        <details><summary className="cursor-pointer">跳过 {preview.skipped.length} 个接口及原因</summary>
          <ul className="mt-2 max-h-56 space-y-1 overflow-auto">{preview.skipped.map(item => <li key={item.dataset_id}><code>{item.dataset_id}</code> · {item.name}：{item.reason}</li>)}</ul>
        </details>
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy || (!preview.count && !preview.pending)}
          onChange={event => setConfirmed(event.target.checked)} />
          我确认永久清理上述所有接口的候选 Raw，并重试列出的未完成清理，理解原始响应及未入仓字段无法恢复。
        </label>
        <button type="button" disabled={busy || !confirmed || (!preview.count && !preview.pending)} onClick={clean}
          className="rounded bg-rose-700 px-3 py-2 font-semibold text-white disabled:opacity-50">确认全局清理已入仓 Raw</button>
      </div>}
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      {result && <div role={result.state === "deleted" ? "status" : "alert"} className={result.state === "deleted" ? "text-teal-800" : "text-rose-700"}>
        <p>{result.state === "deleted" ? "全局清理完成" : "全局清理部分失败，请重新检查后重试"}：确认范围中已完成 {formatNumber(result.deleted)} 个切片。</p>
        {result.results.filter(item => item.state !== "deleted").map((item, index) => <p key={`${item.dataset_id}:${index}`}>{item.name}（{item.dataset_id}）：{item.error || item.failures?.map(failure => failure.error).join("；")}</p>)}
      </div>}
    </div>
  </details>;
}
