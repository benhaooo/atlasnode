import React, { useState } from 'react';
import {
  ArrowUpRight,
  Loader2,
  Network,
  Play,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import type { MeshLatencyCell, ServerSnapshot } from '../types';
import { countryFlag, formatBytes, serverFlag } from '../utils';

interface CompareViewProps {
  snapshots: ServerSnapshot[];
  onSelectServer: (id: string, tab?: string) => void;
}

const COMPARE_SERVICES = ['TikTok', 'Disney+', 'Netflix', 'YouTube', 'ChatGPT', 'Reddit'];

function delayColor(ms: number | null): string {
  if (ms === null) return 'text-rose-400';
  if (ms < 40) return 'text-emerald-400';
  if (ms < 100) return 'text-sky-300';
  if (ms < 180) return 'text-amber-300';
  return 'text-rose-400';
}

export const CompareView: React.FC<CompareViewProps> = ({ snapshots, onSelectServer }) => {
  const [testingMesh, setTestingMesh] = useState(false);
  const [mesh, setMesh] = useState<{ matrix: MeshLatencyCell[]; testedAt: string } | null>(null);
  const [error, setError] = useState('');

  const runMeshTest = async () => {
    setTestingMesh(true);
    setError('');
    try {
      const res = await api.measureMeshLatency();
      setMesh(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : '互联延迟测试失败');
    } finally {
      setTestingMesh(false);
    }
  };

  const getCell = (fromId: string, toId: string) =>
    mesh?.matrix.find((c) => c.fromId === fromId && c.toId === toId);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-7 space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-white">多节点横向对比</h1>
          <p className="text-xs text-slate-400 mt-1">
            一屏横向比较所有服务器的规格、IP 纯净度、流媒体解锁、三网线路与节点间互通延迟
          </p>
        </div>
        <button
          onClick={runMeshTest}
          disabled={testingMesh || snapshots.length < 2}
          className="flex items-center gap-1.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-xs px-4 py-2 rounded-xl cursor-pointer self-start sm:self-auto"
        >
          {testingMesh ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          <span>{testingMesh ? '正在测速...' : '测试节点间互通延迟'}</span>
        </button>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* Part 1: NodeQuality Horizontal Comparison Matrix */}
      <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl overflow-hidden">
        <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-emerald-400" />
            节点质量与能力横向矩阵
          </h2>
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400" /> 电信</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-400" /> 联通</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /> 移动</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs whitespace-nowrap">
            <thead>
              <tr className="text-[11px] text-slate-500 border-b border-white/[0.06] bg-white/[0.015] text-left">
                <th className="py-3 px-4 font-medium sticky left-0 z-10 bg-[#11151e]">节点</th>
                <th className="py-3 px-3 font-medium">配置 / 负载</th>
                <th className="py-3 px-3 font-medium">IP 归属 & 性质</th>
                <th className="py-3 px-3 font-medium">风控 / 黑名单</th>
                <th className="py-3 px-3 font-medium">三网均延 & 回程</th>
                {COMPARE_SERVICES.map((svc) => (
                  <th key={svc} className="py-3 px-2 font-medium text-center">
                    {svc}
                  </th>
                ))}
                <th className="py-3 px-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {snapshots.map((snap) => {
                const nq = snap.latestNodeQuality?.summary;
                const m = snap.metrics;
                const flag = serverFlag(snap.server.region, nq?.ip.country, snap.server.tags);

                // Calculate 3-ISP averages
                const delays = nq?.network.delays || [];
                const avg = (k: 'ct' | 'cu' | 'cm') => {
                  const vals = delays.map((d) => Number(d[k])).filter((n) => Number.isFinite(n) && n > 0);
                  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
                };
                const ct = avg('ct');
                const cu = avg('cu');
                const cm = avg('cm');
                const mainRoute = nq?.network.routes?.[0]?.lineType?.split('->').pop();

                return (
                  <tr key={snap.server.id} className="hover:bg-white/[0.02]">
                    <td className="py-3.5 px-4 sticky left-0 z-10 bg-[#0f131b]">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            snap.online ? 'bg-emerald-400' : 'bg-rose-500'
                          }`}
                        />
                        <span className="text-base leading-none">{flag}</span>
                        <div>
                          <div className="font-semibold text-white">{snap.server.name}</div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {snap.publicIp || snap.server.host}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="py-3.5 px-3 font-mono text-[11px]">
                      {snap.online && m ? (
                        <div>
                          <div className="text-slate-200">
                            {snap.cpuCores}C · {formatBytes(m.memTotalBytes, 1)}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            CPU {m.cpuPercent.toFixed(0)}% · 盘 {m.diskRootPercent.toFixed(0)}%
                          </div>
                        </div>
                      ) : (
                        <span className="text-rose-400">离线</span>
                      )}
                    </td>

                    <td className="py-3.5 px-3">
                      {nq ? (
                        <div className="space-y-0.5">
                          <div className="font-mono text-slate-200 flex items-center gap-1.5">
                            <span className="text-sky-300">{nq.ip.asn || '—'}</span>
                            {nq.ip.ipType && (
                              <span
                                className={`text-[10px] px-1.5 py-0.2 rounded border ${
                                  nq.ip.isNative
                                    ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300'
                                    : 'bg-amber-500/10 border-amber-400/25 text-amber-300'
                                }`}
                              >
                                {nq.ip.ipType}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500 truncate max-w-[160px]">
                            {nq.ip.org || '—'}
                          </div>
                        </div>
                      ) : (
                        <span className="text-slate-600 text-[11px]">未质检</span>
                      )}
                    </td>

                    <td className="py-3.5 px-3 font-mono text-[11px]">
                      {nq ? (
                        <div>
                          <span
                            className={
                              nq.ip.riskLevel === 'low'
                                ? 'text-emerald-400'
                                : nq.ip.riskLevel === 'medium'
                                  ? 'text-amber-300'
                                  : nq.ip.riskLevel === 'high'
                                    ? 'text-rose-400'
                                    : 'text-slate-400'
                            }
                          >
                            {nq.ip.riskLevel === 'low'
                              ? '低风险'
                              : nq.ip.riskLevel === 'medium'
                                ? '中风险'
                                : nq.ip.riskLevel === 'high'
                                  ? '高风险'
                                  : '—'}
                          </span>
                          {nq.ip.blacklistTotal !== undefined && (
                            <div className="text-[10px] text-slate-500">
                              黑名单 {nq.ip.blacklistHit ?? 0}/{nq.ip.blacklistTotal}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>

                    <td className="py-3.5 px-3 font-mono text-[11px]">
                      {ct || cu || cm ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center gap-0.5 text-sky-300">
                              <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                              {ct ?? '—'}
                            </span>
                            <span className="inline-flex items-center gap-0.5 text-orange-300">
                              <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />
                              {cu ?? '—'}
                            </span>
                            <span className="inline-flex items-center gap-0.5 text-emerald-300">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              {cm ?? '—'}
                            </span>
                          </div>
                          {mainRoute && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/12 text-emerald-300 border border-emerald-500/25">
                              {mainRoute}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>

                    {COMPARE_SERVICES.map((svc) => {
                      const u = nq?.unlocks.find(
                        (x) => x.service.toLowerCase().replace(/\s+/g, '') === svc.toLowerCase().replace(/\s+/g, '')
                      );
                      if (!u) {
                        return (
                          <td key={svc} className="py-3.5 px-2 text-center text-slate-700 font-mono">
                            —
                          </td>
                        );
                      }
                      const uFlag = countryFlag(u.region);
                      const tone =
                        u.status === 'native' || u.status === 'unlocked'
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : u.status === 'dns'
                            ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                            : u.status === 'app_only'
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                              : u.status === 'failed'
                                ? 'bg-white/[0.04] text-slate-500 border-white/10'
                                : 'bg-rose-500/12 text-rose-400 border-rose-500/25';
                      return (
                        <td key={svc} className="py-3.5 px-2 text-center">
                          <span
                            title={`${svc}: ${u.detail || u.statusText || u.status}`}
                            className={`inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded border ${tone}`}
                          >
                            {uFlag && <span>{uFlag}</span>}
                            <span>
                              {u.status === 'native'
                                ? '原生'
                                : u.status === 'dns'
                                  ? 'DNS'
                                  : u.status === 'app_only'
                                    ? 'APP'
                                    : u.status === 'blocked'
                                      ? '屏蔽'
                                      : u.status === 'failed'
                                        ? '失败'
                                        : '解锁'}
                            </span>
                          </span>
                        </td>
                      );
                    })}

                    <td className="py-3.5 px-3 text-right">
                      <button
                        onClick={() => onSelectServer(snap.server.id, 'nodequality')}
                        className="inline-flex items-center gap-0.5 text-[11px] text-sky-400 hover:text-sky-300 cursor-pointer"
                      >
                        <span>{nq ? '详情' : '去测试'}</span>
                        <ArrowUpRight className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Part 2: Inter-Server Mesh Latency Matrix */}
      <section className="bg-[#0f131b] border border-white/[0.07] rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
            <Network className="w-3.5 h-3.5 text-sky-400" />
            节点间实时互通延迟矩阵 (TCP RTT)
          </h2>
          {mesh && (
            <span className="text-[10px] font-mono text-slate-500">
              测试时间: {new Date(mesh.testedAt).toLocaleTimeString('zh-CN')}
            </span>
          )}
        </div>

        {!mesh ? (
          <div className="bg-[#090b10] border border-dashed border-white/10 rounded-xl p-6 sm:p-8 text-center text-xs text-slate-400">
            点击上方「测试节点间互通延迟」，并行测量每对服务器之间的真实 TCP 往返延迟（优先走 Tailscale 内网，不可达时测公网）。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono whitespace-nowrap">
              <thead>
                <tr className="text-[11px] text-slate-500 border-b border-white/[0.06]">
                  <th className="py-2.5 px-3 text-left font-sans sticky left-0 z-10 bg-[#0f131b]">源节点 → 目标节点</th>
                  {snapshots.map((dst) => (
                    <th key={dst.server.id} className="py-2.5 px-3 text-center">
                      {serverFlag(dst.server.region, dst.latestNodeQuality?.summary.ip.country, dst.server.tags)}{' '}
                      {dst.server.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                {snapshots.map((src) => (
                  <tr key={src.server.id}>
                    <td className="py-3 px-3 font-sans font-semibold text-white sticky left-0 z-10 bg-[#0f131b]">
                      {serverFlag(src.server.region, src.latestNodeQuality?.summary.ip.country, src.server.tags)}{' '}
                      {src.server.name}
                    </td>
                    {snapshots.map((dst) => {
                      if (src.server.id === dst.server.id) {
                        return (
                          <td key={dst.server.id} className="py-3 px-3 text-center text-slate-700">
                            —
                          </td>
                        );
                      }
                      const cell = getCell(src.server.id, dst.server.id);
                      return (
                        <td key={dst.server.id} className="py-3 px-3 text-center">
                          {cell?.latencyMs !== null && cell?.latencyMs !== undefined ? (
                            <span
                              title={`目标: ${cell.targetHost}`}
                              className={`inline-block px-2.5 py-1 rounded-lg bg-[#090b10] border border-white/[0.06] font-semibold ${delayColor(
                                cell.latencyMs
                              )}`}
                            >
                              {cell.latencyMs} ms
                            </span>
                          ) : (
                            <span
                              title={cell?.error || '超时'}
                              className="text-rose-400/80 text-[11px]"
                            >
                              超时
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
