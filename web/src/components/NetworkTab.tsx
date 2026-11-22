import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Clock,
  Download,
  Gauge,
  Globe,
  Loader2,
  Network,
  Play,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Route,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import type {
  LiveTcpHealth,
  NetworkBurstItem,
  NetworkMonitorResponse,
  NetworkProfile,
  NetworkTarget,
  NetworkTargetSummary,
  ServerConfig,
  ServerSnapshot,
} from '../types';
import { formatBytes } from '../utils';
import { NetworkChartSkeleton, NetworkLiveTcpSkeleton, Sk } from './Skeleton';

interface PresetCategory {
  id: string;
  label: string;
  desc: string;
  items: Omit<NetworkTarget, 'enabled'>[];
}

const PRESET_CATALOG: PresetCategory[] = [
  {
    id: 'cn-east',
    label: '华东三网 (沪/浙/苏)',
    desc: '适合测上海、杭州、南京方向晚高峰拥堵',
    items: [
      { id: 'ct-sh', name: '上海电信', host: '202.96.209.133', protocol: 'icmp', group: '电信' },
      { id: 'cu-sh', name: '上海联通', host: '210.22.70.3', protocol: 'icmp', group: '联通' },
      { id: 'cm-sh', name: '上海移动', host: '211.136.112.50', protocol: 'icmp', group: '移动' },
      { id: 'ct-hz', name: '杭州电信', host: '202.101.172.35', protocol: 'icmp', group: '电信' },
      { id: 'ct-nj', name: '南京电信', host: '218.2.135.1', protocol: 'icmp', group: '电信' },
    ],
  },
  {
    id: 'cn-south',
    label: '华南三网 (广/深)',
    desc: '香港/新加坡/台湾机房回国内首选基准',
    items: [
      { id: 'ct-gz', name: '广州电信', host: '202.96.128.86', protocol: 'icmp', group: '电信' },
      { id: 'cu-gz', name: '广州联通', host: '210.21.196.6', protocol: 'icmp', group: '联通' },
      { id: 'cm-gz', name: '广州移动', host: '221.179.155.161', protocol: 'icmp', group: '移动' },
      { id: 'ct-sz', name: '深圳电信', host: '202.96.134.133', protocol: 'icmp', group: '电信' },
    ],
  },
  {
    id: 'cn-north-west',
    label: '华北与中西部 (京/川/鄂)',
    desc: '北方及内陆三网回程监控',
    items: [
      { id: 'ct-bj', name: '北京电信', host: '219.141.136.10', protocol: 'icmp', group: '电信' },
      { id: 'cu-bj', name: '北京联通', host: '202.106.0.20', protocol: 'icmp', group: '联通' },
      { id: 'cm-bj', name: '北京移动', host: '221.130.33.52', protocol: 'icmp', group: '移动' },
      { id: 'ct-cd', name: '成都电信', host: '61.139.2.69', protocol: 'icmp', group: '电信' },
      { id: 'ct-wh', name: '武汉电信', host: '202.103.24.68', protocol: 'icmp', group: '电信' },
    ],
  },
  {
    id: 'cn-tcp',
    label: '国内大厂 BGP (TCP:443 防禁 Ping)',
    desc: '走真实 TCP 握手，不受运营商 ICMP 限速/禁 Ping 干扰',
    items: [
      { id: 'ali-dns', name: '阿里 DNS (TCP)', host: '223.5.5.5', port: 443, protocol: 'tcp', group: '自定义' },
      { id: 'tx-dns', name: '腾讯 DNSPod (TCP)', host: '119.29.29.29', port: 443, protocol: 'tcp', group: '自定义' },
      { id: 'cn-baidu', name: '百度 (TCP)', host: 'www.baidu.com', port: 443, protocol: 'tcp', group: '自定义' },
      { id: 'cn-bili', name: 'Bilibili (TCP)', host: 'www.bilibili.com', port: 443, protocol: 'tcp', group: '自定义' },
    ],
  },
  {
    id: 'global',
    label: '国际骨干 / AI / 海外机房 (TCP:443)',
    desc: '测试出海稳定性、AI API 及全球主要区域机房延迟',
    items: [
      { id: 'cf-edge', name: 'Cloudflare 1.1.1.1', host: '1.1.1.1', port: 443, protocol: 'tcp', group: '国际' },
      { id: 'gg-dns', name: 'Google 8.8.8.8', host: '8.8.8.8', port: 443, protocol: 'tcp', group: '国际' },
      { id: 'gh-tcp', name: 'GitHub', host: 'github.com', port: 443, protocol: 'tcp', group: '国际' },
      { id: 'openai-api', name: 'OpenAI API', host: 'api.openai.com', port: 443, protocol: 'tcp', group: '国际' },
      { id: 'jp-tyo', name: '日本东京 (Vultr)', host: 'hnd-jp-ping.vultr.com', port: 443, protocol: 'tcp', group: '国际' },
      { id: 'sg-sin', name: '新加坡 (Vultr)', host: 'sgp-ping.vultr.com', port: 443, protocol: 'tcp', group: '国际' },
      { id: 'us-lax', name: '美西洛杉矶 (Vultr)', host: 'lax-ca-us-ping.vultr.com', port: 443, protocol: 'tcp', group: '国际' },
      { id: 'de-fra', name: '德国法兰克福 (Vultr)', host: 'fra-de-ping.vultr.com', port: 443, protocol: 'tcp', group: '国际' },
    ],
  },
];

