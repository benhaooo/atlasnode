import React from 'react';

interface SparklineProps {
  series: {
    data: number[];
    color: string;
    fill?: string;
    label?: string;
  }[];
  height?: number;
  maxVal?: number;
  className?: string;
}

export const Sparkline: React.FC<SparklineProps> = ({
  series,
  height = 84,
  maxVal,
  className = '',
}) => {
  const width = 420;
  const padY = 6;
  const allValues = series.flatMap((s) => s.data);
  const computedMax = maxVal ?? Math.max(10, ...allValues) * 1.15;
  const len = Math.max(2, ...series.map((s) => s.data.length));

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

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full overflow-visible ${className}`}
      style={{ height }}
    >
      <defs>
        {series.map((s, idx) => (
          <linearGradient key={idx} id={`spark-grad-${idx}-${s.color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
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
        />
      ))}

      {series.map((s, idx) => {
        const { line, area } = buildPath(s.data);
        if (!line) return null;
        return (
          <g key={idx}>
            <path d={area} fill={`url(#spark-grad-${idx}-${s.color.replace('#', '')})`} />
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
  );
};
