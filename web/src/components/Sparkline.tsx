import React, { useId, useRef, useState } from 'react';

export interface SparklineSeries {
  data: number[];
  color: string;
  fill?: string;
  label?: string;
  formatValue?: (v: number) => string;
}

interface SparklineProps {
  series: SparklineSeries[];
  timestamps?: number[];
  formatTime?: (ts: number) => string;
  formatValue?: (v: number, seriesIdx: number) => string;
  height?: number;
  maxVal?: number;
  className?: string;
}

export const Sparkline: React.FC<SparklineProps> = ({
  series,
  timestamps,
  formatTime,
  formatValue,
  height = 84,
  maxVal,
  className = '',
}) => {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 420;
  const padY = 6;
  const allValues = series.flatMap((s) => s.data);
  const maxSeriesLen = Math.max(0, ...series.map((s) => s.data.length));
  const computedMax = maxVal ?? Math.max(10, ...allValues) * 1.15;
  const len = Math.max(2, maxSeriesLen);

  const yPctOf = (v: number) => {
    const ratio = Math.min(1, Math.max(0, v / computedMax));
    const y = height - padY - ratio * (height - padY * 2);
    return (y / height) * 100;
  };

  const buildPath = (data: number[]) => {
    if (data.length === 0) return { line: '', area: '' };
    const padded = data.length === 1 ? [data[0], data[0]] : data;
    const stepX = width / Math.max(1, len - 1);
    const offset = len - padded.length;
    const pts = padded.map((v, i) => {
      const x = (i + offset) * stepX;
      const ratio = Math.min(1, Math.max(0, v / computedMax));
      const y = height - padY - ratio * (height - padY * 2);
      return [x, y] as const;
    });

    const line = pts
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
    return { line, area };
  };

  const updateHoverFromClientX = (clientX: number) => {
    const el = containerRef.current;
    if (!el || maxSeriesLen === 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (maxSeriesLen === 1) {
      setHoverIdx(0);
      return;
    }
    const idx = Math.round(ratio * (maxSeriesLen - 1));
    setHoverIdx(Math.min(maxSeriesLen - 1, Math.max(0, idx)));
  };

  const activeIdx =
    hoverIdx !== null && maxSeriesLen > 0 ? Math.min(hoverIdx, maxSeriesLen - 1) : null;
  const activeXPct =
    activeIdx !== null
      ? maxSeriesLen <= 1
        ? 100
        : (activeIdx / (maxSeriesLen - 1)) * 100
      : 0;

  const activeTs =
    activeIdx !== null && timestamps && timestamps.length > 0
      ? timestamps[Math.min(activeIdx, timestamps.length - 1)]
      : undefined;

  const formattedTime =
    activeTs !== undefined
      ? formatTime
        ? formatTime(activeTs)
        : new Date(activeTs).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })
      : null;

  const flipLeft = activeXPct > 58;

  return (
    <div
      ref={containerRef}
      onMouseMove={(e) => updateHoverFromClientX(e.clientX)}
      onMouseLeave={() => setHoverIdx(null)}
      onTouchStart={(e) => {
        if (e.touches[0]) updateHoverFromClientX(e.touches[0].clientX);
      }}
      onTouchMove={(e) => {
        if (e.touches[0]) updateHoverFromClientX(e.touches[0].clientX);
      }}
      onTouchEnd={() => setHoverIdx(null)}
      className={`relative select-none touch-pan-y cursor-crosshair ${className}`}
      style={{ height }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-full block overflow-visible"
      >
        <defs>
          {series.map((s, idx) => (
            <linearGradient
              key={idx}
              id={`spark-grad-${uid}-${idx}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
        </defs>

        {/* Subtle horizontal grid */}
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            x1="0"
            x2={width}
            y1={height * r}
            y2={height * r}
            stroke="rgba(148,163,184,0.08)"
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {series.map((s, idx) => {
          const { line, area } = buildPath(s.data);
          if (!line) return null;
          return (
            <g key={idx}>
              <path d={area} fill={`url(#spark-grad-${uid}-${idx})`} />
              <path
                d={line}
                fill="none"
                stroke={s.color}
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>

      {/* Crisp HTML Crosshair, Dots & Floating Tooltip (never stretched) */}
      {activeIdx !== null && (
        <>
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/25"
            style={{ left: `${activeXPct}%` }}
          />

          {series.map((s, idx) => {
            if (s.data.length === 0) return null;
            const offset = maxSeriesLen - s.data.length;
            const localIdx = activeIdx - offset;
            if (localIdx < 0 || localIdx >= s.data.length) return null;
            const val = s.data[localIdx];
            const topPct = yPctOf(val);
            return (
              <span
                key={idx}
                className="pointer-events-none absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2 ring-2 ring-[#090b10] shadow-sm"
                style={{
                  left: `${activeXPct}%`,
                  top: `${topPct}%`,
                  backgroundColor: s.color,
                }}
              />
            );
          })}

          <div
            className="pointer-events-none absolute top-1 z-20 bg-[#0d121c]/95 backdrop-blur-md border border-white/15 rounded-lg px-2.5 py-1.5 shadow-xl text-[10px] font-mono whitespace-nowrap"
            style={
              flipLeft
                ? { right: `${Math.max(0, 100 - activeXPct)}%`, marginRight: 8 }
                : { left: `${activeXPct}%`, marginLeft: 8 }
            }
          >
            {formattedTime && (
              <div className="text-slate-400 text-[9px] mb-1 pb-0.5 border-b border-white/[0.08]">
                {formattedTime}
              </div>
            )}
            <div className="space-y-0.5">
              {series.map((s, idx) => {
                if (s.data.length === 0) return null;
                const offset = maxSeriesLen - s.data.length;
                const localIdx = activeIdx - offset;
                if (localIdx < 0 || localIdx >= s.data.length) return null;
                const val = s.data[localIdx];
                const text = s.formatValue
                  ? s.formatValue(val)
                  : formatValue
                    ? formatValue(val, idx)
                    : String(val);
                return (
                  <div key={idx} className="flex items-center justify-between gap-2.5">
                    <span className="inline-flex items-center gap-1.5 text-slate-300">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: s.color }}
                      />
                      {s.label && <span>{s.label}</span>}
                    </span>
                    <span className="text-white font-semibold">{text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
