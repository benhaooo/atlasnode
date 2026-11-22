import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  Box,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  FolderOpen,
  Gauge,
  HardDrive,
  Network,
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
  const [chartRange, setChartRange] = useState<'live' | '1h' | '24h' | '7d'>('live');
  const [dbHistory, setDbHistory] = useState<MetricHistoryResult | null>(null);
  const [editingTrafficPlan, setEditingTrafficPlan] = useState(false);
  const [showDailyTraffic, setShowDailyTraffic] = useState(false);
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);

  useEffect(() => {
    if (chartRange === 'live') return;
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

  const riskBadge = (level?: string) => {
    if (level === 'low') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    if (level === 'medium') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    if (level === 'high') return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    return 'bg-white/[0.05] text-slate-300 border-white/10';
  };

  return (
    <div className="space-y-5">
      {/* Notes strip if present */}
      {snapshot.server.notes && (
        <div className="bg-[#0f131b] border border-white/[0.06] rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 sm:gap-4 text-xs">
          <p className="text-slate-300">{snapshot.server.notes}</p>
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            {snapshot.server.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/[0.05] text-slate-400"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* TIER 1 (HERO ROW): 7 cols Real-Time Telemetry + 5 cols What's Inside & Quick Access */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Real-Time Telemetry */}
        <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-white">算力与网络流量</h2>
              <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
                {snapshot.cpuModel || 'CPU'} · {m?.cpuCores || snapshot.cpuCores} 核 · 网卡 {m?.netInterface || 'eth0'}
              </p>
            </div>
            <div className="flex items-center gap-1 bg-[#090b10] border border-white/[0.07] rounded-lg p-0.5 text-[11px] font-mono">
              {(
                [
                  ['live', '实时 2s'],
                  ['1h', '1h'],
                  ['24h', '24h'],
                  ['7d', '7d'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setChartRange(k)}
                  className={`px-2 py-0.5 rounded-md transition-colors cursor-pointer ${
                    chartRange === k
                      ? 'bg-sky-500/20 text-sky-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Two live/historical SVG charts side-by-side */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-sky-400" />
                  {chartRange === 'live' ? 'CPU 实时占用' : `CPU 趋势 (${chartRange})`}
                </span>
                <span className={`text-lg font-mono font-semibold ${usageTextColor(m?.cpuPercent || 0)}`}>
                  {(m?.cpuPercent ?? 0).toFixed(1)}%
                </span>
              </div>
              <Sparkline
                height={76}
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

            <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
                  <Network className="w-3.5 h-3.5 text-emerald-400" />
                  {chartRange === 'live' ? '网络吞吐' : `流量趋势 (${chartRange})`}
                </span>
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-emerald-400 flex items-center">
                    <ArrowDown className="w-3 h-3" />
                    {chartRange === 'live'
                      ? formatSpeed(m?.netRxBps || 0)
                      : formatBytes(dbHistory?.traffic.rxBytes || 0, 1)}
                  </span>
                  <span className="text-sky-400 flex items-center">
                    <ArrowUp className="w-3 h-3" />
                    {chartRange === 'live'
                      ? formatSpeed(m?.netTxBps || 0)
                      : formatBytes(dbHistory?.traffic.txBytes || 0, 1)}
                  </span>
                </div>
              </div>
              <Sparkline
                height={76}
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
              {(bwCapMbps > 0 || (ts && (ts.peakRxBps > 0 || ts.peakTxBps > 0))) && (
                <div className="mt-2 pt-1.5 border-t border-white/[0.05] flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[10px] font-mono text-slate-500">
                  {bwCapMbps > 0 ? (
                    <span className="text-slate-400">
                      限速 <span className="text-sky-300">{bwCapMbps}M</span>
                      {chartRange === 'live' && (
                        <>
                          {' '}· 当前 {formatMbps(liveMaxBps)} ({bwUtilPct.toFixed(0)}%)
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-500">本周期峰值</span>
                  )}
                  {ts && (ts.peakRxBps > 0 || ts.peakTxBps > 0) && (
                    <span className="text-slate-400">
                      峰值 ↓{formatMbps(ts.peakRxBps)} · ↑{formatMbps(ts.peakTxBps)}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Memory & Root Disk Compact Bars */}
          {m && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-slate-400">内存使用</span>
                  <span className="font-mono text-slate-200">
                    {formatBytes(m.memUsedBytes)} / {formatBytes(m.memTotalBytes)}{' '}
                    <span className={`font-semibold ${usageTextColor(m.memPercent)}`}>
                      ({m.memPercent.toFixed(0)}%)
                    </span>
                  </span>
                </div>
                <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${usageBarColor(m.memPercent)}`}
                    style={{ width: `${Math.min(100, m.memPercent)}%` }}
                  />
                </div>
                {m.swapTotalBytes > 0 && (
                  <div className="text-[10px] font-mono text-slate-500 mt-1">
                    Swap: {formatBytes(m.swapUsedBytes)} / {formatBytes(m.swapTotalBytes)}
                  </div>
                )}
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-slate-400 flex items-center gap-1">
                    <HardDrive className="w-3 h-3" />
                    根分区 /
                  </span>
                  <span className="font-mono text-slate-200">
                    {formatBytes(m.diskRootUsedBytes)} / {formatBytes(m.diskRootTotalBytes)}{' '}
                    <span className={`font-semibold ${usageTextColor(m.diskRootPercent)}`}>
                      ({m.diskRootPercent.toFixed(0)}%)
                    </span>
                  </span>
                </div>
                <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${usageBarColor(m.diskRootPercent)}`}
                    style={{ width: `${Math.min(100, m.diskRootPercent)}%` }}
                  />
                </div>
                <div className="text-[10px] font-mono text-slate-500 mt-1">
                  本次开机累计 ↓ {formatBytes(m.netTotalRxBytes)} · ↑ {formatBytes(m.netTotalTxBytes)}
                </div>
              </div>
            </div>
          )}

          {/* Monthly Traffic Quota & Bandwidth Plan */}
          {ts && (
            <div className="pt-3.5 border-t border-white/[0.06] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-300 font-medium flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5 text-sky-400" />
                    本月流量
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">
                    {ts.cycleStart.slice(5)} ~ {ts.cycleEnd.slice(5)}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400 border border-white/[0.06]">
                    {billingModeLabel(ts.billingMode)}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">
                    距 {ts.resetDay} 号重置剩 {ts.daysRemaining} 天
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  {ts.dailySeries && ts.dailySeries.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowDailyTraffic((v) => !v)}
                      className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md border transition-colors cursor-pointer ${
                        showDailyTraffic
                          ? 'bg-sky-500/15 border-sky-400/30 text-sky-300'
                          : 'bg-white/[0.03] border-white/[0.07] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <BarChart3 className="w-3 h-3" />
                      <span>每日</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingTrafficPlan(true)}
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/25 text-sky-300 transition-colors cursor-pointer"
                  >
                    <SlidersHorizontal className="w-3 h-3" />
                    <span>{ts.quotaBytes > 0 || bwCapMbps > 0 ? '调整套餐 / 校准' : '设置带宽与流量包'}</span>
                  </button>
                </div>
              </div>

              {ts.quotaBytes > 0 ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <span className="font-mono text-slate-200">
                      已用 <span className="font-semibold text-white">{formatBytes(ts.billedBytes)}</span>
                      {' / '}
                      {formatBytes(ts.quotaBytes, 0)}
                    </span>
                    <div className="flex items-center gap-2 font-mono">
                      {projectedOverQuota && (
                        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-400/30 text-amber-300">
                          <AlertTriangle className="w-2.5 h-2.5" />
                          按当前速率预计月底 {formatBytes(ts.projectedBytes, 0)}
                        </span>
                      )}
                      <span className={`font-semibold ${usageTextColor(ts.usedPercent)}`}>
                        {ts.usedPercent.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${usageBarColor(ts.usedPercent)}`}
                      style={{ width: `${Math.min(100, Math.max(1.5, ts.usedPercent))}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] font-mono text-slate-500">
                    <span>
                      今日 ↓ {formatBytes(ts.todayRxBytes)} · ↑ {formatBytes(ts.todayTxBytes)}
                    </span>
                    <span>
                      本周期采集 ↓ {formatBytes(ts.cycleRxBytes)} · ↑ {formatBytes(ts.cycleTxBytes)}
                      {ts.baselineBytes > 0 && (
                        <span className="text-sky-400/90"> · 含校准 +{formatBytes(ts.baselineBytes)}</span>
                      )}
                    </span>
                    {!projectedOverQuota && ts.projectedBytes > 0 && (
                      <span>预计月底 {formatBytes(ts.projectedBytes)}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-[#090b10] border border-white/[0.06] rounded-xl px-3 py-2 text-[11px] font-mono">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-300">
                    <span>
                      本周期累计{' '}
                      <span className="text-emerald-400">↓ {formatBytes(ts.cycleRxBytes)}</span>
                      {' · '}
                      <span className="text-sky-400">↑ {formatBytes(ts.cycleTxBytes)}</span>
                    </span>
                    <span className="text-slate-500">
                      今日 ↓ {formatBytes(ts.todayRxBytes)} · ↑ {formatBytes(ts.todayTxBytes)}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-500">
                    {bwCapMbps > 0 ? `标称带宽 ${bwCapMbps} Mbps · 不限月流量` : '未设月配额（已自动累计）'}
                  </span>
                </div>
              )}

              {/* Expandable Daily Traffic Bar Chart */}
              {showDailyTraffic && ts.dailySeries && ts.dailySeries.length > 0 && (() => {
                const series = ts.dailySeries;
                const maxDayBytes = Math.max(1, ...series.map((d) => d.rxBytes + d.txBytes));
                const activeDay =
                  hoveredDayIdx !== null && series[hoveredDayIdx] ? series[hoveredDayIdx] : null;
                return (
                  <div
                    className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3 space-y-2 relative"
                    onMouseLeave={() => setHoveredDayIdx(null)}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-500 min-h-[16px]">
                      {activeDay ? (
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-slate-300">
                          <span className="text-white font-semibold">{activeDay.day}</span>
                          <span>合计 {formatBytes(activeDay.rxBytes + activeDay.txBytes)}</span>
                          <span className="text-emerald-400">↓ {formatBytes(activeDay.rxBytes)}</span>
                          <span className="text-sky-400">↑ {formatBytes(activeDay.txBytes)}</span>
                          <span className="text-slate-400">
                            峰值 ↓{formatMbps(activeDay.peakRxBps)} / ↑{formatMbps(activeDay.peakTxBps)}
                          </span>
                        </div>
                      ) : (
                        <>
                          <span>本周期每日流量（{series.length} 天，悬停查看明细）</span>
                          <div className="flex items-center gap-3">
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
                    <div className="relative">
                      <div className="flex items-end gap-1 h-24 pt-2">
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
                              className={`flex-1 min-w-[4px] h-full flex flex-col justify-end rounded-t-xs cursor-pointer transition-all px-[1px] ${
                                isHovered ? 'bg-white/[0.07]' : ''
                              }`}
                            >
                              <div
                                className={`w-full rounded-t-xs overflow-hidden flex flex-col justify-end bg-white/[0.05] transition-all ${
                                  isHovered
                                    ? 'brightness-125 ring-1 ring-white/30'
                                    : dimmed
                                      ? 'opacity-45'
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
                    <div className="flex justify-between text-[9px] font-mono text-slate-600">
                      <span>{series[0].day.slice(5)}</span>
                      {series.length > 2 && (
                        <span>{series[Math.floor(series.length / 2)].day.slice(5)}</span>
                      )}
                      <span>{series[series.length - 1].day.slice(5)}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </section>

        {/* Right 5 Cols: What's Inside & Quick Launch */}
        <section className="lg:col-span-5 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-white">快捷访问 · 机内服务</h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  直达面板、Web 应用与项目目录
                </p>
              </div>
              <button
                onClick={() => setAddingLink(!addingLink)}
                className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 bg-sky-500/10 border border-sky-400/20 px-2.5 py-1 rounded-lg cursor-pointer shrink-0"
              >
                <Plus className="w-3 h-3" />
                <span>添加入口</span>
              </button>
            </div>

            {addingLink && (
              <form
                onSubmit={handleAddLink}
                className="bg-[#090b10] border border-white/10 rounded-xl p-3 space-y-2 text-xs"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    required
                    placeholder="名称（如 AFFiNE）"
                    value={linkForm.name}
                    onChange={(e) => setLinkForm({ ...linkForm, name: e.target.value })}
                    className="bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-sky-400"
                  />
                  <input
                    required
                    placeholder="URL（https://...）"
                    value={linkForm.url}
                    onChange={(e) => setLinkForm({ ...linkForm, url: e.target.value })}
                    className="bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-sky-400 font-mono"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    placeholder="简短说明（可选）"
                    value={linkForm.description}
                    onChange={(e) => setLinkForm({ ...linkForm, description: e.target.value })}
                    className="flex-1 bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-sky-400"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded-lg bg-sky-500 text-slate-950 font-semibold cursor-pointer"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingLink(false)}
                    className="p-1.5 text-slate-400 hover:text-white cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </form>
            )}

            {/* Clickable Service Links */}
            <div className="space-y-2 max-h-52 overflow-y-auto pr-0.5">
              {allLinks.length === 0 ? (
                <div className="text-xs text-slate-500 bg-[#090b10] border border-dashed border-white/10 rounded-xl p-4 text-center">
                  未检测到公网 Web 入口，可点击右上角添加自定义反代域名
                </div>
              ) : (
                allLinks.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group/link flex items-center justify-between gap-3 bg-[#090b10] hover:bg-[#141a26] border border-white/[0.06] hover:border-sky-400/35 rounded-xl px-3.5 py-2.5 transition-all"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-100 group-hover/link:text-sky-200 truncate">
                          {link.name}
                        </span>
                        {link.autoDetected && (
                          <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-white/[0.06] text-slate-400">
                            自动发现
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 truncate mt-0.5">
                        {link.url}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!link.autoDetected && (
                        <button
                          onClick={(e) => handleRemoveLink(link.id, e)}
                          title="删除快捷入口"
                          className="opacity-100 lg:opacity-0 lg:group-hover/link:opacity-100 p-1 text-slate-500 hover:text-rose-400 transition-all cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                      <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover/link:text-sky-400" />
                    </div>
                  </a>
                ))
              )}
            </div>
          </div>

          {/* Compose Working Dirs Quick Jump + Container Summary */}
          <div className="pt-3 border-t border-white/[0.06] space-y-2.5">
            {snapshot.composeDirs.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {snapshot.composeDirs.slice(0, 5).map((cd) => (
                  <button
                    key={cd.project}
                    onClick={() => onJumpFolder(cd.dir)}
                    title={`打开目录 ${cd.dir}`}
                    className="inline-flex items-center gap-1 text-[11px] font-mono bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.07] text-slate-300 px-2 py-1 rounded-lg transition-colors cursor-pointer"
                  >
                    <FolderOpen className="w-3 h-3 text-amber-400/80" />
                    <span>{cd.project}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-3 text-slate-400">
                {snapshot.dockerAvailable ? (
                  <span className="flex items-center gap-1.5">
                    <Box className="w-3.5 h-3.5 text-sky-400" />
                    运行中 <strong className="text-white font-mono">{snapshot.dockerSummary.running}</strong> /{' '}
                    {snapshot.dockerSummary.total}
                  </span>
                ) : (
                  <span>常驻服务 {snapshot.systemdHighlights.length} 个</span>
                )}
              </div>
              <button
                onClick={() => onNavigateTab('services')}
                className="text-sky-400 hover:text-sky-300 flex items-center gap-0.5 text-xs font-medium cursor-pointer"
              >
                <span>管理服务</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* TIER 2: Proxy & Node Quality Digest (6 cols) + Security Exposure & Top Processes (6 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Proxy & Node Quality Digest */}
        <section className="lg:col-span-6 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 flex flex-col justify-between gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-white">代理与节点质量结论</h2>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => onNavigateTab('network')}
                className="text-xs text-slate-300 hover:text-sky-300 flex items-center gap-0.5 cursor-pointer"
              >
                <span>线路监控</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onNavigateTab('nodequality')}
                className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-0.5 cursor-pointer"
              >
                <span>{nq ? '质检报告' : '立即质检'}</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* 24h Live Line Stability Ribbon */}
          {snapshot.networkSummary && (
            <button
              onClick={() => onNavigateTab('network')}
              className={`w-full text-left rounded-xl px-3.5 py-2.5 border flex flex-wrap items-center justify-between gap-2 transition-colors cursor-pointer ${
                snapshot.networkSummary.grade === 'excellent'
                  ? 'bg-emerald-500/[0.06] border-emerald-500/25 hover:border-emerald-400/40'
                  : snapshot.networkSummary.grade === 'good'
                    ? 'bg-sky-500/[0.06] border-sky-400/25 hover:border-sky-400/40'
                    : snapshot.networkSummary.grade === 'degraded'
                      ? 'bg-amber-500/[0.06] border-amber-400/25 hover:border-amber-400/40'
                      : snapshot.networkSummary.grade === 'poor'
                        ? 'bg-rose-500/[0.08] border-rose-500/30 hover:border-rose-400/45'
                        : 'bg-[#090b10] border-white/[0.06] hover:border-white/15'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Network className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span className="text-xs font-medium text-white truncate">
                  {snapshot.networkSummary.headline}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 shrink-0">
                {snapshot.networkSummary.samples > 0 ? (
                  <>
                    <span>24h 丢包 {snapshot.networkSummary.maxLossPct}%</span>
                    {snapshot.networkSummary.peakDeltaMs !== undefined && (
                      <span>
                        晚高峰 {snapshot.networkSummary.peakDeltaMs >= 0 ? '+' : ''}
                        {snapshot.networkSummary.peakDeltaMs}ms
                      </span>
                    )}
                  </>
                ) : (
                  <span>
                    {snapshot.networkSummary.mode === 'off' ? '后台探测已关闭' : '等待样本积累'}
                  </span>
                )}
              </div>
            </button>
          )}

          {nq ? (
            <div className="space-y-4">
              {/* IP & Risk Headline */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">归属 / ASN</div>
                  <div className="text-xs font-semibold text-white mt-1 truncate">
                    {countryFlag(nq.summary.ip.country)} {nq.summary.ip.asn || '—'}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5">
                    {nq.summary.ip.org || nq.summary.ip.country || '—'}
                  </div>
                </div>
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">IP 性质</div>
                  <div className="text-xs font-semibold text-white mt-1">
                    {nq.summary.ip.ipType || '未知'}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {nq.summary.ip.usageType || '—'}
                  </div>
                </div>
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3">
                  <div className="text-[10px] text-slate-500">风控风险</div>
                  <div className="mt-1">
                    <span
                      className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-md border ${riskBadge(
                        nq.summary.ip.riskLevel
                      )}`}
                    >
                      {nq.summary.ip.riskLevel === 'low'
                        ? '低风险纯净'
                        : nq.summary.ip.riskLevel === 'medium'
                          ? '中等风险'
                          : nq.summary.ip.riskLevel === 'high'
                            ? '高风险'
                            : '待评估'}
                      {nq.summary.ip.riskScore !== null && nq.summary.ip.riskScore !== undefined
                        ? ` (${nq.summary.ip.riskScore})`
                        : ''}
                    </span>
                  </div>
                </div>
              </div>

              {/* Streaming & AI Unlocks Compact Matrix */}
              {nq.summary.unlocks.length > 0 && (
                <div>
                  <div className="text-[11px] text-slate-500 mb-2">流媒体与 AI 解锁</div>
                  <div className="flex flex-wrap gap-1.5">
                    {nq.summary.unlocks.slice(0, 10).map((u) => (
                      <span
                        key={u.service}
                        className={`text-[11px] px-2 py-0.5 rounded-md border font-mono ${
                            u.status === 'native' || u.status === 'unlocked'
                              ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                              : u.status === 'dns'
                                ? 'bg-sky-500/10 border-sky-500/25 text-sky-300'
                                : u.status === 'app_only'
                                  ? 'bg-amber-500/10 border-amber-500/25 text-amber-300'
                                  : u.status === 'blocked'
                                    ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                                    : 'bg-white/[0.04] border-white/10 text-slate-400'
                        }`}
                      >
                        {countryFlag(u.region)} {u.service}
                        {u.region ? ` ${u.region}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Three-ISP Routing Highlights */}
              {nq.summary.network.routes.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {nq.summary.network.routes.slice(0, 6).map((r, i) => (
                    <div
                      key={i}
                      className="text-[11px] font-mono bg-[#090b10] border border-white/[0.06] px-2.5 py-1 rounded-lg text-slate-300"
                    >
                      <span className="text-slate-500">
                        {r.city}
                        {r.isp}
                      </span>{' '}
                      <span className="text-sky-300 font-semibold">{r.lineType}</span>
                      {r.latencyMs ? <span className="text-slate-400 ml-1">{r.latencyMs}ms</span> : null}
                    </div>
                  ))}
                </div>
              )}

              <div className="text-[11px] text-slate-500 flex items-center justify-between pt-1 border-t border-white/[0.05]">
                <span>上次测试: {formatRelativeTime(nq.finishedAt || nq.startedAt)}</span>
                {nq.reportUrl && (
                  <a
                    href={nq.reportUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-400 hover:underline inline-flex items-center gap-1 font-mono"
                  >
                    <span>官方报告链接</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-[#090b10] border border-dashed border-white/10 rounded-xl p-6 text-center space-y-3">
              <p className="text-xs text-slate-400">
                尚未运行 NodeQuality 检测，无法展示 IP 纯净度、流媒体解锁与三网回程质量
              </p>
              <button
                onClick={() => onNavigateTab('nodequality')}
                className="inline-flex items-center gap-1.5 text-xs bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold px-4 py-2 rounded-xl transition-colors cursor-pointer"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>前往运行 NodeQuality 质检</span>
              </button>
            </div>
          )}
        </section>

        {/* Right 6 Cols: Exposure Surface & Top Processes */}
        <section className="lg:col-span-6 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
          {/* Public Ports Snapshot */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                {snapshot.firewallSummary.active ? (
                  <Shield className="w-4 h-4 text-emerald-400" />
                ) : (
                  <ShieldAlert className="w-4 h-4 text-amber-400" />
                )}
                <h2 className="text-sm font-semibold text-white">公网暴露面</h2>
                <span
                  className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                    snapshot.firewallSummary.active
                      ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                      : 'bg-amber-500/10 border-amber-500/25 text-amber-300'
                  }`}
                >
                  {snapshot.firewallSummary.engine.toUpperCase()}{' '}
                  {snapshot.firewallSummary.active ? 'ACTIVE' : 'INACTIVE'}
                </span>
              </div>
              <button
                onClick={() => onNavigateTab('firewall')}
                className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-0.5 cursor-pointer"
              >
                <span>全部端口</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {snapshot.publicPortsPreview.slice(0, 10).map((p, idx) => (
                <span
                  key={`${p.port}-${idx}`}
                  className="inline-flex items-center gap-1.5 text-[11px] font-mono bg-[#090b10] border border-white/[0.08] px-2.5 py-1 rounded-lg"
                >
                  <span className="text-amber-300 font-semibold">:{p.port}</span>
                  <span className="text-slate-400">{p.dockerContainer || p.process}</span>
                </span>
              ))}
              {snapshot.publicPortsPreview.length === 0 && (
                <span className="text-xs text-slate-500">无公网 TCP 监听端口</span>
              )}
            </div>
          </div>

          {/* Live Top Processes */}
          <div className="pt-3 border-t border-white/[0.06]">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-300">实时高耗进程 (Top CPU)</span>
              <span className="text-[10px] font-mono text-slate-500">PID · CPU% · MEM</span>
            </div>
            <div className="space-y-1">
              {(m?.topProcesses || []).slice(0, 5).map((proc) => (
                <div
                  key={proc.pid}
                  className="flex items-center justify-between text-xs font-mono bg-[#090b10] border border-white/[0.04] rounded-lg px-3 py-1.5"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-[10px] text-slate-500 w-12 shrink-0">{proc.pid}</span>
                    <span className="text-slate-200 truncate">{proc.command}</span>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 text-[11px]">
                    <span className={proc.cpu >= 40 ? 'text-amber-300 font-semibold' : 'text-sky-300'}>
                      {proc.cpu.toFixed(1)}%
                    </span>
                    <span className="text-slate-400 w-16 text-right">
                      {formatBytes(proc.rssKb * 1024, 0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* TIER 3 (LOW WEIGHT, COLLAPSIBLE): Hardware Fingerprint, Mounts & Interfaces */}
      <section className="bg-[#0f131b] border border-white/[0.06] rounded-2xl overflow-hidden">
        <button
          onClick={() => setShowSpecs(!showSpecs)}
          className="w-full px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
            {showSpecs ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
            <span>底层硬件指纹、存储分区与网卡详情</span>
          </div>
          <span className="text-[11px] font-mono text-slate-500 pl-6 sm:pl-0 truncate">
            {snapshot.hostname} · Kernel {snapshot.kernel} · {snapshot.arch}
          </span>
        </button>

        {showSpecs && (
          <div className="px-4 sm:px-5 pb-4 sm:pb-5 pt-2 border-t border-white/[0.05] grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                磁盘挂载点
              </div>
              <div className="space-y-1.5 font-mono">
                {snapshot.disks.map((d) => (
                  <div
                    key={d.mount}
                    className="flex flex-wrap items-center justify-between gap-1.5 bg-[#090b10] border border-white/[0.05] rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0 truncate">
                      <span className="text-slate-200">{d.mount}</span>{' '}
                      <span className="text-[10px] text-slate-500">({d.device} · {d.fsType})</span>
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
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                网络接口
              </div>
              <div className="space-y-1.5 font-mono">
                {snapshot.interfaces.map((iface) => (
                  <div
                    key={iface.name}
                    className="flex flex-wrap items-center justify-between gap-1.5 bg-[#090b10] border border-white/[0.05] rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="text-sky-300">{iface.name}</span>{' '}
                      <span className="text-slate-300 text-[11px] break-all">{iface.ipv4.join(', ') || '—'}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 shrink-0">
                      ↓{formatBytes(iface.rxBytes, 0)} ↑{formatBytes(iface.txBytes, 0)}
                    </div>
                  </div>
                ))}
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
