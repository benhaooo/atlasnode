import React from 'react';

export const Sk: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`rounded bg-white/[0.07] animate-pulse ${className}`} />
);

export const FleetSkeleton: React.FC = () => (
  <div className="space-y-4">
    {[0, 1, 2].map((i) => (
      <div
        key={i}
        className="rounded-2xl bg-[#0f131b] border border-white/[0.06] p-5 grid grid-cols-1 xl:grid-cols-12 gap-5"
      >
        <div className="xl:col-span-5 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <Sk className="w-2.5 h-2.5 rounded-full" />
            <Sk className="h-4 w-28" />
            <Sk className="h-4 w-36 bg-white/[0.04]" />
          </div>
          <Sk className="h-3 w-52 bg-white/[0.04]" />
          <div className="flex gap-2 pt-1">
            <Sk className="h-5 w-16 rounded-md bg-white/[0.05]" />
            <Sk className="h-5 w-20 rounded-md bg-white/[0.05]" />
            <Sk className="h-5 w-14 rounded-md bg-white/[0.05]" />
          </div>
        </div>
        <div className="xl:col-span-4 grid grid-cols-3 gap-3">
          {[0, 1, 2].map((j) => (
            <div key={j} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 space-y-2">
              <Sk className="h-2.5 w-10 bg-white/[0.05]" />
              <Sk className="h-5 w-14" />
              <Sk className="h-1.5 w-full rounded-full bg-white/[0.05]" />
            </div>
          ))}
        </div>
        <div className="xl:col-span-3 space-y-2">
          <Sk className="h-3 w-24 bg-white/[0.05]" />
          <Sk className="h-8 w-full rounded-lg bg-white/[0.05]" />
          <Sk className="h-8 w-full rounded-lg bg-white/[0.04]" />
        </div>
      </div>
    ))}
  </div>
);

export const NodeQualitySkeleton: React.FC = () => (
  <div className="space-y-5">
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="bg-[#0f131b] border border-white/[0.06] rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Sk className="h-3 w-24 bg-white/[0.05]" />
            <Sk className="h-4 w-14 rounded-full bg-white/[0.05]" />
          </div>
          <Sk className="h-5 w-36" />
          <Sk className="h-3 w-44 bg-white/[0.04]" />
        </div>
      ))}
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <div className="lg:col-span-7 bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-3">
        <Sk className="h-3.5 w-32" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {[0, 1, 2, 3, 4, 5].map((j) => (
            <div key={j} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 space-y-2">
              <Sk className="h-3 w-16" />
              <Sk className="h-4 w-20 bg-white/[0.05]" />
            </div>
          ))}
        </div>
      </div>
      <div className="lg:col-span-5 bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-2.5">
        <Sk className="h-3.5 w-28" />
        {[0, 1, 2, 3, 4].map((j) => (
          <Sk key={j} className="h-8 w-full rounded-lg bg-[#090b10]" />
        ))}
      </div>
    </div>
  </div>
);

export const FirewallSkeleton: React.FC = () => (
  <div className="space-y-5">
    <div className="rounded-2xl p-5 border border-white/[0.06] bg-[#0f131b] flex items-center justify-between gap-4">
      <div className="flex items-center gap-3.5">
        <Sk className="w-10 h-10 rounded-xl" />
        <div className="space-y-2">
          <Sk className="h-4 w-40" />
          <Sk className="h-3 w-64 bg-white/[0.04]" />
        </div>
      </div>
      <Sk className="h-8 w-24 rounded-xl bg-white/[0.05]" />
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <div className="lg:col-span-7 bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-2.5">
        <Sk className="h-3.5 w-36 mb-3" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl px-3.5 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sk className="h-3.5 w-12" />
              <Sk className="h-3.5 w-10 bg-white/[0.05]" />
              <Sk className="h-3.5 w-28 bg-white/[0.05]" />
            </div>
            <Sk className="h-3 w-20 bg-white/[0.04]" />
          </div>
        ))}
      </div>
      <div className="lg:col-span-5 bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-2.5">
        <Sk className="h-3.5 w-32 mb-3" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 space-y-1.5">
            <Sk className="h-3.5 w-40" />
            <Sk className="h-2.5 w-52 bg-white/[0.04]" />
          </div>
        ))}
      </div>
    </div>
  </div>
);

export const AssetsSkeleton: React.FC = () => (
  <div className="space-y-5">
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      <div className="lg:col-span-7 bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-3">
        <Sk className="h-3.5 w-40" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex justify-between">
              <Sk className="h-3 w-44" />
              <Sk className="h-3 w-14 bg-white/[0.05]" />
            </div>
            <Sk className="h-1.5 w-full rounded-full bg-white/[0.04]" />
          </div>
        ))}
      </div>
      <div className="lg:col-span-5 bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-3">
        <Sk className="h-3.5 w-32" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 flex justify-between">
            <Sk className="h-3.5 w-24" />
            <Sk className="h-3.5 w-20 bg-white/[0.05]" />
          </div>
        ))}
      </div>
    </div>
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-2.5">
          <Sk className="h-3.5 w-28" />
          <Sk className="h-9 w-full rounded-lg bg-[#090b10]" />
          <Sk className="h-9 w-full rounded-lg bg-[#090b10]" />
          <Sk className="h-9 w-full rounded-lg bg-[#090b10]" />
        </div>
      ))}
    </div>
  </div>
);

