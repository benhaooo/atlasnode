import React, { useEffect, useState } from 'react';
import {
  Check,
  Clock,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { ServerSnapshot, SshSecurityInfo } from '../types';
import { copyToClipboard } from '../utils';
import { KeysSkeleton } from './Skeleton';

interface KeysTabProps {
  snapshot: ServerSnapshot;
}

export const KeysTab: React.FC<KeysTabProps> = ({ snapshot }) => {
  const [info, setInfo] = useState<SshSecurityInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [syncAllOnAdd, setSyncAllOnAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [syncingIdx, setSyncingIdx] = useState<number | null>(null);
  const [syncReport, setSyncReport] = useState<
    { serverId: string; serverName: string; status: 'added' | 'exists' | 'error'; message?: string }[] | null
  >(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getKeys(snapshot.server.id);
      setInfo(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 SSH 公钥失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setInfo(null);
    setLoading(true);
    setSyncReport(null);
    load();
  }, [snapshot.server.id]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    setBusy(true);
    setError('');
    setSyncReport(null);
    try {
      if (syncAllOnAdd) {
        const res = await api.syncKeyAll(newKey);
        setSyncReport(res.results);
      } else {
        await api.addKey(snapshot.server.id, newKey);
      }
      setNewKey('');
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加公钥失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSyncKeyToAll = async (idx: number, rawLine: string) => {
    setSyncingIdx(idx);
    setError('');
    setSyncReport(null);
    try {
      const res = await api.syncKeyAll(rawLine);
      setSyncReport(res.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : '全节点同步失败');
    } finally {
      setSyncingIdx(null);
    }
  };

  const handleDelete = async (index: number, comment: string) => {
    if (!confirm(`确认移除公钥 "${comment || `#${index}`}"？`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteKey(snapshot.server.id, index);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除公钥失败');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (idx: number, raw: string) => {
    await copyToClipboard(raw);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  if (loading && !info) {
    return <KeysSkeleton />;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      {/* Primary (7 cols): Authorized Keys List */}
      <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-sky-400" />
              已授权 SSH 公钥 ({info?.keys.length || 0})
            </h2>
            <div className="text-[11px] font-mono text-slate-500 mt-0.5">
              {info?.targetFile || '~/.ssh/authorized_keys'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAdding(!adding)}
              className="flex items-center gap-1 text-xs bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold px-3 py-1.5 rounded-xl cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加公钥</span>
            </button>
            <button
              onClick={load}
              className="p-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
            </button>
          </div>
        </div>

        {error && (
          <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-3.5 py-2.5">
            {error}
          </div>
        )}

        {syncReport && (
          <div className="bg-sky-500/[0.07] border border-sky-400/25 rounded-xl px-3.5 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-semibold text-sky-200">
              <span>全节点 SSH 公钥同步结果</span>
              <button onClick={() => setSyncReport(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {syncReport.map((r) => (
                <span
                  key={r.serverId}
                  title={r.message || ''}
                  className={`text-[11px] font-mono px-2 py-0.5 rounded-md border ${
                    r.status === 'added'
                      ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                      : r.status === 'exists'
                        ? 'bg-white/[0.05] border-white/10 text-slate-300'
                        : 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                  }`}
                >
                  {r.serverName}: {r.status === 'added' ? '已添加' : r.status === 'exists' ? '已存在' : '失败'}
                </span>
              ))}
            </div>
          </div>
        )}

        {adding && (
          <form
            onSubmit={handleAdd}
            className="bg-[#090b10] border border-white/10 rounded-xl p-4 space-y-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-200">粘贴 OpenSSH 公钥</span>
              <button type="button" onClick={() => setAdding(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <textarea
              required
              rows={3}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... user@host"
              className="w-full bg-[#0f131b] border border-white/10 rounded-lg p-3 font-mono text-[11px] text-white placeholder:text-slate-600 focus:border-sky-400 focus:outline-none resize-none"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={syncAllOnAdd}
                  onChange={(e) => setSyncAllOnAdd(e.target.checked)}
                  className="accent-sky-500 cursor-pointer"
                />
                <span>同时同步到所有已纳管服务器</span>
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="px-3 py-1.5 text-slate-400 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-1.5 rounded-lg bg-sky-500 text-slate-950 font-semibold cursor-pointer"
                >
                  {busy ? '写入中...' : syncAllOnAdd ? '同步到全部节点' : '添加到服务器'}
                </button>
              </div>
            </div>
          </form>
        )}

        <div className="space-y-2.5">
          {info?.keys.map((k) => (
            <div
              key={k.index}
              className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5 flex items-start justify-between gap-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-white">
                    {k.comment || '(无备注公钥)'}
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-300">
                    {k.type.replace('ssh-', '').toUpperCase()}
                  </span>
                  {k.isManagerKey && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-400/25 text-sky-300">
                      AtlasNode 管理密钥 · 受保护
                    </span>
                  )}
                </div>
                {k.fingerprint && (
                  <div className="text-[11px] font-mono text-slate-400 truncate">
                    {k.fingerprint}
                  </div>
                )}
                <div className="text-[10px] font-mono text-slate-600 truncate max-w-md">
                  {k.key.slice(0, 28)}...{k.key.slice(-14)}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => handleSyncKeyToAll(k.index, k.rawLine)}
                  disabled={syncingIdx !== null}
                  title="一键同步该公钥到全部已纳管服务器"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] bg-white/[0.04] hover:bg-sky-500/15 border border-white/[0.07] hover:border-sky-400/30 text-slate-300 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                >
                  {syncingIdx === k.index ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Globe className="w-3 h-3" />
                  )}
                  <span>同步全节点</span>
                </button>
                <button
                  onClick={() => handleCopy(k.index, k.rawLine)}
                  title="复制完整公钥"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] cursor-pointer"
                >
                  {copiedIdx === k.index ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
                {!k.isManagerKey && (
                  <button
                    onClick={() => handleDelete(k.index, k.comment)}
                    disabled={busy}
                    title="移除该公钥"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Secondary (5 cols): SSHD Security Posture & Recent Logins */}
      <div className="lg:col-span-5 space-y-5">
        <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-emerald-400" />
            SSHD 安全策略
          </h3>
          {info && (
            <div className="grid grid-cols-2 gap-2.5 text-xs">
              {[
                { label: 'SSH 端口', val: info.sshdConfig.port, ok: true },
                {
                  label: '密码登录',
                  val: info.sshdConfig.passwordAuthentication,
                  ok: info.sshdConfig.passwordAuthentication === 'no',
                },
                {
                  label: 'Root 登录',
                  val: info.sshdConfig.permitRootLogin,
                  ok: info.sshdConfig.permitRootLogin !== 'yes',
                },
                {
                  label: '公钥认证',
                  val: info.sshdConfig.pubkeyAuthentication,
                  ok: info.sshdConfig.pubkeyAuthentication === 'yes',
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3"
                >
                  <div className="text-[10px] text-slate-500">{item.label}</div>
                  <div
                    className={`font-mono font-semibold mt-1 ${
                      item.val === 'unknown'
                        ? 'text-slate-400'
                        : item.ok
                          ? 'text-emerald-300'
                          : 'text-amber-300'
                    }`}
                  >
                    {item.val}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            最近登录记录
          </h3>
          <div className="space-y-1.5 font-mono text-[11px] text-slate-400">
            {(info?.recentLogins || []).map((line, i) => (
              <div
                key={i}
                className="bg-[#090b10] border border-white/[0.04] rounded-lg px-3 py-1.5 truncate"
                title={line}
              >
                {line}
              </div>
            ))}
            {(!info?.recentLogins || info.recentLogins.length === 0) && (
              <div className="text-slate-500 text-xs">暂无登录历史</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
