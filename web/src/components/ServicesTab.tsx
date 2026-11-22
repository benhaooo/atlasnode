import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Box,
  Cpu,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  Save,
  Search,
  ServerCog,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { DockerContainer, ProxyRoute, ServerConfig, ServerSnapshot, SystemdService } from '../types';

interface ServicesTabProps {
  snapshot: ServerSnapshot;
  onJumpFolder: (dirPath: string) => void;
  onServerUpdated: (server: ServerConfig) => void;
  onRefreshSnapshot: () => void;
  onOpenContainerTerminal?: (containerName: string) => void;
}

export const ServicesTab: React.FC<ServicesTabProps> = ({
  snapshot,
  onJumpFolder,
  onRefreshSnapshot,
  onOpenContainerTerminal,
}) => {
  const [loading, setLoading] = useState(true);
  const [dockerAvailable, setDockerAvailable] = useState(snapshot.dockerAvailable);
  const [containers, setContainers] = useState<DockerContainer[]>(snapshot.containersPreview);
  const [systemdServices, setSystemdServices] = useState<SystemdService[]>(snapshot.systemdHighlights);
  const [proxyRoutes, setProxyRoutes] = useState<ProxyRoute[]>([]);
  const [loadingProxies, setLoadingProxies] = useState(false);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logsModal, setLogsModal] = useState<{ title: string; content: string; loading: boolean } | null>(null);
  const [composeModal, setComposeModal] = useState<{
    project: string;
    dir: string;
    path: string;
    content: string;
    loading: boolean;
    saving: boolean;
    msg?: string;
  } | null>(null);
  const [streamModal, setStreamModal] = useState<{
    title: string;
    output: string;
    running: boolean;
  } | null>(null);
  const streamPreRef = useRef<HTMLPreElement | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getServices(snapshot.server.id);
      setDockerAvailable(res.dockerAvailable);
      setContainers(res.containers);
      setSystemdServices(res.systemdServices);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载服务列表失败');
    } finally {
      setLoading(false);
    }
  };

  const loadProxies = async () => {
    setLoadingProxies(true);
    try {
      const res = await api.getProxies(snapshot.server.id);
      setProxyRoutes(res.routes || []);
    } catch {
      // non-fatal
    } finally {
      setLoadingProxies(false);
    }
  };

  useEffect(() => {
    setProxyRoutes([]);
    load();
    loadProxies();
  }, [snapshot.server.id]);

  const handleOpenComposeEditor = async (project: string, dir: string) => {
    setComposeModal({ project, dir, path: '', content: '', loading: true, saving: false });
    try {
      const res = await api.readComposeFile(snapshot.server.id, dir);
      setComposeModal({
        project,
        dir,
        path: res.path,
        content: res.content,
        loading: false,
        saving: false,
      });
    } catch (err) {
      setComposeModal({
        project,
        dir,
        path: '',
        content: '',
        loading: false,
        saving: false,
        msg: err instanceof Error ? err.message : '读取 compose 文件失败',
      });
    }
  };

  const handleSaveComposeFile = async () => {
    if (!composeModal || !composeModal.path) return;
    setComposeModal((prev) => (prev ? { ...prev, saving: true, msg: undefined } : prev));
    try {
      await api.writeFile(snapshot.server.id, composeModal.path, composeModal.content);
      setComposeModal((prev) => (prev ? { ...prev, saving: false, msg: '已保存 compose 文件，可点击“更新重建”应用变更' } : prev));
    } catch (err) {
      setComposeModal((prev) =>
        prev
          ? { ...prev, saving: false, msg: err instanceof Error ? err.message : '保存失败' }
          : prev
      );
    }
  };

  const handleComposeAction = async (
    project: string,
    dir: string,
    action: 'pull_up' | 'up' | 'restart'
  ) => {
    const label =
      action === 'pull_up'
        ? '拉取最新镜像并重建 (pull && up -d)'
        : action === 'up'
          ? '应用配置并重建 (up -d)'
          : '重启栈 (restart)';
    if (action === 'pull_up' && !confirm(`确认对 ${project} 执行 docker compose pull && up -d？`)) return;
    setStreamModal({ title: `${project} · ${label}`, output: `$ cd ${dir}\n`, running: true });
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(snapshot.server.id)}/compose/action`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir, action }),
        }
      );
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `请求失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        setStreamModal((prev) => (prev ? { ...prev, output: prev.output + text } : prev));
        setTimeout(() => {
          if (streamPreRef.current) {
            streamPreRef.current.scrollTop = streamPreRef.current.scrollHeight;
          }
        }, 0);
      }
      setStreamModal((prev) => (prev ? { ...prev, running: false } : prev));
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setStreamModal((prev) =>
        prev
          ? {
              ...prev,
              running: false,
              output: prev.output + `\n[Error] ${err instanceof Error ? err.message : String(err)}\n`,
            }
          : prev
      );
    }
  };

  const handleDockerAction = async (c: DockerContainer, action: 'start' | 'stop' | 'restart') => {
    setBusyId(`${c.id}-${action}`);
    setError('');
    try {
      await api.dockerAction(snapshot.server.id, c.id, action);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleOpenDockerLogs = async (c: DockerContainer) => {
    setLogsModal({ title: `Docker 日志 · ${c.name}`, content: '', loading: true });
    try {
      const res = await api.dockerLogs(snapshot.server.id, c.id, 220);
      setLogsModal({ title: `Docker 日志 · ${c.name}`, content: res.logs || '(无日志输出)', loading: false });
    } catch (err) {
      setLogsModal({
        title: `Docker 日志 · ${c.name}`,
        content: err instanceof Error ? err.message : '获取日志失败',
        loading: false,
      });
    }
  };

  const handleOpenSystemdLogs = async (svc: SystemdService) => {
    setLogsModal({ title: `Systemd 日志 · ${svc.name}`, content: '', loading: true });
    try {
      const res = await api.systemdLogs(snapshot.server.id, svc.name, 140);
      setLogsModal({ title: `Systemd 日志 · ${svc.name}`, content: res.logs || '(无日志输出)', loading: false });
    } catch (err) {
      setLogsModal({
        title: `Systemd 日志 · ${svc.name}`,
        content: err instanceof Error ? err.message : '获取日志失败',
        loading: false,
      });
    }
  };

  const handleSystemdRestart = async (svc: SystemdService) => {
    if (!confirm(`确认重启系统服务 ${svc.name}？`)) return;
    setBusyId(`svc-${svc.name}`);
    try {
      await api.systemdAction(snapshot.server.id, svc.name, 'restart');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重启失败');
    } finally {
      setBusyId(null);
    }
  };

  // Group containers by Compose Project
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = containers.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        (c.composeProject || '').toLowerCase().includes(q)
    );
    const map = new Map<string, { project: string; dir?: string; items: DockerContainer[] }>();
    for (const c of filtered) {
      const key = c.composeProject || '独立容器 (Standalone)';
      if (!map.has(key)) {
        map.set(key, { project: key, dir: c.composeDir, items: [] });
      }
      map.get(key)!.items.push(c);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.project.startsWith('独立容器')) return 1;
      if (b.project.startsWith('独立容器')) return -1;
      return b.items.length - a.items.length;
    });
  }, [containers, query]);

  const allLinks = [...snapshot.server.quickLinks, ...snapshot.detectedLinks];

  return (
    <div className="space-y-6">
      {/* Reverse Proxy Domains & TLS Certificate Topology (shown only when routes exist) */}
      {proxyRoutes.length > 0 && (
        <section className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-emerald-300 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              <span>反代域名与证书拓扑 ({proxyRoutes.length})</span>
            </div>
            <button
              onClick={loadProxies}
              disabled={loadingProxies}
              className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loadingProxies ? 'animate-spin text-sky-400' : ''}`} />
              <span>刷新域名与证书</span>
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {proxyRoutes.map((route, idx) => {
                const days = route.tlsDaysLeft;
                const certColor =
                  days === null || days === undefined
                    ? 'text-slate-500 bg-white/[0.04] border-white/[0.07]'
                    : days <= 7
                      ? 'text-rose-300 bg-rose-500/15 border-rose-500/30'
                      : days <= 20
                        ? 'text-amber-300 bg-amber-500/15 border-amber-500/30'
                        : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25';
                return (
                  <div
                    key={`${route.engine}-${route.domain}-${idx}`}
                    className="bg-[#0f131b] border border-white/[0.07] hover:border-emerald-400/35 rounded-xl p-3.5 transition-all space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-400/25 text-sky-300">
                            {route.engine}
                          </span>
                          {route.url ? (
                            <a
                              href={route.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs font-semibold text-white hover:text-sky-300 truncate inline-flex items-center gap-1"
                            >
                              <span className="truncate">{route.domain}</span>
                              <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" />
                            </a>
                          ) : (
                            <span className="text-xs font-semibold text-white truncate">{route.domain}</span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 truncate mt-1">
                          → {route.upstream}
                        </div>
                      </div>
                      {days !== null && days !== undefined && (
                        <span
                          className={`text-[10px] font-mono px-2 py-0.5 rounded-md border shrink-0 inline-flex items-center gap-1 ${certColor}`}
                          title={route.tlsIssuer || 'TLS 证书剩余有效期'}
                        >
                          <ShieldCheck className="w-3 h-3" />
                          {days}天
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
        </section>
      )}

      {/* Quick-Access Web Services Shelf */}
      {allLinks.length > 0 && (
        <section className="space-y-2.5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            快捷访问入口
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {allLinks.map((link) => (
              <a
                key={link.id}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="group bg-[#0f131b] hover:bg-[#141a26] border border-white/[0.07] hover:border-sky-400/40 rounded-xl p-3.5 transition-all flex items-start justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white group-hover:text-sky-300 truncate">
                    {link.name}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 truncate mt-1">
                    {link.url}
                  </div>
                  {link.description && (
                    <div className="text-[10px] text-slate-500 truncate mt-1">{link.description}</div>
                  )}
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover:text-sky-400 shrink-0 mt-0.5" />
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Search & Refresh Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索容器名、镜像、Compose 项目..."
            className="w-full bg-[#0f131b] border border-white/[0.08] focus:border-sky-400/50 focus:outline-none rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder:text-slate-500"
          />
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-200 px-3 py-2 rounded-xl cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
          <span>刷新状态与实时资源</span>
        </button>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* Docker Section (Primary if Docker is installed) */}
      {dockerAvailable && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Box className="w-4 h-4 text-sky-400" />
              Docker 容器栈 ({containers.filter((c) => c.state === 'running').length} 运行 / {containers.length} 总计)
            </h2>
          </div>

          {grouped.length === 0 ? (
            <div className="bg-[#0f131b] border border-white/[0.06] rounded-2xl p-8 text-center text-xs text-slate-500">
              {loading ? '正在读取容器与实时资源统计...' : '没有匹配的 Docker 容器'}
            </div>
          ) : (
            grouped.map((group) => (
              <div
                key={group.project}
                className="bg-[#0f131b] border border-white/[0.07] rounded-2xl overflow-hidden"
              >
                <div className="px-4 py-2.5 bg-white/[0.02] border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-semibold text-slate-200 truncate">
                      {group.project}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      {group.items.filter((i) => i.state === 'running').length}/{group.items.length} running
                    </span>
                  </div>
                  {group.dir && (
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      <button
                        onClick={() => handleOpenComposeEditor(group.project, group.dir!)}
                        title="在线编辑 docker-compose.yml"
                        className="flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] text-slate-300 hover:text-white px-2 py-1 rounded-lg cursor-pointer"
                      >
                        <FileCode2 className="w-3 h-3 text-sky-400" />
                        <span>compose.yml</span>
                      </button>
                      <button
                        onClick={() => handleComposeAction(group.project, group.dir!, 'pull_up')}
                        title="拉取最新镜像并重建 (docker compose pull && up -d)"
                        className="flex items-center gap-1 text-[11px] bg-sky-500/12 hover:bg-sky-500/22 border border-sky-400/25 text-sky-300 px-2 py-1 rounded-lg cursor-pointer"
                      >
                        <ArrowDownToLine className="w-3 h-3" />
                        <span>更新重建</span>
                      </button>
                      <button
                        onClick={() => onJumpFolder(group.dir!)}
                        className="flex items-center gap-1 text-[11px] font-mono text-slate-400 hover:text-sky-300 cursor-pointer ml-1"
                      >
                        <FolderOpen className="w-3 h-3 text-amber-400/80" />
                        <span className="truncate max-w-[180px]">{group.dir}</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="divide-y divide-white/[0.05]">
                  {group.items.map((c) => {
                    const isRunning = c.state === 'running';
                    return (
                      <div
                        key={c.id}
                        className="px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 hover:bg-white/[0.015]"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                c.health === 'unhealthy'
                                  ? 'bg-rose-500'
                                  : isRunning
                                    ? 'bg-emerald-400'
                                    : 'bg-slate-600'
                              }`}
                            />
                            <span className="text-xs font-semibold text-white font-mono">
                              {c.name}
                            </span>
                            <span className="text-[11px] text-slate-500 truncate max-w-full sm:max-w-md font-mono">
                              {c.image}
                            </span>
                            {c.health && (
                              <span
                                className={`text-[10px] font-mono px-1.5 py-0.2 rounded border ${
                                  c.health === 'healthy'
                                    ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                                    : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
                                }`}
                              >
                                {c.health}
                              </span>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 pl-4 text-[11px]">
                            <span className="text-slate-400">{c.status}</span>
                            {c.ports.map((p, idx) =>
                              p.quickUrl ? (
                                <a
                                  key={idx}
                                  href={p.quickUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 font-mono bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/25 text-sky-300 px-2 py-0.5 rounded-md"
                                >
                                  <span>
                                    :{p.hostPort}→{p.containerPort}
                                  </span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ) : (
                                <span
                                  key={idx}
                                  className="font-mono bg-white/[0.04] border border-white/[0.06] text-slate-400 px-2 py-0.5 rounded-md"
                                >
                                  {p.hostIp}:{p.hostPort}→{p.containerPort}
                                </span>
                              )
                            )}
                          </div>
                        </div>

                        {/* Live Container Stats + Actions */}
                        <div className="flex flex-wrap items-center justify-between lg:justify-end gap-2 sm:gap-4 pl-4 lg:pl-0 shrink-0">
                          {isRunning && (c.cpuPercent !== undefined || c.memUsage) && (
                            <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
                              <span className="flex items-center gap-1">
                                <Cpu className="w-3 h-3 text-sky-400/70" />
                                {(c.cpuPercent ?? 0).toFixed(1)}%
                              </span>
                              <span>{c.memUsage?.split('/')[0]?.trim() || '—'}</span>
                            </div>
                          )}

                          <div className="flex items-center gap-1">
                            {isRunning && onOpenContainerTerminal && (
                              <button
                                onClick={() => onOpenContainerTerminal(c.name)}
                                title="进入容器终端 (docker exec)"
                                className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-emerald-500/20 text-slate-300 hover:text-emerald-300 cursor-pointer"
                              >
                                <Terminal className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleOpenDockerLogs(c)}
                              title="查看容器日志"
                              className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] text-slate-300 hover:text-white cursor-pointer"
                            >
                              <FileText className="w-3.5 h-3.5" />
                            </button>
                            {isRunning ? (
                              <>
                                <button
                                  onClick={() => handleDockerAction(c, 'restart')}
                                  disabled={busyId !== null}
                                  title="重启容器"
                                  className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-sky-500/20 text-slate-300 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                                >
                                  <RotateCw
                                    className={`w-3.5 h-3.5 ${busyId === `${c.id}-restart` ? 'animate-spin' : ''}`}
                                  />
                                </button>
                                <button
                                  onClick={() => handleDockerAction(c, 'stop')}
                                  disabled={busyId !== null}
                                  title="停止容器"
                                  className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 text-slate-300 hover:text-rose-400 cursor-pointer disabled:opacity-40"
                                >
                                  <Square className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleDockerAction(c, 'start')}
                                disabled={busyId !== null}
                                title="启动容器"
                                className="p-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 cursor-pointer disabled:opacity-40"
                              >
                                <Play className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {/* Systemd Services Section (Primary for non-Docker nodes, secondary otherwise) */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <ServerCog className="w-4 h-4 text-indigo-400" />
          宿主机 Systemd 关键服务 ({systemdServices.length})
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {systemdServices.map((svc) => (
            <div
              key={svc.name}
              className="bg-[#0f131b] border border-white/[0.07] rounded-xl px-4 py-3 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      svc.activeState === 'active' ? 'bg-emerald-400' : 'bg-rose-500'
                    }`}
                  />
                  <span className="text-xs font-semibold font-mono text-white truncate">
                    {svc.name}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">{svc.subState}</span>
                </div>
                <div className="text-[11px] text-slate-400 truncate mt-0.5 pl-4">
                  {svc.description}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => handleOpenSystemdLogs(svc)}
                  title="查看 journalctl 日志"
                  className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] text-slate-300 hover:text-white cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleSystemdRestart(svc)}
                  disabled={busyId !== null}
                  title="重启服务"
                  className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-sky-500/20 text-slate-300 hover:text-sky-300 cursor-pointer"
                >
                  <RotateCw
                    className={`w-3.5 h-3.5 ${busyId === `svc-${svc.name}` ? 'animate-spin' : ''}`}
                  />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Logs Modal */}
      {logsModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-[#0c0f16] border border-white/10 rounded-2xl w-full max-w-4xl max-h-[88dvh] sm:max-h-[82vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.07] flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white font-mono truncate">{logsModal.title}</span>
              <button
                onClick={() => setLogsModal(null)}
                className="text-slate-400 hover:text-white cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3.5 sm:p-4 bg-[#07090d]">
              {logsModal.loading ? (
                <div className="flex items-center justify-center py-12 text-xs text-slate-400 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在拉取日志...</span>
                </div>
              ) : (
                <pre className="text-[11px] leading-relaxed font-mono text-slate-300 whitespace-pre-wrap break-all">
                  {logsModal.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Compose YAML Inline Editor Modal */}
      {composeModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-[#0c0f16] border border-white/10 rounded-2xl w-full max-w-4xl h-[88dvh] sm:h-[82vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white font-mono truncate">
                  {composeModal.project} · {composeModal.path || composeModal.dir}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleSaveComposeFile}
                  disabled={composeModal.loading || composeModal.saving || !composeModal.path}
                  className="flex items-center gap-1.5 text-xs bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{composeModal.saving ? '保存中...' : '保存'}</span>
                </button>
                <button
                  onClick={() => {
                    const { project, dir } = composeModal;
                    setComposeModal(null);
                    handleComposeAction(project, dir, 'up');
                  }}
                  disabled={composeModal.loading || !composeModal.path}
                  className="flex items-center gap-1.5 text-xs bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>应用 (up -d)</span>
                </button>
                <button
                  onClick={() => setComposeModal(null)}
                  className="text-slate-400 hover:text-white cursor-pointer ml-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {composeModal.msg && (
              <div className="px-4 sm:px-5 py-2 text-xs bg-sky-500/10 border-b border-sky-500/20 text-sky-200">
                {composeModal.msg}
              </div>
            )}

            <div className="flex-1 bg-[#07090d] flex">
              {composeModal.loading ? (
                <div className="flex-1 flex items-center justify-center text-xs text-slate-400 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在加载 Compose 配置...</span>
                </div>
              ) : (
                <textarea
                  value={composeModal.content}
                  onChange={(e) =>
                    setComposeModal((prev) => (prev ? { ...prev, content: e.target.value } : prev))
                  }
                  spellCheck={false}
                  className="flex-1 w-full h-full bg-[#07090d] text-slate-200 font-mono text-xs leading-relaxed p-3.5 sm:p-4 focus:outline-none resize-none"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Compose Streaming Output Modal */}
      {streamModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-[#0c0f16] border border-white/10 rounded-2xl w-full max-w-4xl max-h-[88dvh] sm:max-h-[82vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.07] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-white font-mono min-w-0">
                {streamModal.running && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400 shrink-0" />}
                <span className="truncate">{streamModal.title}</span>
              </div>
              <button
                onClick={() => setStreamModal(null)}
                disabled={streamModal.running}
                className="text-slate-400 hover:text-white cursor-pointer disabled:opacity-30 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre
              ref={streamPreRef}
              className="flex-1 overflow-auto p-3.5 sm:p-4 bg-[#07090d] text-[11px] leading-relaxed font-mono text-slate-200 whitespace-pre-wrap break-all"
            >
              {streamModal.output}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
