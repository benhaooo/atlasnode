export interface JumpHostConfig {
  host: string;
  port?: number;
  username: string;
}

export interface QuickLink {
  id: string;
  name: string;
  url: string;
  category: 'panel' | 'web' | 'proxy' | 'db' | 'api' | 'custom';
  port?: number;
  description?: string;
  autoDetected?: boolean;
}

export type TrafficBillingMode = 'both' | 'tx' | 'rx' | 'max';

export interface TrafficPlan {
  bandwidthMbps?: number;
  monthlyQuotaGb?: number;
  billingMode?: TrafficBillingMode;
  resetDay?: number;
  baselineGb?: number;
  baselineCycleKey?: string;
}

export interface DailyTrafficPoint {
  day: string;
  rxBytes: number;
  txBytes: number;
  peakRxBps: number;
  peakTxBps: number;
}

export interface TrafficSummary {
  cycleStart: string;
  cycleEnd: string;
  daysElapsed: number;
  daysTotal: number;
  daysRemaining: number;
  todayRxBytes: number;
  todayTxBytes: number;
  cycleRxBytes: number;
  cycleTxBytes: number;
  baselineBytes: number;
  billedBytes: number;
  quotaBytes: number;
  usedPercent: number;
  projectedBytes: number;
  peakRxBps: number;
  peakTxBps: number;
  bandwidthMbps: number;
  billingMode: TrafficBillingMode;
  resetDay: number;
  dailySeries?: DailyTrafficPoint[];
}

export interface ServerConfig {
  id: string;
  name: string;
  role: string;
  notes: string;
  tags: string[];
  region?: string;
  mode: 'local' | 'ssh';
  host: string;
  port: number;
  username: string;
  useSudo: boolean;
  publicIp?: string;
  tailscaleIp?: string;
  jumpHost?: JumpHostConfig;
  quickLinks: QuickLink[];
  trafficPlan?: TrafficPlan;
  createdAt: string;
}

export interface ProcessMetric {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rssKb: number;
  command: string;
}

export interface LiveMetrics {
  timestamp: number;
  cpuPercent: number;
  cpuCores: number;
  loadAvg: [number, number, number];
  memTotalBytes: number;
  memUsedBytes: number;
  memAvailableBytes: number;
  memPercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  diskRootTotalBytes: number;
  diskRootUsedBytes: number;
  diskRootPercent: number;
  netRxBps: number;
  netTxBps: number;
  netTotalRxBytes: number;
  netTotalTxBytes: number;
  netInterface: string;
  uptimeSeconds: number;
  topProcesses: ProcessMetric[];
}

export interface DiskMount {
  device: string;
  mount: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usePercent: number;
}

export interface NetInterface {
  name: string;
  ipv4: string[];
  ipv6: string[];
  rxBytes: number;
  txBytes: number;
  state: string;
}

export interface DockerPort {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  proto: string;
  isPublic: boolean;
  quickUrl?: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health?: string;
  composeProject?: string;
  composeDir?: string;
  ports: DockerPort[];
  cpuPercent?: number;
  memUsage?: string;
  memPercent?: number;
  netIO?: string;
  createdAt?: string;
}

export interface SystemdService {
  name: string;
  description: string;
  activeState: string;
  subState: string;
  partOf?: string;
  workingDir?: string;
}

export interface ListeningPort {
  proto: string;
  address: string;
  port: number;
  scope: 'public' | 'tailscale' | 'local' | 'private';
  process: string;
  pid: number | null;
  dockerContainer?: string;
}

export interface UfwRule {
  num: number;
  to: string;
  action: string;
  from: string;
  comment?: string;
  ipv6: boolean;
}

export interface NftRule {
  table: string;
  chain: string;
  handle: number;
  proto?: string;
  ports?: string;
  action: string;
  comment?: string;
  raw: string;
}

export interface FirewallData {
  engine: 'ufw' | 'nftables' | 'firewalld' | 'iptables' | 'none';
  active: boolean;
  defaultIncoming: string;
  defaultOutgoing: string;
  ufwRules: UfwRule[];
  nftRules?: NftRule[];
  nftTarget?: { table: string; chain: string };
  listeningPorts: ListeningPort[];
  rawIptables: string;
}

