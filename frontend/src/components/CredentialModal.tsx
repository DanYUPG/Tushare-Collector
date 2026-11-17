import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { collectorApi } from "../lib/api";
import type { CredentialResult } from "../types";
import { WorkspaceDrawer } from "./WorkspaceLayout";

interface CredentialModalProps {
  open: boolean;
  tokenConfigured: boolean;
  tokenPersisted: boolean;
  credentialFile?: string;
  onClose: () => void;
  onSaved: (result: CredentialResult) => void;
}

export function CredentialModal({
  open,
  tokenConfigured,
  tokenPersisted,
  credentialFile,
  onClose,
  onSaved,
}: CredentialModalProps) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const rememberEdited = useRef(false);

  useEffect(() => {
    setToken("");
    setError(null);
    rememberEdited.current = false;
  }, [open]);

  useEffect(() => {
    if (!rememberEdited.current) setRemember(open && tokenPersisted);
  }, [open, tokenPersisted]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError("请输入有效的 Tushare Pro Token");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await collectorApi.setCredential(token.trim(), remember);
      setToken("");
      onSaved(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存凭证失败");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await collectorApi.clearCredential();
      setToken("");
      onSaved(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清除凭证失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkspaceDrawer open={open} title="配置 Tushare 访问凭证" busy={saving} onClose={onClose}
      description={`当前状态：${tokenConfigured ? "凭证已就绪" : "尚未设置"}；${tokenPersisted ? "本机已保存（明文）" : "未保存本地凭证"}`}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div role="note" aria-label="Token 明文存储风险"
            className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 leading-relaxed flex items-start gap-2.5 ring-1 ring-inset ring-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">明文保存风险</p>
              <p>记住 Token 会将其保存为未加密的本机文件，重启自动加载。任何能读取该文件的人或程序都能直接获得 Token；
                同一账户下的恶意程序、管理员，以及备份或云同步副本均可能造成泄漏。</p>
              <p>600 权限仅限制访问，.gitignore 仅减少误提交，都不等于加密。请勿分享凭证文件或整个个人数据目录。
                如有顾虑，请不勾选“记住 Token”，仅在当前进程使用。</p>
            </div>
          </div>
          {credentialFile && <p className="break-all text-xs text-slate-500">
            本地凭证位置：<code className="font-mono">{credentialFile}</code>
          </p>}

          <div>
            <label htmlFor="tushare-token-input" className="block text-xs font-medium text-slate-700 mb-1.5">
              Tushare Pro Token
            </label>
            <input
              id="tushare-token-input"
              type="password"
              autoComplete="off"
              maxLength={512}
              disabled={saving}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="粘贴您的 Tushare Token…"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
            />
          </div>

          <label className="flex items-start gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={remember} disabled={saving}
              onChange={event => {
                rememberEdited.current = true;
                setRemember(event.target.checked);
              }} />
            记住 Token（接受本机明文保存风险）
          </label>
          <p className="text-xs leading-relaxed text-slate-500">
            不勾选时，提交新 Token 将删除之前保存的本地凭证，仅本次进程有效。
            启动环境变量 TUSHARE_TOKEN 优先于本地文件；清除后如仍配置该变量，重启会再次加载。
          </p>

          {error && (
            <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {(tokenConfigured || tokenPersisted) && <button type="button" disabled={saving}
              onClick={() => void handleClear()}
              className="mr-auto rounded-lg px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">
              清除本机凭证
            </button>}
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-medium text-white shadow-sm hover:bg-teal-700 disabled:opacity-50"
            >
              {saving ? "处理中…" : remember ? "保存并记住 Token" : "仅本次使用"}
            </button>
          </div>
        </form>
        {(tokenConfigured || tokenPersisted) && <p className="text-xs text-slate-500">
          清除会移除本地凭证文件并清空当前进程凭证，不删除数据，也不会撤回已发出的请求。
        </p>}
    </WorkspaceDrawer>
  );
}
