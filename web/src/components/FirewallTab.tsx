import React, { useEffect, useState } from 'react';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Globe,
  Lock,
  Plus,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { FirewallData, ServerSnapshot } from '../types';

interface FirewallTabProps {
  snapshot: ServerSnapshot;
  onRefreshSnapshot: () => void;
}

export const FirewallTab: React.FC<FirewallTabProps> = ({ snapshot, onRefreshSnapshot }) => {
  const [data, setData] = useState<FirewallData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showLocalPorts, setShowLocalPorts] = useState(false);
  const [showRawIptables, setShowRawIptables] = useState(false);
  const [addingRule, setAddingRule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    port: '',
    proto: 'tcp' as 'tcp' | 'udp' | 'any',
    action: 'allow' as 'allow' | 'deny' | 'limit',
    from: 'any',
    comment: '',
  });
  const [addingNftRule, setAddingNftRule] = useState(false);
  const [nftForm, setNftForm] = useState({
    port: '',
    proto: 'tcp' as 'tcp' | 'udp',
    comment: '',
  });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getFirewall(snapshot.server.id);
      setData(res.firewall);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载防火墙信息失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    setLoading(true);
    load();
  }, [snapshot.server.id]);

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.addUfwRule(snapshot.server.id, ruleForm);
      setRuleForm({ port: '', proto: 'tcp', action: 'allow', from: 'any', comment: '' });
      setAddingRule(false);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加规则失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteRule = async (num: number, to: string) => {
    if (!confirm(`确认删除 UFW 规则 #${num} (${to})？`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteUfwRule(snapshot.server.id, num);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除规则失败');
    } finally {
      setBusy(false);
    }
  };

  const handleToggleUfw = async () => {
    if (!data) return;
    const enable = !data.active;
    const msg = enable
      ? '确认启用 UFW 防火墙？系统会自动先放行 22/tcp (SSH) 防止失联。'
      : '确认关闭 UFW 防火墙？这会放开宿主机本机规则。';
    if (!confirm(msg)) return;
    setBusy(true);
    setError('');
    try {
      await api.toggleUfw(snapshot.server.id, enable);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const handleAddNftRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data?.nftTarget) return;
    setBusy(true);
    setError('');
    try {
      await api.addNftRule(snapshot.server.id, {
        table: data.nftTarget.table,
        chain: data.nftTarget.chain,
        port: nftForm.port.trim(),
        proto: nftForm.proto,
        comment: nftForm.comment.trim() || undefined,
      });
      setNftForm({ port: '', proto: 'tcp', comment: '' });
      setAddingNftRule(false);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加 nftables 规则失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteNftRule = async (table: string, chain: string, handle: number, label: string) => {
    if (!confirm(`确认删除 nftables 规则 #${handle} (${label})？`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteNftRule(snapshot.server.id, { table, chain, handle });
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除 nftables 规则失败');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return <div className="h-64 rounded-2xl bg-[#0f131b] border border-white/[0.06] animate-pulse" />;
  }

  const publicPorts = data?.listeningPorts.filter((p) => p.scope === 'public') || [];
  const tailscalePorts = data?.listeningPorts.filter((p) => p.scope === 'tailscale') || [];
  const privatePorts = data?.listeningPorts.filter((p) => p.scope === 'private') || [];
  const localPorts = data?.listeningPorts.filter((p) => p.scope === 'local') || [];

  return (
    <div className="space-y-5">
      {/* TIER 1: Security Posture Banner */}
      <section
        className={`rounded-2xl p-5 border flex flex-col md:flex-row md:items-center justify-between gap-4 ${
          data?.active
            ? 'bg-emerald-500/[0.05] border-emerald-500/25'
            : 'bg-amber-500/[0.06] border-amber-400/25'
        }`}
      >
        <div className="flex items-start gap-3.5">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              data?.active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'
            }`}
          >
            {data?.active ? <ShieldCheck className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-sm font-semibold text-white">
                防火墙引擎: {(data?.engine || 'iptables').toUpperCase()}
              </h2>
              <span
                className={`text-[11px] font-mono px-2 py-0.5 rounded-full border ${
                  data?.active
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                    : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                }`}
              >
                {data?.active ? '已启用' : '未启用'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              默认入站: <span className="font-mono text-slate-200">{data?.defaultIncoming}</span> · 默认出站:{' '}
              <span className="font-mono text-slate-200">{data?.defaultOutgoing}</span> · 公网监听{' '}
              <span className="font-mono text-amber-300 font-semibold">{publicPorts.length}</span> · Tailscale{' '}
              <span className="font-mono text-sky-300">{tailscalePorts.length}</span> · 仅本机{' '}
              <span className="font-mono text-slate-300">{localPorts.length}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {data?.engine === 'ufw' && (
            <button
              onClick={handleToggleUfw}
              disabled={busy}
              className={`text-xs font-medium px-3.5 py-2 rounded-xl border transition-colors cursor-pointer ${
                data.active
                  ? 'bg-white/[0.04] hover:bg-rose-500/15 border-white/10 hover:border-rose-500/30 text-slate-300 hover:text-rose-300'
                  : 'bg-emerald-500 hover:bg-emerald-400 border-transparent text-slate-950 font-semibold'
              }`}
            >
              {data.active ? '关闭 UFW' : '启用 UFW（保留 SSH）'}
            </button>
          )}
          <button
            onClick={load}
            className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
          </button>
        </div>
      </section>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* TIER 2: Exposure-First Listening Ports */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Publicly Exposed Ports (High Weight) */}
        <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              公网暴露端口 (0.0.0.0 / ::) · {publicPorts.length}
            </h3>
            <span className="text-[10px] text-slate-500">外部网络可直接触达（受云安全组与防火墙约束）</span>
          </div>

          <div className="space-y-1.5">
            {publicPorts.map((p, idx) => (
              <div
                key={`${p.proto}-${p.port}-${idx}`}
                className="flex items-center justify-between bg-[#090b10] border border-white/[0.06] rounded-xl px-3.5 py-2.5 text-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="font-mono font-semibold text-amber-300 w-16 shrink-0">
                    :{p.port}
                  </span>
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400">
                    {p.proto}
                  </span>
                  <span className="font-mono text-slate-200 truncate">
                    {p.dockerContainer ? (
                      <span className="inline-flex items-center gap-1 text-sky-300">
                        <Box className="w-3 h-3" />
                        {p.dockerContainer}
                      </span>
                    ) : (
                      p.process
                    )}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-slate-500 shrink-0">
                  {p.address} {p.pid ? `· PID ${p.pid}` : ''}
                </span>
              </div>
            ))}
            {publicPorts.length === 0 && (
              <div className="text-xs text-slate-500 py-4 text-center">无公网监听端口</div>
            )}
          </div>

          {/* Tailscale & Private Ports */}
          {(tailscalePorts.length > 0 || privatePorts.length > 0) && (
            <div className="pt-3 border-t border-white/[0.06] space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-sky-300 flex items-center gap-1.5">
                <Radio className="w-3 h-3" />
                Tailscale / 内网接口监听 ({tailscalePorts.length + privatePorts.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[...tailscalePorts, ...privatePorts].map((p, i) => (
                  <span
                    key={i}
                    className="text-[11px] font-mono bg-sky-500/[0.07] border border-sky-400/20 text-sky-200 px-2.5 py-1 rounded-lg"
                  >
                    {p.address}:{p.port} ({p.proto} · {p.process})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Localhost Ports (Low Weight, Collapsible) */}
          <div className="pt-2 border-t border-white/[0.05]">
            <button
              onClick={() => setShowLocalPorts(!showLocalPorts)}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              {showLocalPorts ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Lock className="w-3 h-3" />
              <span>仅本机回环端口 (127.0.0.1 / ::1) · {localPorts.length} 个</span>
            </button>
            {showLocalPorts && (
              <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {localPorts.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-[11px] font-mono bg-[#090b10] border border-white/[0.04] rounded-lg px-2.5 py-1.5 text-slate-400"
                  >
                    <span>
                      :{p.port}/{p.proto}
                    </span>
                    <span className="truncate max-w-[160px] text-slate-300">
                      {p.dockerContainer || p.process}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Firewall Rules Management (5 cols): supports both UFW & nftables */}
        <section className="lg:col-span-5 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3.5">
          {data?.engine === 'nftables' || (data?.nftRules && data.nftRules.length > 0 && data.engine !== 'ufw') ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Shield className="w-3.5 h-3.5 text-sky-400" />
                    nftables 入站规则 ({data?.nftRules?.length || 0})
                  </h3>
                  {data?.nftTarget && (
                    <div className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">
                      {data.nftTarget.table} · chain {data.nftTarget.chain}
                    </div>
                  )}
                </div>
                {data?.nftTarget && (
                  <button
                    onClick={() => setAddingNftRule(!addingNftRule)}
                    className="flex items-center gap-1 text-[11px] bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 text-sky-300 px-2.5 py-1 rounded-lg cursor-pointer shrink-0"
                  >
                    <Plus className="w-3 h-3" />
                    <span>放行端口</span>
                  </button>
                )}
              </div>

              {addingNftRule && data?.nftTarget && (
                <form
                  onSubmit={handleAddNftRule}
                  className="bg-[#090b10] border border-white/10 rounded-xl p-3.5 space-y-2.5 text-xs"
                >
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      required
                      placeholder="端口或区间 (8080 / 20000-20010)"
                      value={nftForm.port}
                      onChange={(e) => setNftForm({ ...nftForm, port: e.target.value })}
                      className="col-span-2 bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white font-mono focus:border-sky-400 focus:outline-none"
                    />
                    <select
                      value={nftForm.proto}
                      onChange={(e) => setNftForm({ ...nftForm, proto: e.target.value as 'tcp' | 'udp' })}
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 text-white"
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                  </div>
                  <input
                    placeholder="备注（可选，例如 my-app）"
                    value={nftForm.comment}
                    onChange={(e) => setNftForm({ ...nftForm, comment: e.target.value })}
                    className="w-full bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:border-sky-400 focus:outline-none"
                  />
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span>自动插入至链头部，并持久化到重启脚本</span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setAddingNftRule(false)}
                        className="px-2 py-1 text-slate-400 cursor-pointer"
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        disabled={busy}
                        className="px-3 py-1 rounded-lg bg-sky-500 text-slate-950 font-semibold cursor-pointer"
                      >
                        确认放行
                      </button>
                    </div>
                  </div>
                </form>
              )}

              <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
                {(data?.nftRules || []).map((r) => {
                  const isProtected =
                    r.action === 'DROP' ||
                    r.ports === '22' ||
                    r.ports === '9800' ||
                    /\bdport\s+(22|9800)\b/.test(r.raw) ||
                    /ct state|iifname "lo"/.test(r.raw);
                  const displayLabel = r.ports
                    ? `${(r.proto || 'tcp').toUpperCase()} :${r.ports}`
                    : r.raw.replace(/# handle \d+/, '').trim();
                  return (
                    <div
                      key={`${r.table}-${r.chain}-${r.handle}`}
                      className="flex items-center justify-between gap-2 bg-[#090b10] border border-white/[0.06] rounded-xl px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-mono">
                          <span className="text-[10px] text-slate-500">#{r.handle}</span>
                          <span
                            className={`text-[10px] font-semibold px-1.5 py-0.2 rounded ${
                              r.action === 'ACCEPT'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : r.action === 'DROP' || r.action === 'REJECT'
                                  ? 'bg-rose-500/15 text-rose-300'
                                  : 'bg-white/[0.06] text-slate-300'
                            }`}
                          >
                            {r.action}
                          </span>
                          <span className="text-white truncate">{displayLabel}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5 font-mono truncate">
                          {r.comment ? `${r.comment} · ` : ''}
                          {r.raw}
                        </div>
                      </div>
                      {!isProtected ? (
                        <button
                          onClick={() => handleDeleteNftRule(r.table, r.chain, r.handle, displayLabel)}
                          disabled={busy}
                          title="删除规则"
                          className="p-1.5 text-slate-500 hover:text-rose-400 cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <span
                          title="核心保护规则，禁止误删"
                          className="text-[9px] font-mono text-slate-600 px-1.5 py-0.5 rounded bg-white/[0.03] shrink-0"
                        >
                          保护
                        </span>
                      )}
                    </div>
                  );
                })}
                {(!data?.nftRules || data.nftRules.length === 0) && (
                  <div className="text-xs text-slate-500 bg-[#090b10] border border-dashed border-white/10 rounded-xl p-5 text-center">
                    未解析到 nftables 入站规则
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Shield className="w-3.5 h-3.5 text-sky-400" />
                  UFW 入站规则 ({data?.ufwRules.length || 0})
                </h3>
                {data?.engine === 'ufw' && (
                  <button
                    onClick={() => setAddingRule(!addingRule)}
                    className="flex items-center gap-1 text-[11px] bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 text-sky-300 px-2.5 py-1 rounded-lg cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>添加规则</span>
                  </button>
                )}
              </div>

              {addingRule && (
                <form
                  onSubmit={handleAddRule}
                  className="bg-[#090b10] border border-white/10 rounded-xl p-3.5 space-y-2.5 text-xs"
                >
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      required
                      placeholder="端口 (如 8080)"
                      value={ruleForm.port}
                      onChange={(e) => setRuleForm({ ...ruleForm, port: e.target.value })}
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white font-mono focus:border-sky-400 focus:outline-none"
                    />
                    <select
                      value={ruleForm.proto}
                      onChange={(e) => setRuleForm({ ...ruleForm, proto: e.target.value as any })}
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 text-white"
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                      <option value="any">TCP+UDP</option>
                    </select>
                    <select
                      value={ruleForm.action}
                      onChange={(e) => setRuleForm({ ...ruleForm, action: e.target.value as any })}
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 text-white"
                    >
                      <option value="allow">ALLOW</option>
                      <option value="deny">DENY</option>
                      <option value="limit">LIMIT</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      placeholder="来源 (any 或 CIDR)"
                      value={ruleForm.from}
                      onChange={(e) => setRuleForm({ ...ruleForm, from: e.target.value })}
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white font-mono focus:border-sky-400 focus:outline-none"
                    />
                    <input
                      placeholder="备注（可选）"
                      value={ruleForm.comment}
                      onChange={(e) => setRuleForm({ ...ruleForm, comment: e.target.value })}
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:border-sky-400 focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setAddingRule(false)}
                      className="px-2.5 py-1 text-slate-400 cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="px-3.5 py-1.5 rounded-lg bg-sky-500 text-slate-950 font-semibold cursor-pointer"
                    >
                      确认添加
                    </button>
                  </div>
                </form>
              )}

              {data && data.ufwRules.length > 0 ? (
                <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
                  {data.ufwRules.map((r) => (
                    <div
                      key={r.num}
                      className="flex items-center justify-between gap-2 bg-[#090b10] border border-white/[0.06] rounded-xl px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-mono">
                          <span className="text-[10px] text-slate-500">#{r.num}</span>
                          <span
                            className={`text-[10px] font-semibold px-1.5 py-0.2 rounded ${
                              r.action === 'ALLOW'
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : r.action === 'LIMIT'
                                  ? 'bg-amber-500/15 text-amber-300'
                                  : 'bg-rose-500/15 text-rose-300'
                            }`}
                          >
                            {r.action}
                          </span>
                          <span className="text-white truncate">{r.to}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5 font-mono truncate">
                          From {r.from} {r.comment ? `· ${r.comment}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeleteRule(r.num, r.to)}
                        disabled={busy}
                        title="删除规则"
                        className="p-1.5 text-slate-500 hover:text-rose-400 cursor-pointer shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-500 bg-[#090b10] border border-dashed border-white/10 rounded-xl p-5 text-center">
                  当前没有活动的 UFW 规则（如使用云厂商安全组，流量过滤在云端生效）
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* TIER 3: Raw iptables / nftables (Collapsible) */}
      <section className="bg-[#0f131b] border border-white/[0.06] rounded-2xl overflow-hidden">
        <button
          onClick={() => setShowRawIptables(!showRawIptables)}
          className="w-full px-5 py-3 flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
        >
          <span className="flex items-center gap-2">
            {showRawIptables ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <span>底层 iptables / nftables 原始规则表</span>
          </span>
        </button>
        {showRawIptables && (
          <pre className="p-4 bg-[#07090d] border-t border-white/[0.06] text-[11px] font-mono text-slate-300 overflow-x-auto max-h-96 whitespace-pre">
            {data?.rawIptables || '(空)'}
          </pre>
        )}
      </section>
    </div>
  );
};
