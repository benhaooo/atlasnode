import React, { useEffect, useState } from 'react';
import {
  Box,
  Clock,
  Cpu,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { DiskAuditData, ServerSnapshot } from '../types';
import { formatBytes } from '../utils';
import { AssetsSkeleton } from './Skeleton';

interface AssetsTabProps {
  snapshot: ServerSnapshot;
  onJumpFolder: (dirPath: string) => void;
  onRefreshSnapshot: () => void;
}

export const AssetsTab: React.FC<AssetsTabProps> = ({
  snapshot,
  onJumpFolder,
  onRefreshSnapshot,
}) => {
  const [data, setData] = useState<DiskAuditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pruning, setPruning] = useState<string | null>(null);
  const [pruneMsg, setPruneMsg] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getAssets(snapshot.server.id);
      setData(res.assets);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载机内资产与磁盘分析失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    setLoading(true);
    load();
  }, [snapshot.server.id]);

  const handlePrune = async (target: 'images' | 'builder' | 'containers', label: string) => {
    if (!confirm(`确认执行安全清理「${label}」？（不会删除正在运行的容器及使用中的镜像）`)) return;
    setPruning(target);
    setPruneMsg('');
    setError('');
    try {
      const res = await api.pruneDocker(snapshot.server.id, target);
      setPruneMsg(res.output.split('\n').pop() || '清理完成');
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '清理失败');
    } finally {
      setPruning(null);
    }
  };

  const maxDirBytes = Math.max(1, ...(data?.topDirs.map((d) => d.bytes) || [1]));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white">磁盘空间归因与机内资产清单</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            看清硬盘空间被谁占满、Docker 可回收空间、隐藏定时任务与已装运行环境
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-200 px-3 py-1.5 rounded-xl cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
          <span>重新扫描</span>
        </button>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-4 py-3">
          {error}
        </div>
      )}
      {pruneMsg && (
        <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-4 py-3 font-mono">
          {pruneMsg}
        </div>
      )}

      {loading && !data ? (
        <AssetsSkeleton />
      ) : data ? (
        <div className="space-y-5">
          {/* Row 1: Top Large Directories (7 cols) + Docker Space Breakdown (5 cols) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <HardDrive className="w-3.5 h-3.5 text-amber-400" />
                  空间占用 Top 目录（点击进入文件管理）
                </h3>
                <span className="text-[10px] font-mono text-slate-500">根分区同文件系统</span>
              </div>

              <div className="space-y-2">
                {data.topDirs.map((d) => {
                  const pct = Math.max(3, (d.bytes / maxDirBytes) * 100);
                  const heavy = d.bytes >= 5 * 1024 * 1024 * 1024;
                  return (
                    <button
                      key={d.path}
                      onClick={() => onJumpFolder(d.path)}
                      className="w-full text-left bg-[#090b10] hover:bg-[#131824] border border-white/[0.05] hover:border-sky-400/30 rounded-xl px-3.5 py-2 transition-colors cursor-pointer group"
                    >
                      <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                        <span className="flex items-center gap-1.5 text-slate-200 group-hover:text-sky-300 truncate">
                          <FolderOpen className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
                          <span className="truncate">{d.path}</span>
                        </span>
                        <span className={`font-semibold shrink-0 ml-2 ${heavy ? 'text-amber-300' : 'text-slate-300'}`}>
                          {formatBytes(d.bytes)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${heavy ? 'bg-amber-400' : 'bg-sky-400/80'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
                {data.topDirs.length === 0 && (
                  <div className="text-xs text-slate-500 py-4 text-center">未检测到大于 20MB 的目录</div>
                )}
              </div>
            </section>

            <section className="lg:col-span-5 space-y-5">
              {/* Docker Disk Breakdown + Safe Prune */}
              <div className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Box className="w-3.5 h-3.5 text-sky-400" />
                  Docker 空间占用与安全清理
                </h3>

                {data.dockerDf.length > 0 ? (
                  <>
                    <div className="space-y-2 text-xs">
                      {data.dockerDf.map((row) => (
                        <div
                          key={row.type}
                          className="bg-[#090b10] border border-white/[0.06] rounded-xl px-3.5 py-2.5 flex items-center justify-between"
                        >
                          <div>
                            <div className="font-medium text-slate-200">{row.type}</div>
                            <div className="text-[10px] font-mono text-slate-500 mt-0.5">
                              共 {row.total} · 活跃 {row.active}
                            </div>
                          </div>
                          <div className="text-right font-mono">
                            <div className="text-white font-semibold">{row.size}</div>
                            <div className="text-[10px] text-amber-300/90">可回收 {row.reclaimable}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        onClick={() => handlePrune('images', '悬空镜像')}
                        disabled={pruning !== null}
                        className="flex items-center gap-1 text-[11px] bg-white/[0.05] hover:bg-amber-500/15 border border-white/10 hover:border-amber-400/30 text-slate-200 hover:text-amber-200 px-2.5 py-1.5 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>{pruning === 'images' ? '清理中...' : '清理悬空镜像'}</span>
                      </button>
                      <button
                        onClick={() => handlePrune('builder', '构建缓存')}
                        disabled={pruning !== null}
                        className="flex items-center gap-1 text-[11px] bg-white/[0.05] hover:bg-amber-500/15 border border-white/10 hover:border-amber-400/30 text-slate-200 hover:text-amber-200 px-2.5 py-1.5 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>{pruning === 'builder' ? '清理中...' : '清理构建缓存'}</span>
                      </button>
                      <button
                        onClick={() => handlePrune('containers', '已退出容器')}
                        disabled={pruning !== null}
                        className="flex items-center gap-1 text-[11px] bg-white/[0.05] hover:bg-amber-500/15 border border-white/10 hover:border-amber-400/30 text-slate-200 hover:text-amber-200 px-2.5 py-1.5 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>{pruning === 'containers' ? '清理中...' : '清理已退容器'}</span>
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-slate-500 bg-[#090b10] rounded-xl p-4 text-center">
                    当前主机未安装 Docker
                  </div>
                )}
              </div>

              {/* Installed Runtimes */}
              <div className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-emerald-400" />
                  机内关键运行环境 ({data.runtimes.length})
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {data.runtimes.map((rt) => (
                    <div
                      key={rt.name}
                      className="bg-[#090b10] border border-white/[0.05] rounded-xl px-3 py-2"
                    >
                      <div className="text-[11px] font-semibold text-white">{rt.name}</div>
                      <div className="text-[10px] font-mono text-slate-400 truncate mt-0.5" title={rt.version}>
                        {rt.version}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* Row 2: Crontabs & Systemd Timers */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <section className="lg:col-span-7 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                Crontab 定时任务 ({data.crontabs.length})
              </h3>
              {data.crontabs.length === 0 ? (
                <div className="text-xs text-slate-500 bg-[#090b10] rounded-xl p-4 text-center">
                  未发现用户或 /etc/cron.d 定时任务
                </div>
              ) : (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {data.crontabs.map((c, idx) => (
                    <div
                      key={idx}
                      className="bg-[#090b10] border border-white/[0.05] rounded-xl px-3.5 py-2.5 text-xs font-mono space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sky-300 font-semibold">{c.schedule}</span>
                        <span className="text-[10px] text-slate-500">{c.source}</span>
                      </div>
                      <div className="text-[11px] text-slate-300 break-all">{c.command}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="lg:col-span-5 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-5 space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Systemd Timers ({data.timers.length})
              </h3>
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {data.timers.map((t, i) => (
                  <div
                    key={i}
                    className="bg-[#090b10] border border-white/[0.05] rounded-xl px-3 py-2 text-xs flex items-center justify-between gap-2"
                  >
                    <span className="font-mono text-slate-200 truncate">{t.name}</span>
                    <span className="font-mono text-[10px] text-slate-500 shrink-0">{t.next}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
};
