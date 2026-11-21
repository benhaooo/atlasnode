import React, { useEffect, useState } from 'react';
import { Activity, Bell, Check, Copy, KeyRound, Loader2, Lock, Send, X } from 'lucide-react';
import { api } from '../api';
import type { AlertConfig, AlertEvent } from '../types';
import { copyToClipboard, formatBytes, formatUptime } from '../utils';

interface SettingsModalProps {
  onClose: () => void;
}

const DEFAULT_ALERTS: AlertConfig = {
  enabled: false,
  cooldownMinutes: 30,
  thresholds: {
    diskPercent: 85,
    cpuPercent: 90,
    memPercent: 90,
    offlineAlert: true,
  },
  telegram: { enabled: false, botToken: '', chatId: '' },
  webhook: { enabled: false, url: '' },
  bark: { enabled: false, url: '' },
};

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [tab, setTab] = useState<'general' | 'alerts'>('general');
  const [managerKey, setManagerKey] = useState('');
  const [runtime, setRuntime] = useState<{
    pool: { activeConnections: number; connections: { key: string; idleSec: number }[] };
    metricsDb: { totalSamples: number };
    memoryRssBytes: number;
    uptimeSeconds: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Alerts state
  const [alertCfg, setAlertCfg] = useState<AlertConfig>(DEFAULT_ALERTS);
  const [alertHistory, setAlertHistory] = useState<AlertEvent[]>([]);
  const [alertLoading, setAlertLoading] = useState(false);
  const [alertSaving, setAlertSaving] = useState(false);
  const [alertTesting, setAlertTesting] = useState(false);
  const [alertMsg, setAlertMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.getManagerKey().then((res) => setManagerKey(res.publicKey)).catch(() => {});
    api.getSystemRuntime().then((res) => setRuntime(res)).catch(() => {});
    setAlertLoading(true);
    api
      .getAlerts()
      .then((res) => {
        setAlertCfg(res.config);
        setAlertHistory(res.history || []);
      })
      .catch(() => {})
      .finally(() => setAlertLoading(false));
  }, []);

  const installCmd = managerKey
    ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${managerKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
    : '';

  const handleCopy = async () => {
    await copyToClipboard(installCmd || managerKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      setMsg({ ok: true, text: '访问密钥已更新' });
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : '修改失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAlerts = async (e: React.FormEvent) => {
    e.preventDefault();
    setAlertSaving(true);
    setAlertMsg(null);
    try {
      const res = await api.saveAlerts(alertCfg);
      setAlertCfg(res.config);
      setAlertMsg({ ok: true, text: '告警配置已保存，后台 60s 采样器会自动按阈值触发推送' });
    } catch (err) {
      setAlertMsg({ ok: false, text: err instanceof Error ? err.message : '保存失败' });
    } finally {
      setAlertSaving(false);
    }
  };

  const handleTestAlerts = async () => {
    setAlertTesting(true);
    setAlertMsg(null);
    try {
      const res = await api.testAlerts(alertCfg);
      setAlertMsg({
        ok: res.ok,
        text: res.details.length > 0 ? res.details.join(' · ') : res.ok ? '测试通知发送成功' : '未启用任何通知渠道',
      });
    } catch (err) {
      setAlertMsg({ ok: false, text: err instanceof Error ? err.message : '发送测试通知失败' });
    } finally {
      setAlertTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#0f131b] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <h3 className="text-sm font-semibold text-white">管控中枢设置</h3>
            <div className="flex items-center bg-[#090b10] border border-white/[0.07] rounded-lg p-0.5 text-[11px]">
              <button
                onClick={() => setTab('general')}
                className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                  tab === 'general' ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                连接与密钥
              </button>
              <button
                onClick={() => setTab('alerts')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                  tab === 'alerts' ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Bell className="w-3 h-3" />
                <span>异常告警推送</span>
                {alertCfg.enabled && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
              </button>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6 text-xs">
          {tab === 'general' ? (
            <>
              {/* Runtime & Pool Diagnostics */}
              {runtime && (
                <div className="bg-[#090b10] border border-white/[0.07] rounded-xl p-3.5 space-y-2">
                  <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5 text-emerald-400" />
                    控制端运行态（ssh2 连接池 + SQLite 时序库）
                  </div>
                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                    <div>
                      <span className="text-slate-500">SSH 复用连接: </span>
                      <span className="text-sky-300">{runtime.pool.activeConnections}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">时序样本: </span>
                      <span className="text-emerald-300">{runtime.metricsDb.totalSamples}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">内存 / 运行: </span>
                      <span className="text-slate-200">
                        {formatBytes(runtime.memoryRssBytes, 0)} · {formatUptime(runtime.uptimeSeconds)}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Manager SSH Public Key */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-sky-400" />
                    管控机专用 SSH 公钥
                  </span>
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1 text-sky-400 hover:text-sky-300 cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? '已复制一键授权命令' : '复制一键授权命令'}</span>
                  </button>
                </div>
                <p className="text-slate-400">
                  将此公钥添加到任何新服务器的 <code className="text-slate-300">~/.ssh/authorized_keys</code> 即可纳管。
                </p>
                <pre className="bg-[#090b10] border border-white/[0.07] rounded-xl p-3 text-[11px] font-mono text-sky-300 whitespace-pre-wrap break-all select-all">
                  {managerKey || '未找到公钥'}
                </pre>
              </div>

              {/* Change Console Password */}
              <form onSubmit={handleChangePassword} className="space-y-3 pt-4 border-t border-white/[0.06]">
                <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-amber-400" />
                  修改控制台访问密钥
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="password"
                    required
                    placeholder="当前密钥"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className="bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                  />
                  <input
                    type="password"
                    required
                    minLength={6}
                    placeholder="新密钥（至少 6 位）"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="bg-[#090b10] border border-white/10 rounded-lg px-3 py-2 text-white focus:border-sky-400 focus:outline-none"
                  />
                </div>

                {msg && (
                  <div
                    className={`px-3 py-2 rounded-lg border ${
                      msg.ok
                        ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                        : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
                    }`}
                  >
                    {msg.text}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer"
                  >
                    {saving ? '更新中...' : '更新密钥'}
                  </button>
                </div>
              </form>
            </>
          ) : alertLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-400 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>加载告警配置...</span>
            </div>
          ) : (
            <form onSubmit={handleSaveAlerts} className="space-y-5">
              {/* Master Toggle */}
              <div className="bg-[#090b10] border border-white/[0.07] rounded-xl p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="font-semibold text-white">启用后台主动告警引擎</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    每 60 秒随 SQLite 指标采样器自动检测全节点离线、磁盘满载、CPU/内存飙升，并按冷却时间去重。
                  </div>
                </div>
                <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={alertCfg.enabled}
                    onChange={(e) => setAlertCfg({ ...alertCfg, enabled: e.target.checked })}
                    className="w-4 h-4 accent-sky-500 cursor-pointer"
                  />
                  <span className={alertCfg.enabled ? 'text-emerald-400 font-semibold' : 'text-slate-500'}>
                    {alertCfg.enabled ? '已开启' : '未开启'}
                  </span>
                </label>
              </div>

              {/* Thresholds */}
              <div className="space-y-2.5">
                <div className="font-semibold text-slate-200">触发阈值与冷却</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <label className="bg-[#090b10] border border-white/[0.06] rounded-xl p-2.5 space-y-1">
                    <span className="text-[10px] text-slate-400 block">磁盘告警 (%)</span>
                    <input
                      type="number"
                      min={50}
                      max={99}
                      value={alertCfg.thresholds.diskPercent}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          thresholds: { ...alertCfg.thresholds, diskPercent: Number(e.target.value) },
                        })
                      }
                      className="w-full bg-[#0f131b] border border-white/10 rounded px-2 py-1 font-mono text-white focus:border-sky-400 focus:outline-none"
                    />
                  </label>
                  <label className="bg-[#090b10] border border-white/[0.06] rounded-xl p-2.5 space-y-1">
                    <span className="text-[10px] text-slate-400 block">CPU 告警 (%)</span>
                    <input
                      type="number"
                      min={50}
                      max={100}
                      value={alertCfg.thresholds.cpuPercent}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          thresholds: { ...alertCfg.thresholds, cpuPercent: Number(e.target.value) },
                        })
                      }
                      className="w-full bg-[#0f131b] border border-white/10 rounded px-2 py-1 font-mono text-white focus:border-sky-400 focus:outline-none"
                    />
                  </label>
                  <label className="bg-[#090b10] border border-white/[0.06] rounded-xl p-2.5 space-y-1">
                    <span className="text-[10px] text-slate-400 block">内存告警 (%)</span>
                    <input
                      type="number"
                      min={50}
                      max={100}
                      value={alertCfg.thresholds.memPercent}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          thresholds: { ...alertCfg.thresholds, memPercent: Number(e.target.value) },
                        })
                      }
                      className="w-full bg-[#0f131b] border border-white/10 rounded px-2 py-1 font-mono text-white focus:border-sky-400 focus:outline-none"
                    />
                  </label>
                  <label className="bg-[#090b10] border border-white/[0.06] rounded-xl p-2.5 space-y-1">
                    <span className="text-[10px] text-slate-400 block">冷却去重 (分钟)</span>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={alertCfg.cooldownMinutes}
                      onChange={(e) =>
                        setAlertCfg({ ...alertCfg, cooldownMinutes: Number(e.target.value) })
                      }
                      className="w-full bg-[#0f131b] border border-white/10 rounded px-2 py-1 font-mono text-white focus:border-sky-400 focus:outline-none"
                    />
                  </label>
                </div>
                <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={alertCfg.thresholds.offlineAlert}
                    onChange={(e) =>
                      setAlertCfg({
                        ...alertCfg,
                        thresholds: { ...alertCfg.thresholds, offlineAlert: e.target.checked },
                      })
                    }
                    className="accent-sky-500 cursor-pointer"
                  />
                  <span>节点 SSH 离线 / 不可达时推送告警</span>
                </label>
              </div>

              {/* Channels */}
              <div className="space-y-3">
                <div className="font-semibold text-slate-200">通知推送渠道</div>

                {/* Telegram */}
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5 space-y-2.5">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="font-medium text-slate-200">Telegram Bot</span>
                    <input
                      type="checkbox"
                      checked={alertCfg.telegram.enabled}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          telegram: { ...alertCfg.telegram, enabled: e.target.checked },
                        })
                      }
                      className="accent-sky-500 cursor-pointer"
                    />
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      placeholder="Bot Token (如 123456:ABC-DEF...)"
                      value={alertCfg.telegram.botToken}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          telegram: { ...alertCfg.telegram, botToken: e.target.value },
                        })
                      }
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 font-mono text-white placeholder:text-slate-600 focus:border-sky-400 focus:outline-none"
                    />
                    <input
                      placeholder="Chat ID (如 123456789)"
                      value={alertCfg.telegram.chatId}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          telegram: { ...alertCfg.telegram, chatId: e.target.value },
                        })
                      }
                      className="bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 font-mono text-white placeholder:text-slate-600 focus:border-sky-400 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Feishu / Generic Webhook */}
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5 space-y-2">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="font-medium text-slate-200">飞书 / 钉钉 / 企业微信 / 通用 Webhook</span>
                    <input
                      type="checkbox"
                      checked={alertCfg.webhook.enabled}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          webhook: { ...alertCfg.webhook, enabled: e.target.checked },
                        })
                      }
                      className="accent-sky-500 cursor-pointer"
                    />
                  </label>
                  <input
                    placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                    value={alertCfg.webhook.url}
                    onChange={(e) =>
                      setAlertCfg({
                        ...alertCfg,
                        webhook: { ...alertCfg.webhook, url: e.target.value },
                      })
                    }
                    className="w-full bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 font-mono text-white placeholder:text-slate-600 focus:border-sky-400 focus:outline-none"
                  />
                </div>

                {/* Bark */}
                <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3.5 space-y-2">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="font-medium text-slate-200">Bark (iOS 推送)</span>
                    <input
                      type="checkbox"
                      checked={alertCfg.bark.enabled}
                      onChange={(e) =>
                        setAlertCfg({
                          ...alertCfg,
                          bark: { ...alertCfg.bark, enabled: e.target.checked },
                        })
                      }
                      className="accent-sky-500 cursor-pointer"
                    />
                  </label>
                  <input
                    placeholder="https://api.day.app/YourDeviceKey"
                    value={alertCfg.bark.url}
                    onChange={(e) =>
                      setAlertCfg({
                        ...alertCfg,
                        bark: { ...alertCfg.bark, url: e.target.value },
                      })
                    }
                    className="w-full bg-[#0f131b] border border-white/10 rounded-lg px-2.5 py-1.5 font-mono text-white placeholder:text-slate-600 focus:border-sky-400 focus:outline-none"
                  />
                </div>
              </div>

              {alertMsg && (
                <div
                  className={`px-3 py-2 rounded-lg border ${
                    alertMsg.ok
                      ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                      : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
                  }`}
                >
                  {alertMsg.text}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleTestAlerts}
                  disabled={alertTesting}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 text-slate-200 cursor-pointer disabled:opacity-50"
                >
                  {alertTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5 text-sky-400" />}
                  <span>发送测试通知</span>
                </button>
                <button
                  type="submit"
                  disabled={alertSaving}
                  className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold cursor-pointer disabled:opacity-50"
                >
                  {alertSaving ? '保存中...' : '保存告警配置'}
                </button>
              </div>

              {/* Recent Alert History */}
              {alertHistory.length > 0 && (
                <div className="pt-4 border-t border-white/[0.06] space-y-2">
                  <div className="font-semibold text-slate-300">最近告警记录 ({alertHistory.length})</div>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {alertHistory.slice(0, 15).map((ev) => (
                      <div
                        key={ev.id}
                        className="bg-[#090b10] border border-white/[0.05] rounded-lg px-3 py-2 flex items-center justify-between gap-2 text-[11px]"
                      >
                        <div className="min-w-0">
                          <span className="font-mono text-amber-300 mr-2">[{ev.serverName}]</span>
                          <span className="text-slate-300">{ev.message}</span>
                        </div>
                        <span className="font-mono text-[10px] text-slate-500 shrink-0">
                          {new Date(ev.ts).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
