import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Box,
  Check,
  Copy,
  ExternalLink,
  Plus,
  Radio,
  Shield,
  ShieldAlert,
  Terminal,
  Zap,
} from 'lucide-react';
import type { ServerSnapshot } from '../types';
import {
  copyToClipboard,
  countryFlag,
  formatBytes,
  formatSpeed,
  formatUptime,
  serverFlag,
  usageBarColor,
  usageTextColor,
} from '../utils';
import { FleetSkeleton } from './Skeleton';

interface FleetOverviewProps {
  snapshots: ServerSnapshot[];
  loading: boolean;
  onSelectServer: (id: string, tab?: string) => void;
  onAddServer: () => void;
}

export const FleetOverview: React.FC<FleetOverviewProps> = ({
  snapshots,
  loading,
  onSelectServer,
  onAddServer,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = async (key: string, text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const onlineSnaps = snapshots.filter((s) => s.online);
  const totalRunningContainers = onlineSnaps.reduce((acc, s) => acc + s.dockerSummary.running, 0);
  const totalRx = onlineSnaps.reduce((acc, s) => acc + (s.metrics?.netRxBps || 0), 0);
  const totalTx = onlineSnaps.reduce((acc, s) => acc + (s.metrics?.netTxBps || 0), 0);

  // High-signal alerts only
  const alerts: { serverId: string; serverName: string; message: string; severity: 'warn' | 'danger'; tab: string }[] = [];
  for (const s of snapshots) {
    if (!s.online) {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `连接中断: ${s.error || '无法连接'}`,
        severity: 'danger',
        tab: 'overview',
      });
      continue;
    }
    if ((s.metrics?.diskRootPercent ?? 0) >= 85) {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `磁盘空间紧张 (${s.metrics?.diskRootPercent.toFixed(0)}%)`,
        severity: 'warn',
        tab: 'files',
      });
    }
    if (s.dockerSummary.unhealthy > 0) {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `${s.dockerSummary.unhealthy} 个容器异常`,
        severity: 'danger',
        tab: 'services',
      });
    }
    if (!s.firewallSummary.active && s.firewallSummary.publicPortsCount > 3) {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `防火墙未启 · 公网监听 ${s.firewallSummary.publicPortsCount} 端口`,
        severity: 'warn',
        tab: 'firewall',
      });
    }
    if (s.networkSummary?.grade === 'poor') {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `线路异常（丢包 ${s.networkSummary.maxLossPct}%）`,
        severity: 'danger',
        tab: 'network',
      });
    }
    if (s.trafficSummary && s.trafficSummary.quotaBytes > 0 && s.trafficSummary.usedPercent >= 85) {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `月流量已用 ${s.trafficSummary.usedPercent.toFixed(0)}%`,
        severity: s.trafficSummary.usedPercent >= 95 ? 'danger' : 'warn',
        tab: 'overview',
      });
    }
  }

  const netDotColor = (grade?: string) => {
    if (grade === 'excellent') return 'bg-emerald-400';
    if (grade === 'good') return 'bg-sky-400';
    if (grade === 'degraded') return 'bg-amber-400';
    if (grade === 'poor') return 'bg-rose-400';
    return 'bg-slate-600';
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      {/* Clean Header + Quiet Metric Summary */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-white">全局总览</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-slate-400 font-mono">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-slate-200">{onlineSnaps.length}/{snapshots.length}</span> 在线
            </span>
            <span className="text-slate-700">·</span>
            <span>{totalRunningContainers} 容器运行中</span>
            <span className="text-slate-700 hidden sm:inline">·</span>
            <span className="hidden sm:inline-flex items-center gap-2 text-[11px]">
              <span className="text-emerald-400 inline-flex items-center">
                <ArrowDown className="w-3 h-3" />
                {formatSpeed(totalRx)}
              </span>
              <span className="text-sky-400 inline-flex items-center">
                <ArrowUp className="w-3 h-3" />
                {formatSpeed(totalTx)}
              </span>
            </span>
          </div>
        </div>

        <button
          onClick={onAddServer}
          className="self-start sm:self-auto inline-flex items-center gap-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-xs px-3.5 py-2 rounded-xl transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>添加节点</span>
        </button>
      </div>

      {/* Quiet Priority Attention Strip */}
      {alerts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 bg-amber-500/[0.05] border border-amber-400/15 rounded-xl px-3.5 py-2.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300 mr-1">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>关注 ({alerts.length})</span>
          </span>
          {alerts.map((a, i) => (
            <button
              key={i}
              onClick={() => onSelectServer(a.serverId, a.tab)}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-colors cursor-pointer ${
                a.severity === 'danger'
                  ? 'bg-rose-500/12 text-rose-300 hover:bg-rose-500/20'
                  : 'bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
              }`}
            >
              <span className="font-mono font-semibold">{a.serverName}</span>
              <span className="text-slate-300">{a.message}</span>
              <ArrowUpRight className="w-3 h-3 opacity-60" />
            </button>
          ))}
        </div>
      )}

      {/* Clean, Airy Server Roster Cards */}
      {loading && snapshots.length === 0 ? (
        <FleetSkeleton />
      ) : (
        <div className="space-y-3.5">
          {snapshots.map((snap) => {
            const m = snap.metrics;
            const nq = snap.latestNodeQuality;
            const ts = snap.trafficSummary;
            const allLinks = [...snap.server.quickLinks, ...snap.detectedLinks].slice(0, 4);
            const sshCmd = `ssh ${snap.server.username}@${snap.tailscaleIp || snap.publicIp || snap.server.host}${snap.server.port !== 22 ? ` -p ${snap.server.port}` : ''}`;

            const stacks = new Map<string, number>();
            for (const c of snap.containersPreview) {
              if (c.state !== 'running') continue;
              const key = c.composeProject || c.name;
              stacks.set(key, (stacks.get(key) || 0) + 1);
            }
            const stackEntries = Array.from(stacks.entries());

            return (
              <div
                key={snap.server.id}
                onClick={() => onSelectServer(snap.server.id, 'overview')}
                className="group bg-white/[0.025] hover:bg-white/[0.045] border border-white/[0.06] hover:border-sky-400/25 rounded-2xl p-4 sm:p-5 transition-all cursor-pointer"
              >
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-center">
                  {/* ZONE 1: Identity & Address (4 cols) */}
                  <div className="xl:col-span-4 space-y-2 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            snap.online
                              ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                              : 'bg-rose-500'
                          }`}
                        />
                        <span className="text-base leading-none shrink-0">
                          {serverFlag(snap.server.region, nq?.summary.ip.country, snap.server.tags)}
                        </span>
                        <h2 className="text-[15px] font-semibold text-white tracking-tight truncate">
                          {snap.server.name}
                        </h2>
                        {snap.server.mode === 'local' && (
                          <span className="text-[10px] font-mono text-sky-300/90 bg-sky-500/10 px-1.5 py-0.5 rounded">
                            中枢
                          </span>
                        )}
                      </div>

                      <button
                        onClick={(e) => handleCopy(`ssh-${snap.server.id}`, sshCmd, e)}
                        title={`复制 SSH: ${sshCmd}`}
                        className="shrink-0 inline-flex items-center gap-1 text-[11px] font-mono text-slate-500 hover:text-white hover:bg-white/[0.06] px-2 py-1 rounded-lg transition-colors cursor-pointer"
                      >
                        {copiedKey === `ssh-${snap.server.id}` ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Terminal className="w-3 h-3" />
                        )}
                        <span>SSH</span>
                      </button>
                    </div>

                    {snap.server.role && (
                      <div className="text-xs text-slate-400 truncate pl-4">
                        {snap.server.role}
                      </div>
                    )}

                    <div className="pl-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono text-slate-500">
                      {snap.publicIp && (
                        <button
                          onClick={(e) => handleCopy(`pub-${snap.server.id}`, snap.publicIp!, e)}
                          className="inline-flex items-center gap-1 text-slate-400 hover:text-white transition-colors cursor-pointer"
                        >
                          <span>{snap.publicIp}</span>
                          {copiedKey === `pub-${snap.server.id}` ? (
                            <Check className="w-2.5 h-2.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-2.5 h-2.5 opacity-40" />
                          )}
                        </button>
                      )}
                      {snap.tailscaleIp && (
                        <button
                          onClick={(e) => handleCopy(`ts-${snap.server.id}`, snap.tailscaleIp!, e)}
                          className="inline-flex items-center gap-1 text-sky-400/80 hover:text-sky-300 transition-colors cursor-pointer"
                        >
                          <Radio className="w-2.5 h-2.5" />
                          <span>{snap.tailscaleIp}</span>
                        </button>
                      )}
                      {snap.online && (
                        <span>
                          {snap.cpuCores}C · {m ? formatBytes(m.memTotalBytes, 0) : '—'} · {formatUptime(m?.uptimeSeconds)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* ZONE 2: Services & Quick Launch (4 cols) */}
                  <div className="xl:col-span-4 xl:border-l xl:border-white/[0.05] xl:pl-5 space-y-2.5 min-w-0">
                    {allLinks.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {allLinks.map((link) => (
                          <a
                            key={link.id}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-[11px] bg-sky-500/[0.08] hover:bg-sky-500/18 text-sky-200 px-2 py-0.5 rounded-md transition-colors"
                          >
                            <span>{link.name}</span>
                            <ExternalLink className="w-2.5 h-2.5 opacity-60" />
                          </a>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono text-slate-400">
                      {stackEntries.slice(0, 4).map(([name, count]) => (
                        <span key={name} className="inline-flex items-center gap-1">
                          <Box className="w-2.5 h-2.5 text-slate-600" />
                          <span>{name}</span>
                          {count > 1 && <span className="text-slate-600">×{count}</span>}
                        </span>
                      ))}
                      {stackEntries.length > 4 && (
                        <span className="text-slate-600">+{stackEntries.length - 4}</span>
                      )}
                      {!snap.dockerAvailable && snap.systemdHighlights.length > 0 && (
                        <span>{snap.systemdHighlights.length} 常驻服务</span>
                      )}
                    </div>

                    {snap.online && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                        <span
                          className={`inline-flex items-center gap-1 ${
                            snap.firewallSummary.active ? 'text-emerald-400/85' : 'text-amber-400/90'
                          }`}
                        >
                          {snap.firewallSummary.active ? (
                            <Shield className="w-3 h-3" />
                          ) : (
                            <ShieldAlert className="w-3 h-3" />
                          )}
                          {snap.firewallSummary.engine.toUpperCase()}
                        </span>
                        <span className="font-mono">公网 {snap.firewallSummary.publicPortsCount} 端口</span>
                        {snap.networkSummary && snap.networkSummary.grade !== 'collecting' && (
                          <span className="inline-flex items-center gap-1.5 text-slate-400">
                            <span className={`w-1.5 h-1.5 rounded-full ${netDotColor(snap.networkSummary.grade)}`} />
                            <span>丢包 {snap.networkSummary.maxLossPct}%</span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ZONE 3: Ultra-Clean Vitals & Quality Footer (4 cols) */}
                  <div className="xl:col-span-4 xl:border-l xl:border-white/[0.05] xl:pl-5 space-y-2.5">
                    {snap.online && m ? (
                      <>
                        <div className="space-y-1.5">
                          {[
                            { label: 'CPU', pct: m.cpuPercent, sub: `${m.cpuPercent.toFixed(1)}%` },
                            {
                              label: 'MEM',
                              pct: m.memPercent,
                              sub: `${formatBytes(m.memUsedBytes, 1)} / ${formatBytes(m.memTotalBytes, 0)}`,
                            },
                            {
                              label: 'DISK',
                              pct: m.diskRootPercent,
                              sub: `${formatBytes(m.diskRootUsedBytes, 0)} / ${formatBytes(m.diskRootTotalBytes, 0)}`,
                            },
                            ...(ts && ts.quotaBytes > 0
                              ? [
                                  {
                                    label: '流量',
                                    pct: ts.usedPercent,
                                    sub: `${formatBytes(ts.billedBytes, 1)} / ${formatBytes(ts.quotaBytes, 0)}`,
                                  },
                                ]
                              : []),
                          ].map((row) => (
                            <div key={row.label} className="grid grid-cols-12 items-center gap-2 text-[10px] font-mono">
                              <span className="col-span-2 text-slate-500">{row.label}</span>
                              <div className="col-span-6 h-[3px] bg-white/[0.06] rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all duration-500 ${usageBarColor(row.pct)}`}
                                  style={{ width: `${Math.min(100, Math.max(2, row.pct))}%` }}
                                />
                              </div>
                              <span className={`col-span-4 text-right truncate ${usageTextColor(row.pct)}`}>
                                {row.sub}
                              </span>
                            </div>
                          ))}
                        </div>

                        {/* Compact 1-line Quality & Traffic Micro-footer */}
                        <div className="flex items-center justify-between gap-2 pt-1 text-[10px] font-mono text-slate-500">
                          <span className="truncate flex items-center gap-1.5">
                            {snap.activeNodeQualityJob ? (
                              <span className="text-amber-300 inline-flex items-center gap-1">
                                <Activity className="w-3 h-3 animate-pulse" />
                                {snap.activeNodeQualityJob.phase}
                              </span>
                            ) : nq ? (
                              <>
                                <Zap className="w-3 h-3 text-emerald-400/80 shrink-0" />
                                <span className="text-slate-400 truncate">
                                  {countryFlag(nq.summary.ip.country)} {nq.summary.ip.asn || 'NodeQuality'}
                                  {nq.summary.ip.ipType ? ` · ${nq.summary.ip.ipType}` : ''}
                                </span>
                              </>
                            ) : (
                              <span>未运行质检</span>
                            )}
                          </span>

                          {ts && ts.quotaBytes === 0 && (
                            <span className="shrink-0">
                              本月 {formatBytes(ts.cycleRxBytes + ts.cycleTxBytes)}
                              {ts.bandwidthMbps > 0 ? ` · ${ts.bandwidthMbps}M` : ''}
                            </span>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-rose-400/90">
                        节点离线 · <span className="font-mono text-[11px] text-rose-300/70">{snap.error}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