export interface ProxyRoute {
  engine: 'caddy' | 'nginx' | 'cloudflared';
  domain: string;
  url: string;
  upstream: string;
  tlsDaysLeft?: number | null;
  tlsIssuer?: string;
  configPath?: string;
}

export interface DiskAuditData {
  topDirs: { path: string; bytes: number }[];
  dockerDf: { type: string; total: string; active: string; size: string; reclaimable: string }[];
  crontabs: { source: string; schedule: string; command: string }[];
  timers: { name: string; next: string; activates: string }[];
  runtimes: { name: string; version: string }[];
}

export interface MeshLatencyCell {
  fromId: string;
  toId: string;
  targetHost: string;
  latencyMs: number | null;
  error?: string;
}

export interface AlertConfig {
  enabled: boolean;
  cooldownMinutes: number;
  thresholds: {
    diskPercent: number;
    cpuPercent: number;
    memPercent: number;
    trafficPercent: number;
    offlineAlert: boolean;
  };
  telegram: { enabled: boolean; botToken: string; chatId: string };
  webhook: { enabled: boolean; url: string };
  bark: { enabled: boolean; url: string };
}

export interface AlertEvent {
  id: string;
  ts: string;
  serverId: string;
  serverName: string;
  kind: string;
  message: string;
  delivered: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mode: string;
  owner: string;
  group: string;
  mtime: string;
}

export interface SshKeyItem {
  index: number;
  type: string;
  key: string;
  comment: string;
  fingerprint: string;
  isManagerKey: boolean;
  rawLine: string;
}

export interface SshSecurityInfo {
  targetFile: string;
  keys: SshKeyItem[];
  sshdConfig: {
    port: string;
    permitRootLogin: string;
    passwordAuthentication: string;
    pubkeyAuthentication: string;
  };
  recentLogins: string[];
  managerPublicKey: string;
}

export interface NodeQualityUnlock {
  service: string;
  status: 'native' | 'unlocked' | 'dns' | 'app_only' | 'blocked' | 'failed' | 'unknown';
  statusText?: string;
  region?: string;
  unlockType?: string;
  detail?: string;
}

export interface NodeQualityRoute {
  isp: string;
  city: string;
  proto?: string;
  lineType: string;
  asn?: string;
  latencyMs?: number;
  detail?: string;
}

export interface NodeQualityBackrouteTrace {
  city: string;
  isp: string;
  lineType: string;
  geoPath?: string;
  asnPath?: string;
  hops: string[];
}

export interface NodeQualityTransferRow {
  city: string;
  delayMs?: string;
  sendSpeed?: string;
  sendRetransmits?: string;
  receiveSpeed?: string;
  receiveRetransmits?: string;
}

export interface NodeQualityRiskSource {
  name: string;
  score: string;
  level: 'low' | 'medium' | 'high' | 'unknown';
}

export interface NodeQualityRiskFactorRow {
  provider: string;
  country?: string;
  proxy?: string;
  tor?: string;
  vpn?: string;
  server?: string;
  abuser?: string;
  robot?: string;
}

export interface NodeQualityDelayRow {
  code?: string;
  city: string;
  ct?: string;
  cu?: string;
  cm?: string;
}

