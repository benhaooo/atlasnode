import React, { useEffect } from 'react';
import {
  GitCompareArrows,
  LayoutGrid,
  Plus,
  Settings,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Wifi,
  X,
} from 'lucide-react';
import type { ServerSnapshot } from '../types';
import { serverFlag } from '../utils';
import { BrandLogo } from './BrandLogo';

interface SidebarProps {
  snapshots: ServerSnapshot[];
  selectedId: string | null;
  activeView: 'overview' | 'compare' | 'server';
  loading: boolean;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
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
  mobileOpen = false,
  onCloseMobile,
  onSelectOverview,
  onSelectCompare,
  onSelectServer,
  onAddServer,
  onOpenSettings,
  onRefresh,
  onLogout,
}) => {
  const onlineCount = snapshots.filter((s) => s.online).length;

  useEffect(() => {
    if (!mobileOpen || !onCloseMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {/* Mobile Drawer Backdrop */}
      {mobileOpen && (
        <div
          onClick={onCloseMobile}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/65 backdrop-blur-[2px] lg:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-68 max-w-[85vw] h-dvh bg-[#0a0d13]/95 backdrop-blur-xl border-r border-white/[0.05] flex flex-col select-none transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-60 lg:max-w-none lg:shrink-0 lg:h-screen lg:sticky lg:top-0 lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
      >
        {/* Brand Header */}
        <div className="px-4 h-14 flex items-center justify-between">
          <button
            onClick={onSelectOverview}
            className="flex items-center gap-2.5 text-left group cursor-pointer"
          >
            <BrandLogo className="w-6 h-6 shrink-0 group-hover:scale-105 transition-transform" />
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold text-white tracking-tight">AtlasNode</span>
              <span className="text-[10px] text-slate-500 font-mono">
                {onlineCount}/{snapshots.length}
              </span>
            </div>
          </button>

          <div className="flex items-center gap-0.5">
            <button
              onClick={onRefresh}
              title="刷新全部节点状态"
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
            </button>
            {onCloseMobile && (
              <button
                onClick={onCloseMobile}
                aria-label="关闭菜单"
                className="lg:hidden p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Primary Workspace Links */}
        <div className="px-2.5 pb-3 space-y-0.5">
          <button
            onClick={onSelectOverview}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
              activeView === 'overview'
                ? 'bg-white/[0.07] text-white font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
            }`}
          >
            <span className="flex items-center gap-2">
              <LayoutGrid className={`w-3.5 h-3.5 ${activeView === 'overview' ? 'text-sky-400' : 'text-slate-500'}`} />
              <span>全局总览</span>
            </span>
            <span className="text-[10px] font-mono text-slate-500">{snapshots.length}</span>
          </button>
          <button
            onClick={onSelectCompare}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors cursor-pointer ${
              activeView === 'compare'
                ? 'bg-white/[0.07] text-white font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]'
            }`}
          >
            <span className="flex items-center gap-2">
              <GitCompareArrows className={`w-3.5 h-3.5 ${activeView === 'compare' ? 'text-sky-400' : 'text-slate-500'}`} />
              <span>横向对比</span>
            </span>
            <span className="text-[10px] font-mono text-slate-500">N×N</span>
          </button>
        </div>

        {/* Section Divider + Node List Header */}
        <div className="mx-3 border-t border-white/[0.05]" />
        <div className="px-3.5 pt-3 pb-1.5 flex items-center justify-between">
          <span className="text-[10px] font-medium tracking-wider text-slate-500">
            节点
          </span>
          <button
            onClick={onAddServer}
            className="flex items-center gap-0.5 text-[11px] text-slate-400 hover:text-sky-300 transition-colors cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>添加</span>
          </button>
        </div>

        {/* Compact, Breathing Node List */}
        <div className="flex-1 overflow-y-auto px-2 space-y-1 pb-4">
          {snapshots.map((snap) => {
            const isSelected = selectedId === snap.server.id;
            const cpu = snap.metrics?.cpuPercent ?? 0;
            const mem = snap.metrics?.memPercent ?? 0;
            const diskWarn = (snap.metrics?.diskRootPercent ?? 0) >= 85;
            const trafficWarn =
              snap.trafficSummary &&
              snap.trafficSummary.quotaBytes > 0 &&
              snap.trafficSummary.usedPercent >= 85;
            const fwWarn =
              snap.online && !snap.firewallSummary.active && snap.firewallSummary.publicPortsCount > 2;

            return (
              <button
                key={snap.server.id}
                onClick={() => onSelectServer(snap.server.id)}
                className={`group relative w-full text-left px-2.5 py-2 rounded-xl transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-white/[0.07] text-white'
                    : 'text-slate-300 hover:bg-white/[0.035]'
                }`}
              >
                {/* Linear-style subtle left accent bar for active node */}
                {isSelected && (
                  <span className="absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-r-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.8)]" />
                )}

                {/* Row 1: Status + Flag + Name + Alerts */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        snap.online
                          ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.65)]'
                          : 'bg-rose-500'
                      }`}
                    />
                    <span className="text-xs leading-none shrink-0">
                      {serverFlag(snap.server.region, snap.latestNodeQuality?.summary.ip.country, snap.server.tags)}
                    </span>
                    <span className={`text-xs truncate ${isSelected ? 'font-semibold text-white' : 'font-medium text-slate-200'}`}>
                      {snap.server.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {snap.activeNodeQualityJob && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" title="NodeQuality 测试中" />
                    )}
                    {(diskWarn || fwWarn || trafficWarn) && (
                      <ShieldAlert className="w-3 h-3 text-amber-400/90" />
                    )}
                  </div>
                </div>

                {/* Row 2: Role + Compact Live Telemetry */}
                <div className="mt-1 pl-3.5 flex items-center justify-between gap-2 text-[10px]">
                  <span className="text-slate-500 truncate">
                    {snap.server.role || snap.publicIp || snap.server.host}
                  </span>
                  {snap.online ? (
                    <span className="font-mono text-slate-400 shrink-0 flex items-center gap-1.5">
                      <span className={cpu >= 80 ? 'text-rose-400' : isSelected ? 'text-sky-300' : 'text-slate-400'}>
                        {cpu.toFixed(1)}%
                      </span>
                      <span className="text-slate-700">/</span>
                      <span className={mem >= 85 ? 'text-amber-300' : 'text-slate-500'}>
                        {mem.toFixed(0)}%
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono text-rose-400/80 shrink-0">离线</span>
                  )}
                </div>

                {/* Ultra-thin dual micro-bar (CPU sky + MEM indigo) */}
                {snap.online && (
                  <div className="mt-1.5 pl-3.5 grid grid-cols-2 gap-1.5">
                    <div className="h-[2px] bg-white/[0.05] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${cpu >= 80 ? 'bg-rose-400' : 'bg-sky-400/80'}`}
                        style={{ width: `${Math.min(100, Math.max(3, cpu))}%` }}
                      />
                    </div>
                    <div className="h-[2px] bg-white/[0.05] rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${mem >= 85 ? 'bg-amber-400' : 'bg-indigo-400/75'}`}
                        style={{ width: `${Math.min(100, Math.max(3, mem))}%` }}
                      />
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Minimal Footer */}
        <div className="px-2.5 py-2 border-t border-white/[0.05] flex items-center justify-between gap-1">
          <button
            onClick={onOpenSettings}
            className="flex-1 flex items-center gap-2 py-1.5 px-2.5 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-white/[0.04] transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5 text-slate-500" />
            <span>设置与告警</span>
          </button>
          <button
            onClick={onAddServer}
            title="发现 Tailscale 节点"
            className="p-1.5 rounded-lg text-slate-500 hover:text-sky-300 hover:bg-white/[0.04] transition-colors cursor-pointer"
          >
            <Wifi className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onLogout}
            title="退出登录"
            className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-white/[0.04] transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>
    </>
  );
};
