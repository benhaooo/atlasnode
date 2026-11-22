import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Box,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Plus,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import type {
  LiveMetrics,
  MetricHistoryResult,
  QuickLink,
  ServerConfig,
  ServerSnapshot,
  TrafficSummary,
} from '../types';
import {
  billingModeLabel,
  countryFlag,
  formatBytes,
  formatMbps,
  formatRelativeTime,
  formatSpeed,
  usageBarColor,
  usageTextColor,
} from '../utils';
import { Sparkline } from './Sparkline';
import { TrafficPlanModal } from './TrafficPlanModal';
import type { ServerTab } from './ServerDetail';

interface OverviewTabProps {
  snapshot: ServerSnapshot;
  metrics?: LiveMetrics;
  history: { ts: number[]; cpu: number[]; rx: number[]; tx: number[] };
  onNavigateTab: (tab: ServerTab) => void;
  onJumpFolder: (dirPath: string) => void;
  onServerUpdated: (server: ServerConfig) => void;
  onTrafficPlanSaved?: (server: ServerConfig, summary: TrafficSummary) => void;
}

const PRIORITY_UNLOCKS = ['chatgpt', 'openai', 'claude', 'gemini', 'netflix', 'youtube', 'disney+', 'tiktok'];

export const OverviewTab: React.FC<OverviewTabProps> = ({
  snapshot,
  metrics,
  history,
  onNavigateTab,
  onJumpFolder,
  onServerUpdated,
  onTrafficPlanSaved,
}) => {
  const [showSpecs, setShowSpecs] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '' });
  const [chartRange, setChartRange] = useState<'live' | '1h' | '24h' | '7d' | 'daily'>('live');
  const [dbHistory, setDbHistory] = useState<MetricHistoryResult | null>(null);
  const [editingTrafficPlan, setEditingTrafficPlan] = useState(false);
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const [showAllUnlocks, setShowAllUnlocks] = useState(false);

  useEffect(() => {
    if (chartRange === 'live' || chartRange === 'daily') return;
    let cancelled = false;
    api
      .getServerHistory(snapshot.server.id, chartRange)
      .then((res) => {
        if (!cancelled) setDbHistory(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [snapshot.server.id, chartRange]);

  const tsSeries = chartRange === 'live' ? history.ts : (dbHistory?.points.map((p) => p.ts) || []);
  const cpuSeries = chartRange === 'live' ? history.cpu : (dbHistory?.points.map((p) => p.cpuPercent) || []);
  const rxSeries = chartRange === 'live' ? history.rx : (dbHistory?.points.map((p) => p.netRxBps) || []);
  const txSeries = chartRange === 'live' ? history.tx : (dbHistory?.points.map((p) => p.netTxBps) || []);

  const formatSparkTime = (tsMs: number) => {
    const d = new Date(tsMs);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (chartRange === 'live') {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    if (chartRange === '7d') {
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const m = metrics || snapshot.metrics;
  const nq = snapshot.latestNodeQuality;
  const ts = snapshot.trafficSummary;
  const allLinks = [...snapshot.server.quickLinks, ...snapshot.detectedLinks];

  const liveMaxBps = Math.max(m?.netRxBps || 0, m?.netTxBps || 0);
  const liveMaxMbps = (liveMaxBps * 8) / 1_000_000;
  const bwCapMbps = ts?.bandwidthMbps || snapshot.server.trafficPlan?.bandwidthMbps || 0;
  const bwUtilPct = bwCapMbps > 0 ? Math.min(100, (liveMaxMbps / bwCapMbps) * 100) : 0;
  const projectedOverQuota = Boolean(ts && ts.quotaBytes > 0 && ts.projectedBytes > ts.quotaBytes);

  // Sort unlocks prioritizing key AI/streaming services, expandable inline to view all
  const sortedUnlocks = nq
    ? [...nq.summary.unlocks].sort((a, b) => {
        const pa = PRIORITY_UNLOCKS.indexOf(a.service.toLowerCase());
        const pb = PRIORITY_UNLOCKS.indexOf(b.service.toLowerCase());
        const sa = pa >= 0 ? pa : 99;
        const sb = pb >= 0 ? pb : 99;
        return sa - sb;
      })
    : [];
  const visibleUnlocks = showAllUnlocks ? sortedUnlocks : sortedUnlocks.slice(0, 8);

  // Deduplicate routes by city+ISP for a crisp summary with latency preserved
  const compactRoutes = nq
    ? (() => {
        const seen = new Set<string>();
        const out: typeof nq.summary.network.routes = [];
        for (const r of nq.summary.network.routes) {
          const key = `${r.city}-${r.isp}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(r);
          if (out.length >= 6) break;
        }
        return out;
      })()
    : [];

  const handleAddLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!linkForm.name.trim() || !linkForm.url.trim()) return;
    const newLink: QuickLink = {
      id: `custom-${Date.now()}`,
      name: linkForm.name.trim(),
      url: linkForm.url.trim().startsWith('http') ? linkForm.url.trim() : `http://${linkForm.url.trim()}`,
      category: 'custom',
      description: linkForm.description.trim() || undefined,
    };
    const { server } = await api.updateServer(snapshot.server.id, {
      quickLinks: [...snapshot.server.quickLinks, newLink],
    });
    onServerUpdated(server);
    setLinkForm({ name: '', url: '', description: '' });
    setAddingLink(false);
  };

  const handleRemoveLink = async (linkId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = snapshot.server.quickLinks.filter((l) => l.id !== linkId);
    const { server } = await api.updateServer(snapshot.server.id, { quickLinks: next });
    onServerUpdated(server);
  };

  const riskColor = (level?: string) => {
    if (level === 'low') return 'text-emerald-400';
    if (level === 'medium') return 'text-amber-300';
    if (level === 'high') return 'text-rose-400';
    return 'text-slate-400';
  };

  const netDotColor = (grade?: string) => {
    if (grade === 'excellent') return 'bg-emerald-400';
    if (grade === 'good') return 'bg-sky-400';
    if (grade === 'degraded') return 'bg-amber-400';
    if (grade === 'poor') return 'bg-rose-400';
    return 'bg-slate-500';
  };

  return (
    <div className="space-y-5">
      {/* TIER 0: Unified 4-Metric Vitals Strip (surface-first, zero box-in-box) */}
      {m && (
        <section className="bg-white/[0.025] border border-white/[0.06] rounded-2xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-white/[0.05] overflow-hidden">
          {/* CPU */}
          <div className="px-4 sm:px-5 py-3.5 sm:py-4 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>CPU</span>
              <span className="font-mono text-[10px] text-slate-500 truncate" title={snapshot.cpuModel || undefined}>
                {m.cpuCores || snapshot.cpuCores} 核
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`text-xl sm:text-2xl font-mono font-semibold tracking-tight ${usageTextColor(m.cpuPercent)}`}>
                {m.cpuPercent.toFixed(1)}
                <span className="text-xs font-normal text-slate-500 ml-0.5">%</span>
              </span>
              <span className="text-[10px] font-mono text-slate-500 truncate" title="1分钟 / 5分钟 / 15分钟系统负载">
                Load {m.loadAvg[0].toFixed(2)} / {m.loadAvg[1].toFixed(2)} / {m.loadAvg[2].toFixed(2)}
              </span>
            </div>
            <div className="h-[3px] bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${usageBarColor(m.cpuPercent)}`}
                style={{ width: `${Math.min(100, Math.max(2, m.cpuPercent))}%` }}
              />
            </div>
          </div>

          {/* Memory + Full Swap Readout */}
          <div className="px-4 sm:px-5 py-3.5 sm:py-4 flex flex-col justify-between gap-2 border-l border-white/[0.05] lg:border-l-0">
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>内存</span>
              <span className="font-mono text-[10px] text-slate-500 truncate">
                {formatBytes(m.memUsedBytes)} / {formatBytes(m.memTotalBytes, 1)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`text-xl sm:text-2xl font-mono font-semibold tracking-tight ${usageTextColor(m.memPercent)}`}>
                {m.memPercent.toFixed(0)}
                <span className="text-xs font-normal text-slate-500 ml-0.5">%</span>
              </span>
              <span className="text-[10px] font-mono text-slate-500 truncate">
                {m.swapTotalBytes > 0
                  ? `Swap ${formatBytes(m.swapUsedBytes, 1)} / ${formatBytes(m.swapTotalBytes, 1)}`
                  : '未分配 Swap'}
              </span>
            </div>
            <div className="h-[3px] bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${usageBarColor(m.memPercent)}`}
                style={{ width: `${Math.min(100, Math.max(2, m.memPercent))}%` }}
              />
            </div>
          </div>

          {/* Root Disk */}
          <div className="px-4 sm:px-5 py-3.5 sm:py-4 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
              <span>根分区 /</span>
              <span className="font-mono text-[10px] text-slate-500 truncate">
                {formatBytes(m.diskRootUsedBytes, 1)} / {formatBytes(m.diskRootTotalBytes, 1)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className={`text-xl sm:text-2xl font-mono font-semibold tracking-tight ${usageTextColor(m.diskRootPercent)}`}>
                {m.diskRootPercent.toFixed(0)}
                <span className="text-xs font-normal text-slate-500 ml-0.5">%</span>
              </span>
              <span className="text-[10px] font-mono text-slate-500 truncate">
                可用 {formatBytes(Math.max(0, m.diskRootTotalBytes - m.diskRootUsedBytes), 1)}
              </span>
            </div>
            <div className="h-[3px] bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${usageBarColor(m.diskRootPercent)}`}
                style={{ width: `${Math.min(100, Math.max(2, m.diskRootPercent))}%` }}
              />
            </div>
          </div>

          {/* Monthly Traffic & Quota */}
          <div className="px-4 sm:px-5 py-3.5 sm:py-4 flex flex-col justify-between gap-2 border-l border-white/[0.05] lg:border-l-0">
            <div className="flex items-center justify-between gap-1 text-[11px] text-slate-400">
              <span className="truncate">
                本月流量
                {ts && ts.quotaBytes > 0
                  ? ` · ${billingModeLabel(ts.billingMode)} · 剩${ts.daysRemaining}天`
                  : ''}
              </span>
              <button
                type="button"
                onClick={() => setEditingTrafficPlan(true)}
                title="配置标称带宽、月流量配额与已用校准"
                className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-sky-300 transition-colors cursor-pointer shrink-0"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>{ts && (ts.quotaBytes > 0 || bwCapMbps > 0) ? '套餐' : '设配额'}</span>
              </button>
            </div>

            {ts && ts.quotaBytes > 0 ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-xl sm:text-2xl font-mono font-semibold tracking-tight ${usageTextColor(ts.usedPercent)}`}>
                    {ts.usedPercent.toFixed(1)}
                    <span className="text-xs font-normal text-slate-500 ml-0.5">%</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-400 truncate">
                    {formatBytes(ts.billedBytes, 1)} / {formatBytes(ts.quotaBytes, 0)}
                  </span>
                </div>
                <div className="h-[3px] bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${usageBarColor(ts.usedPercent)}`}
                    style={{ width: `${Math.min(100, Math.max(2, ts.usedPercent))}%` }}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xl sm:text-2xl font-mono font-semibold tracking-tight text-slate-100">
                    {formatBytes((ts?.cycleRxBytes || 0) + (ts?.cycleTxBytes || 0))}
                  </span>
                  {bwCapMbps > 0 && (
                    <span className="text-[10px] font-mono text-sky-300">{bwCapMbps} Mbps</span>
                  )}
                </div>
                <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                  <span>↓ {formatBytes(ts?.cycleRxBytes || 0)}</span>
                  <span>↑ {formatBytes(ts?.cycleTxBytes || 0)}</span>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {/* TIER 1: Breathing Telemetry Canvas (7 cols) + Clean Service Launcher (5 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left 7: Unified Telemetry & Daily Traffic Canvas */}
        <section className="lg:col-span-7 bg-white/[0.025] border border-white/[0.06] rounded-2xl p-5 flex flex-col justify-between gap-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium text-white">实时遥测与流量</h2>
              <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
                {m?.netInterface || 'eth0'}
                {bwCapMbps > 0 ? ` · 标称 ${bwCapMbps} Mbps` : ''}
                {ts && (ts.peakRxBps > 0 || ts.peakTxBps > 0)
                  ? ` · 本月峰值 ↓${formatMbps(ts.peakRxBps)} ↑${formatMbps(ts.peakTxBps)}`
                  : ''}
              </p>
            </div>

            <div className="inline-flex items-center bg-black/30 border border-white/[0.06] rounded-lg p-0.5 text-[11px] font-mono">
              {(
                [
                  ['live', '实时'],
                  ['1h', '1h'],
                  ['24h', '24h'],
                  ['7d', '7d'],
                  ['daily', '每日'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setChartRange(k)}
                  className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    chartRange === k
                      ? 'bg-white/[0.1] text-white font-medium'
                      : 'text-slate-500 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {chartRange === 'daily' ? (
            /* Daily Traffic Bar View inside the same canvas */
            ts && ts.dailySeries && ts.dailySeries.length > 0 ? (
              (() => {
                const series = ts.dailySeries;
                const maxDayBytes = Math.max(1, ...series.map((d) => d.rxBytes + d.txBytes));
                const activeDay =
                  hoveredDayIdx !== null && series[hoveredDayIdx] ? series[hoveredDayIdx] : null;
                return (
                  <div
                    className="space-y-3"
                    onMouseLeave={() => setHoveredDayIdx(null)}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono min-h-[20px]">
                      {activeDay ? (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-slate-300">
                          <span className="text-white font-semibold">{activeDay.day}</span>
                          <span>合计 {formatBytes(activeDay.rxBytes + activeDay.txBytes)}</span>
                          <span className="text-emerald-400">↓ {formatBytes(activeDay.rxBytes)}</span>
                          <span className="text-sky-400">↑ {formatBytes(activeDay.txBytes)}</span>
                          <span className="text-slate-500">
                            峰值 ↓{formatMbps(activeDay.peakRxBps)} / ↑{formatMbps(activeDay.peakTxBps)}
                          </span>
                        </div>
                      ) : (
                        <>
                          <span className="text-slate-400">
                            账期 {ts.cycleStart.slice(5)} ~ {ts.cycleEnd.slice(5)} · {billingModeLabel(ts.billingMode)}
                          </span>
                          <div className="flex items-center gap-3 text-slate-500 text-[10px]">
                            <span className="inline-flex items-center gap-1">
                              <span className="w-2 h-2 rounded-xs bg-emerald-400/80" />
                              入站 ↓
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <span className="w-2 h-2 rounded-xs bg-sky-400/80" />
                              出站 ↑
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    <div className="relative pt-2">
                      <div className="flex items-end gap-1.5 h-32">
                        {series.map((d, idx) => {
                          const total = d.rxBytes + d.txBytes;
                          const totalPct = total > 0 ? Math.max(6, (total / maxDayBytes) * 100) : 2;
                          const rxRatio = total > 0 ? (d.rxBytes / total) * 100 : 50;
                          const txRatio = 100 - rxRatio;
                          const isHovered = hoveredDayIdx === idx;
                          const dimmed = hoveredDayIdx !== null && !isHovered;
                          return (
                            <div
                              key={d.day}
                              onMouseEnter={() => setHoveredDayIdx(idx)}
                              onClick={() => setHoveredDayIdx(isHovered ? null : idx)}
                              className={`flex-1 min-w-[4px] h-full flex flex-col justify-end rounded-t-sm cursor-pointer transition-all px-[1px] ${
                                isHovered ? 'bg-white/[0.06]' : ''
                              }`}
                            >
                              <div
                                className={`w-full rounded-t-sm overflow-hidden flex flex-col justify-end bg-white/[0.05] transition-all ${
                                  isHovered
                                    ? 'brightness-125 ring-1 ring-white/30'
                                    : dimmed
                                      ? 'opacity-40'
                                      : ''
                                }`}
                                style={{ height: `${totalPct}%` }}
                              >
                                {total > 0 && (
                                  <>
                                    <div className="w-full bg-sky-400/85" style={{ height: `${txRatio}%` }} />
                                    <div className="w-full bg-emerald-400/85" style={{ height: `${rxRatio}%` }} />
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {activeDay && hoveredDayIdx !== null && (
                        <div
                          className="pointer-events-none hidden sm:block absolute bottom-full mb-1.5 z-20 bg-[#0d121c]/95 backdrop-blur-md border border-white/15 rounded-lg px-2.5 py-1.5 shadow-xl text-[10px] font-mono whitespace-nowrap"
                          style={
                            hoveredDayIdx / Math.max(1, series.length - 1) > 0.6
                              ? { right: 0 }
                              : hoveredDayIdx / Math.max(1, series.length - 1) < 0.25
                                ? { left: 0 }
                                : {
                                    left: `${((hoveredDayIdx + 0.5) / series.length) * 100}%`,
                                    transform: 'translateX(-50%)',
                                  }
                          }
                        >
                          <div className="text-white font-semibold mb-0.5">
                            {activeDay.day} · 合计 {formatBytes(activeDay.rxBytes + activeDay.txBytes)}
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-emerald-400">入站 ↓ {formatBytes(activeDay.rxBytes)}</span>
                            <span className="text-sky-400">出站 ↑ {formatBytes(activeDay.txBytes)}</span>
                          </div>
                          <div className="text-slate-400 mt-0.5">
                            峰值 ↓ {formatMbps(activeDay.peakRxBps)} · ↑ {formatMbps(activeDay.peakTxBps)}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex justify-between text-[10px] font-mono text-slate-600">
                      <span>{series[0].day.slice(5)}</span>
                      {series.length > 2 && (
                        <span>{series[Math.floor(series.length / 2)].day.slice(5)}</span>
                      )}
                      <span>{series[series.length - 1].day.slice(5)}</span>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="h-36 flex items-center justify-center text-xs text-slate-500">
                暂无按日流量样本
              </div>
            )
          ) : (
            /* Clean Borderless Dual Sparklines separated by a hairline */
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-0 sm:divide-x divide-white/[0.06]">
              {/* CPU Sparkline */}
              <div className="sm:pr-5">
                <div className="flex items-baseline justify-between mb-3">
                  <span className="text-xs text-slate-400">CPU 走势</span>
                  <span className="text-xs font-mono text-sky-300">
                    {(m?.cpuPercent ?? 0).toFixed(1)}%
                  </span>
                </div>
                <Sparkline
                  height={96}
                  maxVal={100}
                  timestamps={tsSeries}
                  formatTime={formatSparkTime}
                  series={[
                    {
                      data: cpuSeries,
                      color: '#38bdf8',
                      label: 'CPU',
                      formatValue: (v) => `${v.toFixed(1)}%`,
                    },
                  ]}
                />
              </div>

              {/* Network Sparkline */}
              <div className="sm:pl-5">
                <div className="flex items-baseline justify-between mb-3 gap-2">
                  <span className="text-xs text-slate-400">
                    {chartRange === 'live' ? '网络吞吐' : `区间流量 (${chartRange})`}
                  </span>
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-emerald-400 inline-flex items-center">
                      <ArrowDown className="w-3 h-3" />
                      {chartRange === 'live'
                        ? formatSpeed(m?.netRxBps || 0)
                        : formatBytes(dbHistory?.traffic.rxBytes || 0, 1)}
                    </span>
                    <span className="text-sky-400 inline-flex items-center">
                      <ArrowUp className="w-3 h-3" />
                      {chartRange === 'live'
                        ? formatSpeed(m?.netTxBps || 0)
                        : formatBytes(dbHistory?.traffic.txBytes || 0, 1)}
                    </span>
                  </div>
                </div>
                <Sparkline
                  height={96}
                  timestamps={tsSeries}
                  formatTime={formatSparkTime}
                  series={[
                    {
                      data: rxSeries,
                      color: '#34d399',
                      label: '入站 ↓',
                      formatValue: (v) => `${formatSpeed(v)} (${formatMbps(v)})`,
                    },
                    {
                      data: txSeries,
                      color: '#38bdf8',
                      label: '出站 ↑',
                      formatValue: (v) => `${formatSpeed(v)} (${formatMbps(v)})`,
                    },
                  ]}
                />
              </div>
            </div>
          )}

          {/* Subtle Footer Strip: Today / Cycle Breakdown / Projection */}
          {ts && (
            <div className="pt-3.5 border-t border-white/[0.05] flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-[11px] font-mono text-slate-500">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  今日 <span className="text-slate-300">↓{formatBytes(ts.todayRxBytes)}</span>{' '}
                  <span className="text-slate-400">↑{formatBytes(ts.todayTxBytes)}</span>
                </span>
                <span>
                  本周期采集 <span className="text-emerald-400/90">↓{formatBytes(ts.cycleRxBytes)}</span>{' '}
                  <span className="text-sky-400/90">↑{formatBytes(ts.cycleTxBytes)}</span>
                </span>
                {ts.baselineBytes > 0 && (
                  <span className="text-sky-400/80">含校准 +{formatBytes(ts.baselineBytes)}</span>
                )}
                {bwCapMbps > 0 && chartRange === 'live' && (
                  <span>
                    带宽占比 <span className="text-sky-300">{bwUtilPct.toFixed(0)}%</span>
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                {projectedOverQuota ? (
                  <span className="inline-flex items-center gap-1 text-amber-300">
                    <AlertTriangle className="w-3 h-3" />
                    预计月底 {formatBytes(ts.projectedBytes, 0)}（超额）
                  </span>
                ) : ts.projectedBytes > 0 && ts.quotaBytes > 0 ? (
                  <span>预计月底 {formatBytes(ts.projectedBytes, 0)}</span>
                ) : (
                  <span>开机累计 ↓{formatBytes(m?.netTotalRxBytes || 0)} · ↑{formatBytes(m?.netTotalTxBytes || 0)}</span>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Right 5: Clean Quick Launcher & Containers */}
        <section className="lg:col-span-5 bg-white/[0.025] border border-white/[0.06] rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-white">快捷入口</h2>
              <button
                onClick={() => setAddingLink(!addingLink)}
                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-sky-300 transition-colors cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>添加</span>
              </button>
            </div>

            {addingLink && (
              <form
                onSubmit={handleAddLink}
                className="bg-black/30 border border-white/[0.08] rounded-xl p-3 space-y-2 text-xs"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    required
                    placeholder="名称（如 1Panel）"
                    value={linkForm.name}
                    onChange={(e) => setLinkForm({ ...linkForm, name: e.target.value })}
                    className="bg-[#080a0f] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-sky-400"
                  />
                  <input
                    required
                    placeholder="URL（https://...）"
                    value={linkForm.url}
                    onChange={(e) => setLinkForm({ ...linkForm, url: e.target.value })}
                    className="bg-[#080a0f] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-sky-400 font-mono"
                  />
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAddingLink(false)}
                    className="px-2.5 py-1 text-slate-400 hover:text-white cursor-pointer"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="px-3 py-1 rounded-lg bg-sky-500 text-slate-950 font-semibold cursor-pointer"
                  >
                    保存
                  </button>
                </div>
              </form>
            )}

            {/* Borderless Clean Link List */}
            {allLinks.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                暂无 Web 入口，可点击右上角添加反代地址
              </div>
            ) : (
              <div className="divide-y divide-white/[0.04] max-h-52 overflow-y-auto -mx-2">
                {allLinks.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group/link flex items-center justify-between gap-3 px-2.5 py-2.5 rounded-lg hover:bg-white/[0.035] transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-200 group-hover/link:text-white truncate">
                          {link.name}
                        </span>
                        {link.autoDetected && (
                          <span className="text-[9px] font-mono text-slate-500">自动</span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 truncate mt-0.5">
                        {link.url.replace(/^https?:\/\//, '')}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!link.autoDetected && (
                        <button
                          onClick={(e) => handleRemoveLink(link.id, e)}
                          title="删除"
                          className="opacity-100 lg:opacity-0 lg:group-hover/link:opacity-100 p-1 text-slate-500 hover:text-rose-400 transition-all cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                      <ExternalLink className="w-3.5 h-3.5 text-slate-600 group-hover/link:text-sky-400 transition-colors" />
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Compact Project Dirs & Services Footer */}
          <div className="pt-3.5 border-t border-white/[0.05] space-y-2.5">
            {snapshot.composeDirs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {snapshot.composeDirs.slice(0, 4).map((cd) => (
                  <button
                    key={cd.project}
                    onClick={() => onJumpFolder(cd.dir)}
                    title={cd.dir}
                    className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-400 hover:text-white hover:bg-white/[0.05] px-2 py-0.5 rounded-md transition-colors cursor-pointer"
                  >
                    <FolderOpen className="w-3 h-3 text-amber-400/75" />
                    <span>{cd.project}</span>
                  </button>
                ))}
                {snapshot.composeDirs.length > 4 && (
                  <span className="text-[10px] font-mono text-slate-600">
                    +{snapshot.composeDirs.length - 4}
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Box className="w-3.5 h-3.5 text-sky-400/80" />
                {snapshot.dockerAvailable ? (
                  <>
                    运行中 <strong className="text-slate-100 font-mono">{snapshot.dockerSummary.running}</strong>/{snapshot.dockerSummary.total} 容器
                  </>
                ) : (
                  <>常驻服务 {snapshot.systemdHighlights.length} 个</>
                )}
              </span>
              <button
                onClick={() => onNavigateTab('services')}
                className="text-slate-400 hover:text-sky-300 inline-flex items-center gap-0.5 text-xs transition-colors cursor-pointer"
              >
                <span>管理服务</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* TIER 2: Distilled Secondary Row — Quality Digest (6) + Exposure & Processes (6) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left 6: Line & NodeQuality Digest (distilled, no box-in-box) */}
        <section className="lg:col-span-6 bg-white/[0.025] border border-white/[0.06] rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-white">线路与节点质检</h2>
            <div className="flex items-center gap-3 text-xs">
              <button
                onClick={() => onNavigateTab('network')}
                className="text-slate-400 hover:text-white inline-flex items-center gap-0.5 transition-colors cursor-pointer"
              >
                <span>线路</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onNavigateTab('nodequality')}
                className="text-sky-400 hover:text-sky-300 inline-flex items-center gap-0.5 transition-colors cursor-pointer"
              >
                <span>{nq ? '报告' : '去质检'}</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* 1-Line Live Stability Summary */}
          {snapshot.networkSummary && (
            <button
              onClick={() => onNavigateTab('network')}
              className="w-full text-left flex flex-wrap items-center justify-between gap-2 py-2 px-3 rounded-xl bg-white/[0.025] hover:bg-white/[0.045] transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${netDotColor(snapshot.networkSummary.grade)}`} />
                <span className="text-xs text-slate-200 truncate">{snapshot.networkSummary.headline}</span>
              </div>
              <span className="text-[11px] font-mono text-slate-500 shrink-0">
                {snapshot.networkSummary.samples > 0
                  ? `丢包 ${snapshot.networkSummary.maxLossPct}%${
                      snapshot.networkSummary.peakDeltaMs !== undefined
                        ? ` · 高峰 ${snapshot.networkSummary.peakDeltaMs >= 0 ? '+' : ''}${snapshot.networkSummary.peakDeltaMs}ms`
                        : ''
                    }`
                  : snapshot.networkSummary.mode === 'off'
                    ? '后台探测已关'
                    : '采样中'}
              </span>
            </button>
          )}

          {nq ? (
            <div className="space-y-4">
              {/* Clean 3-column key-value strip with full org / usageType subtitles */}
              <div className="grid grid-cols-3 divide-x divide-white/[0.06]">
                <div className="pr-3 min-w-0">
                  <div className="text-[10px] text-slate-500">归属 / ASN</div>
                  <div className="text-xs font-medium text-slate-100 mt-1 truncate">
                    {countryFlag(nq.summary.ip.country)} {nq.summary.ip.asn || '—'}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate mt-0.5" title={nq.summary.ip.org || undefined}>
                    {nq.summary.ip.org || nq.summary.ip.country || '—'}
                  </div>
                </div>
                <div className="px-3 min-w-0">
                  <div className="text-[10px] text-slate-500">IP 性质</div>
                  <div className="text-xs font-medium text-slate-100 mt-1 truncate">
                    {nq.summary.ip.ipType || '未知'}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate mt-0.5">
                    {nq.summary.ip.usageType || '—'}
                  </div>
                </div>
                <div className="pl-3 min-w-0">
                  <div className="text-[10px] text-slate-500">风控评级</div>
                  <div className={`text-xs font-medium mt-1 truncate ${riskColor(nq.summary.ip.riskLevel)}`}>
                    {nq.summary.ip.riskLevel === 'low'
                      ? '纯净低风险'
                      : nq.summary.ip.riskLevel === 'medium'
                        ? '中等风险'
                        : nq.summary.ip.riskLevel === 'high'
                          ? '高风险'
                          : '待评估'}
                  </div>
                  <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5">
                    {nq.summary.ip.riskScore !== null && nq.summary.ip.riskScore !== undefined
                      ? `评分 ${nq.summary.ip.riskScore}`
                      : '—'}
                  </div>
                </div>
              </div>

              {/* Compact Unlocks with regions preserved + inline expand */}
              {visibleUnlocks.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {visibleUnlocks.map((u) => {
                    const ok = u.status === 'native' || u.status === 'unlocked' || u.status === 'dns';
                    return (
                      <span
                        key={u.service}
                        title={u.detail || u.statusText || u.status}
                        className={`text-[11px] px-2 py-0.5 rounded-md font-mono ${
                          ok
                            ? 'bg-emerald-500/[0.08] text-emerald-300'
                            : u.status === 'app_only'
                              ? 'bg-amber-500/[0.08] text-amber-300'
                              : u.status === 'blocked'
                                ? 'bg-rose-500/[0.07] text-rose-300/80'
                                : 'bg-white/[0.04] text-slate-400'
                        }`}
                      >
                        {countryFlag(u.region)} {u.service}
                        {u.region ? ` ${u.region}` : ''}
                      </span>
                    );
                  })}
                  {sortedUnlocks.length > 8 && (
                    <button
                      type="button"
                      onClick={() => setShowAllUnlocks((v) => !v)}
                      className="text-[11px] font-mono text-slate-500 hover:text-sky-300 px-1.5 cursor-pointer"
                    >
                      {showAllUnlocks ? '收起' : `+${sortedUnlocks.length - 8} 项`}
                    </button>
                  )}
                </div>
              )}

              {/* Distilled Three-ISP Routes with city + latency + official report link */}
              <div className="pt-3 border-t border-white/[0.05] space-y-2 text-[11px] font-mono text-slate-500">
                {compactRoutes.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {compactRoutes.map((r, i) => (
                      <span key={i}>
                        {r.city}
                        {r.isp}{' '}
                        <span className="text-sky-300">{r.lineType}</span>
                        {r.latencyMs ? <span className="text-slate-400 ml-1">{r.latencyMs}ms</span> : null}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <span>上次质检 {formatRelativeTime(nq.finishedAt || nq.startedAt)}</span>
                  {nq.reportUrl && (
                    <a
                      href={nq.reportUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-400 hover:text-sky-300 inline-flex items-center gap-1"
                    >
                      <span>官方报告</span>
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="py-5 flex items-center justify-between gap-3 text-xs text-slate-500">
              <span>尚未运行 NodeQuality，暂无 IP 纯净度与流媒体解锁数据</span>
              <button
                onClick={() => onNavigateTab('nodequality')}
                className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-medium shrink-0 cursor-pointer"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>运行质检</span>
              </button>
            </div>
          )}
        </section>

        {/* Right 6: Exposure & Live Top Processes (subtle CPU heat bars!) */}
        <section className="lg:col-span-6 bg-white/[0.025] border border-white/[0.06] rounded-2xl p-5 flex flex-col justify-between gap-4">
          {/* Public Ports Compact Row */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {snapshot.firewallSummary.active ? (
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                )}
                <h2 className="text-sm font-medium text-white">公网暴露</h2>
                <span
                  className={`text-[10px] font-mono ${
                    snapshot.firewallSummary.active ? 'text-emerald-400/90' : 'text-amber-300'
                  }`}
                >
                  {snapshot.firewallSummary.engine.toUpperCase()}{' '}
                  {snapshot.firewallSummary.active ? '已启' : '未启'}
                </span>
              </div>
              <button
                onClick={() => onNavigateTab('firewall')}
                className="text-xs text-slate-400 hover:text-sky-300 inline-flex items-center gap-0.5 transition-colors cursor-pointer"
              >
                <span>防火墙</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11px] font-mono">
              {snapshot.publicPortsPreview.slice(0, 6).map((p, idx) => (
                <span key={`${p.port}-${idx}`} className="inline-flex items-center gap-1 text-slate-400">
                  <span className="text-amber-300/95">:{p.port}</span>
                  <span className="text-slate-500">{p.dockerContainer || p.process}</span>
                </span>
              ))}
              {snapshot.publicPortsPreview.length > 6 && (
                <button
                  onClick={() => onNavigateTab('firewall')}
                  className="text-slate-500 hover:text-sky-300 cursor-pointer"
                >
                  +{snapshot.publicPortsPreview.length - 6} 端口
                </button>
              )}
              {snapshot.publicPortsPreview.length === 0 && (
                <span className="text-slate-500 font-sans">无公网 TCP 监听</span>
              )}
            </div>
          </div>

          {/* Top 4 Processes with subtle inline CPU heat backdrop */}
          <div className="pt-3.5 border-t border-white/[0.05] space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>实时高耗进程</span>
              <span className="font-mono text-[10px]">CPU · 内存</span>
            </div>
            <div className="space-y-1">
              {(m?.topProcesses || []).slice(0, 5).map((proc) => {
                const barWidth = Math.min(100, Math.max(0, proc.cpu));
                return (
                  <div
                    key={proc.pid}
                    className="relative overflow-hidden rounded-lg px-2.5 py-1.5 flex items-center justify-between text-xs font-mono hover:bg-white/[0.03] transition-colors"
                  >
                    <div
                      className="pointer-events-none absolute inset-y-0 left-0 bg-sky-400/[0.06] transition-all duration-500"
                      style={{ width: `${barWidth}%` }}
                    />
                    <div className="relative flex items-center gap-2 min-w-0">
                      <span className="text-[10px] text-slate-600 w-10 shrink-0">{proc.pid}</span>
                      <span className="text-slate-200 truncate">{proc.command}</span>
                    </div>
                    <div className="relative flex items-center gap-3 shrink-0 text-[11px]">
                      <span className={proc.cpu >= 40 ? 'text-amber-300 font-medium' : 'text-sky-300/90'}>
                        {proc.cpu.toFixed(1)}%
                      </span>
                      <span className="text-slate-500 w-14 text-right">
                        {formatBytes(proc.rssKb * 1024, 0)}
                      </span>
                    </div>
                  </div>
                );
              })}
              {(!m || m.topProcesses.length === 0) && (
                <div className="text-xs text-slate-500 py-2">正在采集进程信息...</div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* TIER 3: Quiet Collapsible Hardware, Notes & Interfaces Footer */}
      <section className="border-t border-white/[0.05] pt-3">
        <button
          onClick={() => setShowSpecs(!showSpecs)}
          className="w-full flex items-center justify-between py-1.5 text-left text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            {showSpecs ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <span>硬件规格 · 磁盘挂载与网卡明细</span>
          </span>
          <span className="text-[11px] font-mono text-slate-600 hidden sm:inline truncate max-w-md">
            {snapshot.cpuModel || 'CPU'} · {snapshot.arch} · {snapshot.kernel}
          </span>
        </button>

        {showSpecs && (
          <div className="mt-3 bg-white/[0.02] border border-white/[0.05] rounded-2xl p-4 sm:p-5 space-y-4 text-xs">
            {snapshot.server.notes && (
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-white/[0.05]">
                <p className="text-slate-300">{snapshot.server.notes}</p>
                {snapshot.server.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {snapshot.server.tags.map((tag) => (
                      <span key={tag} className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.05] text-slate-400">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500 mb-2">
                  磁盘挂载
                </div>
                <div className="divide-y divide-white/[0.04] font-mono">
                  {snapshot.disks.map((d) => (
                    <div key={`${d.device}-${d.mount}`} className="py-1.5 flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate">
                        <span className="text-slate-200">{d.mount}</span>{' '}
                        <span className="text-[10px] text-slate-500">{d.fsType}</span>
                      </div>
                      <div className="shrink-0 text-[11px]">
                        <span className="text-slate-400">
                          {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)}
                        </span>{' '}
                        <span className={usageTextColor(d.usePercent)}>({d.usePercent}%)</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500 mb-2">
                  网络接口
                </div>
                <div className="divide-y divide-white/[0.04] font-mono">
                  {snapshot.interfaces.map((iface) => (
                    <div key={iface.name} className="py-1.5 flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate">
                        <span className="text-sky-300">{iface.name}</span>{' '}
                        <span className="text-slate-400 text-[11px]">{iface.ipv4.join(', ') || '—'}</span>
                      </div>
                      <div className="text-[10px] text-slate-500 shrink-0">
                        ↓{formatBytes(iface.rxBytes, 0)} ↑{formatBytes(iface.txBytes, 0)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      {editingTrafficPlan && (
        <TrafficPlanModal
          server={snapshot.server}
          summary={ts}
          onClose={() => setEditingTrafficPlan(false)}
          onSaved={(server, summary) => {
            if (onTrafficPlanSaved) {
              onTrafficPlanSaved(server, summary);
            } else {
              onServerUpdated(server);
            }
          }}
        />
      )}
    </div>
  );
};
