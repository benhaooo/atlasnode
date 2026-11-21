import type {
  AlertConfig,
  AlertEvent,
  DiskAuditData,
  DockerContainer,
  FileEntry,
  FirewallData,
  LiveTcpHealth,
  MeshLatencyCell,
  MetricHistoryResult,
  NetworkBurstItem,
  NetworkMonitorResponse,
  NetworkProfile,
  NetworkRouteSnapshot,
  NetworkSpeedSample,
  NetworkTarget,
  NodeQualityMode,
  NodeQualityRun,
  ProxyRoute,
  ServerConfig,
  ServerNetworkMode,
  ServerSnapshot,
  SshSecurityInfo,
  SystemdService,
  TailscalePeer,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  if (res.status === 401 && !url.includes('/api/auth/')) {
    window.dispatchEvent(new CustomEvent('atlasnode:unauthorized'));
    throw new Error('未登录或会话已过期');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data as T;
}

export const api = {
  authStatus: () => request<{ authenticated: boolean }>('/api/auth/status'),
  login: (password: string) => request<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  getManagerKey: () => request<{ publicKey: string }>('/api/manager-key'),
  getSystemRuntime: () =>
    request<{
      pool: { activeConnections: number; connections: { key: string; idleSec: number }[] };
      metricsDb: { totalSamples: number; dbPath: string };
      memoryRssBytes: number;
      uptimeSeconds: number;
    }>('/api/system/runtime'),

  getFleetSnapshots: (fresh = false) =>
    request<{ snapshots: ServerSnapshot[] }>(`/api/fleet/snapshots${fresh ? '?fresh=1' : ''}`),
  getServerSnapshot: (id: string, fresh = false) =>
    request<{ snapshot: ServerSnapshot }>(`/api/servers/${id}/snapshot${fresh ? '?fresh=1' : ''}`),
  getServerHistory: (id: string, range: '1h' | '6h' | '24h' | '7d') =>
    request<MetricHistoryResult>(`/api/servers/${id}/history?range=${range}`),
  createServer: (payload: Partial<ServerConfig>) =>
    request<{ server: ServerConfig }>('/api/servers', { method: 'POST', body: JSON.stringify(payload) }),
  updateServer: (id: string, payload: Partial<ServerConfig>) =>
    request<{ server: ServerConfig }>(`/api/servers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteServer: (id: string) => request<{ ok: boolean }>(`/api/servers/${id}`, { method: 'DELETE' }),
  testServer: (payload: Partial<ServerConfig>) =>
    request<{ ok: boolean; hostname?: string; os?: string; error?: string }>('/api/servers/test', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  discoverTailscale: () => request<{ source: string; peers: TailscalePeer[] }>('/api/tailscale/peers'),

  getServices: (id: string) =>
    request<{ dockerAvailable: boolean; containers: DockerContainer[]; systemdServices: SystemdService[] }>(
      `/api/servers/${id}/services`
    ),
  dockerAction: (id: string, cid: string, action: 'start' | 'stop' | 'restart') =>
    request<{ ok: boolean }>(`/api/servers/${id}/docker/${encodeURIComponent(cid)}/${action}`, { method: 'POST' }),
  dockerLogs: (id: string, cid: string, tail = 180) =>
    request<{ logs: string }>(`/api/servers/${id}/docker/${encodeURIComponent(cid)}/logs?tail=${tail}`),
  systemdLogs: (id: string, unit: string, lines = 120) =>
    request<{ logs: string }>(`/api/servers/${id}/systemd/${encodeURIComponent(unit)}/logs?lines=${lines}`),
  systemdAction: (id: string, unit: string, action: 'start' | 'stop' | 'restart') =>
    request<{ ok: boolean }>(`/api/servers/${id}/systemd/${encodeURIComponent(unit)}/${action}`, { method: 'POST' }),

  listNodeQuality: (id: string) =>
    request<{
      runs: NodeQualityRun[];
      activeJob: { id: string; mode: NodeQualityMode; phase: string; startedAt: string; logLines: string[] } | null;
    }>(`/api/servers/${id}/nodequality`),
  getNodeQualityRun: (id: string, runId: string) =>
    request<{ run: NodeQualityRun }>(`/api/servers/${id}/nodequality/${encodeURIComponent(runId)}`),
  startNodeQuality: (id: string, mode: NodeQualityMode) =>
    request<{ run: NodeQualityRun }>(`/api/servers/${id}/nodequality/run`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  cancelNodeQuality: (id: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/nodequality/cancel`, { method: 'POST' }),
  deleteNodeQuality: (id: string, runId: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/nodequality/${encodeURIComponent(runId)}`, { method: 'DELETE' }),

  getFirewall: (id: string) => request<{ firewall: FirewallData }>(`/api/servers/${id}/firewall`),
  addUfwRule: (
    id: string,
    payload: { port: string; proto: 'tcp' | 'udp' | 'any'; action: 'allow' | 'deny' | 'limit'; from?: string; comment?: string }
  ) => request<{ ok: boolean; output: string }>(`/api/servers/${id}/firewall/ufw/add`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteUfwRule: (id: string, num: number) =>
    request<{ ok: boolean }>(`/api/servers/${id}/firewall/ufw/delete`, { method: 'POST', body: JSON.stringify({ num }) }),
  toggleUfw: (id: string, enable: boolean) =>
    request<{ ok: boolean }>(`/api/servers/${id}/firewall/ufw/toggle`, { method: 'POST', body: JSON.stringify({ enable }) }),

  listFiles: (id: string, dirPath: string) =>
    request<{ path: string; entries: FileEntry[] }>(`/api/servers/${id}/files/list?path=${encodeURIComponent(dirPath)}`),
  readFile: (id: string, filePath: string) =>
    request<{ path: string; size: number; truncated: boolean; binary: boolean; content: string }>(
      `/api/servers/${id}/files/read?path=${encodeURIComponent(filePath)}`
    ),
  writeFile: (id: string, filePath: string, content: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/files/write`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, content }),
    }),
  uploadFileStream: async (id: string, filePath: string, file: File) => {
    const res = await fetch(
      `/api/servers/${encodeURIComponent(id)}/files/upload-stream?path=${encodeURIComponent(filePath)}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
    return data as { ok: boolean };
  },
  uploadFile: (id: string, filePath: string, base64: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/files/upload`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, base64 }),
    }),
  mkdir: (id: string, dirPath: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/files/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path: dirPath }),
    }),
  deleteFile: (id: string, targetPath: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/files/delete`, {
      method: 'POST',
      body: JSON.stringify({ path: targetPath }),
    }),
  downloadUrl: (id: string, filePath: string) =>
    `/api/servers/${id}/files/download?path=${encodeURIComponent(filePath)}`,

  getKeys: (id: string) => request<SshSecurityInfo>(`/api/servers/${id}/keys`),
  addKey: (id: string, publicKey: string) =>
    request<{ ok: boolean }>(`/api/servers/${id}/keys/add`, { method: 'POST', body: JSON.stringify({ publicKey }) }),
  deleteKey: (id: string, index: number) =>
    request<{ ok: boolean }>(`/api/servers/${id}/keys/delete`, { method: 'POST', body: JSON.stringify({ index }) }),
  syncKeyAll: (publicKey: string) =>
    request<{ results: { serverId: string; serverName: string; status: 'added' | 'exists' | 'error'; message?: string }[] }>(
      '/api/keys/sync-all',
      { method: 'POST', body: JSON.stringify({ publicKey }) }
    ),

  getProxies: (id: string) => request<{ routes: ProxyRoute[] }>(`/api/servers/${id}/proxies`),
  getAssets: (id: string) => request<{ assets: DiskAuditData }>(`/api/servers/${id}/assets`),
  pruneDocker: (id: string, target: 'images' | 'builder' | 'containers') =>
    request<{ ok: boolean; output: string }>(`/api/servers/${id}/docker-prune`, {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  addNftRule: (
    id: string,
    payload: { table: string; chain: string; port: string; proto: 'tcp' | 'udp'; comment?: string }
  ) => request<{ ok: boolean }>(`/api/servers/${id}/firewall/nft/add`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteNftRule: (id: string, payload: { table: string; chain: string; handle: number }) =>
    request<{ ok: boolean }>(`/api/servers/${id}/firewall/nft/delete`, { method: 'POST', body: JSON.stringify(payload) }),
  readComposeFile: (id: string, dir: string) =>
    request<{ path: string; size: number; truncated: boolean; binary: boolean; content: string }>(
      `/api/servers/${id}/compose/file?dir=${encodeURIComponent(dir)}`
    ),
  measureMeshLatency: () =>
    request<{ matrix: MeshLatencyCell[]; testedAt: string }>('/api/fleet/mesh-latency', { method: 'POST' }),

  getAlerts: () => request<{ config: AlertConfig; history: AlertEvent[] }>('/api/alerts/config'),
  saveAlerts: (config: AlertConfig) =>
    request<{ ok: boolean; config: AlertConfig }>('/api/alerts/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  testAlerts: (config: AlertConfig) =>
    request<{ ok: boolean; details: string[] }>('/api/alerts/test', {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),

  getNetworkProfile: (id: string) =>
    request<{ profile: NetworkProfile }>(`/api/servers/${id}/network/profile`),
  getNetworkMonitor: (id: string, range: '1h' | '6h' | '24h' | '7d') =>
    request<NetworkMonitorResponse>(`/api/servers/${id}/network/monitor?range=${range}`),
  runNetworkProbe: (id: string, count = 4) =>
    request<{ results: NetworkBurstItem[]; testedAt: string }>(`/api/servers/${id}/network/probe`, {
      method: 'POST',
      body: JSON.stringify({ count }),
    }),
  probeSingleNetworkTarget: (id: string, target: Partial<NetworkTarget>) =>
    request<{ result: NetworkBurstItem }>(`/api/servers/${id}/network/probe-single`, {
      method: 'POST',
      body: JSON.stringify(target),
    }),
  setServerNetworkMode: (
    id: string,
    payload: {
      mode: 'off' | 'routine' | 'inspect';
      durationHours?: number;
      enableSpeedInInspect?: boolean;
      enableRouteInInspect?: boolean;
    }
  ) =>
    request<{ ok: boolean; modeConfig: ServerNetworkMode }>(`/api/servers/${id}/network/mode`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getLiveTcpHealth: (id: string) =>
    request<{ health: LiveTcpHealth }>(`/api/servers/${id}/network/live-conns`),
  runNetworkSpeedtest: (id: string) =>
    request<{ samples: NetworkSpeedSample[] }>(`/api/servers/${id}/network/speedtest`, { method: 'POST' }),
  runNetworkRouteCheck: (id: string) =>
    request<{ snapshots: NetworkRouteSnapshot[] }>(`/api/servers/${id}/network/route-check`, { method: 'POST' }),
  listServers: () => request<{ servers: ServerConfig[] }>('/api/servers'),
  getNetworkTargets: () => request<{ targets: NetworkTarget[] }>('/api/network/targets'),
  saveNetworkTargets: (targets: NetworkTarget[]) =>
    request<{ ok: boolean; targets: NetworkTarget[] }>('/api/network/targets', {
      method: 'PUT',
      body: JSON.stringify({ targets }),
    }),
};
