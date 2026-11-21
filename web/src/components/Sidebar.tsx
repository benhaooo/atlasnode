import React from 'react';
import {
  GitCompareArrows,
  LayoutGrid,
  Plus,
  Settings,
  LogOut,
  RefreshCw,
  Box,
  ShieldAlert,
  Wifi,
} from 'lucide-react';
import type { ServerSnapshot } from '../types';
import { serverFlag } from '../utils';
import { BrandLogo } from './BrandLogo';

interface SidebarProps {
  snapshots: ServerSnapshot[];
  selectedId: string | null;
  activeView: 'overview' | 'compare' | 'server';
  loading: boolean;
  onSelectOverview: () => void;
  onSelectCompare: () => void;
  onSelectServer: (id: string) => void;
  onAddServer: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  snapshots,
  selectedId,
  activeView,
  loading,
  onSelectOverview,
  onSelectCompare,
  onSelectServer,
  onAddServer,
  onOpenSettings,
  onRefresh,
  onLogout,
}) => {
  const onlineCount = snapshots.filter((s) => s.online).length;

  return (
    <aside className="w-64 shrink-0 bg-[#0c0f16] border-r border-white/[0.06] flex flex-col h-screen sticky top-0 select-none">
      {/* Brand header */}
      <div className="px-4 h-14 flex items-center justify-between border-b border-white/[0.06]">
        <button
          onClick={onSelectOverview}
          className="flex items-center gap-2.5 text-left group cursor-pointer"
        >
          <BrandLogo className="w-7 h-7 shrink-0 group-hover:scale-105 transition-transform" />
          <div>
            <div className="text-sm font-semibold text-white tracking-tight leading-none">AtlasNode</div>
            <div className="text-[10px] text-slate-500 mt-1 font-mono">
              {onlineCount}/{snapshots.length} ONLINE
            </div>
          </div>
        </button>

        <button
          onClick={onRefresh}
          title="刷新全部节点状态"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
        </button>
      </div>

      {/* Fleet Overview & Compare Links */}
      <div className="p-2.5 space-y-1">
        <button
          onClick={onSelectOverview}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            activeView === 'overview'
              ? 'bg-sky-500/12 text-sky-300 border border-sky-400/25'
              : 'text-slate-300 hover:bg-white/[0.04] border border-transparent'
          }`}
        >
          <span className="flex items-center gap-2">
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>节点全局总览</span>
          </span>
          <span className="text-[10px] font-mono text-slate-500">{snapshots.length}</span>
        </button>
        <button
          onClick={onSelectCompare}
          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
            activeView === 'compare'
              ? 'bg-sky-500/12 text-sky-300 border border-sky-400/25'
              : 'text-slate-300 hover:bg-white/[0.04] border border-transparent'
          }`}
        >
          <span className="flex items-center gap-2">
            <GitCompareArrows className="w-3.5 h-3.5" />
            <span>多节点横向对比</span>
          </span>
          <span className="text-[10px] font-mono text-slate-500">N×N</span>
        </button>
      </div>

      {/* Node List */}
      <div className="px-3 pt-2 pb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          受管服务器
        </span>
        <button
          onClick={onAddServer}
          className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 cursor-pointer"
        >
          <Plus className="w-3 h-3" />
          <span>添加 / 发现</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 space-y-1.5 pb-4">
        {snapshots.map((snap) => {
          const isSelected = selectedId === snap.server.id;
          const cpu = snap.metrics?.cpuPercent ?? 0;
          const mem = snap.metrics?.memPercent ?? 0;
          const diskWarn = (snap.metrics?.diskRootPercent ?? 0) >= 85;
          const fwWarn = snap.online && !snap.firewallSummary.active && snap.firewallSummary.publicPortsCount > 2;

          return (
            <button
              key={snap.server.id}
              onClick={() => onSelectServer(snap.server.id)}
              className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer ${
                isSelected
                  ? 'bg-[#141a24] border-sky-400/35 shadow-sm'
                  : 'bg-transparent border-transparent hover:bg-white/[0.03] hover:border-white/[0.06]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      snap.online
                        ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                        : 'bg-rose-500'
                    }`}
                  />
                  <span className="text-xs leading-none shrink-0">
                    {serverFlag(snap.server.region, snap.latestNodeQuality?.summary.ip.country, snap.server.tags)}
                  </span>
                  <span className="text-xs font-semibold text-slate-100 truncate">
                    {snap.server.name}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {snap.activeNodeQualityJob && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" title="NodeQuality 测试中" />
                  )}
                  {(diskWarn || fwWarn) && (
                    <ShieldAlert className="w-3 h-3 text-amber-400" />
                  )}
                </div>
              </div>

              <div className="text-[11px] text-slate-400 truncate mt-0.5 pl-4">
                {snap.server.role}
              </div>

              <div className="mt-2 pl-4 flex items-center justify-between text-[10px] font-mono text-slate-500">
                <span className="truncate">{snap.publicIp || snap.server.host}</span>
                {snap.online && snap.dockerSummary.running > 0 && (
                  <span className="flex items-center gap-0.5 text-slate-400">
                    <Box className="w-2.5 h-2.5 text-sky-400/80" />
                    {snap.dockerSummary.running}
                  </span>
                )}
              </div>

              {snap.online && (
                <div className="mt-2 pl-4 grid grid-cols-2 gap-2">
                  <div>
                    <div className="flex justify-between text-[9px] font-mono text-slate-500 mb-0.5">
                      <span>CPU</span>
                      <span className="text-slate-300">{cpu.toFixed(0)}%</span>
                    </div>
                    <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${cpu >= 80 ? 'bg-rose-400' : 'bg-sky-400'}`}
                        style={{ width: `${Math.min(100, Math.max(3, cpu))}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-[9px] font-mono text-slate-500 mb-0.5">
                      <span>MEM</span>
                      <span className="text-slate-300">{mem.toFixed(0)}%</span>
                    </div>
                    <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${mem >= 85 ? 'bg-amber-400' : 'bg-indigo-400'}`}
                        style={{ width: `${Math.min(100, Math.max(3, mem))}%` }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div className="p-2.5 border-t border-white/[0.06] flex items-center justify-between gap-1">
        <button
          onClick={onOpenSettings}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>密钥与设置</span>
        </button>
        <button
          onClick={onAddServer}
          title="发现 Tailscale 节点"
          className="p-2 rounded-lg text-slate-400 hover:text-sky-300 hover:bg-white/[0.05] transition-colors cursor-pointer"
        >
          <Wifi className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onLogout}
          title="退出登录"
          className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-white/[0.05] transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
    </aside>
  );
};
