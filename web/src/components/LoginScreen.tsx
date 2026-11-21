import React, { useState } from 'react';
import { Lock, Server, ArrowRight, AlertCircle } from 'lucide-react';
import { api } from '../api';

interface LoginScreenProps {
  onSuccess: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onSuccess }) => {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#090b10] px-4 relative overflow-hidden">
      {/* Subtle radial backdrop */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(56,189,248,0.10),_transparent_55%)]" />

      <div className="w-full max-w-sm relative z-10">
        <div className="flex items-center gap-3 mb-7 justify-center">
          <div className="w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-400/30 flex items-center justify-center">
            <Server className="w-5 h-5 text-sky-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white">AtlasNode</h1>
            <p className="text-xs text-slate-400">多服务器态势与运维中枢</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-[#0f131b] border border-white/[0.08] rounded-2xl p-6 shadow-2xl space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-2">
              控制台访问密钥
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入访问密钥"
                className="w-full bg-[#090b10] border border-white/10 focus:border-sky-400/60 focus:outline-none rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-slate-600 transition-colors"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full flex items-center justify-center gap-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-sm py-2.5 rounded-xl transition-colors cursor-pointer"
          >
            <span>{loading ? '验证中...' : '进入控制台'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <p className="text-center text-[11px] text-slate-600 mt-5 font-mono">
          AtlasNode · Control Plane
        </p>
      </div>
    </div>
  );
};
