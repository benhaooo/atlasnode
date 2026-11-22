import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Box,
  Check,
  Copy,
  Edit3,
  FolderOpen,
  Globe,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Network,
  Radio,
  RefreshCw,
  Shield,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import type { LiveMetrics, ServerConfig, ServerSnapshot } from '../types';
import { copyToClipboard, formatUptime, serverFlag } from '../utils';
import { OverviewTab } from './OverviewTab';
import { ServicesTab } from './ServicesTab';
import { NodeQualityTab } from './NodeQualityTab';
import { FirewallTab } from './FirewallTab';
import { FilesTab } from './FilesTab';
import { KeysTab } from './KeysTab';
import { AssetsTab } from './AssetsTab';
import { TerminalTab } from './TerminalTab';
import { NetworkTab } from './NetworkTab';

export type ServerTab =
  | 'overview'
  | 'services'
  | 'network'
  | 'nodequality'
  | 'firewall'
  | 'assets'
  | 'files'
  | 'terminal'
  | 'keys';

interface ServerDetailProps {
  snapshot: ServerSnapshot;
  initialTab?: ServerTab;
  onTabChange?: (tab: ServerTab) => void;
  onRefreshSnapshot: () => void;
  onServerUpdated: (server: ServerConfig) => void;
  onServerDeleted: () => void;
}

const TABS: { id: ServerTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'services', label: '容器与服务', icon: Box },
  { id: 'network', label: '网络与线路', icon: Network },
  { id: 'nodequality', label: 'NodeQuality 质检', icon: Zap },
  { id: 'firewall', label: '防火墙与端口', icon: Shield },
  { id: 'assets', label: '磁盘与资产', icon: HardDrive },
  { id: 'files', label: '文件管理', icon: FolderOpen },
  { id: 'terminal', label: '网页终端', icon: Terminal },
  { id: 'keys', label: 'SSH 公钥', icon: KeyRound },
];

