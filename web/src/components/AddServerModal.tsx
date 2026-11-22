import React, { useEffect, useState } from 'react';
import { Check, Loader2, Plus, Radio, Server, Wifi, X } from 'lucide-react';
import { api } from '../api';
import type { ServerConfig, TailscalePeer } from '../types';

interface AddServerModalProps {
  existingServers: ServerConfig[];
  onClose: () => void;
  onAdded: () => void;
}

export const AddServerModal: React.FC<AddServerModalProps> = ({
  existingServers,
  onClose,
  onAdded,
}) => {
  const [tab, setTab] = useState<'tailscale' | 'manual'>('tailscale');
  const [peers, setPeers] = useState<TailscalePeer[]>([]);
  const [peerSource, setPeerSource] = useState('');
  const [loadingPeers, setLoadingPeers] = useState(true);
  const [managerKey, setManagerKey] = useState('');

  const [form, setForm] = useState({
    name: '',
    role: 'Linux 服务器',
    notes: '',
    host: '',
    port: 22,
    username: 'root',
    useSudo: false,
    publicIp: '',
    tailscaleIp: '',
    jumpServerId: '',
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .discoverTailscale()
      .then((res) => {
        setPeers(res.peers);
        setPeerSource(res.source);
      })
      .finally(() => setLoadingPeers(false));
    api.getManagerKey().then((res) => setManagerKey(res.publicKey)).catch(() => {});
  }, []);

  const pickPeer = (peer: TailscalePeer) => {
    // If local control plane doesn't have Tailscale running, default jump host to the source server
    const defaultJump = existingServers.find((s) => s.name === peerSource && s.mode === 'ssh');
    setForm({
      name: peer.hostName,
      role: 'Tailscale 受管节点',
      notes: `通过 Tailscale (${peer.dnsName || peer.tailscaleIp}) 接入`,
      host: peer.tailscaleIp,
      port: 22,
      username: 'root',
      useSudo: false,
      publicIp: '',
      tailscaleIp: peer.tailscaleIp,
      jumpServerId: defaultJump?.id || '',
    });
    setTab('manual');
    setTestResult(null);
  };

  const buildPayload = () => {
    const jumpServer = existingServers.find((s) => s.id === form.jumpServerId);
    return {
      name: form.name.trim(),
      role: form.role.trim(),
      notes: form.notes.trim(),
      mode: 'ssh' as const,
      host: form.host.trim(),
      port: Number(form.port) || 22,
      username: form.username.trim() || 'root',
      useSudo: form.useSudo,
      publicIp: form.publicIp.trim() || undefined,
      tailscaleIp: form.tailscaleIp.trim() || undefined,
      jumpHost: jumpServer
        ? { host: jumpServer.host, port: jumpServer.port, username: jumpServer.username }
        : undefined,
    };
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testServer(buildPayload());
      if (res.ok) {
        setTestResult({ ok: true, msg: `连接成功 · ${res.hostname} (${res.os})` });
      } else {
        setTestResult({ ok: false, msg: res.error || 'SSH 连接失败' });
      }
    } catch (err) {
      setTestResult({ ok: false, msg: err instanceof Error ? err.message : '测试失败' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.createServer(buildPayload());
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="bg-[#0f131b] border border-white/10 rounded-2xl w-full max-w-xl max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-white/[0.06] flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-white">添加或发现服务器</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="px-4 sm:px-6 pt-3.5 sm:pt-4 flex flex-wrap gap-2 shrink-0">
          <button
            onClick={() => setTab('tailscale')}
            className={`flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-lg border transition-colors cursor-pointer ${
              tab === 'tailscale'
                ? 'bg-sky-500/15 border-sky-400/35 text-sky-300'
                : 'bg-white/[0.02] border-white/[0.07] text-slate-400 hover:text-white'
            }`}
          >
            <Wifi className="w-3.5 h-3.5" />
            <span>Tailscale 节点发现</span>
          </button>
          <button
            onClick={() => setTab('manual')}
            className={`flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-lg border transition-colors cursor-pointer ${
              tab === 'manual'
                ? 'bg-sky-500/15 border-sky-400/35 text-sky-300'
                : 'bg-white/[0.02] border-white/[0.07] text-slate-400 hover:text-white'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>手动 SSH 接入</span>
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1">
          {tab === 'tailscale' ? (
            <div className="space-y-3">
              <div className="text-xs text-slate-400">
                {peerSource && peerSource !== 'none'
                  ? `已通过节点 ${peerSource} 扫描 Tailscale 组网设备：`
                  : '未检测到在线的 Tailscale 客户端，可切换至手动 SSH 接入。'}
              </div>

              {loadingPeers ? (
                <div className="flex items-center justify-center py-10 text-xs text-slate-400 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在扫描 Tailscale 节点...</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {peers.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-2 bg-[#090b10] border border-white/[0.07] rounded-xl px-3.5 sm:px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full ${
                              p.online ? 'bg-emerald-400' : 'bg-slate-600'
                            }`}
                          />
                          <span className="text-xs font-semibold text-white">{p.hostName}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400">
                            {p.os}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-sky-300/90 mt-1 flex items-center gap-1.5">
                          <Radio className="w-3 h-3" />
                          <span>{p.tailscaleIp}</span>
                        </div>
                      </div>

                      {p.alreadyAdded ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                          <Check className="w-3.5 h-3.5" />
                          已纳管
                        </span>
                      ) : p.os === 'linux' ? (
                        <button
                          onClick={() => pickPeer(p)}
                          className="inline-flex items-center gap-1 text-xs bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 text-sky-300 px-3 py-1.5 rounded-lg cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>导入配置</span>
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-500">客户端设备</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">服务器名称 *</label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="如 jp-edge"
                    className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">定位 / 用途</label>
                  <input
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                    placeholder="如 日本边缘代理"
                    className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-12 gap-3">
                <div className="col-span-2 sm:col-span-6">
                  <label className="block text-slate-400 mb-1">SSH 主机地址 *</label>
                  <input
                    required
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder="IP 或 Tailscale IP"
                    className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white font-mono focus:border-sky-400 focus:outline-none"
                  />
                </div>
                <div className="col-span-1 sm:col-span-3">
                  <label className="block text-slate-400 mb-1">用户名</label>
                  <input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white font-mono focus:border-sky-400 focus:outline-none"
                  />
                </div>
                <div className="col-span-1 sm:col-span-3">
                  <label className="block text-slate-400 mb-1">端口</label>
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                    className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white font-mono focus:border-sky-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">公网 IP（展示用，可选）</label>
                  <input
                    value={form.publicIp}
                    onChange={(e) => setForm({ ...form, publicIp: e.target.value })}
                    className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white font-mono focus:border-sky-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">通过已有节点跳板 (ProxyJump)</label>
                  <select
                    value={form.jumpServerId}
                    onChange={(e) => setForm({ ...form, jumpServerId: e.target.value })}
                    className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                  >
                    <option value="">直连（不使用跳板）</option>
                    {existingServers
                      .filter((s) => s.mode === 'ssh')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          经由 {s.name} ({s.host})
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.useSudo}
                  onChange={(e) => setForm({ ...form, useSudo: e.target.checked })}
                  className="rounded accent-sky-500"
                />
                <span>非 root 用户，自动使用 sudo -n 执行特权操作（防火墙/文件/NodeQuality）</span>
              </label>

              {managerKey && (
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3 space-y-1">
                  <div className="text-[11px] text-slate-400">
                    如新服务器尚未信任当前管控机，请在目标机器执行：
                  </div>
                  <code className="block text-[10px] text-sky-300 break-all select-all">
                    mkdir -p ~/.ssh && echo &apos;{managerKey}&apos; &gt;&gt; ~/.ssh/authorized_keys
                  </code>
                </div>
              )}

              {testResult && (
                <div
                  className={`rounded-lg px-3 py-2 border text-xs ${
                    testResult.ok
                      ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
                  }`}
                >
                  {testResult.msg}
                </div>
              )}

              {error && (
                <div className="rounded-lg px-3 py-2 border bg-rose-500/10 border-rose-500/25 text-rose-300">
                  {error}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing || !form.host.trim()}
                  className="px-3.5 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-slate-200 cursor-pointer disabled:opacity-50"
                >
                  {testing ? '测试连接中...' : '测试 SSH 连接'}
                </button>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-3.5 py-2 rounded-lg text-slate-400 hover:text-white cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer"
                  >
                    {saving ? '保存中...' : '添加服务器'}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
