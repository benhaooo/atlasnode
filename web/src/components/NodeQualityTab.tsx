import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  ExternalLink,
  Globe,
  HardDrive,
  Loader2,
  Mail,
  Network,
  Play,
  Route,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Tv,
  XCircle,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import type { AutoNQConfig, NodeQualityMode, NodeQualityRun, ServerSnapshot } from '../types';
import { countryFlag, formatDateTime, formatRelativeTime } from '../utils';
import { NodeQualitySkeleton } from './Skeleton';

interface NodeQualityTabProps {
  snapshot: ServerSnapshot;
  onRefreshSnapshot: () => void;
}

const MODE_LABELS: Record<NodeQualityMode, { label: string; desc: string }> = {
  fast: { label: '快速低流量 (推荐)', desc: '硬件快速 + IP 质量 + 低流量网络 + 三网回程' },
  full: { label: '完整标准测试', desc: '全量硬件 + IP 质量 + 标准网络测速 + 三网回程' },
  ip_hw: { label: '仅 IP 与硬件', desc: '跳过网络与回程，最快查看解锁与风险' },
  net: { label: '仅网络与回程', desc: '低流量网络质量 + 三网回程追踪' },
};

const ISP_META = {
  电信: { short: '电', code: 'CT', dot: 'bg-sky-400', badge: 'bg-sky-500/15 text-sky-300 border-sky-400/30', text: 'text-sky-300' },
  联通: { short: '联', code: 'CU', dot: 'bg-orange-400', badge: 'bg-orange-500/15 text-orange-300 border-orange-400/30', text: 'text-orange-300' },
  移动: { short: '移', code: 'CM', dot: 'bg-emerald-400', badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30', text: 'text-emerald-300' },
} as const;

const SERVICE_BADGE: Record<string, { abbr: string; bg: string }> = {
  TikTok: { abbr: 'TT', bg: 'bg-pink-500/15 text-pink-300 border-pink-400/25' },
  'Disney+': { abbr: 'D+', bg: 'bg-blue-500/15 text-blue-300 border-blue-400/25' },
  Netflix: { abbr: 'NF', bg: 'bg-red-500/15 text-red-300 border-red-400/25' },
  YouTube: { abbr: 'YT', bg: 'bg-rose-500/15 text-rose-300 border-rose-400/25' },
  Youtube: { abbr: 'YT', bg: 'bg-rose-500/15 text-rose-300 border-rose-400/25' },
  'Amazon PV': { abbr: 'PV', bg: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/25' },
  AmazonPV: { abbr: 'PV', bg: 'bg-cyan-500/15 text-cyan-300 border-cyan-400/25' },
  Reddit: { abbr: 'RD', bg: 'bg-orange-500/15 text-orange-300 border-orange-400/25' },
  ChatGPT: { abbr: 'AI', bg: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/25' },
};

function latencyColor(val?: string | number): string {
  const n = Number(val);
  if (val === undefined || val === '' || Number.isNaN(n)) return 'text-slate-600';
  if (n < 40) return 'text-emerald-400';
  if (n < 80) return 'text-sky-300';
  if (n < 150) return 'text-amber-300';
  return 'text-rose-400';
}

function latencyBarColor(val?: string | number): string {
  const n = Number(val);
  if (val === undefined || val === '' || Number.isNaN(n)) return 'bg-slate-700';
  if (n < 40) return 'bg-emerald-400';
  if (n < 80) return 'bg-sky-400';
  if (n < 150) return 'bg-amber-400';
  return 'bg-rose-400';
}

function routePillStyle(lineType?: string): string {
  if (!lineType) return 'bg-white/[0.04] text-slate-400 border-white/10';
  const u = lineType.toUpperCase();
  if (u.includes('CN2') || u.includes('9929') || u.includes('CMIN2') || u.includes('CTG')) {
    return 'bg-emerald-500/12 text-emerald-300 border-emerald-400/30';
  }
  if (u.includes('4837') || u.includes('CMI')) {
    return 'bg-sky-500/12 text-sky-300 border-sky-400/25';
  }
  return 'bg-white/[0.05] text-slate-300 border-white/10';
}

function parseRiskPercent(score: string): number {
  const m = score.match(/(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (score.includes('%')) return Math.min(100, Math.max(0, n));
  return Math.min(100, Math.max(0, n));
}

export const NodeQualityTab: React.FC<NodeQualityTabProps> = ({ snapshot, onRefreshSnapshot }) => {
  const [runs, setRuns] = useState<NodeQualityRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<NodeQualityRun | null>(null);
  const [mode, setMode] = useState<NodeQualityMode>('fast');
  const [loading, setLoading] = useState(true);
  const [activeJob, setActiveJob] = useState<{
    id: string;
    mode: NodeQualityMode;
    phase: string;
    startedAt: string;
  } | null>(null);
  const [streamLines, setStreamLines] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [showRawLogs, setShowRawLogs] = useState(false);
  const [rawLogTab, setRawLogTab] = useState<'ip' | 'hardware' | 'net' | 'backroute' | 'json' | 'combined'>('ip');
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);
  const [autoCfg, setAutoCfg] = useState<AutoNQConfig>({
    enabled: false,
    intervalDays: 7,
    mode: 'fast',
    alertOnDegrade: true,
  });
  const [savingAuto, setSavingAuto] = useState(false);

  useEffect(() => {
    api
      .getNodeQualitySchedule()
      .then((res) => setAutoCfg(res.config))
      .catch(() => {});
  }, []);

  const updateAutoCfg = async (next: AutoNQConfig) => {
    setAutoCfg(next);
    setSavingAuto(true);
    try {
      const res = await api.saveNodeQualitySchedule(next);
      setAutoCfg(res.config);
    } catch {
      // ignore transient error
    } finally {
      setSavingAuto(false);
    }
  };

  const logEndRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const loadList = async (preferredRunId?: string) => {
    setLoading(true);
    try {
      const res = await api.listNodeQuality(snapshot.server.id);
      setRuns(res.runs);
      if (res.activeJob) {
        setActiveJob({
          id: res.activeJob.id,
          mode: res.activeJob.mode,
          phase: res.activeJob.phase,
          startedAt: res.activeJob.startedAt,
        });
        setStreamLines(res.activeJob.logLines || []);
        connectStream();
      } else {
        setActiveJob(null);
      }

      const targetId =
        preferredRunId ||
        res.runs.find((r) => r.status === 'completed')?.id ||
        res.runs[0]?.id;

      if (targetId) {
        const detail = await api.getNodeQualityRun(snapshot.server.id, targetId);
        setSelectedRun(detail.run);
      } else {
        setSelectedRun(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 NodeQuality 记录失败');
    } finally {
      setLoading(false);
    }
  };

  const connectStream = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    const es = new EventSource(
      `/api/servers/${encodeURIComponent(snapshot.server.id)}/nodequality/stream`,
      { withCredentials: true }
    );
    esRef.current = es;

    es.addEventListener('init', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setActiveJob({ id: data.id, mode: data.mode, phase: data.phase, startedAt: data.startedAt });
      setStreamLines(data.lines || []);
    });
    es.addEventListener('phase', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setActiveJob((prev) => (prev ? { ...prev, phase: data.phase } : prev));
    });
    es.addEventListener('log', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      setStreamLines((prev) => [...prev.slice(-600), data.line]);
    });
    es.addEventListener('done', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data);
      es.close();
      esRef.current = null;
      setActiveJob(null);
      loadList(data.runId);
      onRefreshSnapshot();
    });
    es.addEventListener('idle', () => {
      es.close();
      esRef.current = null;
      setActiveJob(null);
    });
  };

  useEffect(() => {
    setRuns([]);
    setSelectedRun(null);
    setActiveJob(null);
    setLoading(true);
    loadList();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [snapshot.server.id]);

  useEffect(() => {
    if (activeJob) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamLines.length, activeJob]);

  const handleStart = async () => {
    setStarting(true);
    setError('');
    try {
      const { run } = await api.startNodeQuality(snapshot.server.id, mode);
      setActiveJob({ id: run.id, mode: run.mode, phase: run.phase || '启动中...', startedAt: run.startedAt });
      setStreamLines([`[AtlasNode] 已启动 NodeQuality 测试 (${MODE_LABELS[mode].label})...`]);
      connectStream();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动测试失败');
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    await api.cancelNodeQuality(snapshot.server.id);
    esRef.current?.close();
    setActiveJob(null);
    loadList();
  };

  const handleSelectRun = async (runId: string) => {
    const detail = await api.getNodeQualityRun(snapshot.server.id, runId);
    setSelectedRun(detail.run);
  };

  const handleDeleteRun = async (runId: string) => {
    if (!confirm('确认删除这条历史测试记录？')) return;
    await api.deleteNodeQuality(snapshot.server.id, runId);
    loadList();
  };

  const summary = selectedRun?.summary;
  const usableUnlocks =
    summary?.unlocks.filter((u) => ['native', 'unlocked', 'dns', 'app_only'].includes(u.status)).length || 0;

  // Split risk factors into active providers vs all-empty providers (removes table dead weight!)
  const { activeFactors, emptyFactorNames } = useMemo(() => {
    const all = summary?.ip.riskFactors || [];
    const active = [];
    const empty: string[] = [];
    for (const r of all) {
      const hasAny = [r.country, r.proxy, r.tor, r.vpn, r.server, r.abuser, r.robot].some(
        (v) => v && v !== '—' && v !== '无'
      );
      if (hasAny) active.push(r);
      else empty.push(r.provider);
    }
    return { activeFactors: active, emptyFactorNames: empty };
  }, [summary?.ip.riskFactors]);

  // Structured 3-city × TCP/UDP route matrix
  const routeMatrixRows = useMemo(() => {
    if (!summary?.network.routes?.length) return [];
    const grouped = new Map<string, { city: string; proto: string; ct?: string; cu?: string; cm?: string }>();
    for (const r of summary.network.routes) {
      const proto = r.proto || 'TCP';
      const key = `${r.city}-${proto}`;
      if (!grouped.has(key)) grouped.set(key, { city: r.city, proto });
      const row = grouped.get(key)!;
      if (r.isp === '电信') row.ct = r.lineType;
      else if (r.isp === '联通') row.cu = r.lineType;
      else if (r.isp === '移动') row.cm = r.lineType;
    }
    return Array.from(grouped.values());
  }, [summary?.network.routes]);

  // Compute 3-ISP national average latencies for instant summary
  const delayAverages = useMemo(() => {
    const list = summary?.network.delays || [];
    const avg = (key: 'ct' | 'cu' | 'cm') => {
      const nums = list.map((d) => Number(d[key])).filter((n) => Number.isFinite(n) && n > 0);
      return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
    };
    return { ct: avg('ct'), cu: avg('cu'), cm: avg('cm') };
  }, [summary?.network.delays]);

  // Sort global transfers fastest -> slowest so visual latency curve reads naturally
  const sortedTransfers = useMemo(() => {
    return [...(summary?.network.transfers || [])].sort(
      (a, b) => (Number(a.delayMs) || 9999) - (Number(b.delayMs) || 9999)
    );
  }, [summary?.network.transfers]);

  const formatRawTabContent = () => {
    if (!selectedRun) return '';
    if (rawLogTab === 'json') {
      const hasJson = selectedRun.rawJson && Object.values(selectedRun.rawJson).some(Boolean);
      return hasJson
        ? JSON.stringify(selectedRun.rawJson, null, 2)
        : '(该次历史测试未捕获到原始 JSON，请重新运行一次测试即可生成完整结构化 JSON)';
    }
    return selectedRun.logs?.[rawLogTab] || '(该模块本次未运行或无日志输出)';
  };

  const ipFlag = countryFlag(summary?.ip.country);
  const regFlag = countryFlag(summary?.ip.registeredCountry);

  return (
    <div className="space-y-5">
      {/* Top Control Strip */}
      <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400 shrink-0" />
              <h2 className="text-sm font-semibold text-white">NodeQuality 服务器质检报告</h2>
              <span className="text-[10px] font-mono text-slate-500 bg-white/[0.04] px-2 py-0.5 rounded">
                Hardware · IP · Net · Backroute
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              直观呈现出口归属、IP 纯净度、流媒体解锁、三网回程质量与全球节点延迟
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as NodeQualityMode)}
              disabled={Boolean(activeJob)}
              className="bg-[#090b10] border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 focus:border-sky-400 focus:outline-none"
            >
              {(Object.keys(MODE_LABELS) as NodeQualityMode[]).map((k) => (
                <option key={k} value={k}>
                  {MODE_LABELS[k].label}
                </option>
              ))}
            </select>

            {activeJob ? (
              <button
                onClick={handleCancel}
                className="flex items-center gap-1.5 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 font-medium text-xs px-4 py-2 rounded-xl cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
                <span>中止测试</span>
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={starting || !snapshot.online}
                className="flex items-center gap-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-semibold text-xs px-4 py-2 rounded-xl transition-colors cursor-pointer"
              >
                {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                <span>{runs.length > 0 ? '重新测试' : '开始测试'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Hands-off Auto-Recheck Bar */}
        <div className="pt-3 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2.5 text-[11px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-slate-300 font-medium">
              <Clock className="w-3.5 h-3.5 text-sky-400" />
              全节点自动复测
            </span>
            <div className="inline-flex items-center bg-[#090b10] border border-white/[0.07] rounded-lg p-0.5 font-mono">
              {[
                { label: '关闭', enabled: false, days: autoCfg.intervalDays },
                { label: '每7天', enabled: true, days: 7 },
                { label: '每14天', enabled: true, days: 14 },
                { label: '每30天', enabled: true, days: 30 },
              ].map((opt) => {
                const active = opt.enabled ? autoCfg.enabled && autoCfg.intervalDays === opt.days : !autoCfg.enabled;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={savingAuto}
                    onClick={() => updateAutoCfg({ ...autoCfg, enabled: opt.enabled, intervalDays: opt.days })}
                    className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                      active ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {savingAuto && <Loader2 className="w-3 h-3 animate-spin text-sky-400" />}
          </div>

          <label className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCfg.alertOnDegrade}
              onChange={(e) => updateAutoCfg({ ...autoCfg, alertOnDegrade: e.target.checked })}
              className="accent-sky-500 cursor-pointer"
            />
            <span>IP 风控升高或核心解锁失效时自动推送告警（需在设置中配置通知渠道）</span>
          </label>
        </div>
      </section>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* Live Streaming Runner */}
      {activeJob && (
        <section className="bg-[#0c0f16] border border-amber-400/30 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 bg-amber-500/[0.08] border-b border-amber-400/20 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Activity className="w-4 h-4 text-amber-400 animate-pulse" />
              <span className="font-semibold text-amber-200">{activeJob.phase}</span>
              <span className="text-[11px] font-mono text-slate-400">
                模式: {MODE_LABELS[activeJob.mode]?.label} · 预计 1.5 ~ 4 分钟
              </span>
            </div>
            <span className="text-[11px] font-mono text-amber-300/80">LIVE STREAM</span>
          </div>
          <div className="h-64 overflow-y-auto p-4 bg-[#07090d] font-mono text-[11px] leading-relaxed text-slate-300 space-y-0.5">
            {streamLines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </section>
      )}

      {/* History Switcher + Official Links */}
      {runs.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-500">测试历史:</span>
            {runs.slice(0, 6).map((r) => (
              <button
                key={r.id}
                onClick={() => handleSelectRun(r.id)}
                className={`px-3 py-1 rounded-lg border font-mono text-[11px] transition-colors cursor-pointer ${
                  selectedRun?.id === r.id
                    ? 'bg-sky-500/15 border-sky-400/35 text-sky-300'
                    : 'bg-[#0f131b] border-white/[0.07] text-slate-400 hover:text-white'
                }`}
              >
                {formatDateTime(r.startedAt)} · {r.mode}
                {r.status !== 'completed' ? ` (${r.status})` : ''}
              </button>
            ))}
          </div>

          {selectedRun && (
            <div className="flex items-center gap-2 flex-wrap">
              {selectedRun.reportUrl && (
                <a
                  href={selectedRun.reportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/25 text-sky-300 px-2.5 py-1 rounded-lg font-mono"
                >
                  <span>NodeQuality 报告</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {summary?.ip.reportSvgUrl && (
                <a
                  href={summary.ip.reportSvgUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-slate-300 px-2.5 py-1 rounded-lg font-mono"
                >
                  <span>IP 图</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {summary?.hardware.reportSvgUrl && (
                <a
                  href={summary.hardware.reportSvgUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-slate-300 px-2.5 py-1 rounded-lg font-mono"
                >
                  <span>硬件图</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {summary?.network.reportSvgUrl && (
                <a
                  href={summary.network.reportSvgUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-slate-300 px-2.5 py-1 rounded-lg font-mono"
                >
                  <span>网络图</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <button
                onClick={() => handleDeleteRun(selectedRun.id)}
                className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 cursor-pointer"
                title="删除此报告"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Main Visual Report */}
      {loading && !selectedRun ? (
        <NodeQualitySkeleton />
      ) : !selectedRun || !summary ? (
        <div className="bg-[#0f131b] border border-dashed border-white/10 rounded-2xl p-12 text-center space-y-3">
          <Zap className="w-8 h-8 text-slate-600 mx-auto" />
          <div className="text-sm font-medium text-slate-300">暂无 NodeQuality 质检报告</div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            点击右上角「开始测试」，自动运行 NodeQuality 并以可视化方式呈现 IP、解锁、硬件与三网回程。
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* TIER 1: Executive Verdict Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5">
            {/* IP Identity with Flags */}
            <div className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 space-y-2">
              <div className="text-[11px] text-slate-500 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-sky-400" />
                  IP 归属与性质
                </span>
                {summary.ip.ipType && (
                  <span
                    className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                      summary.ip.isNative
                        ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                        : 'bg-amber-500/12 border-amber-400/25 text-amber-300'
                    }`}
                  >
                    {summary.ip.ipType}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {ipFlag && <span className="text-xl leading-none">{ipFlag}</span>}
                <div className="min-w-0">
                  <div className="text-sm font-semibold font-mono text-white">
                    {summary.ip.ipv4 || snapshot.publicIp || '—'}
                  </div>
                  <div className="text-[11px] text-slate-300 truncate">
                    <span className="font-mono text-sky-300">{summary.ip.asn || '—'}</span>
                    {summary.ip.org ? ` · ${summary.ip.org}` : ''}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 pt-0.5 flex-wrap">
                <span className="inline-flex items-center gap-1 bg-white/[0.04] px-2 py-0.5 rounded-md">
                  {ipFlag} {summary.ip.country?.replace(/\[[A-Z]{2}\]\s*/, '') || '—'}
                </span>
                {summary.ip.registeredCountry && (
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    注册 {regFlag} {summary.ip.registeredCountry.replace(/\[[A-Z]{2}\]\s*/, '')}
                  </span>
                )}
              </div>
            </div>

            {/* Risk & Visual Blacklist Bar */}
            <div className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 space-y-2">
              <div className="text-[11px] text-slate-500 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  风控与黑名单
                </span>
                <span
                  className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${
                    summary.ip.riskLevel === 'low'
                      ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                      : summary.ip.riskLevel === 'medium'
                        ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                        : summary.ip.riskLevel === 'high'
                          ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                          : 'bg-white/5 border-white/10 text-slate-400'
                  }`}
                >
                  {summary.ip.riskLevel === 'low'
                    ? '纯净低风险'
                    : summary.ip.riskLevel === 'medium'
                      ? '中等风险'
                      : summary.ip.riskLevel === 'high'
                        ? '高风险'
                        : '待评估'}
                </span>
              </div>

              {summary.ip.blacklistTotal ? (
                <>
                  <div className="flex items-baseline justify-between font-mono">
                    <span className="text-sm font-semibold text-white">
                      黑名单{' '}
                      <span className={(summary.ip.blacklistHit ?? 0) === 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {summary.ip.blacklistHit ?? 0}
                      </span>
                      <span className="text-slate-500 text-xs"> / {summary.ip.blacklistTotal}</span>
                    </span>
                    <span className="text-[10px] text-slate-400">
                      正常 {summary.ip.blacklistClean ?? 0} · 标记 {summary.ip.blacklistMarked ?? 0}
                    </span>
                  </div>
                  {/* Segmented cleanliness bar */}
                  <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden flex">
                    <div
                      className="bg-emerald-400/90 h-full"
                      style={{
                        width: `${((summary.ip.blacklistClean ?? 0) / summary.ip.blacklistTotal) * 100}%`,
                      }}
                    />
                    <div
                      className="bg-amber-400/80 h-full"
                      style={{
                        width: `${((summary.ip.blacklistMarked ?? 0) / summary.ip.blacklistTotal) * 100}%`,
                      }}
                    />
                    <div
                      className="bg-rose-500 h-full"
                      style={{
                        width: `${((summary.ip.blacklistHit ?? 0) / summary.ip.blacklistTotal) * 100}%`,
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="text-sm font-semibold font-mono text-white">
                  {summary.ip.riskSources.length} 个风控库已评估
                </div>
              )}

              <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <Mail className="w-3 h-3" />
                <span>25 端口出站:</span>
                <span className={summary.ip.mailPort25 === '开放' ? 'text-emerald-400' : 'text-slate-400'}>
                  {summary.ip.mailPort25 || '未测'}
                </span>
              </div>
            </div>

            {/* Unlocks Summary */}
            <div className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 space-y-2">
              <div className="text-[11px] text-slate-500 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Tv className="w-3.5 h-3.5 text-indigo-400" />
                  流媒体 & AI 解锁
                </span>
                <span className="font-mono text-xs font-semibold text-white">
                  {usableUnlocks}/{summary.unlocks.length || '—'}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {summary.unlocks.map((u) => {
                  const flag = countryFlag(u.region);
                  return (
                    <span
                      key={u.service}
                      title={`${u.service}: ${u.detail || u.statusText || u.status}`}
                      className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-md border ${
                        u.status === 'native' || u.status === 'unlocked'
                          ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300'
                          : u.status === 'dns'
                            ? 'bg-sky-500/12 border-sky-500/25 text-sky-300'
                            : u.status === 'app_only'
                              ? 'bg-amber-500/12 border-amber-500/25 text-amber-300'
                              : u.status === 'failed'
                                ? 'bg-white/[0.04] border-white/10 text-slate-500'
                                : 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                      }`}
                    >
                      {flag && <span>{flag}</span>}
                      <span>{u.service}</span>
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Three-ISP Latency & Route Headline */}
            <div className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 space-y-2">
              <div className="text-[11px] text-slate-500 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Network className="w-3.5 h-3.5 text-sky-400" />
                  三网均延 & 协议栈
                </span>
                <span className="text-[10px] font-mono text-slate-500">
                  {formatRelativeTime(selectedRun.finishedAt || selectedRun.startedAt)}
                </span>
              </div>
              {delayAverages.ct || delayAverages.cu || delayAverages.cm ? (
                <div className="grid grid-cols-3 gap-1.5 font-mono">
                  {(
                    [
                      ['电信', delayAverages.ct],
                      ['联通', delayAverages.cu],
                      ['移动', delayAverages.cm],
                    ] as const
                  ).map(([isp, ms]) => {
                    const meta = ISP_META[isp];
                    return (
                      <div key={isp} className="bg-[#090b10] border border-white/[0.05] rounded-lg px-2 py-1.5 text-center">
                        <div className="flex items-center justify-center gap-1 text-[10px] text-slate-400">
                          <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                          <span>{meta.short}</span>
                        </div>
                        <div className={`text-xs font-semibold mt-0.5 ${latencyColor(ms ?? undefined)}`}>
                          {ms ? `${ms}ms` : '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs font-semibold text-white truncate">
                  {summary.hardware.cpuModel || snapshot.cpuModel || '—'}
                </div>
              )}
              <div className="text-[11px] font-mono text-slate-400 flex items-center justify-between">
                <span>
                  {summary.network.local?.tcpCc
                    ? `TCP ${summary.network.local.tcpCc}/${summary.network.local.qdisc || 'fq'}`
                    : summary.hardware.virtualization || 'Linux'}
                </span>
                {summary.network.routes[0]?.lineType && (
                  <span className="text-emerald-300 font-semibold">
                    {summary.network.routes[0].lineType.split('->').pop()}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* TIER 2A: Visual Streaming & AI Cards (Full width compact scorecard) */}
          {summary.unlocks.length > 0 && (
            <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Tv className="w-3.5 h-3.5 text-indigo-400" />
                  流媒体与 AI 平台解锁
                </h3>
                <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> 原生</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sky-400" /> DNS</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> 仅APP</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-400" /> 屏蔽</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
                {summary.unlocks.map((u) => {
                  const badge = SERVICE_BADGE[u.service] || {
                    abbr: u.service.slice(0, 2).toUpperCase(),
                    bg: 'bg-white/[0.06] text-slate-300 border-white/10',
                  };
                  const flag = countryFlag(u.region);
                  const statusTone =
                    u.status === 'native' || u.status === 'unlocked'
                      ? 'border-emerald-500/25 bg-emerald-500/[0.05]'
                      : u.status === 'dns'
                        ? 'border-sky-500/25 bg-sky-500/[0.05]'
                        : u.status === 'app_only'
                          ? 'border-amber-500/25 bg-amber-500/[0.05]'
                          : u.status === 'failed'
                            ? 'border-white/[0.06] bg-[#090b10]'
                            : 'border-rose-500/20 bg-rose-500/[0.04]';
                  const pillTone =
                    u.status === 'native' || u.status === 'unlocked'
                      ? 'text-emerald-300'
                      : u.status === 'dns'
                        ? 'text-sky-300'
                        : u.status === 'app_only'
                          ? 'text-amber-300'
                          : u.status === 'failed'
                            ? 'text-slate-500'
                            : 'text-rose-400';

                  return (
                    <div
                      key={u.service}
                      className={`rounded-xl border p-3 flex flex-col justify-between gap-2.5 ${statusTone}`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className={`w-6 h-6 rounded-lg border text-[10px] font-mono font-bold flex items-center justify-center ${badge.bg}`}>
                          {badge.abbr}
                        </span>
                        {flag ? (
                          <span className="text-sm leading-none" title={u.region}>
                            {flag}
                          </span>
                        ) : (
                          <span className="text-[10px] font-mono text-slate-600">—</span>
                        )}
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-white truncate">{u.service}</div>
                        <div className="flex items-center justify-between gap-1 mt-1 text-[10px] font-mono">
                          <span className={`font-semibold ${pillTone}`}>
                            {u.status === 'failed'
                              ? '检测失败'
                              : u.status === 'dns'
                                ? 'DNS 解锁'
                                : u.status === 'native'
                                  ? '原生解锁'
                                  : u.statusText || u.status}
                          </span>
                          {u.region && <span className="text-slate-400">{u.region}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* TIER 2B: Risk Gauges + Compact Visual Risk Factor Matrix */}
          {(summary.ip.riskSources.length > 0 || activeFactors.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Left 5 cols: Risk Score Gauges + Type Matrix */}
              <section className="lg:col-span-5 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                  风控库评分与 IP 属性
                </h3>

                <div className="space-y-2.5">
                  {summary.ip.riskSources.map((src) => {
                    const pct = parseRiskPercent(src.score);
                    const barCol =
                      src.level === 'low'
                        ? 'bg-emerald-400'
                        : src.level === 'medium'
                          ? 'bg-amber-400'
                          : 'bg-rose-500';
                    const txtCol =
                      src.level === 'low'
                        ? 'text-emerald-400'
                        : src.level === 'medium'
                          ? 'text-amber-300'
                          : 'text-rose-400';
                    return (
                      <div key={src.name} className="bg-[#090b10] border border-white/[0.05] rounded-xl px-3 py-2">
                        <div className="flex items-center justify-between text-xs mb-1.5">
                          <span className="font-mono text-slate-300">{src.name}</span>
                          <span className={`font-mono text-[11px] font-medium ${txtCol}`}>{src.score}</span>
                        </div>
                        <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${barCol}`}
                            style={{ width: `${Math.max(4, pct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {summary.ip.typeMatrix && summary.ip.typeMatrix.length > 0 && (
                  <div className="pt-3 border-t border-white/[0.06] space-y-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      各库属性判定（使用类型 / 公司类型）
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {summary.ip.typeMatrix.map((row) => (
                        <span
                          key={row.provider}
                          className="text-[11px] bg-[#090b10] border border-white/[0.06] rounded-lg px-2.5 py-1 text-slate-300"
                        >
                          <span className="font-mono text-slate-500 mr-1.5">{row.provider}</span>
                          <span>{row.usage || '—'}</span>
                          {row.company && row.company !== row.usage && (
                            <span className="text-slate-500">/{row.company}</span>
                          )}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* Right 7 cols: Compact Icon-based Risk Factor Matrix */}
              <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-3">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                      风险因子交叉判定
                    </h3>
                    <div className="flex items-center gap-3 text-[10px] text-slate-500">
                      <span className="flex items-center gap-1"><Check className="w-3 h-3 text-emerald-400" /> 干净</span>
                      <span className="flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-amber-400" /> 风险</span>
                      <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400/80" /> 机房</span>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs whitespace-nowrap">
                      <thead>
                        <tr className="text-[11px] text-slate-500 border-b border-white/[0.06]">
                          <th className="pb-2 text-left font-medium">数据库</th>
                          <th className="pb-2 text-left font-medium">地区</th>
                          <th className="pb-2 text-center font-medium">代理</th>
                          <th className="pb-2 text-center font-medium">Tor</th>
                          <th className="pb-2 text-center font-medium">VPN</th>
                          <th className="pb-2 text-center font-medium">机房</th>
                          <th className="pb-2 text-center font-medium">滥用</th>
                          <th className="pb-2 text-center font-medium">爬虫</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {activeFactors.map((row) => {
                          const iconCell = (v?: string, neutralYes = false) => {
                            if (!v || v === '无' || v === '—') {
                              return <span className="text-slate-700 font-mono">·</span>;
                            }
                            if (v === '否') {
                              return <Check className="w-3.5 h-3.5 text-emerald-400/80 mx-auto" />;
                            }
                            if (v === '是') {
                              return neutralYes ? (
                                <span
                                  className="inline-block w-2 h-2 rounded-full bg-sky-400/90"
                                  title="机房 / IDC"
                                />
                              ) : (
                                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mx-auto" />
                              );
                            }
                            return <span className="text-slate-400 text-[10px]">{v}</span>;
                          };
                          const f = countryFlag(row.country);
                          return (
                            <tr key={row.provider} className="hover:bg-white/[0.015]">
                              <td className="py-2 font-mono text-slate-200 font-medium">{row.provider}</td>
                              <td className="py-2 font-mono text-slate-300">
                                {row.country ? (
                                  <span className="inline-flex items-center gap-1">
                                    <span>{f}</span>
                                    <span className="text-[11px]">{row.country}</span>
                                  </span>
                                ) : (
                                  <span className="text-slate-600">—</span>
                                )}
                              </td>
                              <td className="py-2 text-center">{iconCell(row.proxy)}</td>
                              <td className="py-2 text-center">{iconCell(row.tor)}</td>
                              <td className="py-2 text-center">{iconCell(row.vpn)}</td>
                              <td className="py-2 text-center">{iconCell(row.server, true)}</td>
                              <td className="py-2 text-center">{iconCell(row.abuser)}</td>
                              <td className="py-2 text-center">{iconCell(row.robot)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {emptyFactorNames.length > 0 && (
                  <div className="text-[10px] font-mono text-slate-500 pt-2 border-t border-white/[0.05]">
                    无返回数据（跳过空行）: {emptyFactorNames.join(' · ')}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* TIER 2C: Network Quality, BGP, Backroute & Global/Domestic Latency */}
          {(summary.network.bgp ||
            routeMatrixRows.length > 0 ||
            (summary.network.backrouteTraces && summary.network.backrouteTraces.length > 0) ||
            sortedTransfers.length > 0 ||
            (summary.network.delays && summary.network.delays.length > 0) ||
            summary.network.speedtests.length > 0) && (
            <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-6">
              {/* Section Header + BGP/Local Pills */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Network className="w-3.5 h-3.5 text-sky-400" />
                  网络质量、三网回程与全球延迟
                </h3>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                  {summary.network.bgp?.rir && (
                    <span className="px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.07] text-slate-300">
                      {summary.network.bgp.rir} · {summary.network.bgp.asn}/{summary.network.bgp.prefix ?? 24}
                    </span>
                  )}
                  {summary.network.bgp?.ipActive !== undefined && summary.network.bgp.ipTotal && (
                    <span className="px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.07] text-slate-300">
                      邻居 {summary.network.bgp.ipActive}/{summary.network.bgp.ipTotal}
                    </span>
                  )}
                  {summary.network.local?.tcpCc && (
                    <span className="px-2 py-0.5 rounded-md bg-sky-500/12 border border-sky-400/25 text-sky-300">
                      {summary.network.local.tcpCc} / {summary.network.local.qdisc || 'fq'}
                    </span>
                  )}
                  {summary.network.local?.nat && (
                    <span className="px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.07] text-slate-400">
                      NAT: {summary.network.local.nat}
                    </span>
                  )}
                </div>
              </div>

              {/* Backroute Summary Matrix (Compact ISP Badges) + Global Interconnect side by side */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-5">
                {/* Left 6 cols: Backroute Summary Table */}
                {routeMatrixRows.length > 0 && (
                  <div className="xl:col-span-6 space-y-2.5">
                    <div className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
                      <Route className="w-3.5 h-3.5 text-emerald-400" />
                      北上广三网回程摘要
                    </div>
                    <div className="bg-[#090b10] border border-white/[0.06] rounded-xl overflow-x-auto">
                      <table className="w-full text-xs whitespace-nowrap">
                        <thead>
                          <tr className="text-[11px] text-slate-500 border-b border-white/[0.06] bg-white/[0.015]">
                            <th className="py-2 px-3 text-left font-medium">目标</th>
                            {(['电信', '联通', '移动'] as const).map((isp) => (
                              <th key={isp} className="py-2 px-2.5 text-left font-medium">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className={`w-2 h-2 rounded-full ${ISP_META[isp].dot}`} />
                                  <span>{isp}</span>
                                </span>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.04] font-mono">
                          {routeMatrixRows.map((row) => (
                            <tr key={`${row.city}-${row.proto}`}>
                              <td className="py-2 px-3 font-sans">
                                <span className="font-medium text-white">{row.city}</span>
                                <span className="ml-1.5 text-[10px] font-mono text-slate-500">{row.proto}</span>
                              </td>
                              {[row.ct, row.cu, row.cm].map((val, idx) => (
                                <td key={idx} className="py-2 px-2.5">
                                  <span
                                    className={`inline-block text-[11px] px-2 py-0.5 rounded-md border ${routePillStyle(val)}`}
                                  >
                                    {val || '—'}
                                  </span>
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Right 6 cols: Global Interconnect Visual Latency Bars with Country Flags */}
                {sortedTransfers.length > 0 && (
                  <div className={routeMatrixRows.length > 0 ? 'xl:col-span-6 space-y-2.5' : 'xl:col-span-12 space-y-2.5'}>
                    <div className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-sky-400" />
                      全球 10 大枢纽延迟（由近及远）
                    </div>
                    <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2">
                      {sortedTransfers.map((tr) => {
                        const ms = Number(tr.delayMs) || 0;
                        const pct = Math.min(100, Math.max(3, (ms / 350) * 100));
                        const flag = countryFlag(tr.city);
                        return (
                          <div key={tr.city} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="flex items-center gap-1.5 text-slate-200">
                                <span className="text-sm leading-none">{flag}</span>
                                <span>{tr.city}</span>
                              </span>
                              <span className={`font-mono text-[11px] font-semibold ${latencyColor(ms)}`}>
                                {tr.delayMs ? `${tr.delayMs} ms` : '—'}
                              </span>
                            </div>
                            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${latencyBarColor(ms)}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* NextTrace Detailed Backroute Traces (9 routes with ISP badges + geo/ASN paths) */}
              {summary.network.backrouteTraces && summary.network.backrouteTraces.length > 0 && (
                <div className="space-y-2.5 pt-3 border-t border-white/[0.06]">
                  <div className="text-[11px] font-medium text-slate-400">
                    NextTrace 三网回程逐跳追踪（点击卡片展开完整跳数明细）
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    {summary.network.backrouteTraces.map((tr) => {
                      const key = `${tr.city}-${tr.isp}`;
                      const isOpen = expandedTrace === key;
                      const meta = ISP_META[tr.isp as keyof typeof ISP_META] || ISP_META.电信;
                      return (
                        <div
                          key={key}
                          className="bg-[#090b10] border border-white/[0.06] hover:border-white/15 rounded-xl overflow-hidden transition-colors"
                        >
                          <button
                            onClick={() => setExpandedTrace(isOpen ? null : key)}
                            className="w-full p-3 text-left cursor-pointer"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className={`w-5 h-5 rounded-md border text-[10px] font-semibold flex items-center justify-center ${meta.badge}`}>
                                  {meta.short}
                                </span>
                                <span className="text-xs font-semibold text-white">{tr.city}</span>
                              </div>
                              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-md border font-semibold ${routePillStyle(tr.lineType)}`}>
                                {tr.lineType}
                              </span>
                            </div>
                            {tr.geoPath && (
                              <div className="text-[11px] text-slate-300 mt-2 truncate" title={tr.geoPath}>
                                {tr.geoPath}
                              </div>
                            )}
                            {tr.asnPath && (
                              <div className="text-[10px] font-mono text-slate-500 mt-0.5 truncate" title={tr.asnPath}>
                                {tr.asnPath}
                              </div>
                            )}
                          </button>
                          {isOpen && tr.hops.length > 0 && (
                            <pre className="p-3 bg-[#07090d] border-t border-white/[0.06] text-[10px] font-mono text-slate-300 overflow-x-auto max-h-56 whitespace-pre">
                              {tr.hops.join('\n')}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Compact 31-Province Domestic TCP Latency Grid (Color-coded ISP micro-dots, ZERO repeated labels!) */}
              {summary.network.delays && summary.network.delays.length > 0 && (
                <div className="space-y-3 pt-3 border-t border-white/[0.06]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] font-medium text-slate-300 flex items-center gap-2">
                      <span>🇨🇳 全国 {summary.network.delays.length} 省市三网延迟 (ms)</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
                      {(['电信', '联通', '移动'] as const).map((isp) => (
                        <span key={isp} className="inline-flex items-center gap-1 text-slate-300">
                          <span className={`w-2 h-2 rounded-full ${ISP_META[isp].dot}`} />
                          <span className="font-sans text-slate-400">{isp}</span>
                          {isp === '电信' && delayAverages.ct ? <span className="text-slate-500">均{delayAverages.ct}</span> : null}
                          {isp === '联通' && delayAverages.cu ? <span className="text-slate-500">均{delayAverages.cu}</span> : null}
                          {isp === '移动' && delayAverages.cm ? <span className="text-slate-500">均{delayAverages.cm}</span> : null}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Ultra-compact 3-dot tiles: ~60% less vertical space, 3x faster to scan */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-1.5">
                    {summary.network.delays.map((d) => (
                      <div
                        key={d.city}
                        title={`${d.city} — 电信 ${d.ct || '—'}ms · 联通 ${d.cu || '—'}ms · 移动 ${d.cm || '—'}ms`}
                        className="bg-[#090b10] border border-white/[0.05] hover:border-white/15 rounded-lg px-2.5 py-2 transition-colors"
                      >
                        <div className="text-[11px] font-medium text-slate-200 mb-1.5">{d.city}</div>
                        <div className="grid grid-cols-3 gap-1 font-mono text-[10px] tabular-nums">
                          <div className="flex items-center gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                            <span className={latencyColor(d.ct)}>{d.ct || '—'}</span>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                            <span className={latencyColor(d.cu)}>{d.cu || '—'}</span>
                          </div>
                          <div className="flex items-center gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                            <span className={latencyColor(d.cm)}>{d.cm || '—'}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Speedtests */}
              {summary.network.speedtests.length > 0 && (
                <div className="space-y-2 pt-3 border-t border-white/[0.06]">
                  <div className="text-[11px] font-medium text-slate-400">测速结果</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs font-mono whitespace-nowrap">
                      <thead>
                        <tr className="text-[11px] text-slate-500 border-b border-white/[0.06] text-left">
                          <th className="pb-2">节点</th>
                          <th className="pb-2">运营商</th>
                          <th className="pb-2">下载</th>
                          <th className="pb-2">上传</th>
                          <th className="pb-2 text-right">延迟</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {summary.network.speedtests.map((sp, i) => (
                          <tr key={i}>
                            <td className="py-1.5 text-slate-200">{sp.node}</td>
                            <td className="py-1.5 text-slate-400">{sp.provider || '—'}</td>
                            <td className="py-1.5 text-emerald-300">{sp.download || '—'}</td>
                            <td className="py-1.5 text-sky-300">{sp.upload || '—'}</td>
                            <td className="py-1.5 text-right text-slate-400">{sp.latency || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* TIER 2D: Hardware Deep Profile */}
          {(summary.hardware.cpuModel || summary.hardware.memory || summary.hardware.disk) && (
            <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5 text-amber-400" />
                  硬件质量体检明细
                </h3>
                {summary.hardware.oversell && (
                  <div className="flex items-center gap-2 text-[11px] font-mono">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${
                        summary.hardware.oversell.balloon
                          ? 'bg-amber-500/12 border-amber-400/25 text-amber-300'
                          : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {summary.hardware.oversell.balloon ? (
                        <XCircle className="w-3 h-3" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3" />
                      )}
                      气球回收: {summary.hardware.oversell.balloon ? '有' : '无'}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${
                        summary.hardware.oversell.ksm
                          ? 'bg-amber-500/12 border-amber-400/25 text-amber-300'
                          : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                      }`}
                    >
                      {summary.hardware.oversell.ksm ? (
                        <XCircle className="w-3 h-3" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3" />
                      )}
                      KSM 复用: {summary.hardware.oversell.ksm ? '有' : '无'}
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                {[
                  { label: 'CPU 处理器', val: summary.hardware.cpuModel },
                  {
                    label: '核心 / 频率',
                    val: [summary.hardware.cores, summary.hardware.freqMhz].filter(Boolean).join(' · '),
                  },
                  { label: 'CPU 缓存', val: summary.hardware.cache },
                  {
                    label: '虚拟化 / 架构',
                    val: [summary.hardware.virtualization, summary.hardware.arch].filter(Boolean).join(' · '),
                  },
                  { label: '内存 / 交换', val: [summary.hardware.memory, summary.hardware.swap].filter(Boolean).join(' / ') },
                  { label: '硬盘概况', val: summary.hardware.disk },
                  { label: '主板 / BIOS', val: summary.hardware.motherboard },
                  { label: '网卡 / 显卡', val: [summary.hardware.nic, summary.hardware.gpu].filter(Boolean).join(' · ') },
                  {
                    label: 'CPU 基准跑分',
                    val: summary.hardware.cpuSingle
                      ? `单核 ${summary.hardware.cpuSingle} / 多核 ${summary.hardware.cpuMulti || '—'}`
                      : undefined,
                  },
                  {
                    label: '磁盘读写基准',
                    val:
                      summary.hardware.fio4kRead || summary.hardware.fio1mRead || summary.hardware.ddSpeed
                        ? [
                            summary.hardware.fio4kRead ? `4K: ${summary.hardware.fio4kRead} / ${summary.hardware.fio4kWrite}` : '',
                            summary.hardware.fio1mRead ? `1M: ${summary.hardware.fio1mRead} / ${summary.hardware.fio1mWrite}` : '',
                            summary.hardware.ddSpeed ? `DD: ${summary.hardware.ddSpeed}` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : undefined,
                  },
                ]
                  .filter((item) => item.val)
                  .map((item) => (
                    <div key={item.label} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3">
                      <div className="text-[10px] text-slate-500">{item.label}</div>
                      <div className="font-mono text-slate-200 mt-1 break-words">{item.val}</div>
                    </div>
                  ))}
              </div>

              {((summary.hardware.featureChecks && summary.hardware.featureChecks.length > 0) ||
                (summary.hardware.flags && summary.hardware.flags.length > 0)) && (
                <div className="flex items-center gap-1.5 flex-wrap pt-1">
                  <span className="text-[11px] text-slate-500 mr-1 flex items-center gap-1">
                    <Cpu className="w-3 h-3" /> CPU 指令集:
                  </span>
                  {(
                    summary.hardware.featureChecks ||
                    (summary.hardware.flags || []).map((name) => ({ name, supported: true }))
                  ).map((item) => (
                    <span
                      key={item.name}
                      className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                        item.supported
                          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                          : 'bg-white/[0.03] border-white/[0.08] text-slate-500 line-through decoration-slate-600'
                      }`}
                    >
                      {item.supported ? '✓' : '✕'} {item.name}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* TIER 3: Cleaned Formatted Report & Raw JSON Inspector */}
          <section className="bg-[#0f131b] border border-white/[0.06] rounded-2xl overflow-hidden">
            <button
              onClick={() => setShowRawLogs(!showRawLogs)}
              className="w-full px-4 sm:px-5 py-3.5 flex flex-wrap items-center justify-between gap-2 text-left hover:bg-white/[0.02] cursor-pointer"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
                {showRawLogs ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                <Terminal className="w-3.5 h-3.5 text-slate-400" />
                <span>查看格式化纯文本报告与原生 JSON 数据</span>
              </div>
              <span className="text-[11px] font-mono text-slate-500">ID: {selectedRun.id}</span>
            </button>

            {showRawLogs && (
              <div className="border-t border-white/[0.06]">
                <div className="px-4 py-2 bg-[#0c0f16] border-b border-white/[0.06] flex gap-1.5 overflow-x-auto">
                  {(
                    [
                      ['ip', 'IP 体检报告'],
                      ['hardware', '硬件体检报告'],
                      ['net', '网络体检报告'],
                      ['backroute', '回程追踪'],
                      ['json', '原生 JSON'],
                      ['combined', '清洗后终端日志'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setRawLogTab(k)}
                      className={`text-[11px] px-3 py-1 rounded-lg font-medium cursor-pointer ${
                        rawLogTab === k
                          ? 'bg-sky-500/15 text-sky-300 border border-sky-400/30'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <pre className="p-4 bg-[#07090d] text-[11px] leading-relaxed font-mono text-slate-300 overflow-x-auto max-h-[540px] whitespace-pre">
                  {formatRawTabContent()}
                </pre>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