function parseSmartInput(raw: string): { host: string; port?: number; protocol: 'icmp' | 'tcp'; suggestedName: string } {
  const s = raw.trim();
  const hasScheme = /^https?:\/\//i.test(s);
  const cleaned = s.replace(/^https?:\/\//i, '').split('/')[0].trim();
  const m = cleaned.match(/^([^:]+):(\d{1,5})$/);
  if (m) {
    return {
      host: m[1],
      port: Number(m[2]),
      protocol: 'tcp',
      suggestedName: m[1],
    };
  }
  if (hasScheme) {
    return {
      host: cleaned,
      port: s.toLowerCase().startsWith('http://') ? 80 : 443,
      protocol: 'tcp',
      suggestedName: cleaned,
    };
  }
  const isIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(cleaned);
  return {
    host: cleaned,
    port: isIP ? undefined : 443,
    protocol: isIP ? 'icmp' : 'tcp',
    suggestedName: cleaned,
  };
}

interface NetworkTabProps {
  snapshot: ServerSnapshot;
}

const LINE_COLORS = ['#38bdf8', '#fb7185', '#34d399', '#a78bfa', '#fbbf24', '#2dd4bf', '#f472b6', '#818cf8'];

function groupDotColor(group: string): string {
  switch (group) {
    case '电信':
      return 'bg-sky-400';
    case '联通':
      return 'bg-rose-400';
    case '移动':
      return 'bg-emerald-400';
    case '国际':
      return 'bg-violet-400';
    default:
      return 'bg-amber-400';
  }
}

function gradeBadge(grade: NetworkTargetSummary['grade']): { text: string; cls: string } {
  switch (grade) {
    case 'excellent':
      return { text: '稳如磐石', cls: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' };
    case 'good':
      return { text: '运行平稳', cls: 'bg-sky-500/15 border-sky-500/30 text-sky-300' };
    case 'degraded':
      return { text: '轻度波动', cls: 'bg-amber-500/15 border-amber-500/30 text-amber-300' };
    case 'poor':
      return { text: '劣化/丢包', cls: 'bg-rose-500/15 border-rose-500/30 text-rose-300' };
    default:
      return { text: '等待采样', cls: 'bg-white/[0.05] border-white/10 text-slate-400' };
  }
}

function formatClock(ts: number, rng: string): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (rng === '7d') {
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:00`;
  }
  return `${hh}:${mm}`;
}

function isPeakHourCST(ts: number): boolean {
  // Convert to UTC+8 hour regardless of viewer browser timezone
  const utcMs = ts + 8 * 3600 * 1000;
  const hr = new Date(utcMs).getUTCHours();
  return hr >= 20 && hr <= 23;
}

export const NetworkTab: React.FC<NetworkTabProps> = ({ snapshot }) => {
  const [range, setRange] = useState<'1h' | '6h' | '24h' | '7d'>('24h');
  const [monitor, setMonitor] = useState<NetworkMonitorResponse | null>(null);
  const [profile, setProfile] = useState<NetworkProfile | null>(null);
  const [liveTcp, setLiveTcp] = useState<LiveTcpHealth | null>(null);
  const [loadingMon, setLoadingMon] = useState(true);
  const [loadingProf, setLoadingProf] = useState(true);
  const [loadingTcp, setLoadingTcp] = useState(true);
  const [savingMode, setSavingMode] = useState(false);
  const [probing, setProbing] = useState(false);
  const [bursting, setBursting] = useState(false);
  const [runningSpeed, setRunningSpeed] = useState(false);
  const [runningRoute, setRunningRoute] = useState(false);
  const [burstResults, setBurstResults] = useState<{ items: NetworkBurstItem[]; testedAt: string } | null>(null);
  const [chartMode, setChartMode] = useState<'single' | 'multi'>('single');
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [error, setError] = useState('');

  // Target manager modal
  const [editingTargets, setEditingTargets] = useState(false);
  const [modalTab, setModalTab] = useState<'presets' | 'custom' | 'current'>('presets');
  const [targetsDraft, setTargetsDraft] = useState<NetworkTarget[]>([]);
  const [allServers, setAllServers] = useState<ServerConfig[]>([]);
  const [presetQuery, setPresetQuery] = useState('');
  const [savingTargets, setSavingTargets] = useState(false);

  // Smart custom target form + live reachability check
  const [customInput, setCustomInput] = useState('');
  const [customName, setCustomName] = useState('');
  const [customProto, setCustomProto] = useState<'icmp' | 'tcp'>('tcp');
  const [customPort, setCustomPort] = useState<number>(443);
  const [customGroup, setCustomGroup] = useState<string>('自定义');
  const [testingSingle, setTestingSingle] = useState(false);
  const [singleTestRes, setSingleTestRes] = useState<NetworkBurstItem | null>(null);
  const [singleTestErr, setSingleTestErr] = useState('');

  const loadMonitor = async (r = range) => {
    setLoadingMon(true);
    setError('');
    try {
      const res = await api.getNetworkMonitor(snapshot.server.id, r);
      setMonitor(res);
      if (res.targets.length > 0 && !res.targets.some((t) => t.target.id === selectedTargetId)) {
        setSelectedTargetId(res.targets[0].target.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载网络监测数据失败');
    } finally {
      setLoadingMon(false);
    }
  };

  const loadProfile = async () => {
    setLoadingProf(true);
    try {
      const res = await api.getNetworkProfile(snapshot.server.id);
      setProfile(res.profile);
    } catch {
      // non-fatal
    } finally {
      setLoadingProf(false);
    }
  };

  const loadLiveTcp = async () => {
    setLoadingTcp(true);
    try {
      const res = await api.getLiveTcpHealth(snapshot.server.id);
      setLiveTcp(res.health);
    } catch {
      // non-fatal
    } finally {
      setLoadingTcp(false);
    }
  };

  useEffect(() => {
    setBurstResults(null);
    setMonitor(null);
    setProfile(null);
    setLiveTcp(null);
    setLoadingMon(true);
    setLoadingProf(true);
    setLoadingTcp(true);
    loadProfile();
    loadLiveTcp();
  }, [snapshot.server.id]);

  const handleModeChange = async (mode: 'off' | 'routine' | 'inspect', durationHours = 72) => {
    setSavingMode(true);
    setError('');
    try {
      const res = await api.setServerNetworkMode(snapshot.server.id, {
        mode,
        durationHours: mode === 'inspect' ? durationHours : 0,
        enableSpeedInInspect: true,
        enableRouteInInspect: true,
      });
      setMonitor((prev) => (prev ? { ...prev, modeConfig: res.modeConfig } : prev));
      if (mode !== 'off') {
        await loadMonitor(range);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '切换监测模式失败');
    } finally {
      setSavingMode(false);
    }
  };

  const handleRunSpeedtest = async () => {
    setRunningSpeed(true);
    setError('');
    try {
      await api.runNetworkSpeedtest(snapshot.server.id);
      await loadMonitor(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : '单线程测速失败');
    } finally {
      setRunningSpeed(false);
    }
  };

  const handleRunRouteCheck = async () => {
    setRunningRoute(true);
    setError('');
    try {
      await api.runNetworkRouteCheck(snapshot.server.id);
      await loadMonitor(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : '路由跳数检测失败');
    } finally {
      setRunningRoute(false);
    }
  };

  useEffect(() => {
    loadMonitor(range);
  }, [snapshot.server.id, range]);

  const handleProbeOnce = async () => {
    setProbing(true);
    setError('');
    try {
      await api.runNetworkProbe(snapshot.server.id, 4);
      await loadMonitor(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : '探测失败');
    } finally {
      setProbing(false);
    }
  };

  const handleBurstTest = async () => {
    setBursting(true);
    setError('');
    try {
      const res = await api.runNetworkProbe(snapshot.server.id, 20);
      setBurstResults({ items: res.results, testedAt: res.testedAt });
      await loadMonitor(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : '连发稳定性测试失败');
    } finally {
      setBursting(false);
    }
  };

  const openTargetEditor = async () => {
    try {
      const [res, srvs] = await Promise.all([
        api.getNetworkTargets(),
        api.listServers().catch(() => ({ servers: [] as ServerConfig[] })),
      ]);
      setTargetsDraft(res.targets);
      setAllServers(srvs.servers || []);
      setPresetQuery('');
      setSingleTestRes(null);
      setSingleTestErr('');
      setModalTab('presets');
      setEditingTargets(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载探测目标失败');
    }
  };

  const isTargetAdded = (host: string, protocol: string, port?: number) =>
    targetsDraft.some(
      (t) => t.host === host && t.protocol === protocol && (protocol !== 'tcp' || (t.port || 443) === (port || 443))
    );

  const togglePresetTarget = (item: Omit<NetworkTarget, 'enabled'>) => {
    if (isTargetAdded(item.host, item.protocol, item.port)) {
      setTargetsDraft((prev) =>
        prev.filter(
          (t) =>
            !(
              t.host === item.host &&
              t.protocol === item.protocol &&
              (item.protocol !== 'tcp' || (t.port || 443) === (item.port || 443))
            )
        )
      );
    } else {
      setTargetsDraft((prev) => [...prev, { ...item, enabled: true }]);
    }
  };

  const handleSmartInputChange = (val: string) => {
    setCustomInput(val);
    setSingleTestRes(null);
    setSingleTestErr('');
    if (!val.trim()) return;
    const parsed = parseSmartInput(val);
    setCustomProto(parsed.protocol);
    if (parsed.port) setCustomPort(parsed.port);
    if (!customName.trim() || customName === parseSmartInput(customInput).suggestedName) {
      setCustomName(parsed.suggestedName);
    }
  };

  const handleTestSingleTarget = async () => {
    const parsed = parseSmartInput(customInput);
    if (!parsed.host) {
      setSingleTestErr('请先输入 IP、域名或网址');
      return;
    }
    setTestingSingle(true);
    setSingleTestRes(null);
    setSingleTestErr('');
    try {
      const res = await api.probeSingleNetworkTarget(snapshot.server.id, {
        name: customName.trim() || parsed.suggestedName,
        host: parsed.host,
        protocol: customProto,
        port: customProto === 'tcp' ? customPort || 443 : undefined,
      });
      setSingleTestRes(res.result);
    } catch (err) {
      setSingleTestErr(err instanceof Error ? err.message : '测试失败');
    } finally {
      setTestingSingle(false);
    }
  };

  const handleAddCustomTarget = () => {
    const parsed = parseSmartInput(customInput);
    if (!parsed.host) {
      setSingleTestErr('请先输入 IP、域名或网址');
      return;
    }
    const newItem: NetworkTarget = {
      id: `custom-${Date.now()}`,
      name: customName.trim() || parsed.suggestedName,
      host: parsed.host,
      protocol: customProto,
      port: customProto === 'tcp' ? customPort || 443 : undefined,
      group: customGroup || '自定义',
      enabled: true,
    };
    setTargetsDraft((prev) => [...prev, newItem]);
    setCustomInput('');
    setCustomName('');
    setSingleTestRes(null);
    setSingleTestErr('');
  };

  const handleSaveTargets = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSavingTargets(true);
    try {
      await api.saveNetworkTargets(targetsDraft);
      setEditingTargets(false);
      await handleProbeOnce();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存目标失败');
    } finally {
      setSavingTargets(false);
    }
  };

  const selectedSummary = useMemo(() => {
    if (!monitor || monitor.targets.length === 0) return null;
    return monitor.targets.find((t) => t.target.id === selectedTargetId) || monitor.targets[0];
  }, [monitor, selectedTargetId]);

  // Smokeping SVG geometry calculation (plot-only coordinates; axes rendered in crisp HTML)
  const chartData = useMemo(() => {
    const W = 800;
    const H = 200;
    const padL = 0;
    const padR = 0;
    const padT = 6;
    const padB = 6;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const allSeries =
      chartMode === 'single'
        ? selectedSummary
          ? [selectedSummary]
          : []
        : monitor?.targets || [];

    const allPts = allSeries.flatMap((s) => s.points);
    if (allPts.length === 0) return null;

    let minTs = Infinity;
    let maxTs = -Infinity;
    let maxMs = 20;
    for (const p of allPts) {
      if (p.ts < minTs) minTs = p.ts;
      if (p.ts > maxTs) maxTs = p.ts;
      const hi = p.maxMs ?? p.avgMs ?? 0;
      if (hi > maxMs) maxMs = hi;
    }
    if (minTs === maxTs) {
      minTs -= 60_000;
      maxTs += 60_000;
    }
    maxMs = Math.ceil((maxMs * 1.15) / 10) * 10;

    const xOf = (ts: number) => padL + ((ts - minTs) / (maxTs - minTs)) * innerW;
    const yOf = (ms: number) => padT + innerH - (Math.min(maxMs, Math.max(0, ms)) / maxMs) * innerH;

    // Identify peak-hour (20:00-23:59 CST) contiguous bands along the x-axis
    const peakBands: { x1: number; x2: number }[] = [];
    const stepMs = Math.max(5 * 60_000, Math.floor((maxTs - minTs) / 120));
    let bandStart: number | null = null;
    for (let t = minTs; t <= maxTs; t += stepMs) {
      if (isPeakHourCST(t)) {
        if (bandStart === null) bandStart = t;
      } else if (bandStart !== null) {
        peakBands.push({ x1: xOf(bandStart), x2: xOf(t) });
        bandStart = null;
      }
    }
    if (bandStart !== null) {
      peakBands.push({ x1: xOf(bandStart), x2: xOf(maxTs) });
    }

    return { W, H, padL, padR, padT, padB, innerW, innerH, minTs, maxTs, maxMs, xOf, yOf, peakBands, allSeries };
  }, [monitor, selectedSummary, chartMode]);

  const tcpEntries = useMemo(() => {
    if (!profile) return [];
    const order = ['ESTAB', 'LISTEN', 'TIME-WAIT', 'CLOSE-WAIT', 'SYN-RECV', 'FIN-WAIT-1', 'FIN-WAIT-2'];
    const entries = Object.entries(profile.tcpStates);
    entries.sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return b[1] - a[1];
    });
    return entries;
  }, [profile]);

  const curMode = monitor?.modeConfig?.mode || 'routine';
  const inspectRemainHours = useMemo(() => {
    const until = monitor?.modeConfig?.inspectUntil;
    if (!until) return null;
    const ms = new Date(until).getTime() - Date.now();
    if (ms <= 0) return null;
    return Math.max(1, Math.round(ms / 3600_000));
  }, [monitor?.modeConfig?.inspectUntil]);

  const verdictStyle = (grade?: string) => {
    switch (grade) {
      case 'excellent':
        return 'bg-emerald-500/[0.06] border-emerald-500/25 text-emerald-200';
      case 'good':
        return 'bg-sky-500/[0.06] border-sky-400/25 text-sky-200';
      case 'degraded':
        return 'bg-amber-500/[0.06] border-amber-400/30 text-amber-200';
      case 'poor':
        return 'bg-rose-500/[0.07] border-rose-500/30 text-rose-200';
      default:
        return 'bg-[#0f131b] border-white/[0.07] text-slate-300';
    }
  };

  return (
    <div className="space-y-6">
      {/* Lifecycle Mode Switcher & Auto Verdict Banner */}
      <section className={`rounded-2xl p-4 border transition-colors space-y-3.5 ${verdictStyle(monitor?.verdict?.grade)}`}>
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          {/* Left: Per-server 3-mode switch */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-white">当前节点监测模式</span>
              <div className="inline-flex flex-wrap items-center bg-[#090b10] border border-white/[0.08] rounded-xl p-0.5 text-[11px]">
                <button
                  type="button"
                  disabled={savingMode}
                  onClick={() => handleModeChange('off')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                    curMode === 'off'
                      ? 'bg-slate-600/40 text-white font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Power className="w-3 h-3" />
                  <span>关闭后台</span>
                </button>
                <button
                  type="button"
                  disabled={savingMode}
                  onClick={() => handleModeChange('routine')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                    curMode === 'routine'
                      ? 'bg-sky-500/20 text-sky-300 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <ShieldCheck className="w-3 h-3" />
                  <span>常规巡检 (5分)</span>
                </button>
                <button
                  type="button"
                  disabled={savingMode}
                  onClick={() => handleModeChange('inspect', 72)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                    curMode === 'inspect'
                      ? 'bg-amber-500/20 text-amber-300 font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span>新机验机 (1分+吞吐/路由)</span>
                </button>
              </div>
              {savingMode && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />}
            </div>

            <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2">
              {curMode === 'off' && (
                <span>已停止该节点的后台自动探测（零后台流量），仍可随时点击下方手动测速或查看实时内核连接。</span>
              )}
              {curMode === 'routine' && (
                <span>日常低耗守护：每 5 分钟轻量检测延迟与丢包（极低流量），配合零流量内核连接体检。</span>
              )}
              {curMode === 'inspect' && (
                <>
                  <span>
                    新机退款期深度考察：1 分钟高频 Smokeping + 每 30 分钟路由切线检测 + 每小时 4s 单线程吞吐测试
                  </span>
                  <span className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-300 bg-amber-500/10 border border-amber-400/25 px-2 py-0.5 rounded-full">
                    <Clock className="w-2.5 h-2.5" />
                    {inspectRemainHours ? `剩余约 ${inspectRemainHours}h 自动切回常规` : '持续考察中'}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px]">
                    {[
                      { h: 24, lbl: '24h' },
                      { h: 72, lbl: '72h' },
                      { h: 0, lbl: '不限时' },
                    ].map((opt) => (
                      <button
                        key={opt.h}
                        type="button"
                        onClick={() => handleModeChange('inspect', opt.h)}
                        className="px-1.5 py-0.5 rounded bg-white/[0.05] hover:bg-white/[0.12] text-slate-300 cursor-pointer"
                      >
                        {opt.lbl}
                      </button>
                    ))}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right: Verdict headline */}
          {monitor?.verdict && (
            <div className="lg:text-right shrink-0 max-w-md">
              <div className="text-xs font-semibold text-white">{monitor.verdict.headline}</div>
              {monitor.verdict.reasons.length > 0 && (
                <div className="text-[11px] text-slate-400 mt-0.5">
                  {monitor.verdict.reasons.join(' · ')}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Top Action & Range Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-[#0f131b] border border-white/[0.08] rounded-xl p-1 text-xs">
            {(['1h', '6h', '24h', '7d'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 rounded-lg font-mono transition-colors cursor-pointer ${
                  range === r ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-500 hidden sm:inline">
            {curMode === 'off'
              ? '后台探测已关闭 · 仅显示历史与手动采样'
              : curMode === 'inspect'
                ? '新机验机模式：每 60s 自动采样 · 晚高峰 (20:00–24:00 CST) 自动标注'
                : '常规巡检模式：每 5 分钟自动采样 · 晚高峰 (20:00–24:00 CST) 自动标注'}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleBurstTest}
            disabled={bursting || probing}
            className="flex items-center gap-1.5 text-xs bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold px-3.5 py-2 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
          >
            {bursting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            <span>{bursting ? '20连发测速中...' : '高峰稳定性连测 (20发)'}</span>
          </button>
          <button
            onClick={handleProbeOnce}
            disabled={probing || bursting}
            className="flex items-center gap-1.5 text-xs bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] text-slate-200 px-3 py-2 rounded-xl cursor-pointer disabled:opacity-50"
          >
            <Play className={`w-3 h-3 text-emerald-400 ${probing ? 'animate-pulse' : ''}`} />
            <span>{probing ? '采样中...' : '立即采样'}</span>
          </button>
          <button
            onClick={openTargetEditor}
            className="flex items-center gap-1.5 text-xs bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 px-3 py-2 rounded-xl cursor-pointer"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>探测目标</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* On-Demand 20-Shot Burst Stability Result Panel */}
      {burstResults && (
        <section className="bg-[#0f131b] border border-sky-400/30 rounded-2xl p-4 sm:p-5 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-sky-400" />
              <h3 className="text-xs font-semibold text-white">
                实时 20 连发稳定性快测结果（{new Date(burstResults.testedAt).toLocaleTimeString()}）
              </h3>
            </div>
            <button onClick={() => setBurstResults(null)} className="text-slate-400 hover:text-white cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {burstResults.items.map((item) => {
              const rtts = item.rtts || [];
              const maxR = Math.max(10, ...rtts.filter((x) => x >= 0));
              return (
                <div
                  key={item.targetId}
                  className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5 space-y-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white truncate">{item.targetName}</div>
                      <div className="text-[10px] font-mono text-slate-500">
                        {item.host} · {item.protocol.toUpperCase()}
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                        item.lossPct > 0
                          ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                          : (item.jitterMs ?? 0) > 15
                            ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                            : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                      }`}
                    >
                      丢包 {item.lossPct}%
                    </span>
                  </div>

                  {/* Per-packet 20-bar mini sparkline */}
                  <div className="h-10 flex items-end gap-[2px] pt-1">
                    {rtts.map((v, idx) => {
                      if (v < 0) {
                        return (
                          <div
                            key={idx}
                            title={`#${idx + 1}: 丢包 / 超时`}
                            className="flex-1 h-full bg-rose-500/75 rounded-t-sm"
                          />
                        );
                      }
                      const pct = Math.max(12, Math.min(100, (v / maxR) * 100));
                      const barColor =
                        item.avgMs && v > item.avgMs * 1.6
                          ? 'bg-amber-400'
                          : 'bg-sky-400/80';
                      return (
                        <div
                          key={idx}
                          title={`#${idx + 1}: ${v} ms`}
                          style={{ height: `${pct}%` }}
                          className={`flex-1 rounded-t-sm ${barColor}`}
                        />
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-4 gap-1 text-[10px] font-mono text-slate-400 pt-1 border-t border-white/[0.05]">
                    <div>
                      <div className="text-slate-500">AVG</div>
                      <div className="text-white">{item.avgMs !== null ? `${item.avgMs}ms` : '—'}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">P95</div>
                      <div className="text-sky-300">{item.p95Ms !== null ? `${item.p95Ms}ms` : '—'}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">MAX</div>
                      <div className="text-amber-300">{item.maxMs !== null ? `${item.maxMs}ms` : '—'}</div>
                    </div>
                    <div>
                      <div className="text-slate-500">抖动</div>
                      <div className="text-slate-200">{item.jitterMs !== null ? `${item.jitterMs}ms` : '—'}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* TIER 1: Target Stability Scorecards */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span>
              {loadingMon && !monitor
                ? '多线路稳定性监控（正在加载探针数据...）'
                : `多线路稳定性监控 (${monitor?.targets.length || 0} 条探针 · 点击卡片切换曲线)`}
            </span>
          </h2>
          <button
            onClick={() => loadMonitor(range)}
            className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer shrink-0"
          >
            <RefreshCw className={`w-3 h-3 ${loadingMon ? 'animate-spin text-sky-400' : ''}`} />
            <span>刷新</span>
          </button>
        </div>

        {loadingMon && !monitor ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl p-4 border border-white/[0.06] bg-[#0f131b] space-y-3 animate-pulse"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1.5 flex-1">
                    <div className="h-3.5 w-24 bg-white/[0.08] rounded" />
                    <div className="h-2.5 w-32 bg-white/[0.05] rounded" />
                  </div>
                  <div className="h-5 w-14 bg-white/[0.06] rounded-full" />
                </div>
                <div className="grid grid-cols-4 gap-2 pt-1">
                  {Array.from({ length: 4 }).map((__, j) => (
                    <div key={j} className="space-y-1">
                      <div className="h-2.5 w-8 bg-white/[0.04] rounded" />
                      <div className="h-4 w-12 bg-white/[0.08] rounded" />
                    </div>
                  ))}
                </div>
                <div className="pt-2 border-t border-white/[0.05]">
                  <div className="h-3 w-40 bg-white/[0.05] rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {(monitor?.targets || []).map((item, idx) => {
            const selected = chartMode === 'single' && selectedSummary?.target.id === item.target.id;
            const badge = gradeBadge(item.grade);
            const curMs = item.latest?.avgMs;
            const loss = item.overall.lossPct;
            const peakDelta = item.peakDeltaMs;
            return (
              <button
                key={item.target.id}
                onClick={() => {
                  setSelectedTargetId(item.target.id);
                  setChartMode('single');
                }}
                className={`text-left rounded-2xl p-4 border transition-all cursor-pointer space-y-3 ${
                  selected
                    ? 'bg-[#141a26] border-sky-400/50 shadow-sm'
                    : 'bg-[#0f131b] border-white/[0.07] hover:border-white/20'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${groupDotColor(item.target.group)}`}
                        style={chartMode === 'multi' ? { backgroundColor: LINE_COLORS[idx % LINE_COLORS.length] } : undefined}
                      />
                      <span className="text-xs font-semibold text-white truncate">{item.target.name}</span>
                      <span className="text-[10px] font-mono text-slate-500 uppercase">{item.target.protocol}</span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-500 mt-0.5 pl-4 truncate">
                      {item.target.host}{item.target.port ? `:${item.target.port}` : ''}
                    </div>
                  </div>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border shrink-0 ${badge.cls}`}>
                    {badge.text}
                  </span>
                </div>

                {/* Key Metrics Row */}
                <div className="grid grid-cols-4 gap-2 font-mono">
                  <div>
                    <div className="text-[10px] text-slate-500">当前</div>
                    <div className="text-sm font-semibold text-white">
                      {curMs !== null && curMs !== undefined ? `${curMs}ms` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500">P95</div>
                    <div className="text-xs font-semibold text-sky-300 mt-0.5">
                      {item.overall.p95Ms !== null ? `${item.overall.p95Ms}ms` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500">抖动</div>
                    <div className="text-xs font-semibold text-slate-200 mt-0.5">
                      {item.overall.jitterMs !== null ? `${item.overall.jitterMs}ms` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500">丢包</div>
                    <div className={`text-xs font-semibold mt-0.5 ${loss > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                      {loss}%
                    </div>
                  </div>
                </div>

                {/* Peak vs Off-Peak Highlight Bar */}
                <div className="pt-2 border-t border-white/[0.05] flex items-center justify-between text-[11px]">
                  {item.peak.samples > 0 ? (
                    <>
                      <span className="text-slate-400">
                        晚高峰{' '}
                        <span className="font-mono text-amber-300 font-semibold">
                          {item.peak.avgMs !== null ? `${item.peak.avgMs}ms` : '超时'}
                        </span>
                        {item.peak.lossPct > 0 && (
                          <span className="font-mono text-rose-400 ml-1">丢包 {item.peak.lossPct}%</span>
                        )}
                      </span>
                      {peakDelta !== undefined && (
                        <span
                          className={`font-mono font-semibold ${
                            peakDelta >= 30
                              ? 'text-rose-400'
                              : peakDelta >= 12
                                ? 'text-amber-300'
                                : 'text-emerald-400'
                          }`}
                        >
                          {peakDelta >= 0 ? `+${peakDelta}ms` : `${peakDelta}ms`}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-slate-500">
                      样本 {item.overall.samples} 条 · 20:00-24:00 自动对比晚高峰
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        )}
      </section>

      {/* TIER 2: Smokeping Latency + Jitter Band + Loss + Peak Hours SVG Chart */}
      <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Gauge className="w-4 h-4 text-sky-400" />
              {chartMode === 'single' && selectedSummary
                ? `${selectedSummary.target.name} · 延迟抖动与丢包曲线 (${range})`
                : `全部线路延迟对比 (${range})`}
              {loadingMon && monitor && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
              )}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              浅色阴影带 = Min–Max 瞬时抖动区间 · 红色竖条 = 丢包事件 · 淡琥珀背景 = 北京时间 20:00–24:00 晚高峰
            </p>
          </div>

          <div className="flex items-center bg-[#090b10] border border-white/[0.07] rounded-lg p-0.5 text-[11px]">
            <button
              onClick={() => setChartMode('single')}
              className={`px-2.5 py-1 rounded-md cursor-pointer ${
                chartMode === 'single' ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              单线 Smokeping 详情
            </button>
            <button
              onClick={() => setChartMode('multi')}
              className={`px-2.5 py-1 rounded-md cursor-pointer ${
                chartMode === 'multi' ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              多线叠加对比
            </button>
          </div>
        </div>

        {loadingMon && !monitor ? (
          <NetworkChartSkeleton />
        ) : !chartData ? (
          <div className="h-52 rounded-xl bg-[#090b10] border border-dashed border-white/10 flex flex-col items-center justify-center gap-2 text-xs text-slate-500">
            <span>当前时间窗口内暂无探针历史数据</span>
            <button
              onClick={handleProbeOnce}
              disabled={probing}
              className="text-sky-400 hover:text-sky-300 underline cursor-pointer"
            >
              立即采样一次
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="bg-[#090b10] rounded-xl border border-white/[0.05] p-2.5 sm:p-3.5">
              <div className="flex items-stretch">
                {/* Crisp HTML Y-Axis Labels (never stretched) */}
                <div className="w-10 sm:w-12 shrink-0 pr-2 sm:pr-2.5 py-1 flex flex-col justify-between text-right font-mono text-[10px] text-slate-500 leading-none select-none">
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                    <span key={ratio}>{Math.round(chartData.maxMs * (1 - ratio))}ms</span>
                  ))}
                </div>

                {/* Plot-only SVG with non-scaling strokes */}
                <svg
                  viewBox={`0 0 ${chartData.W} ${chartData.H}`}
                  className="flex-1 h-48 block overflow-visible"
                  preserveAspectRatio="none"
                >
                  {/* Peak hour (20:00-24:00 CST) shaded bands */}
                  {chartData.peakBands.map((b, i) => (
                    <rect
                      key={i}
                      x={b.x1}
                      y={chartData.padT}
                      width={Math.max(2, b.x2 - b.x1)}
                      height={chartData.innerH}
                      fill="rgba(251, 191, 36, 0.08)"
                    />
                  ))}

                  {/* Horizontal grid lines */}
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                    const y = chartData.padT + ratio * chartData.innerH;
                    return (
                      <line
                        key={ratio}
                        x1={0}
                        x2={chartData.W}
                        y1={y}
                        y2={y}
                        stroke="rgba(255,255,255,0.06)"
                        strokeDasharray="3 3"
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}

                  {/* Series rendering */}
                  {chartData.allSeries.map((series, sIdx) => {
                    const color = chartMode === 'single' ? '#38bdf8' : LINE_COLORS[sIdx % LINE_COLORS.length];
                    const valid = series.points.filter((p) => p.avgMs !== null);
                    if (valid.length === 0) return null;

                    const avgPath = valid
                      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${chartData.xOf(p.ts).toFixed(1)} ${chartData.yOf(p.avgMs!).toFixed(1)}`)
                      .join(' ');

                    // Min-Max smoke polygon in single mode
                    let smokePoly = '';
                    if (chartMode === 'single' && valid.length >= 2) {
                      const topPts = valid.map(
                        (p) => `${chartData.xOf(p.ts).toFixed(1)},${chartData.yOf(p.maxMs ?? p.avgMs!).toFixed(1)}`
                      );
                      const botPts = [...valid]
                        .reverse()
                        .map((p) => `${chartData.xOf(p.ts).toFixed(1)},${chartData.yOf(p.minMs ?? p.avgMs!).toFixed(1)}`);
                      smokePoly = [...topPts, ...botPts].join(' ');
                    }

                    return (
                      <g key={series.target.id}>
                        {smokePoly && <polygon points={smokePoly} fill="rgba(56, 189, 248, 0.16)" />}
                        <path
                          d={avgPath}
                          fill="none"
                          stroke={color}
                          strokeWidth={chartMode === 'single' ? 2 : 1.7}
                          vectorEffect="non-scaling-stroke"
                        />

                        {/* Loss vertical markers in single mode */}
                        {chartMode === 'single' &&
                          series.points
                            .filter((p) => p.lossPct > 0)
                            .map((p, i) => {
                              const x = chartData.xOf(p.ts);
                              const barH = Math.max(6, (p.lossPct / 100) * chartData.innerH);
                              return (
                                <rect
                                  key={i}
                                  x={x - 1.5}
                                  y={chartData.padT + chartData.innerH - barH}
                                  width={3}
                                  height={barH}
                                  fill="rgba(251, 113, 133, 0.85)"
                                />
                              );
                            })}
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Crisp HTML X-Axis Timestamps (never stretched) */}
              <div className="pl-10 sm:pl-12 pt-2.5 flex items-center justify-between font-mono text-[10px] text-slate-500 leading-none select-none">
                {[0, 0.25, 0.5, 0.75, 1].map((r, i) => {
                  const ts = chartData.minTs + (chartData.maxTs - chartData.minTs) * r;
                  return (
                    <span key={r} className={i === 1 || i === 3 ? 'hidden sm:inline' : ''}>
                      {formatClock(ts, range)}
                    </span>
                  );
                })}
              </div>
            </div>

            {chartMode === 'multi' && (
              <div className="flex flex-wrap items-center gap-3 text-[11px] pt-1">
                {(monitor?.targets || []).map((t, idx) => (
                  <span key={t.target.id} className="inline-flex items-center gap-1.5 text-slate-300">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: LINE_COLORS[idx % LINE_COLORS.length] }}
                    />
                    <span>{t.target.name}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* TIER 2.5: Live Proxy/Service Kernel TCP Health + Single-Thread Throughput & Route Detour */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left (6 cols): Zero-Traffic Live Kernel TCP Health (`ss -ti`) */}
        <div className="lg:col-span-6 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-300 flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5" />
                实时业务 / 代理连接内核体检（零流量）
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                直接读取内核 <span className="font-mono text-slate-400">ss -ti</span> 活跃连接的真实 RTT、BBR 速率与重传丢包
              </p>
            </div>
            <button
              onClick={loadLiveTcp}
              disabled={loadingTcp}
              className="flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 px-2.5 py-1.5 rounded-lg cursor-pointer shrink-0"
            >
              <RefreshCw className={`w-3 h-3 ${loadingTcp ? 'animate-spin text-sky-400' : ''}`} />
              <span>刷新</span>
            </button>
          </div>

          {loadingTcp && !liveTcp ? (
            <NetworkLiveTcpSkeleton />
          ) : !liveTcp || (liveTcp.ports.length === 0 && liveTcp.topPeers.length === 0) ? (
            <div className="h-36 rounded-xl bg-[#090b10] border border-dashed border-white/10 flex flex-col items-center justify-center text-xs text-slate-500 px-4 text-center">
              <span>当前暂无外部活跃 TCP 连接</span>
              <span className="text-[11px] text-slate-600 mt-1">
                当你正在通过本机代理刷网页或跑服务流量时，点击刷新即可看到真实连接的延迟与丢包重传
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Grouped by local service port */}
              {liveTcp.ports.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {liveTcp.ports.slice(0, 6).map((p) => (
                    <div
                      key={p.port}
                      className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3 space-y-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-white truncate">
                          :{p.port} <span className="text-slate-400 font-normal">({p.process})</span>
                        </span>
                        <span className="text-[10px] font-mono text-sky-300 bg-sky-500/10 border border-sky-400/20 px-1.5 py-0.2 rounded">
                          {p.activeCount} 连接
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-1 text-[10px] font-mono">
                        <div>
                          <div className="text-slate-500">内核 RTT</div>
                          <div className="text-slate-200">{p.avgRttMs !== null ? `${p.avgRttMs}ms` : '—'}</div>
                        </div>
                        <div>
                          <div className="text-slate-500">估算速率</div>
                          <div className="text-emerald-300">
                            {p.avgDeliveryMbps !== null ? `${p.avgDeliveryMbps}M` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-500">重传/丢包</div>
                          <div className={p.retransTotal + p.lostTotal > 0 ? 'text-amber-300' : 'text-emerald-400'}>
                            {p.retransTotal}/{p.lostTotal}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Top Active Peers */}
              {liveTcp.topPeers.length > 0 && (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                    主要活跃流 ({liveTcp.totalEstablished} 条 ESTABLISHED)
                  </div>
                  {liveTcp.topPeers.slice(0, 6).map((peer, idx) => (
                    <div
                      key={idx}
                      className="bg-[#090b10] border border-white/[0.04] rounded-lg px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] font-mono"
                    >
                      <span className="text-slate-300 truncate">
                        :{peer.localPort} ↔ {peer.remoteAddr}
                      </span>
                      <span className="flex items-center gap-2.5 shrink-0 text-[10px]">
                        <span className="text-sky-300">{peer.rttMs !== null ? `${peer.rttMs}ms` : '—'}</span>
                        {peer.deliveryMbps !== null && (
                          <span className="text-emerald-400">{peer.deliveryMbps}Mbps</span>
                        )}
                        <span className={peer.retrans > 0 ? 'text-amber-300' : 'text-slate-500'}>
                          重传 {peer.retrans}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right (6 cols): Single-Thread Throughput & Route Detour Checks */}
        <div className="lg:col-span-6 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-sky-300 flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5" />
                单线程吞吐 & 晚高峰切线检测
              </h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                抓出“延迟低但单线程限速”与“晚高峰自动绕路切线”（验机模式自动定时采集）
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={handleRunSpeedtest}
                disabled={runningSpeed || runningRoute}
                className="flex items-center gap-1 text-[11px] bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 text-sky-300 px-2.5 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
              >
                {runningSpeed ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                <span>{runningSpeed ? '测速中...' : '单线程测速'}</span>
              </button>
              <button
                onClick={handleRunRouteCheck}
                disabled={runningRoute || runningSpeed}
                className="flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-200 px-2.5 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
              >
                {runningRoute ? <Loader2 className="w-3 h-3 animate-spin" /> : <Route className="w-3 h-3 text-amber-400" />}
                <span>{runningRoute ? '追踪中...' : '路由跳数'}</span>
              </button>
            </div>
          </div>

          {/* Single-thread speed history */}
          <div className="space-y-2">
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              单线程实测速率 (最近记录)
            </div>
            {monitor && monitor.speedSamples.length > 0 ? (
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {monitor.speedSamples.slice(0, 6).map((s, idx) => (
                  <div
                    key={`${s.endpointId}-${s.ts}-${idx}`}
                    className="bg-[#090b10] border border-white/[0.05] rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-slate-200 truncate">{s.endpointName}</span>
                        {s.isPeak && (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-500/15 border border-amber-400/25 text-amber-300">
                            晚高峰
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-slate-500">
                        {formatClock(s.ts, range)} · TTFB {s.ttfbMs}ms · {formatBytes(s.bytes, 1)}
                      </div>
                    </div>
                    {s.error ? (
                      <span className="text-[11px] font-mono text-rose-400 shrink-0">{s.error}</span>
                    ) : (
                      <span
                        className={`font-mono font-semibold shrink-0 ${
                          s.mbps >= 100 ? 'text-emerald-400' : s.mbps >= 30 ? 'text-sky-300' : 'text-amber-300'
                        }`}
                      >
                        {s.mbps} Mbps
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-[#090b10] border border-dashed border-white/10 rounded-xl py-4 text-center text-[11px] text-slate-500">
                暂无单线程测速记录（点击右上角「单线程测速」或开启「新机验机」自动整点采集）
              </div>
            )}
          </div>

          {/* Route hop change snapshots */}
          <div className="space-y-2 pt-2 border-t border-white/[0.06]">
            <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              轻量路由跳数快照 (检测晚高峰切线)
            </div>
            {monitor && monitor.routeSnapshots.length > 0 ? (
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {monitor.routeSnapshots.slice(0, 6).map((r, idx) => (
                  <div
                    key={`${r.targetId}-${r.ts}-${idx}`}
                    className={`rounded-xl px-3 py-2 border text-xs space-y-1 ${
                      r.changed
                        ? 'bg-amber-500/[0.08] border-amber-400/30'
                        : 'bg-[#090b10] border-white/[0.05]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-medium text-white">{r.targetName}</span>
                        <span className="text-[10px] font-mono text-sky-300">{r.hopsCount} 跳</span>
                        {r.isPeak && (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-300">
                            晚高峰
                          </span>
                        )}
                        {r.changed && (
                          <span className="text-[9px] font-semibold px-1.5 py-0.2 rounded bg-rose-500/20 text-rose-300">
                            跳数突变更线
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono text-slate-500">
                        {formatClock(r.ts, range)} {r.finalMs !== null ? `· ${r.finalMs}ms` : ''}
                      </span>
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 truncate" title={r.hops.join('\n')}>
                      {r.pathSummary}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-[#090b10] border border-dashed border-white/10 rounded-xl py-4 text-center text-[11px] text-slate-500">
                暂无路由跳数快照（点击右上角「路由跳数」或开启「新机验机」每 30 分钟自动记录）
              </div>
            )}
          </div>
        </div>
      </section>

      {/* TIER 3: Host Network Profile & Kernel TCP Stack */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left (5 cols): Kernel TCP Stack & Socket States */}
        <div className="lg:col-span-5 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5 text-sky-400" />
              宿主机网络栈与内核调优
            </h3>
            <button onClick={loadProfile} className="text-slate-400 hover:text-white cursor-pointer">
              <RefreshCw className={`w-3.5 h-3.5 ${loadingProf ? 'animate-spin text-sky-400' : ''}`} />
            </button>
          </div>

          {!profile ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 space-y-2">
                    <Sk className="h-2.5 w-20 bg-white/[0.04]" />
                    <Sk className="h-4 w-24" />
                  </div>
                ))}
              </div>
              <div className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3.5 space-y-2">
                <Sk className="h-3 w-32 bg-white/[0.05]" />
                <div className="flex gap-2">
                  <Sk className="h-5 w-16 rounded-lg bg-white/[0.05]" />
                  <Sk className="h-5 w-20 rounded-lg bg-white/[0.05]" />
                  <Sk className="h-5 w-14 rounded-lg bg-white/[0.05]" />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">TCP 拥塞控制 / 队列</div>
                  <div className="mt-1 flex items-center gap-1.5 font-mono">
                    <span
                      className={`font-semibold ${
                        profile.tcpCc.includes('bbr') ? 'text-emerald-400' : 'text-amber-300'
                      }`}
                    >
                      {profile.tcpCc}
                    </span>
                    <span className="text-slate-600">/</span>
                    <span className="text-slate-200">{profile.qdisc}</span>
                  </div>
                </div>
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">默认出口网关</div>
                  <div className="mt-1 font-mono text-slate-200 truncate">
                    {profile.defaultGateway || '—'} {profile.defaultDev ? `(${profile.defaultDev})` : ''}
                  </div>
                </div>
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">公网 IPv4 / IPv6</div>
                  <div className="mt-1 font-mono text-white truncate">{profile.publicIpv4 || '—'}</div>
                  {profile.publicIpv6 && (
                    <div className="text-[10px] font-mono text-sky-300 truncate mt-0.5">{profile.publicIpv6}</div>
                  )}
                </div>
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">内核转发 / DNS</div>
                  <div className="mt-1 font-mono text-slate-200 truncate">
                    ip_forward={profile.ipForward ? '1' : '0'}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 truncate mt-0.5">
                    DNS: {profile.dnsServers.join(', ') || '—'}
                  </div>
                </div>
              </div>

              {/* TCP Socket States */}
              <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400 font-medium">当前 TCP 连接状态分布</span>
                  <span className="font-mono text-slate-300">总计 {profile.totalConns}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tcpEntries.map(([st, cnt]) => (
                    <span
                      key={st}
                      className={`text-[11px] font-mono px-2 py-0.5 rounded-lg border ${
                        st === 'ESTAB'
                          ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300'
                          : st === 'TIME-WAIT'
                            ? 'bg-amber-500/10 border-amber-500/20 text-amber-300'
                            : st === 'SYN-RECV'
                              ? 'bg-rose-500/12 border-rose-500/25 text-rose-300'
                              : 'bg-white/[0.04] border-white/[0.07] text-slate-300'
                      }`}
                    >
                      {st}: {cnt}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right (7 cols): NIC Interfaces & Drop Counters */}
        <div className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-3.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            网卡接口、MTU 与丢包计数 ({profile?.interfaces.length || 0})
          </h3>

          {!profile ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 space-y-2">
                    <Sk className="h-2.5 w-20 bg-white/[0.04]" />
                    <Sk className="h-4 w-24" />
                  </div>
                ))}
              </div>
              <div className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3.5 space-y-2">
                <Sk className="h-3 w-32 bg-white/[0.05]" />
                <div className="flex gap-2">
                  <Sk className="h-5 w-16 rounded-lg bg-white/[0.05]" />
                  <Sk className="h-5 w-20 rounded-lg bg-white/[0.05]" />
                  <Sk className="h-5 w-14 rounded-lg bg-white/[0.05]" />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {profile.interfaces.map((nic) => (
                <div
                  key={nic.name}
                  className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          nic.state === 'UP' || nic.name === 'tailscale0' ? 'bg-emerald-400' : 'bg-slate-500'
                        }`}
                      />
                      <span className="font-mono font-semibold text-white">{nic.name}</span>
                      <span className="text-[10px] font-mono text-slate-500">MTU {nic.mtu}</span>
                      {nic.mac && <span className="text-[10px] font-mono text-slate-600">{nic.mac}</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5 pl-4 font-mono text-[11px]">
                      {nic.ipv4.map((ip) => (
                        <span key={ip} className="text-sky-300 bg-sky-500/10 border border-sky-400/20 px-1.5 py-0.2 rounded">
                          {ip}
                        </span>
                      ))}
                      {nic.ipv6.map((ip) => (
                        <span key={ip} className="text-indigo-300 bg-indigo-500/10 border border-indigo-400/20 px-1.5 py-0.2 rounded truncate max-w-[240px]">
                          {ip}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-4 pl-4 sm:pl-0 font-mono text-[11px] shrink-0">
                    <div>
                      <div className="text-[10px] text-slate-500">累计入/出</div>
                      <div className="text-slate-200">
                        ↓{formatBytes(nic.rxBytes, 1)} / ↑{formatBytes(nic.txBytes, 1)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500">网卡丢包</div>
                      <div className={nic.rxDrops + nic.txDrops > 0 ? 'text-amber-300' : 'text-emerald-400'}>
                        {nic.rxDrops}/{nic.txDrops}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Edit Probe Targets Modal (Preset Library + Smart Quick Add + Current List) */}
      {editingTargets && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-[#0f131b] border border-white/10 rounded-2xl w-full max-w-3xl max-h-[92dvh] sm:max-h-[88vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Header + Tabs */}
            <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
              <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Globe className="w-4 h-4 text-sky-400" />
                  <span>探测目标库</span>
                </div>
                <div className="flex flex-wrap items-center bg-[#090b10] border border-white/[0.07] rounded-lg p-0.5 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setModalTab('presets')}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md cursor-pointer ${
                      modalTab === 'presets' ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Sparkles className="w-3 h-3" />
                    <span>一键预设库</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalTab('custom')}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md cursor-pointer ${
                      modalTab === 'custom' ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Plus className="w-3 h-3" />
                    <span>快捷自定义</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setModalTab('current')}
                    className={`px-2.5 py-1 rounded-md cursor-pointer ${
                      modalTab === 'current' ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    已选监控 ({targetsDraft.filter((t) => t.enabled).length}/{targetsDraft.length})
                  </button>
                </div>
              </div>
              <button onClick={() => setEditingTargets(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 sm:p-5 overflow-y-auto flex-1 space-y-5 text-xs">
              {modalTab === 'presets' && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="relative flex-1 min-w-[200px]">
                      <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        value={presetQuery}
                        onChange={(e) => setPresetQuery(e.target.value)}
                        placeholder="搜索城市、运营商或站点（如 深圳、联通、日本、OpenAI...）"
                        className="w-full bg-[#090b10] border border-white/10 focus:border-sky-400 focus:outline-none rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder:text-slate-500"
                      />
                    </div>
                    <span className="text-[11px] text-slate-500">点击卡片即可一键添加或取消</span>
                  </div>

                  {/* Managed Servers Quick互测 */}
                  {allServers.filter((s) => s.id !== snapshot.server.id).length > 0 && !presetQuery.trim() && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-sky-300 flex items-center gap-1.5">
                          <Server className="w-3.5 h-3.5" />
                          我的已纳管服务器（一键监测节点间晚高峰线路）
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {allServers
                          .filter((s) => s.id !== snapshot.server.id)
                          .map((srv) => {
                            const host = srv.publicIp || srv.tailscaleIp || srv.host;
                            const port = srv.jumpHost ? 443 : srv.port || 22;
                            const item: Omit<NetworkTarget, 'enabled'> = {
                              id: `srv-${srv.id}`,
                              name: `节点 · ${srv.name}`,
                              host,
                              port,
                              protocol: 'tcp',
                              group: '自定义',
                            };
                            const added = isTargetAdded(item.host, item.protocol, item.port);
                            return (
                              <button
                                key={srv.id}
                                type="button"
                                onClick={() => togglePresetTarget(item)}
                                className={`text-left px-3 py-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                                  added
                                    ? 'bg-emerald-500/12 border-emerald-500/35 text-emerald-200'
                                    : 'bg-[#090b10] border-white/[0.07] hover:border-sky-400/40 text-slate-200'
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="font-semibold truncate">{item.name}</div>
                                  <div className="text-[10px] font-mono text-slate-500 truncate">
                                    {host}:{port} (TCP)
                                  </div>
                                </div>
                                {added ? (
                                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : (
                                  <Plus className="w-4 h-4 text-slate-500 shrink-0" />
                                )}
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}

                  {/* Built-in Preset Categories */}
                  {PRESET_CATALOG.map((cat) => {
                    const q = presetQuery.trim().toLowerCase();
                    const filtered = cat.items.filter(
                      (it) =>
                        !q ||
                        it.name.toLowerCase().includes(q) ||
                        it.host.toLowerCase().includes(q) ||
                        it.group.toLowerCase().includes(q) ||
                        cat.label.toLowerCase().includes(q)
                    );
                    if (filtered.length === 0) return null;
                    return (
                      <div key={cat.id} className="space-y-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] font-semibold text-slate-200">{cat.label}</span>
                          <span className="text-[10px] text-slate-500">{cat.desc}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {filtered.map((item) => {
                            const added = isTargetAdded(item.host, item.protocol, item.port);
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => togglePresetTarget(item)}
                                className={`text-left px-3 py-2.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                                  added
                                    ? 'bg-emerald-500/12 border-emerald-500/35 text-emerald-200'
                                    : 'bg-[#090b10] border-white/[0.07] hover:border-sky-400/40 text-slate-200'
                                }`}
                              >
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${groupDotColor(item.group)}`} />
                                    <span className="font-semibold truncate">{item.name}</span>
                                  </div>
                                  <div className="text-[10px] font-mono text-slate-500 truncate pl-3">
                                    {item.host}{item.port ? `:${item.port}` : ''} · {item.protocol.toUpperCase()}
                                  </div>
                                </div>
                                {added ? (
                                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                                ) : (
                                  <Plus className="w-4 h-4 text-slate-500 shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}

              {modalTab === 'custom' && (
                <div className="space-y-4">
                  <div className="bg-[#090b10] border border-white/[0.07] rounded-xl p-4 space-y-3.5">
                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        直接粘贴网址、IP 或 host:port（自动识别协议与端口）
                      </label>
                      <input
                        value={customInput}
                        onChange={(e) => handleSmartInputChange(e.target.value)}
                        placeholder="例如：https://openai.com 、1.1.1.1:443 、你家宽带公网 IP 或目标域名"
                        className="w-full bg-[#0f131b] border border-white/10 focus:border-sky-400 focus:outline-none rounded-xl px-3 py-2.5 font-mono text-white placeholder:text-slate-600"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
                      <div className="sm:col-span-4">
                        <label className="block text-[10px] text-slate-400 mb-1">显示名称</label>
                        <input
                          value={customName}
                          onChange={(e) => setCustomName(e.target.value)}
                          placeholder="如：家里宽带 / 公司出口"
                          className="w-full bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:border-sky-400 focus:outline-none"
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <label className="block text-[10px] text-slate-400 mb-1">探测协议</label>
                        <select
                          value={customProto}
                          onChange={(e) => setCustomProto(e.target.value as 'icmp' | 'tcp')}
                          className="w-full bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 text-white"
                        >
                          <option value="tcp">TCP 端口握手（推荐）</option>
                          <option value="icmp">ICMP 普通 Ping</option>
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <label className="block text-[10px] text-slate-400 mb-1">端口</label>
                        <input
                          type="number"
                          disabled={customProto !== 'tcp'}
                          value={customProto === 'tcp' ? customPort : ''}
                          onChange={(e) => setCustomPort(Number(e.target.value) || 443)}
                          className="w-full bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 font-mono text-white disabled:opacity-35"
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <label className="block text-[10px] text-slate-400 mb-1">分组颜色</label>
                        <select
                          value={customGroup}
                          onChange={(e) => setCustomGroup(e.target.value)}
                          className="w-full bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 text-white"
                        >
                          <option value="自定义">自定义</option>
                          <option value="电信">电信</option>
                          <option value="联通">联通</option>
                          <option value="移动">移动</option>
                          <option value="国际">国际</option>
                        </select>
                      </div>
                    </div>

                    {/* Live Reachability Test Result */}
                    {singleTestErr && (
                      <div className="text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
                        {singleTestErr}
                      </div>
                    )}
                    {singleTestRes && (
                      <div
                        className={`rounded-lg px-3 py-2 border flex items-center justify-between gap-2 ${
                          singleTestRes.lossPct < 100
                            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200'
                            : 'bg-amber-500/10 border-amber-500/25 text-amber-200'
                        }`}
                      >
                        <div>
                          {singleTestRes.lossPct < 100 ? (
                            <span>
                              从 <b>{snapshot.server.name}</b> 连通正常 · 平均{' '}
                              <b className="font-mono">{singleTestRes.avgMs}ms</b> · 抖动{' '}
                              <b className="font-mono">{singleTestRes.jitterMs}ms</b> · 丢包{' '}
                              <b className="font-mono">{singleTestRes.lossPct}%</b>
                            </span>
                          ) : (
                            <span>
                              100% 丢包（目标可能禁 Ping 或端口未开放，建议切换{' '}
                              {customProto === 'icmp' ? 'TCP 443/80' : '其他端口或 ICMP'} 重试）
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleTestSingleTarget}
                        disabled={testingSingle || !customInput.trim()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 text-slate-200 cursor-pointer disabled:opacity-40"
                      >
                        {testingSingle ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3 h-3 text-emerald-400" />}
                        <span>先测通不通</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleAddCustomTarget}
                        disabled={!customInput.trim()}
                        className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer disabled:opacity-40"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>加入监控列表</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'current' && (
                <div className="space-y-2">
                  {targetsDraft.map((t, idx) => (
                    <div
                      key={t.id || idx}
                      className="bg-[#090b10] border border-white/[0.07] rounded-xl p-3 grid grid-cols-6 sm:grid-cols-12 gap-2 items-center"
                    >
                      <input
                        className="col-span-3 bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 text-white focus:border-sky-400 focus:outline-none"
                        placeholder="名称"
                        value={t.name}
                        onChange={(e) => {
                          const next = [...targetsDraft];
                          next[idx] = { ...t, name: e.target.value };
                          setTargetsDraft(next);
                        }}
                      />
                      <input
                        className="col-span-3 bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 font-mono text-white focus:border-sky-400 focus:outline-none"
                        placeholder="IP 或域名"
                        value={t.host}
                        onChange={(e) => {
                          const next = [...targetsDraft];
                          next[idx] = { ...t, host: e.target.value };
                          setTargetsDraft(next);
                        }}
                      />
                      <select
                        className="col-span-2 bg-[#0f131b] border border-white/10 rounded-lg px-1.5 py-1.5 text-white"
                        value={t.protocol}
                        onChange={(e) => {
                          const next = [...targetsDraft];
                          next[idx] = {
                            ...t,
                            protocol: e.target.value as 'icmp' | 'tcp',
                            port: e.target.value === 'tcp' ? t.port || 443 : undefined,
                          };
                          setTargetsDraft(next);
                        }}
                      >
                        <option value="icmp">ICMP</option>
                        <option value="tcp">TCP</option>
                      </select>
                      <input
                        type="number"
                        disabled={t.protocol !== 'tcp'}
                        placeholder="端口"
                        className="col-span-2 bg-[#0f131b] border border-white/10 rounded-lg px-2 py-1.5 font-mono text-white disabled:opacity-35"
                        value={t.protocol === 'tcp' ? t.port || 443 : ''}
                        onChange={(e) => {
                          const next = [...targetsDraft];
                          next[idx] = { ...t, port: Number(e.target.value) || 443 };
                          setTargetsDraft(next);
                        }}
                      />
                      <div className="col-span-2 flex items-center justify-end gap-2">
                        <input
                          type="checkbox"
                          checked={t.enabled}
                          onChange={(e) => {
                            const next = [...targetsDraft];
                            next[idx] = { ...t, enabled: e.target.checked };
                            setTargetsDraft(next);
                          }}
                          className="accent-sky-500 cursor-pointer"
                        />
                        <button
                          type="button"
                          onClick={() => setTargetsDraft(targetsDraft.filter((_, i) => i !== idx))}
                          className="text-slate-500 hover:text-rose-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {targetsDraft.length === 0 && (
                    <div className="text-center py-8 text-slate-500">
                      当前列表为空，请切换到「一键预设库」或「快捷自定义」添加目标
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Sticky Footer */}
            <div className="px-4 sm:px-5 py-3.5 border-t border-white/[0.06] bg-[#0b0e15] flex flex-wrap items-center justify-between gap-2 shrink-0 text-xs">
              <span className="text-slate-400">
                当前已选 <b className="text-sky-300 font-mono">{targetsDraft.filter((t) => t.enabled).length}</b> 条探针（每 60s 持续采集）
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingTargets(false)}
                  className="px-3 py-1.5 text-slate-400 hover:text-white cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleSaveTargets}
                  disabled={savingTargets || targetsDraft.filter((t) => t.enabled).length === 0}
                  className="px-4 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer disabled:opacity-40"
                >
                  {savingTargets ? '保存并采样中...' : '保存并立即采样'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
