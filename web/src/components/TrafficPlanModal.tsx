import React, { useState } from 'react';
import { Gauge, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import type { ServerConfig, TrafficBillingMode, TrafficSummary } from '../types';
import { formatBytes } from '../utils';

interface TrafficPlanModalProps {
  server: ServerConfig;
  summary?: TrafficSummary;
  onClose: () => void;
  onSaved: (server: ServerConfig, summary: TrafficSummary) => void;
}

const PLAN_PRESETS: {
  label: string;
  desc: string;
  bandwidthMbps: number;
  monthlyQuotaGb: number;
  billingMode: TrafficBillingMode;
}[] = [
  { label: '轻量 5M · 1TB', desc: '常见国内轻量应用', bandwidthMbps: 5, monthlyQuotaGb: 1024, billingMode: 'both' },
  { label: '轻量 30M · 1TB', desc: '腾讯云/阿里轻量', bandwidthMbps: 30, monthlyQuotaGb: 1024, billingMode: 'both' },
  { label: '100M · 1TB', desc: '常见香港/亚太 VPS', bandwidthMbps: 100, monthlyQuotaGb: 1024, billingMode: 'both' },
  { label: '1G · 2TB', desc: '欧美/大口子 VPS', bandwidthMbps: 1000, monthlyQuotaGb: 2048, billingMode: 'both' },
  { label: '1G · 不限流量', desc: '仅看带宽峰值', bandwidthMbps: 1000, monthlyQuotaGb: 0, billingMode: 'both' },
];

const BILLING_MODES: { value: TrafficBillingMode; label: string; hint: string }[] = [
  { value: 'both', label: '双向合计', hint: '入站 + 出站' },
  { value: 'tx', label: '仅出站', hint: '只算上行发送' },
  { value: 'rx', label: '仅入站', hint: '只算下行接收' },
  { value: 'max', label: '取收发大值', hint: 'Max(入, 出)' },
];

export const TrafficPlanModal: React.FC<TrafficPlanModalProps> = ({
  server,
  summary,
  onClose,
  onSaved,
}) => {
  const existing = server.trafficPlan;
  const [bandwidthMbps, setBandwidthMbps] = useState(
    existing?.bandwidthMbps ? String(existing.bandwidthMbps) : ''
  );
  const [monthlyQuotaGb, setMonthlyQuotaGb] = useState(
    existing?.monthlyQuotaGb ? String(existing.monthlyQuotaGb) : ''
  );
  const [billingMode, setBillingMode] = useState<TrafficBillingMode>(
    existing?.billingMode || summary?.billingMode || 'both'
  );
  const [resetDay, setResetDay] = useState(String(existing?.resetDay || summary?.resetDay || 1));
  const [calibrateUsedGb, setCalibrateUsedGb] = useState('');
  const [clearBaseline, setClearBaseline] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trackedCycleBytes = summary
    ? billingMode === 'tx'
      ? summary.cycleTxBytes
      : billingMode === 'rx'
        ? summary.cycleRxBytes
        : billingMode === 'max'
          ? Math.max(summary.cycleRxBytes, summary.cycleTxBytes)
          : summary.cycleRxBytes + summary.cycleTxBytes
    : 0;

  const hasActiveBaseline = (summary?.baselineBytes ?? 0) > 0 && !clearBaseline;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const bw = Math.max(0, Math.round(Number(bandwidthMbps) || 0));
      const quota = Math.max(0, Number(monthlyQuotaGb) || 0);
      const day = Math.min(28, Math.max(1, Math.round(Number(resetDay) || 1)));
      const trimmedCal = calibrateUsedGb.trim();
      const calNum = trimmedCal !== '' ? Number(trimmedCal) : null;
      if (calNum !== null && (!Number.isFinite(calNum) || calNum < 0)) {
        setError('校准流量请输入大于等于 0 的数字（单位 GB）');
        setSaving(false);
        return;
      }
      const res = await api.saveTrafficPlan(server.id, {
        bandwidthMbps: bw,
        monthlyQuotaGb: quota,
        billingMode,
        resetDay: day,
        calibrateUsedGb: calNum,
        clearBaseline,
      });
      onSaved(res.server, res.trafficSummary);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-[#0f131b] border border-white/10 rounded-2xl w-full max-w-lg max-h-[92dvh] overflow-y-auto p-4 sm:p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-sky-500/15 border border-sky-400/25 flex items-center justify-center">
              <Gauge className="w-4 h-4 text-sky-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">带宽与月流量套餐</h3>
              <p className="text-[11px] text-slate-400">
                {server.name} · 配置后自动追踪本周期已用进度、月底预测与超限告警
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer p-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quick Presets */}
        <div className="mb-4">
          <div className="text-[11px] text-slate-400 mb-1.5 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-sky-400" />
            <span>常用 VPS 套餐一键填入</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PLAN_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                title={p.desc}
                onClick={() => {
                  setBandwidthMbps(String(p.bandwidthMbps));
                  setMonthlyQuotaGb(p.monthlyQuotaGb > 0 ? String(p.monthlyQuotaGb) : '');
                  setBillingMode(p.billingMode);
                }}
                className="text-[11px] font-mono px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-sky-500/15 border border-white/[0.08] hover:border-sky-400/30 text-slate-300 hover:text-sky-200 transition-colors cursor-pointer"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Bandwidth & Monthly Quota */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">标称公网带宽 (Mbps)</label>
              <input
                type="number"
                min={0}
                step={1}
                placeholder="例如 100（留空不设上限）"
                value={bandwidthMbps}
                onChange={(e) => setBandwidthMbps(e.target.value)}
                className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 font-mono text-white focus:border-sky-400 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {[5, 30, 100, 500, 1000].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setBandwidthMbps(String(v))}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] hover:bg-white/[0.1] text-slate-400 hover:text-white cursor-pointer"
                  >
                    {v}M
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">月流量配额 (GB)</label>
              <input
                type="number"
                min={0}
                step="any"
                placeholder="例如 1024（留空表示不限）"
                value={monthlyQuotaGb}
                onChange={(e) => setMonthlyQuotaGb(e.target.value)}
                className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 font-mono text-white focus:border-sky-400 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {[
                  { label: '500G', val: '500' },
                  { label: '1TB', val: '1024' },
                  { label: '2TB', val: '2048' },
                  { label: '4TB', val: '4096' },
                  { label: '不限', val: '' },
                ].map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => setMonthlyQuotaGb(q.val)}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] hover:bg-white/[0.1] text-slate-400 hover:text-white cursor-pointer"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Billing Mode */}
          <div>
            <label className="block text-slate-300 font-medium mb-1.5">云商计费方向</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {BILLING_MODES.map((m) => {
                const active = billingMode === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setBillingMode(m.value)}
                    className={`px-2.5 py-2 rounded-lg border text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-sky-500/15 border-sky-400/40 text-sky-200'
                        : 'bg-[#090b10] border-white/[0.07] text-slate-400 hover:text-slate-200 hover:border-white/15'
                    }`}
                  >
                    <div className="font-medium text-[11px]">{m.label}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{m.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reset Day & Current Cycle Calibration */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">每月重置日</label>
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500">每月</span>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={resetDay}
                  onChange={(e) => setResetDay(e.target.value)}
                  className="w-full bg-[#090b10] border border-white/10 rounded-lg px-2.5 py-2 font-mono text-white text-center focus:border-sky-400 focus:outline-none"
                />
                <span className="text-slate-500 shrink-0">号</span>
              </div>
              <p className="text-[10px] text-slate-500 mt-1">支持 1–28 号</p>
            </div>

            <div className="sm:col-span-2">
              <div className="flex items-center justify-between mb-1">
                <label className="text-slate-300 font-medium">本周期已用校准 (GB，选填)</label>
                {hasActiveBaseline && (
                  <button
                    type="button"
                    onClick={() => {
                      setClearBaseline(true);
                      setCalibrateUsedGb('');
                    }}
                    className="inline-flex items-center gap-1 text-[10px] text-amber-300 hover:text-amber-200 cursor-pointer"
                  >
                    <RotateCcw className="w-2.5 h-2.5" />
                    <span>清除校准 (+{formatBytes(summary?.baselineBytes || 0)})</span>
                  </button>
                )}
              </div>
              <input
                type="number"
                min={0}
                step="any"
                placeholder={`自动已采 ${formatBytes(trackedCycleBytes)}，留空则保持`}
                value={calibrateUsedGb}
                onChange={(e) => {
                  setCalibrateUsedGb(e.target.value);
                  setClearBaseline(false);
                }}
                className="w-full bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 font-mono text-white focus:border-sky-400 focus:outline-none"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                直接填云厂商后台显示的「本周期已用 GB」即可自动补齐差值；跨到下个账期会自动归零。
              </p>
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-white/[0.06]">
            <span className="text-[10px] text-slate-500">
              告警阈值可在左下角「设置 → 异常告警推送」统一调整
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg text-slate-400 hover:text-white cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer disabled:opacity-60"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{saving ? '保存中...' : '保存配置'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
