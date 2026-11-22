import React, { useEffect, useMemo, useState } from 'react';
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
  ShieldOff,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import { getTabCache, setTabCache } from '../tabCache';
import type { FirewallData, ListeningPort, NftRule, ServerSnapshot, UfwRule } from '../types';
import { formatRelativeTime } from '../utils';
import { FirewallSkeleton } from './Skeleton';

type PortFwStatus = 'blocked' | 'allowed' | 'restricted' | 'docker_bypass' | 'unprotected';

interface PortFwVerdict {
  status: PortFwStatus;
  label: string;
  detail: string;
  matchedRuleKey?: string;
}

const SERVICE_PORT_MAP: Record<string, number[]> = {
  openssh: [22],
  ssh: [22],
  http: [80],
  www: [80],
  https: [443],
  'nginx http': [80],
  'nginx https': [443],
  'nginx full': [80, 443],
  'apache': [80],
  'apache secure': [443],
  'apache full': [80, 443],
  dns: [53],
  domain: [53],
};

function normProto(p?: string): 'tcp' | 'udp' | '' {
  const s = (p || '').toLowerCase().trim();
  if (s.startsWith('tcp')) return 'tcp';
  if (s.startsWith('udp')) return 'udp';
  return '';
}

function matchPortSpec(port: number, spec: string): boolean {
  const cleaned = spec.replace(/[{}]/g, '').trim().toLowerCase();
  if (!cleaned) return false;
  if (SERVICE_PORT_MAP[cleaned]) {
    return SERVICE_PORT_MAP[cleaned].includes(port);
  }
  for (const part of cleaned.split(',')) {
    const token = part.trim();
    if (!token) continue;
    if (SERVICE_PORT_MAP[token]) {
      if (SERVICE_PORT_MAP[token].includes(port)) return true;
      continue;
    }
    const rangeMatch = token.match(/^(\d+)[:-](\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      if (port >= lo && port <= hi) return true;
      continue;
    }
    if (/^\d+$/.test(token) && Number(token) === port) {
      return true;
    }
  }
  return false;
}

function matchUfwRule(p: ListeningPort, r: UfwRule): boolean {
  const cleaned = r.to.replace(/\(v6\)/gi, '').trim();
  if (/^anywhere$/i.test(cleaned)) return true;
  const protoMatch = cleaned.match(/\/(tcp|udp)$/i);
  const ruleProto = protoMatch ? protoMatch[1].toLowerCase() : '';
  const portProto = normProto(p.proto);
  if (ruleProto && portProto && ruleProto !== portProto) return false;
  const portPart = protoMatch ? cleaned.slice(0, -protoMatch[0].length).trim() : cleaned;
  return matchPortSpec(p.port, portPart);
}

function matchNftRule(p: ListeningPort, r: NftRule): boolean {
  const portProto = normProto(p.proto);
  const ruleProto = normProto(r.proto);
  if (ruleProto && portProto && ruleProto !== portProto) return false;
  if (r.ports && matchPortSpec(p.port, r.ports)) return true;
  const rawMatch = r.raw.match(/\b(tcp|udp)\s+dport\s+(\{[^}]+\}|[\d,-]+)/i);
  if (rawMatch) {
    if (portProto && rawMatch[1].toLowerCase() !== portProto) return false;
    return matchPortSpec(p.port, rawMatch[2]);
  }
  return false;
}

