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
  Globe,
  HardDrive,
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
  formatRelativeTime,
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

  // Collect high-signal alerts only (non-noisy)
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
        message: `根分区空间紧张 (${s.metrics?.diskRootPercent.toFixed(0)}%)`,
        severity: 'warn',
        tab: 'files',
      });
    }
    if (s.dockerSummary.unhealthy > 0) {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `${s.dockerSummary.unhealthy} 个容器处于 Unhealthy 状态`,
        severity: 'danger',
        tab: 'services',
      });
    }
    if (!s.firewallSummary.active && s.firewallSummary.publicPortsCount > 3) {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `UFW 防火墙未启用，公网监听 ${s.firewallSummary.publicPortsCount} 个 TCP 端口`,
        severity: 'warn',
        tab: 'firewall',
      });
    }
    if (s.networkSummary?.grade === 'poor') {
      alerts.push({
        serverId: s.server.id,
        serverName: s.server.name,
        message: `线路异常（丢包 ${s.networkSummary.maxLossPct}% / 晚高峰波动大）`,
        severity: 'danger',
        tab: 'network',
      });
    }
  }

  const netGradeMeta = (grade?: string) => {
    switch (grade) {
      case 'excellent':
        return { label: '线路稳健', cls: 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300' };
      case 'good':
        return { label: '线路平稳', cls: 'bg-sky-500/12 border-sky-400/25 text-sky-300' };
      case 'degraded':
        return { label: '高峰波动', cls: 'bg-amber-500/12 border-amber-400/25 text-amber-300' };
      case 'poor':
        return { label: '丢包炸线', cls: 'bg-rose-500/15 border-rose-500/30 text-rose-300' };
      default:
        return null;
    }
  };

  const KEY_PROXY_SERVICES = ['chatgpt', 'openai', 'claude', 'gemini', 'netflix', 'youtube', 'disney+', 'tiktok'];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-7 space-y-5 sm:space-y-6">
      {/* Header + Compact Signal Ribbon */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-white">服务器态势总览</h1>
          <p className="text-xs text-slate-400 mt-1">
            一眼掌握每台节点的用途、运行服务、公网质量与实时健康状态
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-1.5 bg-[#0f131b] border border-white/[0.07] rounded-xl px-3 sm:px-4 py-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-slate-400">在线</span>
              <span className="font-mono font-semibold text-white">
                {onlineSnaps.length}/{snapshots.length}
              </span>
            </div>
            <div className="w-px h-3.5 bg-white/10" />
            <div className="flex items-center gap-1.5">
              <Box className="w-3.5 h-3.5 text-sky-400" />
              <span className="text-slate-400">运行容器</span>
              <span className="font-mono font-semibold text-white">{totalRunningContainers}</span>
            </div>
            <div className="w-px h-3.5 bg-white/10 hidden sm:block" />
            <div className="hidden sm:flex items-center gap-2 font-mono text-[11px]">
              <span className="flex items-center gap-0.5 text-emerald-400">
                <ArrowDown className="w-3 h-3" />
                {formatSpeed(totalRx)}
              </span>
              <span className="flex items-center gap-0.5 text-sky-400">
                <ArrowUp className="w-3 h-3" />
                {formatSpeed(totalTx)}
              </span>
            </div>
          </div>

          <button
            onClick={onAddServer}
            className="flex items-center gap-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-xs px-3.5 py-2 rounded-xl transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加 / 发现节点</span>
          </button>
        </div>
      </div>

      {/* Priority Attention Strip (only shown when something needs attention) */}
      {alerts.length > 0 && (
        <div className="bg-amber-500/[0.06] border border-amber-400/20 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-300 mb-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>需要关注 ({alerts.length})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {alerts.map((a, i) => (
              <button
                key={i}
                onClick={() => onSelectServer(a.serverId, a.tab)}
                className={`flex items-center gap-2 text-xs text-left max-w-full px-2.5 py-1.5 rounded-lg border transition-colors cursor-pointer ${
                  a.severity === 'danger'
                    ? 'bg-rose-500/10 border-rose-500/25 text-rose-300 hover:bg-rose-500/20'
                    : 'bg-amber-500/10 border-amber-500/20 text-amber-200 hover:bg-amber-500/20'
                }`}
              >
                <span className="font-mono font-semibold shrink-0">{a.serverName}</span>
                <span className="text-slate-300 truncate">{a.message}</span>
                <ArrowUpRight className="w-3 h-3 opacity-70 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Server Dossiers — Weighted Horizontal Cards */}
      {loading && snapshots.length === 0 ? (
        <FleetSkeleton />
      ) : (
        <div className="space-y-4">
          {snapshots.map((snap) => {
            const m = snap.metrics;
            const nq = snap.latestNodeQuality;
            const allLinks = [...snap.server.quickLinks, ...snap.detectedLinks].slice(0, 6);
            const sshCmd = `ssh ${snap.server.username}@${snap.tailscaleIp || snap.publicIp || snap.server.host}${snap.server.port !== 22 ? ` -p ${snap.server.port}` : ''}`;

            // Group running containers by compose project for crisp "what's inside" pills
            const stacks = new Map<string, number>();
            for (const c of snap.containersPreview) {
              if (c.state !== 'running') continue;
              const key = c.composeProject || c.name;
              stacks.set(key, (stacks.get(key) || 0) + 1);
            }
            const stackList = Array.from(stacks.entries()).slice(0, 6);

            const keyUnlocks = (nq?.summary.unlocks || [])
              .filter(
                (u) =>
                  (u.status === 'native' || u.status === 'unlocked' || u.status === 'dns') &&
                  KEY_PROXY_SERVICES.includes(u.service.toLowerCase())
              )
              .slice(0, 4);
            const netBadge = netGradeMeta(snap.networkSummary?.grade);

            return (
              <div
                key={snap.server.id}
                onClick={() => onSelectServer(snap.server.id, 'overview')}
                className="group bg-[#0f131b] hover:bg-[#121722] border border-white/[0.07] hover:border-sky-400/30 rounded-2xl p-4 sm:p-5 transition-all cursor-pointer"
              >
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 sm:gap-5 items-start">
                  {/* ZONE 1 (Primary): Identity, Role & Network Addresses */}
                  <div className="xl:col-span-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                              snap.online
                                ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.55)]'
                                : 'bg-rose-500'
                            }`}
                          />
                          <span className="text-base leading-none shrink-0">
                            {serverFlag(snap.server.region, nq?.summary.ip.country, snap.server.tags)}
                          </span>
                          <h2 className="text-base font-semibold text-white tracking-tight truncate">
                            {snap.server.name}
                          </h2>
                          {snap.server.mode === 'local' && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-400/25">
                              本机中枢
                            </span>
                          )}
                          {snap.server.jumpHost && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-400/25">
                              跳板可达
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-sky-300/90 font-medium mt-1">
                          {snap.server.role}
                        </div>
                      </div>

                      <button
                        onClick={(e) => handleCopy(`ssh-${snap.server.id}`, sshCmd, e)}
                        title={`复制 SSH 命令: ${sshCmd}`}
                        className="shrink-0 flex items-center gap-1 text-[11px] font-mono text-slate-400 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.07] px-2 py-1 rounded-lg transition-colors cursor-pointer"
                      >
                        {copiedKey === `ssh-${snap.server.id}` ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Terminal className="w-3 h-3" />
                        )}
                        <span>SSH</span>
                      </button>
                    </div>

                    {snap.server.notes && (
                      <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">
                        {snap.server.notes}
                      </p>
                    )}

                    {/* IP & Spec Pills */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {snap.publicIp && (
                        <button
                          onClick={(e) => handleCopy(`pub-${snap.server.id}`, snap.publicIp!, e)}
                          className="flex items-center gap-1.5 text-[11px] font-mono bg-[#090b10] border border-white/[0.08] hover:border-white/20 text-slate-300 px-2 py-0.5 rounded-md cursor-pointer"
                        >
                          <Globe className="w-3 h-3 text-slate-500" />
                          <span>{snap.publicIp}</span>
                          {copiedKey === `pub-${snap.server.id}` ? (
                            <Check className="w-2.5 h-2.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-2.5 h-2.5 text-slate-600" />
                          )}
                        </button>
                      )}
                      {snap.tailscaleIp && (
                        <button
                          onClick={(e) => handleCopy(`ts-${snap.server.id}`, snap.tailscaleIp!, e)}
                          className="flex items-center gap-1.5 text-[11px] font-mono bg-sky-500/[0.07] border border-sky-400/20 hover:border-sky-400/40 text-sky-300 px-2 py-0.5 rounded-md cursor-pointer"
                        >
                          <Radio className="w-3 h-3 text-sky-400" />
                          <span>{snap.tailscaleIp}</span>
                        </button>
                      )}
                    </div>

                    {snap.online && (
                      <div className="text-[11px] text-slate-500 font-mono flex flex-wrap gap-x-3 gap-y-1">
                        <span>{snap.os?.replace(' LTS', '') || 'Linux'}</span>
                        <span>
                          {snap.cpuCores}C · {m ? formatBytes(m.memTotalBytes, 1) : '—'}
                        </span>
                        <span>运行 {formatUptime(m?.uptimeSeconds)}</span>
                      </div>
                    )}
                  </div>

                  {/* ZONE 2 (Primary): What's Running Inside + Quick Access */}
                  <div className="xl:col-span-5 pt-3.5 border-t border-white/[0.06] xl:pt-0 xl:border-t-0 xl:border-l xl:border-white/[0.06] xl:pl-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                        里面运行着什么 · 快捷入口
                      </span>
                      <span className="text-[11px] font-mono text-slate-500">
                        {snap.dockerAvailable
                          ? `${snap.dockerSummary.running}/${snap.dockerSummary.total} 容器`
                          : `${snap.systemdHighlights.length} 常驻服务`}
                      </span>
                    </div>

                    {/* Quick Launch Web Services */}
                    {allLinks.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {allLinks.map((link) => (
                          <a
                            key={link.id}
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1.5 text-xs bg-sky-500/10 hover:bg-sky-500/20 text-sky-200 border border-sky-400/20 hover:border-sky-400/40 px-2.5 py-1 rounded-lg transition-colors"
                          >
                            <span className="font-medium">{link.name}</span>
                            {link.port && (
                              <span className="font-mono text-[10px] text-sky-400/80">:{link.port}</span>
                            )}
                            <ExternalLink className="w-3 h-3 opacity-70" />
                          </a>
                        ))}
                      </div>
                    )}

                    {/* Running Stacks / Key Services */}
                    <div className="flex flex-wrap gap-1.5">
                      {stackList.map(([stackName, count]) => (
                        <span
                          key={stackName}
                          className="inline-flex items-center gap-1 text-[11px] bg-white/[0.03] border border-white/[0.07] text-slate-300 px-2 py-0.5 rounded-md font-mono"
                        >
                          <Box className="w-2.5 h-2.5 text-slate-500" />
                          <span>{stackName}</span>
                          {count > 1 && <span className="text-slate-500">×{count}</span>}
                        </span>
                      ))}
                      {!snap.dockerAvailable &&
                        snap.systemdHighlights.slice(0, 6).map((svc) => (
                          <span
                            key={svc.name}
                            className="inline-flex items-center gap-1 text-[11px] bg-white/[0.03] border border-white/[0.07] text-slate-300 px-2 py-0.5 rounded-md font-mono"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80" />
                            <span>{svc.name}</span>
                          </span>
                        ))}
                    </div>

                    {/* Firewall & Exposure Summary Line */}
                    {snap.online && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] pt-0.5">
                        <span
                          className={`inline-flex items-center gap-1 ${
                            snap.firewallSummary.active ? 'text-emerald-400' : 'text-amber-400'
                          }`}
                        >
                          {snap.firewallSummary.active ? (
                            <Shield className="w-3 h-3" />
                          ) : (
                            <ShieldAlert className="w-3 h-3" />
                          )}
                          {snap.firewallSummary.engine.toUpperCase()}{' '}
                          {snap.firewallSummary.active ? '已启用' : '未启用'}
                        </span>
                        <span className="text-slate-500 font-mono">
                          公网端口 {snap.firewallSummary.publicPortsCount} · 内网 {snap.firewallSummary.localPortsCount}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* ZONE 3 (Secondary): Vitals & NodeQuality Verdict */}
                  <div className="xl:col-span-3 pt-3.5 border-t border-white/[0.06] xl:pt-0 xl:border-t-0 xl:border-l xl:border-white/[0.06] xl:pl-5 space-y-3">
                    {snap.online && m ? (
                      <>
                        <div className="space-y-2">
                          {[
                            { label: 'CPU', pct: m.cpuPercent, sub: `负载 ${m.loadAvg[0]}` },
                            {
                              label: '内存',
                              pct: m.memPercent,
                              sub: `${formatBytes(m.memUsedBytes, 1)} / ${formatBytes(m.memTotalBytes, 1)}`,
                            },
                            {
                              label: '磁盘 /',
                              pct: m.diskRootPercent,
                              sub: `${formatBytes(m.diskRootUsedBytes, 0)} / ${formatBytes(m.diskRootTotalBytes, 0)}`,
                            },
                          ].map((row) => (
                            <div key={row.label}>
                              <div className="flex items-center justify-between text-[11px] mb-1">
                                <span className="text-slate-400">{row.label}</span>
                                <span className="font-mono text-[10px] text-slate-500">{row.sub}</span>
                                <span className={`font-mono font-semibold ${usageTextColor(row.pct)}`}>
                                  {row.pct.toFixed(0)}%
                                </span>
                              </div>
                              <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${usageBarColor(row.pct)}`}
                                  style={{ width: `${Math.min(100, Math.max(2, row.pct))}%` }}
                                />
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Proxy Quality & Line Stability Strip */}
                        <div className="pt-2 border-t border-white/[0.06] space-y-2">
                          {/* Live 24h Network Stability */}
                          {netBadge && snap.networkSummary && (
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectServer(snap.server.id, 'network');
                              }}
                              className="flex items-center justify-between gap-2 group/net"
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border shrink-0 ${netBadge.cls}`}>
                                  {netBadge.label}
                                </span>
                                <span className="text-[10px] font-mono text-slate-400 truncate">
                                  丢包 {snap.networkSummary.maxLossPct}%
                                  {snap.networkSummary.peakDeltaMs !== undefined
                                    ? ` · 高峰 ${snap.networkSummary.peakDeltaMs >= 0 ? '+' : ''}${snap.networkSummary.peakDeltaMs}ms`
                                    : ''}
                                </span>
                              </div>
                              <ArrowUpRight className="w-3 h-3 text-slate-600 group-hover/net:text-sky-300 shrink-0" />
                            </div>
                          )}

                          {/* NodeQuality & Key Unlocks */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectServer(snap.server.id, 'nodequality');
                            }}
                            className="flex items-start justify-between gap-2 group/nq"
                          >
                            {snap.activeNodeQualityJob ? (
                              <div className="flex items-center gap-1.5 text-[11px] text-amber-300">
                                <Activity className="w-3.5 h-3.5 animate-pulse shrink-0" />
                                <span className="truncate">{snap.activeNodeQualityJob.phase}</span>
                              </div>
                            ) : nq ? (
                              <div className="min-w-0 space-y-1.5">
                                <div className="flex items-center gap-1.5 text-[11px]">
                                  <Zap className="w-3 h-3 text-emerald-400 shrink-0" />
                                  <span className="text-slate-200 font-medium truncate">
                                    {countryFlag(nq.summary.ip.country)}{' '}
                                    {nq.summary.ip.asn || 'NodeQuality'}{' '}
                                    {nq.summary.ip.ipType ? `· ${nq.summary.ip.ipType}` : ''}
                                  </span>
                                </div>
                                {keyUnlocks.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {keyUnlocks.map((u) => (
                                      <span
                                        key={u.service}
                                        className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
                                      >
                                        {countryFlag(u.region)} {u.service}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-[10px] text-slate-500 font-mono">
                                    {formatRelativeTime(nq.finishedAt || nq.startedAt)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5 text-[11px] text-slate-400 group-hover/nq:text-sky-300">
                                <Zap className="w-3 h-3" />
                                <span>运行 NodeQuality 质检</span>
                              </div>
                            )}
                            <ArrowUpRight className="w-3.5 h-3.5 text-slate-500 group-hover/nq:text-sky-300 shrink-0 mt-0.5" />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-xl p-3">
                        <div className="font-medium mb-1">节点离线</div>
                        <div className="text-[11px] text-rose-300/80 break-all">{snap.error}</div>
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
