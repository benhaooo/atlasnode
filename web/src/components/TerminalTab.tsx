import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Box, RefreshCw, Terminal as TerminalIcon, X } from 'lucide-react';
import type { ServerSnapshot } from '../types';

interface TerminalTabProps {
  snapshot: ServerSnapshot;
  containerName?: string | null;
  onClearContainer?: () => void;
}

const QUICK_CMDS = [
  { label: 'df -h', cmd: 'df -h\n' },
  { label: 'free -h', cmd: 'free -h\n' },
  { label: 'docker ps', cmd: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"\n' },
  { label: 'ss -tlpn', cmd: 'ss -tlpn\n' },
  { label: 'uptime', cmd: 'uptime\n' },
];

export const TerminalTab: React.FC<TerminalTabProps> = ({
  snapshot,
  containerName,
  onClearContainer,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting');
  const [statusMsg, setStatusMsg] = useState('');
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: {
        background: '#07090d',
        foreground: '#e2e8f0',
        cursor: '#38bdf8',
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
        black: '#1e293b',
        red: '#fb7185',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#38bdf8',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#f1f5f9',
      },
      scrollback: 3000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    setStatus('connecting');
    setStatusMsg('');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams({
      serverId: snapshot.server.id,
      cols: String(term.cols || 100),
      rows: String(term.rows || 30),
    });
    if (containerName) qs.set('container', containerName);

    const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal?${qs.toString()}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      term.focus();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'output' && typeof msg.data === 'string') {
          term.write(msg.data);
        } else if (msg.type === 'error') {
          setStatus('error');
          setStatusMsg(msg.message || '连接错误');
          term.writeln(`\r\n\x1b[31m[错误] ${msg.message}\x1b[0m`);
        } else if (msg.type === 'exit') {
          setStatus('closed');
          term.writeln(`\r\n\x1b[33m[会话已结束 exit=${msg.code}]\x1b[0m`);
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      setStatus((prev) => (prev === 'error' ? prev : 'closed'));
    };

    ws.onerror = () => {
      setStatus('error');
      setStatusMsg('WebSocket 连接中断');
    };

    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const handleResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [snapshot.server.id, containerName, sessionKey]);

  const sendQuickCmd = (cmd: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: cmd }));
      termRef.current?.focus();
    }
  };

  return (
    <div className="bg-[#0c0f16] border border-white/[0.08] rounded-2xl overflow-hidden flex flex-col">
      {/* Terminal Toolbar */}
      <div className="px-4 py-2.5 bg-[#0f131b] border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 text-xs">
          {containerName ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/15 border border-sky-400/30 text-sky-300 font-mono">
              <Box className="w-3.5 h-3.5" />
              <span>docker exec · {containerName}</span>
              {onClearContainer && (
                <button
                  onClick={onClearContainer}
                  title="切回宿主机 Shell"
                  className="ml-1 hover:text-white cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-mono text-slate-200">
              <TerminalIcon className="w-3.5 h-3.5 text-sky-400" />
              <span>
                {snapshot.server.username}@{snapshot.server.name}
                {snapshot.server.jumpHost ? ' (经跳板)' : ''}
              </span>
            </span>
          )}

          <span
            className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${
              status === 'connected'
                ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300'
                : status === 'connecting'
                  ? 'bg-amber-500/12 border-amber-400/25 text-amber-300'
                  : 'bg-rose-500/12 border-rose-500/25 text-rose-300'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                status === 'connected'
                  ? 'bg-emerald-400'
                  : status === 'connecting'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-rose-400'
              }`}
            />
            {status === 'connected'
              ? '已连接'
              : status === 'connecting'
                ? '连接中...'
                : statusMsg || '已断开'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {!containerName &&
            QUICK_CMDS.map((q) => (
              <button
                key={q.label}
                onClick={() => sendQuickCmd(q.cmd)}
                disabled={status !== 'connected'}
                className="text-[11px] font-mono bg-white/[0.04] hover:bg-white/[0.09] disabled:opacity-40 border border-white/[0.07] text-slate-300 px-2 py-1 rounded-md cursor-pointer"
              >
                {q.label}
              </button>
            ))}

          <button
            onClick={() => setSessionKey((k) => k + 1)}
            className="flex items-center gap-1 text-[11px] bg-sky-500/15 hover:bg-sky-500/25 border border-sky-400/30 text-sky-300 px-2.5 py-1 rounded-lg cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>重连</span>
          </button>
        </div>
      </div>

      {/* XTerm Canvas */}
      <div className="p-2 bg-[#07090d]">
        <div ref={containerRef} className="w-full h-[540px]" />
      </div>
    </div>
  );
};