function evaluatePortFirewall(p: ListeningPort, fw: FirewallData | null): PortFwVerdict {
  if (!fw || !fw.active) {
    return {
      status: 'unprotected',
      label: '防火墙未启',
      detail: '本机防火墙未启用，外部能否连通取决于云厂商安全组',
    };
  }

  const isDocker = Boolean(p.dockerContainer || p.process === 'docker-proxy');
  const isNft = fw.engine === 'nftables' || (fw.nftRules && fw.nftRules.length > 0 && fw.engine !== 'ufw');
  const defaultDrops = /deny|drop|reject/i.test(fw.defaultIncoming || '');

  if (isNft) {
    for (const r of fw.nftRules || []) {
      if (!matchNftRule(p, r)) continue;
      const key = `nft-${r.handle}`;
      if (r.action === 'ACCEPT') {
        const restricted = /\b(ip6?\s+saddr|iifname)\b/i.test(r.raw) && !/\biifname\s+!=\s*"lo"/i.test(r.raw);
        if (restricted) {
          return {
            status: 'restricted',
            label: `限源放行 #${r.handle}`,
            detail: `命中 nftables 规则 #${r.handle}（限定来源/网卡）`,
            matchedRuleKey: key,
          };
        }
        return {
          status: 'allowed',
          label: `已放行 #${r.handle}`,
          detail: `命中 nftables 入站放行规则 #${r.handle}`,
          matchedRuleKey: key,
        };
      }
      if (r.action === 'DROP' || r.action === 'REJECT') {
        return {
          status: 'blocked',
          label: `已拦截 #${r.handle}`,
          detail: `命中 nftables 拦截规则 #${r.handle}`,
          matchedRuleKey: key,
        };
      }
    }
    if (isDocker) {
      return {
        status: 'docker_bypass',
        label: 'Docker 转发',
        detail: 'Docker 映射走内核 FORWARD/DOCKER 链，可能绕过入站 input 拦截，请核对云安全组',
      };
    }
    if (defaultDrops) {
      return {
        status: 'blocked',
        label: '已拦截',
        detail: '未命中任何放行规则，已被 nftables 默认入站策略丢弃',
      };
    }
    return {
      status: 'unprotected',
      label: '默认放行',
      detail: '未命中拦截规则且默认入站策略为放行',
    };
  }

  // UFW mode
  if (isDocker) {
    return {
      status: 'docker_bypass',
      label: 'Docker 绕过 UFW',
      detail: 'Docker 映射默认直接写 iptables 绕过 UFW，不受 UFW 拦截，请通过云安全组控制',
    };
  }

  for (const r of fw.ufwRules || []) {
    if (!matchUfwRule(p, r)) continue;
    const key = `ufw-${r.num}`;
    if (r.action === 'ALLOW' || r.action === 'LIMIT') {
      const isAny = /^anywhere/i.test(r.from.trim());
      if (!isAny) {
        return {
          status: 'restricted',
          label: `限源 ${r.from}`,
          detail: `命中 UFW #${r.num}（仅允许来自 ${r.from}）`,
          matchedRuleKey: key,
        };
      }
      return {
        status: 'allowed',
        label: `已放行 #${r.num}`,
        detail: `命中 UFW #${r.num}（${r.action} ${r.to}）`,
        matchedRuleKey: key,
      };
    }
    if (r.action === 'DENY' || r.action === 'REJECT') {
      return {
        status: 'blocked',
        label: `已拦截 #${r.num}`,
        detail: `命中 UFW #${r.num}（${r.action} ${r.to}）`,
        matchedRuleKey: key,
      };
    }
  }

  if (defaultDrops) {
    return {
      status: 'blocked',
      label: '已拦截',
      detail: '未命中放行规则，已被 UFW 默认入站策略拦截',
    };
  }
  return {
    status: 'unprotected',
    label: '默认放行',
    detail: 'UFW 默认入站为放行',
  };
}

interface FirewallTabProps {
  snapshot: ServerSnapshot;
  onRefreshSnapshot: () => void;
}