export const ServerDetail: React.FC<ServerDetailProps> = ({
  snapshot,
  initialTab = 'overview',
  onTabChange,
  onRefreshSnapshot,
  onServerUpdated,
  onServerDeleted,
}) => {
  const [activeTab, setActiveTab] = useState<ServerTab>(initialTab);
  const [fileInitialPath, setFileInitialPath] = useState<string>('/');
  const [terminalContainer, setTerminalContainer] = useState<string | null>(null);
  const [liveMetrics, setLiveMetrics] = useState<LiveMetrics | undefined>(snapshot.metrics);
  const [history, setHistory] = useState<{ cpu: number[]; rx: number[]; tx: number[] }>({
    cpu: snapshot.metrics ? [snapshot.metrics.cpuPercent] : [],
    rx: snapshot.metrics ? [snapshot.metrics.netRxBps] : [],
    tx: snapshot.metrics ? [snapshot.metrics.netTxBps] : [],
  });
  const [streamConnected, setStreamConnected] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaForm, setMetaForm] = useState({
    name: snapshot.server.name,
    role: snapshot.server.role,
    notes: snapshot.server.notes,
    tags: snapshot.server.tags.join(', '),
  });
  const [savingMeta, setSavingMeta] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const switchTab = (tab: ServerTab) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  useEffect(() => {
    setActiveTab(initialTab);
    if (initialTab !== 'terminal') {
      setTerminalContainer(null);
    }
  }, [initialTab, snapshot.server.id]);

  useEffect(() => {
    setTerminalContainer(null);
  }, [snapshot.server.id]);

  useEffect(() => {
    setMetaForm({
      name: snapshot.server.name,
      role: snapshot.server.role,
      notes: snapshot.server.notes,
      tags: snapshot.server.tags.join(', '),
    });
  }, [snapshot.server]);

  // Live SSE telemetry stream per server
  useEffect(() => {
    setLiveMetrics(snapshot.metrics);
    setHistory({
      cpu: snapshot.metrics ? [snapshot.metrics.cpuPercent] : [],
      rx: snapshot.metrics ? [snapshot.metrics.netRxBps] : [],
      tx: snapshot.metrics ? [snapshot.metrics.netTxBps] : [],
    });

    if (!snapshot.online) {
      setStreamConnected(false);
      return;
    }

    const es = new EventSource(`/api/servers/${encodeURIComponent(snapshot.server.id)}/stream`, {
      withCredentials: true,
    });
    esRef.current = es;

    es.onopen = () => setStreamConnected(true);
    es.addEventListener('metrics', (ev) => {
      try {
        const m = JSON.parse((ev as MessageEvent).data) as LiveMetrics;
        setStreamConnected(true);
        setLiveMetrics(m);
        setHistory((prev) => ({
          cpu: [...prev.cpu.slice(-44), m.cpuPercent],
          rx: [...prev.rx.slice(-44), m.netRxBps],
          tx: [...prev.tx.slice(-44), m.netTxBps],
        }));
      } catch {
        // ignore parse errors
      }
    });
    es.onerror = () => setStreamConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [snapshot.server.id, snapshot.online]);

  const handleCopy = async (key: string, text: string) => {
    await copyToClipboard(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleSaveMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingMeta(true);
    try {
      const { server } = await api.updateServer(snapshot.server.id, {
        name: metaForm.name,
        role: metaForm.role,
        notes: metaForm.notes,
        tags: metaForm.tags
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      onServerUpdated(server);
      setEditingMeta(false);
    } finally {
      setSavingMeta(false);
    }
  };

  const handleDeleteServer = async () => {
    if (!confirm(`确认从面板中移除服务器 "${snapshot.server.name}"？（不会影响远端服务器本身）`)) return;
    await api.deleteServer(snapshot.server.id);
    onServerDeleted();
  };

  const jumpToFolder = (dirPath: string) => {
    setFileInitialPath(dirPath);
    switchTab('files');
  };

  const sshCmd = `ssh ${snapshot.server.username}@${snapshot.tailscaleIp || snapshot.publicIp || snapshot.server.host}${snapshot.server.port !== 22 ? ` -p ${snapshot.server.port}` : ''}`;

  return (
    <div className="min-h-dvh flex flex-col">
      {/* Server Identity Bar (scrolls away on mobile to save vertical space, sticky with tabs on lg+) */}
      <div className="bg-[#090b10] border-b border-white/[0.04] lg:border-b-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-3 sm:pt-4 pb-3 sm:pb-3.5">
          {/* Identity Row */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 sm:gap-2.5 flex-wrap">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    snapshot.online
                      ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.55)]'
                      : 'bg-rose-500'
                  }`}
                />
                <span className="text-base leading-none">
                  {serverFlag(snapshot.server.region, snapshot.latestNodeQuality?.summary.ip.country, snapshot.server.tags)}
                </span>
                <h1 className="text-base sm:text-lg font-semibold text-white tracking-tight">
                  {snapshot.server.name}
                </h1>
                <span className="text-xs text-sky-300/90 font-medium">{snapshot.server.role}</span>

                {streamConnected && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                    <Activity className="w-2.5 h-2.5 animate-pulse" />
                    LIVE 2s
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[11px] font-mono text-slate-400">
                {snapshot.publicIp && (
                  <button
                    onClick={() => handleCopy('pub', snapshot.publicIp!)}
                    className="inline-flex items-center gap-1 hover:text-white transition-colors cursor-pointer"
                  >
                    <Globe className="w-3 h-3 text-slate-500" />
                    <span>{snapshot.publicIp}</span>
                    {copied === 'pub' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-2.5 h-2.5 opacity-50" />}
                  </button>
                )}
                {snapshot.tailscaleIp && (
                  <>
                    <span className="text-slate-700">·</span>
                    <button
                      onClick={() => handleCopy('ts', snapshot.tailscaleIp!)}
                      className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200 transition-colors cursor-pointer"
                    >
                      <Radio className="w-3 h-3" />
                      <span>{snapshot.tailscaleIp}</span>
                      {copied === 'ts' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-2.5 h-2.5 opacity-50" />}
                    </button>
                  </>
                )}
                {snapshot.online && (
                  <>
                    <span className="text-slate-700">·</span>
                    <span>{snapshot.os?.replace(' LTS', '')}</span>
                    <span className="text-slate-700">·</span>
                    <span>在线 {formatUptime(liveMetrics?.uptimeSeconds)}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <button
                onClick={() => handleCopy('ssh', sshCmd)}
                className="flex items-center gap-1.5 text-xs font-mono bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-200 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
              >
                {copied === 'ssh' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Terminal className="w-3.5 h-3.5 text-sky-400" />}
                <span>{copied === 'ssh' ? '已复制 SSH' : '复制 SSH'}</span>
              </button>
              <button
                onClick={() => setEditingMeta(true)}
                title="编辑节点备注与用途"
                className="p-2 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 hover:text-white transition-colors cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onRefreshSnapshot}
                title="刷新快照"
                className="p-2 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 hover:text-white transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              {snapshot.server.mode !== 'local' && (
                <button
                  onClick={handleDeleteServer}
                  title="移除节点"
                  className="p-2 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/15 border border-white/[0.08] hover:border-rose-500/30 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Persistent Workspace Tabs */}
      <header className="sticky top-12 lg:top-0 z-20 bg-[#090b10]/95 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <nav className="flex items-center gap-0.5 sm:gap-1 overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0 -mb-px">
            {TABS.map((t) => {
              const Icon = t.icon;
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => switchTab(t.id)}
                  className={`flex items-center gap-1.5 px-3 sm:px-3.5 py-2.5 text-xs font-medium border-b-2 whitespace-nowrap transition-colors cursor-pointer shrink-0 ${
                    isActive
                      ? 'border-sky-400 text-sky-300'
                      : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-white/15'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{t.label}</span>
                  {t.id === 'services' && snapshot.dockerSummary.running > 0 && (
                    <span className="ml-0.5 text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-white/[0.06] text-slate-300">
                      {snapshot.dockerSummary.running}
                    </span>
                  )}
                  {t.id === 'nodequality' && snapshot.activeNodeQualityJob && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Main Workspace Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-4 sm:py-6">
        {!snapshot.online && activeTab !== 'nodequality' ? (
          <div className="bg-rose-500/10 border border-rose-500/25 rounded-2xl p-6 text-sm text-rose-200">
            <div className="font-semibold mb-1">当前无法连接到该服务器</div>
            <div className="font-mono text-xs text-rose-300/80">{snapshot.error}</div>
          </div>
        ) : (
          <>
            {activeTab === 'overview' && (
              <OverviewTab
                snapshot={snapshot}
                metrics={liveMetrics}
                history={history}
                onNavigateTab={switchTab}
                onJumpFolder={jumpToFolder}
                onServerUpdated={onServerUpdated}
              />
            )}
            {activeTab === 'services' && (
              <ServicesTab
                snapshot={snapshot}
                onJumpFolder={jumpToFolder}
                onServerUpdated={onServerUpdated}
                onRefreshSnapshot={onRefreshSnapshot}
                onOpenContainerTerminal={(name) => {
                  setTerminalContainer(name);
                  switchTab('terminal');
                }}
              />
            )}
            {activeTab === 'network' && <NetworkTab snapshot={snapshot} />}
            {activeTab === 'nodequality' && (
              <NodeQualityTab snapshot={snapshot} onRefreshSnapshot={onRefreshSnapshot} />
            )}
            {activeTab === 'firewall' && (
              <FirewallTab snapshot={snapshot} onRefreshSnapshot={onRefreshSnapshot} />
            )}
            {activeTab === 'assets' && (
              <AssetsTab
                snapshot={snapshot}
                onJumpFolder={jumpToFolder}
                onRefreshSnapshot={onRefreshSnapshot}
              />
            )}
            {activeTab === 'files' && (
              <FilesTab snapshot={snapshot} initialPath={fileInitialPath} />
            )}
            {activeTab === 'terminal' && (
              <TerminalTab
                snapshot={snapshot}
                containerName={terminalContainer}
                onClearContainer={() => setTerminalContainer(null)}
              />
            )}
            {activeTab === 'keys' && <KeysTab snapshot={snapshot} />}
          </>
        )}
      </main>

      {/* Edit Node Metadata Modal */}
      {editingMeta && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-[#0f131b] border border-white/10 rounded-2xl w-full max-w-md max-h-[90dvh] overflow-y-auto p-4 sm:p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-white">编辑节点信息与备注</h3>
              <button
                onClick={() => setEditingMeta(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveMeta} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">节点显示名称</label>
                <input
                  value={metaForm.name}
                  onChange={(e) => setMetaForm({ ...metaForm, name: e.target.value })}
                  className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">核心定位 / 角色</label>
                <input
                  value={metaForm.role}
                  onChange={(e) => setMetaForm({ ...metaForm, role: e.target.value })}
                  placeholder="例如：香港应用主机 / 代理中继 / 数据库节点"
                  className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">服务器说明（里面有什么、用途备忘）</label>
                <textarea
                  rows={3}
                  value={metaForm.notes}
                  onChange={(e) => setMetaForm({ ...metaForm, notes: e.target.value })}
                  className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none resize-none"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">标签（逗号分隔）</label>
                <input
                  value={metaForm.tags}
                  onChange={(e) => setMetaForm({ ...metaForm, tags: e.target.value })}
                  className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingMeta(false)}
                  className="px-3.5 py-2 rounded-lg text-slate-400 hover:text-white cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={savingMeta}
                  className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer"
                >
                  {savingMeta ? '保存中...' : '保存'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