export interface NodeQualitySummary {
  ip: {
    ipv4?: string;
    ipv6?: string;
    asn?: string;
    org?: string;
    country?: string;
    continent?: string;
    registeredCountry?: string;
    city?: string;
    timezone?: string;
    mapUrl?: string;
    usageType?: string;
    ipType?: string;
    isNative?: boolean | null;
    riskScore?: number | null;
    riskLevel: 'low' | 'medium' | 'high' | 'unknown';
    riskSources: NodeQualityRiskSource[];
    typeMatrix?: { provider: string; usage?: string; company?: string }[];
    riskFactors?: NodeQualityRiskFactorRow[];
    blacklistHit?: number;
    blacklistMarked?: number;
    blacklistClean?: number;
    blacklistTotal?: number;
    mailPort25?: string;
    mailReachable?: string[];
    reportSvgUrl?: string;
  };
  unlocks: NodeQualityUnlock[];
  hardware: {
    os?: string;
    arch?: string;
    virtualization?: string;
    cpuModel?: string;
    cores?: string;
    freqMhz?: string;
    cache?: string;
    flags?: string[];
    featureChecks?: { name: string; supported: boolean }[];
    gpu?: string;
    memory?: string;
    swap?: string;
    oversell?: { balloon?: boolean; ksm?: boolean };
    disk?: string;
    motherboard?: string;
    nic?: string;
    cpuSingle?: string;
    cpuMulti?: string;
    memReadMBps?: string;
    memWriteMBps?: string;
    fio4kRead?: string;
    fio4kWrite?: string;
    fio1mRead?: string;
    fio1mWrite?: string;
    ddSpeed?: string;
    reportSvgUrl?: string;
  };
  network: {
    bgp?: {
      asn?: string;
      org?: string;
      prefix?: number;
      rir?: string;
      modDate?: string;
      country?: string;
      address?: string;
      ipActive?: number;
      ipTotal?: number;
      ixCount?: number;
      upstreamsCount?: number;
      peersCount?: number;
      upstreams?: string[];
    };
    local?: {
      nat?: string;
      mapping?: string;
      filter?: string;
      tcpCc?: string;
      qdisc?: string;
      rmem?: string;
      wmem?: string;
    };
    delays?: NodeQualityDelayRow[];
    transfers?: NodeQualityTransferRow[];
    routes: NodeQualityRoute[];
    backrouteTraces?: NodeQualityBackrouteTrace[];
    speedtests: { node: string; provider?: string; download?: string; upload?: string; latency?: string }[];
    reportSvgUrl?: string;
  };
}

export interface MetricHistoryPoint {
  ts: number;
  cpuPercent: number;
  memPercent: number;
  diskPercent: number;
  load1: number;
  netRxBps: number;
  netTxBps: number;
}

export interface MetricHistoryResult {
  range: '1h' | '6h' | '24h' | '7d';
  points: MetricHistoryPoint[];
  traffic: {
    rxBytes: number;
    txBytes: number;
  };
  sampleCount: number;
}

export type NodeQualityMode = 'fast' | 'full' | 'ip_hw' | 'net';

export interface NodeQualityRun {
  id: string;
  serverId: string;
  mode: NodeQualityMode;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  phase?: string;
  reportUrl?: string;
  error?: string;
  summary: NodeQualitySummary;
  rawJson?: {
    hardware?: unknown;
    ip?: unknown;
    net?: unknown;
    backroute?: unknown;
  };
  logs?: {
    header?: string;
    hardware?: string;
    ip?: string;
    net?: string;
    backroute?: string;
    combined?: string;
  };
}

export interface NetworkHealthBrief {
  mode: 'off' | 'routine' | 'inspect';
  grade: 'excellent' | 'good' | 'degraded' | 'poor' | 'collecting';
  headline: string;
  avgLossPct: number;
  maxLossPct: number;
  peakDeltaMs?: number;
  samples: number;
}

export interface AutoNQConfig {
  enabled: boolean;
  intervalDays: number;
  mode: NodeQualityMode;
  alertOnDegrade: boolean;
}

export interface ServerSnapshot {
  server: ServerConfig;
  online: boolean;
  error?: string;
  hostname?: string;
  os?: string;
  kernel?: string;
  arch?: string;
  cpuModel?: string;
  cpuCores?: number;
  publicIp?: string;
  tailscaleIp?: string;
  metrics?: LiveMetrics;
  disks: DiskMount[];
  interfaces: NetInterface[];
  dockerAvailable: boolean;
  dockerSummary: {
    total: number;
    running: number;
    stopped: number;
    unhealthy: number;
  };
  containersPreview: DockerContainer[];
  systemdHighlights: SystemdService[];
  firewallSummary: {
    engine: string;
    active: boolean;
    publicPortsCount: number;
    tailscalePortsCount: number;
    localPortsCount: number;
  };
  publicPortsPreview: ListeningPort[];
  composeDirs: { project: string; dir: string }[];
  detectedLinks: QuickLink[];
  latestNodeQuality?: {
    id: string;
    startedAt: string;
    finishedAt?: string;
    mode: NodeQualityMode;
    status: NodeQualityRun['status'];
    reportUrl?: string;
    summary: NodeQualitySummary;
  };
  activeNodeQualityJob?: {
    id: string;
    mode: NodeQualityMode;
    phase: string;
    startedAt: string;
  };
  networkSummary?: NetworkHealthBrief;
  trafficSummary?: TrafficSummary;
  collectedAt: string;
}