export const FirewallTab: React.FC<FirewallTabProps> = ({ snapshot, onRefreshSnapshot }) => {
  const cachedInit = getTabCache<FirewallData>('firewall', snapshot.server.id);
  const [data, setData] = useState<FirewallData | null>(cachedInit?.data ?? null);
  const [cachedAt, setCachedAt] = useState<string | undefined>(cachedInit?.cachedAt);
  const [loading, setLoading] = useState(!cachedInit);
  const [error, setError] = useState('');
  const [showLocalPorts, setShowLocalPorts] = useState(false);
  const [showRawIptables, setShowRawIptables] = useState(false);
  const [portFilter, setPortFilter] = useState<'all' | 'exposed' | 'blocked'>('all');
  const [hoveredRuleKey, setHoveredRuleKey] = useState<string | null>(null);
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

  const load = async (fresh = false) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getFirewall(snapshot.server.id, fresh);
      setData(res.firewall);
      setCachedAt(res.cachedAt);
      setTabCache('firewall', snapshot.server.id, res.firewall, res.cachedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载防火墙信息失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const hit = getTabCache<FirewallData>('firewall', snapshot.server.id);
    if (hit) {
      setData(hit.data);
      setCachedAt(hit.cachedAt);
    } else {
      setData(null);
      setCachedAt(undefined);
    }
    load(false);
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

  const publicPorts = useMemo(
    () => data?.listeningPorts.filter((p) => p.scope === 'public') || [],
    [data]
  );
  const tailscalePorts = data?.listeningPorts.filter((p) => p.scope === 'tailscale') || [];
  const privatePorts = data?.listeningPorts.filter((p) => p.scope === 'private') || [];
  const localPorts = data?.listeningPorts.filter((p) => p.scope === 'local') || [];

  const isNftView =
    data?.engine === 'nftables' || (Boolean(data?.nftRules?.length) && data?.engine !== 'ufw');

  const evaluatedPublicPorts = useMemo(() => {
    const order: Record<PortFwStatus, number> = {
      docker_bypass: 0,
      allowed: 1,
      unprotected: 2,
      restricted: 3,
      blocked: 4,
    };
    return publicPorts
      .map((port) => ({ port, verdict: evaluatePortFirewall(port, data) }))
      .sort((a, b) => {
        const diff = order[a.verdict.status] - order[b.verdict.status];
        return diff !== 0 ? diff : a.port.port - b.port.port;
      });
  }, [publicPorts, data]);

  // Map ruleKey -> list of matched port numbers so rules show live hit badges
  const ruleMatchedPorts = useMemo(() => {
    const mp = new Map<string, number[]>();
    for (const item of evaluatedPublicPorts) {
      const k = item.verdict.matchedRuleKey;
      if (!k) continue;
      const arr = mp.get(k) || [];
      if (!arr.includes(item.port.port)) arr.push(item.port.port);
      mp.set(k, arr);
    }
    return mp;
  }, [evaluatedPublicPorts]);

  if (loading && !data) {
    return <FirewallSkeleton />;
  }

  const blockedCount = evaluatedPublicPorts.filter((x) => x.verdict.status === 'blocked').length;
  const exposedCount = evaluatedPublicPorts.length - blockedCount;
  const visiblePublicPorts = evaluatedPublicPorts.filter((x) => {
    if (portFilter === 'blocked') return x.verdict.status === 'blocked';
    if (portFilter === 'exposed') return x.verdict.status !== 'blocked';
    return true;
  });

  const handleQuickAllowPort = (p: ListeningPort) => {
    const proto = normProto(p.proto) || 'tcp';
    const label = p.dockerContainer || p.process;
    if (isNftView) {
      setNftForm({ port: String(p.port), proto, comment: label !== 'unknown' ? label : '' });
      setAddingNftRule(true);
    } else if (data?.engine === 'ufw') {
      setRuleForm({
        port: String(p.port),
        proto,
        action: 'allow',
        from: 'any',
        comment: label !== 'unknown' ? label : '',
      });
      setAddingRule(true);
    }
  };

  const verdictBadgeClass = (status: PortFwStatus) => {
    switch (status) {
      case 'blocked':
        return 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300';
      case 'restricted':
        return 'bg-sky-500/12 border-sky-400/25 text-sky-300';
      case 'allowed':
        return 'bg-amber-500/12 border-amber-400/30 text-amber-300';
      case 'docker_bypass':
        return 'bg-rose-500/12 border-rose-500/30 text-rose-300';
      default:
        return 'bg-white/[0.04] border-white/[0.08] text-slate-400';
    }
  };

  return (
    <div className="space-y-5">
      {/* TIER 1: Security Posture Banner */}
      <section
        className={`rounded-2xl p-4 sm:p-5 border flex flex-col md:flex-row md:items-center justify-between gap-4 ${
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
          {cachedAt && (
            <span className="text-[10px] font-mono text-slate-500 hidden sm:inline">
              {formatRelativeTime(cachedAt)}
            </span>
          )}
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
            onClick={() => load(true)}
            title="强制刷新"
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
        {/* Publicly Exposed Ports (High Weight) with Firewall Cross-Reference */}
        <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 shrink-0" />
              公网监听端口 (0.0.0.0 / ::) · {publicPorts.length}
            </h3>
            {data?.active && blockedCount > 0 ? (
              <div className="inline-flex items-center bg-[#090b10] border border-white/[0.07] rounded-lg p-0.5 text-[10px] font-mono">
                {(
                  [
                    ['all', `全部 ${publicPorts.length}`],
                    ['exposed', `实际暴露 ${exposedCount}`],
                    ['blocked', `已拦截 ${blockedCount}`],
                  ] as const
                ).map(([k, lbl]) => (
                  <button
                    key={k}
                    onClick={() => setPortFilter(k)}
                    className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                      portFilter === k
                        ? 'bg-sky-500/20 text-sky-300 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-[10px] text-slate-500">
                {data?.active ? '悬停端口可高亮右侧命中规则' : '本机防火墙未启，仅靠云安全组约束'}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            {visiblePublicPorts.map(({ port: p, verdict }, idx) => {
              const isLinkedHighlight =
                Boolean(hoveredRuleKey && verdict.matchedRuleKey && hoveredRuleKey === verdict.matchedRuleKey);
              const isBlocked = verdict.status === 'blocked';
              const canQuickAllow =
                isBlocked &&
                data?.active &&
                ((isNftView && Boolean(data?.nftTarget)) || (!isNftView && data?.engine === 'ufw'));
              return (
                <div
                  key={`${p.proto}-${p.port}-${idx}`}
                  onMouseEnter={() => {
                    if (verdict.matchedRuleKey) setHoveredRuleKey(verdict.matchedRuleKey);
                  }}
                  onMouseLeave={() => setHoveredRuleKey(null)}
                  className={`group flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-xl px-3.5 py-2.5 text-xs border transition-all ${
                    isLinkedHighlight
                      ? 'bg-sky-500/12 border-sky-400/50 shadow-sm'
                      : isBlocked
                        ? 'bg-[#090b10]/70 border-white/[0.04] opacity-75 hover:opacity-100'
                        : 'bg-[#090b10] border-white/[0.06]'
                  }`}
                >
                  <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
                    <span
                      className={`font-mono font-semibold w-14 sm:w-16 shrink-0 ${
                        isBlocked ? 'text-slate-400' : 'text-amber-300'
                      }`}
                    >
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

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] font-mono text-slate-500 hidden sm:inline">
                      {p.address}
                    </span>
                    <span
                      title={verdict.detail}
                      className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md border ${verdictBadgeClass(verdict.status)}`}
                    >
                      {verdict.status === 'blocked' ? (
                        <ShieldCheck className="w-2.5 h-2.5" />
                      ) : verdict.status === 'unprotected' ? (
                        <ShieldOff className="w-2.5 h-2.5" />
                      ) : (
                        <Shield className="w-2.5 h-2.5" />
                      )}
                      <span>{verdict.label}</span>
                    </span>
                    {canQuickAllow && (
                      <button
                        type="button"
                        onClick={() => handleQuickAllowPort(p)}
                        title={`在右侧预填放行 :${p.port}/${normProto(p.proto) || 'tcp'}`}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/12 hover:bg-sky-500/25 border border-sky-400/25 text-sky-300 transition-colors cursor-pointer"
                      >
                        放行
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {visiblePublicPorts.length === 0 && (
              <div className="text-xs text-slate-500 py-4 text-center">
                {publicPorts.length === 0 ? '无公网监听端口' : '当前筛选下无匹配端口'}
              </div>
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
        <section className="lg:col-span-5 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-3.5">
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
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
                    <span>自动插入至链头部，并持久化到重启脚本</span>
                    <div className="flex gap-2 ml-auto">
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
                  const ruleKey = `nft-${r.handle}`;
                  const hitPorts = ruleMatchedPorts.get(ruleKey) || [];
                  const isHighlighted = hoveredRuleKey === ruleKey;
                  return (
                    <div
                      key={`${r.table}-${r.chain}-${r.handle}`}
                      onMouseEnter={() => setHoveredRuleKey(ruleKey)}
                      onMouseLeave={() => setHoveredRuleKey(null)}
                      className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs border transition-all ${
                        isHighlighted
                          ? 'bg-sky-500/12 border-sky-400/50 shadow-sm'
                          : 'bg-[#090b10] border-white/[0.06]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-mono flex-wrap">
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
                          {hitPorts.length > 0 && (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-300 border border-sky-400/25">
                              命中 {hitPorts.map((pt) => `:${pt}`).join(' ')}
                            </span>
                          )}
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
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                  {data.ufwRules.map((r) => {
                    const ruleKey = `ufw-${r.num}`;
                    const hitPorts = ruleMatchedPorts.get(ruleKey) || [];
                    const isHighlighted = hoveredRuleKey === ruleKey;
                    return (
                      <div
                        key={r.num}
                        onMouseEnter={() => setHoveredRuleKey(ruleKey)}
                        onMouseLeave={() => setHoveredRuleKey(null)}
                        className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs border transition-all ${
                          isHighlighted
                            ? 'bg-sky-500/12 border-sky-400/50 shadow-sm'
                            : 'bg-[#090b10] border-white/[0.06]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-mono flex-wrap">
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
                            {hitPorts.length > 0 && (
                              <span className="text-[9px] px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-300 border border-sky-400/25">
                                命中 {hitPorts.map((pt) => `:${pt}`).join(' ')}
                              </span>
                            )}
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
                    );
                  })}
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