export const KeysSkeleton: React.FC = () => (
  <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
    <div className="lg:col-span-7 bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-3.5">
      <div className="flex items-center justify-between">
        <div className="space-y-1.5">
          <Sk className="h-4 w-36" />
          <Sk className="h-2.5 w-44 bg-white/[0.04]" />
        </div>
        <Sk className="h-8 w-24 rounded-xl bg-white/[0.06]" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <Sk className="h-3.5 w-32" />
            <Sk className="h-4 w-14 rounded bg-white/[0.05]" />
          </div>
          <Sk className="h-3 w-56 bg-white/[0.04]" />
          <Sk className="h-2.5 w-40 bg-white/[0.04]" />
        </div>
      ))}
    </div>
    <div className="lg:col-span-5 space-y-5">
      <div className="bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-3">
        <Sk className="h-3.5 w-28" />
        <div className="grid grid-cols-2 gap-2.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 space-y-1.5">
              <Sk className="h-2.5 w-14 bg-white/[0.04]" />
              <Sk className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
      <div className="bg-[#0f131b] border border-white/[0.06] rounded-2xl p-5 space-y-2">
        <Sk className="h-3.5 w-24" />
        {[0, 1, 2, 3].map((i) => (
          <Sk key={i} className="h-7 w-full rounded-lg bg-[#090b10]" />
        ))}
      </div>
    </div>
  </div>
);

export const FileListSkeleton: React.FC = () => (
  <div className="divide-y divide-white/[0.04]">
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="px-4 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 flex-1">
          <Sk className="w-4 h-4 rounded shrink-0 bg-white/[0.06]" />
          <div style={{ width: `${(i % 4) * 14 + 22}%` }} className="h-3.5 rounded bg-white/[0.06] animate-pulse" />
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <Sk className="h-3 w-20 hidden sm:block bg-white/[0.04]" />
          <Sk className="h-3 w-12 bg-white/[0.05]" />
        </div>
      </div>
    ))}
  </div>
);

export const ProxyRoutesSkeleton: React.FC = () => (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
    {[0, 1, 2].map((i) => (
      <div key={i} className="bg-[#0f131b] border border-white/[0.06] rounded-xl p-3.5 flex items-start justify-between gap-2">
        <div className="space-y-2 flex-1">
          <div className="flex items-center gap-1.5">
            <Sk className="h-4 w-12 rounded bg-white/[0.06]" />
            <Sk className="h-3.5 w-32" />
          </div>
          <Sk className="h-3 w-28 bg-white/[0.04]" />
        </div>
        <Sk className="h-5 w-12 rounded-md bg-white/[0.05]" />
      </div>
    ))}
  </div>
);

export const NetworkChartSkeleton: React.FC = () => (
  <div className="bg-[#090b10] rounded-xl border border-white/[0.05] p-3.5 space-y-2.5">
    <div className="flex items-stretch h-48">
      <div className="w-12 shrink-0 pr-2.5 py-1 flex flex-col justify-between items-end">
        {[0, 1, 2, 3, 4].map((i) => (
          <Sk key={i} className="h-2.5 w-8 bg-white/[0.05]" />
        ))}
      </div>
      <div className="flex-1 flex flex-col justify-between py-2 relative overflow-hidden">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="w-full border-t border-dashed border-white/[0.05]" />
        ))}
        <div className="absolute inset-x-4 bottom-6 h-20 rounded-xl bg-gradient-to-t from-sky-500/[0.07] to-transparent animate-pulse" />
      </div>
    </div>
    <div className="pl-12 pt-1 flex items-center justify-between">
      {[0, 1, 2, 3, 4].map((i) => (
        <Sk key={i} className="h-2.5 w-10 bg-white/[0.05]" />
      ))}
    </div>
  </div>
);

export const NetworkLiveTcpSkeleton: React.FC = () => (
  <div className="space-y-3">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {[0, 1].map((i) => (
        <div key={i} className="bg-[#090b10] border border-white/[0.05] rounded-xl p-3 space-y-2.5">
          <div className="flex justify-between">
            <Sk className="h-3.5 w-24" />
            <Sk className="h-4 w-12 rounded bg-white/[0.05]" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((j) => (
              <div key={j} className="space-y-1">
                <Sk className="h-2 w-10 bg-white/[0.04]" />
                <Sk className="h-3.5 w-12" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
    <div className="space-y-1.5">
      {[0, 1, 2].map((i) => (
        <Sk key={i} className="h-7 w-full rounded-lg bg-[#090b10]" />
      ))}
    </div>
  </div>
);

export const ServerDetailSkeleton: React.FC = () => (
  <div className="min-h-dvh flex flex-col">
    <header className="bg-[#090b10]/90 backdrop-blur-md border-b border-white/[0.06]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-3 sm:pt-4 pb-0">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3.5">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              <Sk className="w-2.5 h-2.5 rounded-full" />
              <Sk className="h-5 w-36" />
              <Sk className="h-4 w-24 bg-white/[0.05]" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Sk className="h-3 w-28 bg-white/[0.04]" />
              <Sk className="h-3 w-28 bg-white/[0.04]" />
              <Sk className="h-3 w-36 bg-white/[0.04]" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Sk className="h-8 w-24 rounded-lg bg-white/[0.05]" />
            <Sk className="h-8 w-8 rounded-lg bg-white/[0.05]" />
            <Sk className="h-8 w-8 rounded-lg bg-white/[0.05]" />
          </div>
        </div>
        <div className="flex items-center gap-2 pb-2.5 overflow-hidden">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <Sk key={i} className="h-6 w-20 shrink-0 rounded-md bg-white/[0.05]" />
          ))}
        </div>
      </div>
    </header>
    <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-4 sm:py-6">
      <NodeQualitySkeleton />
    </main>
  </div>
);