export interface TailscalePeer {
  id: string;
  hostName: string;
  dnsName: string;
  tailscaleIp: string;
  os: string;
  online: boolean;
  lastSeen?: string;
  alreadyAdded: boolean;
}

export interface NetworkTarget {
  id: string;
  name: string;
  host: string;
  port?: number;
  protocol: 'icmp' | 'tcp';
  group: string;
  enabled: boolean;
}

export interface NetworkProbeSample {
  ts: number;
  targetId: string;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  jitterMs: number | null;
  lossPct: number;
}

export interface NetworkPeriodStats {
  samples: number;
  avgMs: number | null;
  p95Ms: number | null;
  jitterMs: number | null;
  lossPct: number;
}

export interface NetworkTargetSummary {
  target: NetworkTarget;
  latest?: NetworkProbeSample;
  overall: NetworkPeriodStats;
  peak: NetworkPeriodStats;
  offPeak: NetworkPeriodStats;
  peakDeltaMs?: number;
  grade: 'excellent' | 'good' | 'degraded' | 'poor' | 'unknown';
  points: NetworkProbeSample[];
}

export interface ServerNetworkMode {
  mode: 'off' | 'routine' | 'inspect';
  inspectUntil?: string;
  enableSpeedInInspect: boolean;
  enableRouteInInspect: boolean;
  updatedAt?: string;
}

export interface NetworkSpeedSample {
  ts: number;
  endpointId: string;
  endpointName: string;
  mbps: number;
  ttfbMs: number;
  bytes: number;
  durationMs: number;
  error?: string;
  isPeak: boolean;
}

export interface NetworkRouteSnapshot {
  ts: number;
  targetId: string;
  targetName: string;
  hopsCount: number;
  finalMs: number | null;
  pathSummary: string;
  hops: string[];
  isPeak: boolean;
  changed: boolean;
}

export interface NetworkVerdict {
  grade: 'excellent' | 'good' | 'degraded' | 'poor' | 'collecting';
  headline: string;
  reasons: string[];
}

export interface NetworkMonitorResponse {
  range: '1h' | '6h' | '24h' | '7d';
  sampleIntervalMs: number;
  modeConfig: ServerNetworkMode;
  verdict: NetworkVerdict;
  targets: NetworkTargetSummary[];
  speedSamples: NetworkSpeedSample[];
  routeSnapshots: NetworkRouteSnapshot[];
  updatedAt: string;
}

export interface LivePortConnSummary {
  port: number;
  process: string;
  activeCount: number;
  avgRttMs: number | null;
  maxRttMs: number | null;
  avgDeliveryMbps: number | null;
  retransTotal: number;
  lostTotal: number;
}

export interface LivePeerConn {
  localPort: number;
  process: string;
  remoteAddr: string;
  rttMs: number | null;
  rttVarMs: number | null;
  deliveryMbps: number | null;
  pacingMbps: number | null;
  retrans: number;
  lost: number;
  bytesSent: number;
  bytesRecv: number;
}

export interface LiveTcpHealth {
  totalEstablished: number;
  ports: LivePortConnSummary[];
  topPeers: LivePeerConn[];
  collectedAt: string;
}

export interface NetworkNICDetail {
  name: string;
  state: string;
  mtu: number;
  mac?: string;
  ipv4: string[];
  ipv6: string[];
  rxBytes: number;
  txBytes: number;
  rxDrops: number;
  txDrops: number;
}

export interface NetworkRouteInfo {
  destination: string;
  gateway: string;
  device: string;
  src?: string;
}

export interface NetworkProfile {
  publicIpv4?: string;
  publicIpv6?: string;
  defaultGateway?: string;
  defaultDev?: string;
  tcpCc: string;
  qdisc: string;
  ipForward: boolean;
  tcpFastOpen?: string;
  rmemMax?: string;
  wmemMax?: string;
  dnsServers: string[];
  tcpStates: Record<string, number>;
  totalConns: number;
  interfaces: NetworkNICDetail[];
  routes: NetworkRouteInfo[];
  collectedAt: string;
}

export interface NetworkBurstItem {
  targetId: string;
  targetName: string;
  host: string;
  protocol: string;
  sent: number;
  received: number;
  lossPct: number;
  minMs: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  jitterMs: number | null;
  rtts?: number[];
}
