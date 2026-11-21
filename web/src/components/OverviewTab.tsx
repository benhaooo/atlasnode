import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Box,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Network,
  Plus,
  Shield,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import type { LiveMetrics, MetricHistoryResult, QuickLink, ServerConfig, ServerSnapshot } from '../types';
import {
  countryFlag,
  formatBytes,
  formatRelativeTime,
  formatSpeed,
  usageBarColor,
  usageTextColor,
} from '../utils';
import { Sparkline } from './Sparkline';
import type { ServerTab } from './ServerDetail';

interface OverviewTabProps {
  snapshot: ServerSnapshot;
  metrics?: LiveMetrics;
  history: { cpu: number[]; rx: number[]; tx: number[] };
  onNavigateTab: (tab: ServerTab) => void;
  onJumpFolder: (dirPath: string) => void;
  onServerUpdated: (server: ServerConfig) => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  snapshot,
  metrics,
  history,
  onNavigateTab,
  onJumpFolder,
  onServerUpdated,
}) => {
  const [showSpecs, setShowSpecs] = useState(false);
  const [addingLink, setAddingLink] = useState(false);
  const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '' });
  const [chartRange, setChartRange] = useState<'live' | '1h' | '24h' | '7d'>('live');
  const [dbHistory, setDbHistory] = useState<MetricHistoryResult | null>(null);

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

  const cpuSeries = chartRange === 'live' ? history.cpu : (dbHistory?.points.map((p) => p.cpuPercent) || []);
  const rxSeries = chartRange === 'live' ? history.rx : (dbHistory?.points.map((p) => p.netRxBps) || []);
  const txSeries = chartRange === 'live' ? history.tx : (dbHistory?.points.map((p) => p.netTxBps) || []);

  const m = metrics || snapshot.metrics;
  const nq = snapshot.latestNodeQuality;
  const allLinks = [...snapshot.server.quickLinks, ...snapshot.detectedLinks];

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
        <div className="bg-[#0f131b] border border-white/[0.06] rounded-xl px-4 py-2.5 flex items-center justify-between gap-4 text-xs">
          <p className="text-slate-300">{snapshot.server.notes}</p>
          <div className="flex items-center gap-1.5 shrink-0">
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
        <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 flex flex-col justify-between gap-5">
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
                series={[{ data: cpuSeries, color: '#38bdf8' }]}
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
                series={[
                  { data: rxSeries, color: '#34d399' },
                  { data: txSeries, color: '#38bdf8' },
                ]}
              />
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
                  累计流量 ↓ {formatBytes(m.netTotalRxBytes)} · ↑ {formatBytes(m.netTotalTxBytes)}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Right 5 Cols: What's Inside & Quick Launch */}
        <section className="lg:col-span-5 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">快捷访问 · 机内服务</h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  直达面板、Web 应用与项目目录
                </p>
              </div>
              <button
                onClick={() => setAddingLink(!addingLink)}
                className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 bg-sky-500/10 border border-sky-400/20 px-2.5 py-1 rounded-lg cursor-pointer"
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
                <div className="grid grid-cols-2 gap-2">
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
                          className="opacity-0 group-hover/link:opacity-100 p-1 text-slate-500 hover:text-rose-400 transition-all cursor-pointer"
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

      {/* TIER 2: NodeQuality Executive Digest (6 cols) + Security Exposure & Top Processes (6 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* NodeQuality Executive Digest */}
        <section className="lg:col-span-6 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 flex flex-col justify-between gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-white">NodeQuality 质量结论</h2>
            </div>
            <button
              onClick={() => onNavigateTab('nodequality')}
              className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 cursor-pointer"
            >
              <span>{nq ? '完整报告 / 重测' : '立即测试'}</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {nq ? (
            <div className="space-y-4">
              {/* IP & Risk Headline */}
              <div className="grid grid-cols-3 gap-2.5">
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
        <section className="lg:col-span-6 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-4">
          {/* Public Ports Snapshot */}
          <div>
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
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
          className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
            {showSpecs ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
            <span>底层硬件指纹、存储分区与网卡详情</span>
          </div>
          <span className="text-[11px] font-mono text-slate-500">
            {snapshot.hostname} · Kernel {snapshot.kernel} · {snapshot.arch}
          </span>
        </button>

        {showSpecs && (
          <div className="px-5 pb-5 pt-2 border-t border-white/[0.05] grid grid-cols-1 md:grid-cols-2 gap-5 text-xs">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                磁盘挂载点
              </div>
              <div className="space-y-1.5 font-mono">
                {snapshot.disks.map((d) => (
                  <div
                    key={d.mount}
                    className="flex items-center justify-between bg-[#090b10] border border-white/[0.05] rounded-lg px-3 py-2"
                  >
                    <div className="truncate">
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
                    className="flex items-center justify-between bg-[#090b10] border border-white/[0.05] rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="text-sky-300">{iface.name}</span>{' '}
                      <span className="text-slate-300 text-[11px]">{iface.ipv4.join(', ') || '—'}</span>
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
    </div>
  );
};
