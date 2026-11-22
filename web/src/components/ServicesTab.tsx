import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  Box,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Layers,
  Loader2,
  MemoryStick,
  Play,
  RefreshCw,
  RotateCw,
  Save,
  Search,
  ServerCog,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { DockerContainer, DockerPort, ProxyRoute, ServerConfig, ServerSnapshot, SystemdService } from '../types';
import { formatBytes } from '../utils';

interface ServicesTabProps {
  snapshot: ServerSnapshot;
  onJumpFolder: (dirPath: string) => void;
  onServerUpdated: (server: ServerConfig) => void;
  onRefreshSnapshot: () => void;
  onOpenContainerTerminal?: (containerName: string) => void;
}

interface ComposeStackGroup {
  project: string;
  dir?: string;
  items: DockerContainer[];
  runningCount: number;
  unhealthyCount: number;
  totalCpu: number;
  totalMemBytes: number;
  publicPorts: { port: DockerPort; container: string }[];
  internalPorts: { port: DockerPort; container: string }[];
  hasOnlyCleanExited: boolean;
}

interface HostSuiteGroup {
  name: string;
  partOf?: string;
  workingDir?: string;
  items: SystemdService[];
  managedContainers: DockerContainer[];
  runningCount: number;
  failedCount: number;
  totalCpu: number;
  totalMemBytes: number;
  publicPorts: { port: DockerPort; container: string }[];
  description: string;
  allProtected: boolean;
}

type DeleteTarget =
  | { kind: 'stack'; project: string; dir?: string; containers: DockerContainer[] }
  | { kind: 'container'; container: DockerContainer };

const PROTECTED_SYSTEMD = new Set(['ssh', 'sshd', 'atlasnode', 'tailscaled']);

const INFRA_SYSTEMD = new Set([
  'ssh', 'sshd', 'docker', 'containerd', 'tailscaled', 'cron', 'crond',
  'fail2ban', 'ufw', 'nftables', 'firewalld', 'iptables', 'netfilter-persistent',
  'chronyd', 'ntp', 'ntpd', 'rsyslog', 'syslog-ng', 'auditd', 'haveged',
  'rngd', 'smartd', 'lm-sensors', 'monit', 'open-vm-tools', 'vmtoolsd', 'vgauth',
  'open-iscsi', 'thermald', 'apport', 'pollinate', 'tat_agent', 'barad_agent', 'sgagent',
]);

function cleanTargetSuiteName(target: string): string {
  return target
    .replace(/\.target$/i, '')
    .replace(/-(control|main|all|services|group)$/i, '');
}

function groupHostServices(
  services: SystemdService[],
  allContainers: DockerContainer[]
): {
  suites: HostSuiteGroup[];
  singles: SystemdService[];
  infra: SystemdService[];
  claimedContainerIds: Set<string>;
} {
  const infra: SystemdService[] = [];
  const apps: SystemdService[] = [];
  for (const s of services) {
    if (INFRA_SYSTEMD.has(s.name.toLowerCase())) {
      infra.push(s);
    } else {
      apps.push(s);
    }
  }

  const assigned = new Set<string>();
  const rawSuites: { name: string; partOf?: string; workingDir?: string; items: SystemdService[] }[] = [];

  // Priority 1: Explicit systemd PartOf=*.target
  const byPartOf = new Map<string, SystemdService[]>();
  for (const s of apps) {
    if (!s.partOf) continue;
    if (!byPartOf.has(s.partOf)) byPartOf.set(s.partOf, []);
    byPartOf.get(s.partOf)!.push(s);
  }
  for (const [target, items] of byPartOf.entries()) {
    if (items.length >= 2) {
      const wd = items.find((i) => i.workingDir)?.workingDir;
      rawSuites.push({ name: cleanTargetSuiteName(target), partOf: target, workingDir: wd, items });
      for (const it of items) assigned.add(it.name);
    }
  }

  // Priority 2: Shared non-root WorkingDirectory
  const byDir = new Map<string, SystemdService[]>();
  for (const s of apps) {
    if (assigned.has(s.name) || !s.workingDir) continue;
    if (!byDir.has(s.workingDir)) byDir.set(s.workingDir, []);
    byDir.get(s.workingDir)!.push(s);
  }
  for (const [wd, items] of byDir.entries()) {
    if (items.length >= 2) {
      const base = wd.split('/').filter(Boolean).pop() || items[0].name.split('-')[0];
      rawSuites.push({ name: base, workingDir: wd, items });
      for (const it of items) assigned.add(it.name);
    }
  }

  // Priority 3: Fallback hyphen prefix grouping for multi-daemon apps (e.g. 1panel-core + 1panel-agent)
  const tryGroupBySegments = (segCount: number) => {
    const buckets = new Map<string, SystemdService[]>();
    for (const s of apps) {
      if (assigned.has(s.name)) continue;
      const parts = s.name.split('-');
      if (parts.length <= segCount) continue;
      const prefix = parts.slice(0, segCount).join('-');
      if (!buckets.has(prefix)) buckets.set(prefix, []);
      buckets.get(prefix)!.push(s);
    }
    for (const [prefix, items] of buckets.entries()) {
      if (items.length >= 2) {
        const wd = items.find((i) => i.workingDir)?.workingDir;
        rawSuites.push({ name: prefix, workingDir: wd, items });
        for (const it of items) assigned.add(it.name);
      }
    }
  };
  tryGroupBySegments(2);
  tryGroupBySegments(1);

  // Deterministically attach Docker containers managed by a Host Suite
  // (Rule A: composeDir is under suite's WorkingDirectory; Rule B: standalone container matched by suite's wrapper unit)
  const claimedContainerIds = new Set<string>();
  const suites: HostSuiteGroup[] = rawSuites.map((rs) => {
    const suiteDirs = new Set(
      rs.items
        .map((i) => i.workingDir?.replace(/\/+$/, ''))
        .filter((d): d is string => Boolean(d && d !== '/'))
    );
    if (rs.workingDir) suiteDirs.add(rs.workingDir.replace(/\/+$/, ''));

    const suiteRoot = rs.name.split('-')[0].toLowerCase();
    const wrapperSuffixes = rs.items
      .filter((u) => /container|proxy|coredns|egress/i.test(u.description || ''))
      .map((u) => u.name.toLowerCase());

    const managed: DockerContainer[] = [];
    for (const c of allContainers) {
      if (claimedContainerIds.has(c.id)) continue;
      const cDir = c.composeDir?.replace(/\/+$/, '');
      let matched = false;
      if (cDir && suiteDirs.size > 0) {
        for (const wd of suiteDirs) {
          if (cDir === wd || cDir.startsWith(wd + '/')) {
            matched = true;
            break;
          }
        }
      }
      if (!matched && !c.composeProject && suiteRoot.length >= 3 && c.name.toLowerCase().startsWith(suiteRoot + '-')) {
        const cLow = c.name.toLowerCase();
        const cTail = cLow.split('-').pop() || '';
        if (
          wrapperSuffixes.some(
            (u) => u.endsWith('-' + cLow) || (cTail.length >= 4 && u.endsWith('-' + cTail))
          )
        ) {
          matched = true;
        }
      }
      if (matched) {
        claimedContainerIds.add(c.id);
        managed.push(c);
      }
    }

    const totalCpu = managed.reduce((acc, c) => acc + (c.state === 'running' ? c.cpuPercent || 0 : 0), 0);
    const totalMemBytes = managed.reduce((acc, c) => acc + (c.state === 'running' ? parseMemToBytes(c.memUsage) : 0), 0);
    const seenPort = new Set<string>();
    const publicPorts: { port: DockerPort; container: string }[] = [];
    for (const c of managed) {
      for (const p of c.ports) {
        if (!p.quickUrl) continue;
        const pk = `${p.hostPort}->${p.containerPort}/${p.proto}`;
        if (seenPort.has(pk)) continue;
        seenPort.add(pk);
        publicPorts.push({ port: p, container: c.name });
      }
    }

    return {
      name: rs.name,
      partOf: rs.partOf,
      workingDir: rs.workingDir,
      items: rs.items,
      managedContainers: managed,
      runningCount: rs.items.filter((i) => i.activeState === 'active').length,
      failedCount: rs.items.filter((i) => i.activeState === 'failed').length,
      totalCpu,
      totalMemBytes,
      publicPorts,
      description: rs.items[0]?.description || '',
      allProtected: rs.items.every((i) => PROTECTED_SYSTEMD.has(i.name)),
    };
  });

  const singles = apps.filter((s) => !assigned.has(s.name));
  return { suites, singles, infra, claimedContainerIds };
}

function parseMemToBytes(memUsage?: string): number {
  if (!memUsage) return 0;
  const used = memUsage.split('/')[0]?.trim() || '';
  const m = used.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  if (!Number.isFinite(val)) return 0;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('g')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('m')) return val * 1024 * 1024;
  if (unit.startsWith('k')) return val * 1024;
  return val;
}

function isSafeDirHint(dir?: string): boolean {
  if (!dir) return false;
  const cleaned = dir.trim().replace(/\/+$/, '');
  if (!cleaned.startsWith('/') || cleaned.includes('..')) return false;
  const forbidden = new Set([
    '/', '/root', '/home', '/opt', '/srv', '/var', '/etc', '/usr',
    '/usr/local', '/usr/local/services', '/tmp', '/data',
  ]);
  if (forbidden.has(cleaned)) return false;
  const parts = cleaned.replace(/^\/+/, '').split('/');
  if (parts.length < 2) return false;
  if (parts[0] === 'home' && parts.length < 3) return false;
  return true;
}

function shortServiceLabel(c: DockerContainer, project: string): string {
  const prefix = `${project}-`;
  let name = c.name;
  if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
    name = name.slice(prefix.length);
  }
  return name.replace(/-\d+$/, '');
}

export const ServicesTab: React.FC<ServicesTabProps> = ({
  snapshot,
  onJumpFolder,
  onRefreshSnapshot,
  onOpenContainerTerminal,
}) => {
  const [loading, setLoading] = useState(true);
  const [dockerAvailable, setDockerAvailable] = useState(snapshot.dockerAvailable);
  const [containers, setContainers] = useState<DockerContainer[]>(snapshot.containersPreview);
  const [systemdServices, setSystemdServices] = useState<SystemdService[]>(snapshot.systemdHighlights);
  const [proxyRoutes, setProxyRoutes] = useState<ProxyRoute[]>([]);
  const [loadingProxies, setLoadingProxies] = useState(false);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [expandedStacks, setExpandedStacks] = useState<Record<string, boolean>>({});
  const [infraExpanded, setInfraExpanded] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const [logsModal, setLogsModal] = useState<{ title: string; content: string; loading: boolean } | null>(null);
  const [composeModal, setComposeModal] = useState<{
    project: string;
    dir: string;
    path: string;
    content: string;
    loading: boolean;
    saving: boolean;
    msg?: string;
  } | null>(null);
  const [streamModal, setStreamModal] = useState<{
    title: string;
    output: string;
    running: boolean;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteVolumes, setDeleteVolumes] = useState(false);
  const [deleteDir, setDeleteDir] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const streamPreRef = useRef<HTMLPreElement | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getServices(snapshot.server.id);
      setDockerAvailable(res.dockerAvailable);
      setContainers(res.containers);
      setSystemdServices(res.systemdServices);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载服务列表失败');
    } finally {
      setLoading(false);
    }
  };

  const loadProxies = async () => {
    setLoadingProxies(true);
    try {
      const res = await api.getProxies(snapshot.server.id);
      setProxyRoutes(res.routes || []);
    } catch {
      // non-fatal
    } finally {
      setLoadingProxies(false);
    }
  };

  useEffect(() => {
    setProxyRoutes([]);
    setExpandedStacks({});
    setInfraExpanded(false);
    load();
    loadProxies();
  }, [snapshot.server.id]);

  const toggleStack = (project: string) => {
    setExpandedStacks((prev) => ({ ...prev, [project]: !prev[project] }));
  };

  const handleOpenComposeEditor = async (project: string, dir: string) => {
    setComposeModal({ project, dir, path: '', content: '', loading: true, saving: false });
    try {
      const res = await api.readComposeFile(snapshot.server.id, dir);
      setComposeModal({
        project,
        dir,
        path: res.path,
        content: res.content,
        loading: false,
        saving: false,
      });
    } catch (err) {
      setComposeModal({
        project,
        dir,
        path: '',
        content: '',
        loading: false,
        saving: false,
        msg: err instanceof Error ? err.message : '读取 compose 文件失败',
      });
    }
  };

  const handleSaveComposeFile = async () => {
    if (!composeModal || !composeModal.path) return;
    setComposeModal((prev) => (prev ? { ...prev, saving: true, msg: undefined } : prev));
    try {
      await api.writeFile(snapshot.server.id, composeModal.path, composeModal.content);
      setComposeModal((prev) =>
        prev ? { ...prev, saving: false, msg: '已保存配置，点击「应用 (up -d)」生效' } : prev
      );
    } catch (err) {
      setComposeModal((prev) =>
        prev ? { ...prev, saving: false, msg: err instanceof Error ? err.message : '保存失败' } : prev
      );
    }
  };

  const handleComposeAction = async (
    project: string,
    dir: string | undefined,
    action: 'pull_up' | 'up' | 'restart' | 'stop' | 'remove',
    opts?: { removeVolumes?: boolean; removeDir?: boolean; skipConfirm?: boolean }
  ) => {
    const label =
      action === 'pull_up'
        ? '拉取最新镜像并重建'
        : action === 'up'
          ? '启动服务'
          : action === 'stop'
            ? '停止服务'
            : action === 'remove'
              ? '删除服务'
              : '重启服务';
    if (!opts?.skipConfirm) {
      if (action === 'pull_up' && !confirm(`确认更新并重建服务「${project}」？`)) return;
      if (action === 'stop' && !confirm(`确认停止服务「${project}」中的全部容器？`)) return;
      if (action === 'restart' && !confirm(`确认重启服务「${project}」？`)) return;
    }

    setStreamModal({
      title: `${project} · ${label}`,
      output: dir ? `$ cd ${dir}\n` : '',
      running: true,
    });
    try {
      const res = await fetch(
        `/api/servers/${encodeURIComponent(snapshot.server.id)}/compose/action`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dir: dir || '',
            project,
            action,
            removeVolumes: Boolean(opts?.removeVolumes),
            removeDir: Boolean(opts?.removeDir),
          }),
        }
      );
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `请求失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        setStreamModal((prev) => (prev ? { ...prev, output: prev.output + text } : prev));
        setTimeout(() => {
          if (streamPreRef.current) {
            streamPreRef.current.scrollTop = streamPreRef.current.scrollHeight;
          }
        }, 0);
      }
      setStreamModal((prev) => (prev ? { ...prev, running: false } : prev));
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setStreamModal((prev) =>
        prev
          ? {
              ...prev,
              running: false,
              output: prev.output + `\n[Error] ${err instanceof Error ? err.message : String(err)}\n`,
            }
          : prev
      );
    }
  };

  const handleDockerAction = async (c: DockerContainer, action: 'start' | 'stop' | 'restart') => {
    setBusyId(`${c.id}-${action}`);
    setError('');
    try {
      await api.dockerAction(snapshot.server.id, c.id, action);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyId(null);
    }
  };

  const openDeleteModal = (target: DeleteTarget) => {
    setDeleteTarget(target);
    setDeleteVolumes(false);
    setDeleteDir(false);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === 'stack') {
      const target = deleteTarget;
      const rmVol = deleteVolumes;
      const rmDir = deleteDir;
      setDeleteTarget(null);
      await handleComposeAction(target.project, target.dir, 'remove', {
        removeVolumes: rmVol,
        removeDir: rmDir,
        skipConfirm: true,
      });
      return;
    }

    setDeleting(true);
    setError('');
    try {
      await api.dockerRemove(snapshot.server.id, deleteTarget.container.id, deleteVolumes);
      setDeleteTarget(null);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除容器失败');
    } finally {
      setDeleting(false);
    }
  };

  const handleOpenDockerLogs = async (c: DockerContainer) => {
    setLogsModal({ title: `容器日志 · ${c.name}`, content: '', loading: true });
    try {
      const res = await api.dockerLogs(snapshot.server.id, c.id, 220);
      setLogsModal({ title: `容器日志 · ${c.name}`, content: res.logs || '(无日志输出)', loading: false });
    } catch (err) {
      setLogsModal({
        title: `容器日志 · ${c.name}`,
        content: err instanceof Error ? err.message : '获取日志失败',
        loading: false,
      });
    }
  };

  const handleOpenSystemdLogs = async (svc: SystemdService) => {
    setLogsModal({ title: `Systemd 日志 · ${svc.name}`, content: '', loading: true });
    try {
      const res = await api.systemdLogs(snapshot.server.id, svc.name, 140);
      setLogsModal({ title: `Systemd 日志 · ${svc.name}`, content: res.logs || '(无日志输出)', loading: false });
    } catch (err) {
      setLogsModal({
        title: `Systemd 日志 · ${svc.name}`,
        content: err instanceof Error ? err.message : '获取日志失败',
        loading: false,
      });
    }
  };

  const handleSystemdAction = async (svc: SystemdService, action: 'start' | 'stop' | 'restart') => {
    if (action === 'stop' && PROTECTED_SYSTEMD.has(svc.name)) return;
    const actionLabel = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
    if (action !== 'start' && !confirm(`确认${actionLabel}服务 ${svc.name}？`)) return;
    setBusyId(`svc-${svc.name}-${action}`);
    setError('');
    try {
      await api.systemdAction(snapshot.server.id, svc.name, action);
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${actionLabel}失败`);
    } finally {
      setBusyId(null);
    }
  };

  const handleHostSuiteAction = async (suite: HostSuiteGroup, action: 'start' | 'stop' | 'restart') => {
    const targets = suite.items.filter((s) => !(action === 'stop' && PROTECTED_SYSTEMD.has(s.name)));
    if (targets.length === 0) return;
    const actionLabel = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
    if (action !== 'start' && !confirm(`确认${actionLabel}服务套件「${suite.name}」（共 ${targets.length} 个子服务）？`)) {
      return;
    }
    setBusyId(`suite-${suite.name}-${action}`);
    setError('');
    try {
      for (const s of targets) {
        await api.systemdAction(snapshot.server.id, s.name, action);
      }
      await load();
      onRefreshSnapshot();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${actionLabel}套件失败`);
    } finally {
      setBusyId(null);
    }
  };

  // Group host apps & determine which Docker containers are managed by a Host Suite
  const { hostSuites, hostSingles, infraSystemd, claimedContainerIds } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const { suites, singles, infra, claimedContainerIds: claimed } = groupHostServices(systemdServices, containers);

    const filteredSuites = suites
      .filter((st) => {
        if (
          q &&
          !st.name.toLowerCase().includes(q) &&
          !st.description.toLowerCase().includes(q) &&
          !(st.workingDir || '').toLowerCase().includes(q) &&
          !st.items.some((i) => i.name.toLowerCase().includes(q)) &&
          !st.managedContainers.some((c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q))
        ) {
          return false;
        }
        if (statusFilter === 'running' && st.runningCount === 0) return false;
        if (statusFilter === 'stopped' && st.runningCount > 0) return false;
        return true;
      })
      .sort((a, b) => {
        const aRun = a.runningCount > 0 ? 1 : 0;
        const bRun = b.runningCount > 0 ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        return b.items.length + b.managedContainers.length - (a.items.length + a.managedContainers.length);
      });

    const filteredSingles = singles
      .filter((s) => {
        if (q && !s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) {
          return false;
        }
        if (statusFilter === 'running' && s.activeState !== 'active') return false;
        if (statusFilter === 'stopped' && s.activeState === 'active') return false;
        return true;
      })
      .sort((a, b) => {
        const aRun = a.activeState === 'active' ? 1 : 0;
        const bRun = b.activeState === 'active' ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        return a.name.localeCompare(b.name);
      });

    const filteredInfra = infra.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !(s.description || '').toLowerCase().includes(q)) {
        return false;
      }
      if (statusFilter === 'running' && s.activeState !== 'active') return false;
      if (statusFilter === 'stopped' && s.activeState === 'active') return false;
      return true;
    });

    return {
      hostSuites: filteredSuites,
      hostSingles: filteredSingles,
      infraSystemd: filteredInfra,
      claimedContainerIds: claimed,
    };
  }, [systemdServices, containers, query, statusFilter]);

  // Partition remaining Docker containers (not owned by a Host Suite) into Compose Stacks + Standalone Services
  const { stacks, standalones } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const stackMap = new Map<string, DockerContainer[]>();
    const standaloneList: DockerContainer[] = [];

    for (const c of containers) {
      if (claimedContainerIds.has(c.id)) continue;
      if (c.composeProject) {
        if (!stackMap.has(c.composeProject)) stackMap.set(c.composeProject, []);
        stackMap.get(c.composeProject)!.push(c);
      } else {
        standaloneList.push(c);
      }
    }

    const builtStacks: ComposeStackGroup[] = [];
    for (const [project, items] of stackMap.entries()) {
      const matchesQuery =
        !q ||
        project.toLowerCase().includes(q) ||
        items.some(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.image.toLowerCase().includes(q) ||
            (c.composeDir || '').toLowerCase().includes(q)
        );
      if (!matchesQuery) continue;

      const runningCount = items.filter((c) => c.state === 'running').length;
      if (statusFilter === 'running' && runningCount === 0) continue;
      if (statusFilter === 'stopped' && runningCount > 0) continue;

      const unhealthyCount = items.filter((c) => c.health === 'unhealthy').length;
      const totalCpu = items.reduce((acc, c) => acc + (c.state === 'running' ? c.cpuPercent || 0 : 0), 0);
      const totalMemBytes = items.reduce((acc, c) => acc + (c.state === 'running' ? parseMemToBytes(c.memUsage) : 0), 0);

      const seenPort = new Set<string>();
      const publicPorts: { port: DockerPort; container: string }[] = [];
      const internalPorts: { port: DockerPort; container: string }[] = [];
      for (const c of items) {
        for (const p of c.ports) {
          const pk = `${p.hostIp}:${p.hostPort}->${p.containerPort}/${p.proto}`;
          if (seenPort.has(pk)) continue;
          seenPort.add(pk);
          if (p.quickUrl) {
            publicPorts.push({ port: p, container: shortServiceLabel(c, project) });
          } else {
            internalPorts.push({ port: p, container: shortServiceLabel(c, project) });
          }
        }
      }

      const stoppedItems = items.filter((c) => c.state !== 'running');
      const hasOnlyCleanExited =
        stoppedItems.length > 0 && stoppedItems.every((c) => /Exited\s*\(0\)/i.test(c.status));

      builtStacks.push({
        project,
        dir: items.find((i) => i.composeDir)?.composeDir,
        items,
        runningCount,
        unhealthyCount,
        totalCpu,
        totalMemBytes,
        publicPorts,
        internalPorts,
        hasOnlyCleanExited,
      });
    }

    builtStacks.sort((a, b) => {
      // Running stacks first, then by container count
      const aRun = a.runningCount > 0 ? 1 : 0;
      const bRun = b.runningCount > 0 ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return b.items.length - a.items.length;
    });

    const filteredStandalones = standaloneList
      .filter((c) => {
        if (q && !c.name.toLowerCase().includes(q) && !c.image.toLowerCase().includes(q)) return false;
        if (statusFilter === 'running' && c.state !== 'running') return false;
        if (statusFilter === 'stopped' && c.state === 'running') return false;
        return true;
      })
      .sort((a, b) => {
        const aRun = a.state === 'running' ? 1 : 0;
        const bRun = b.state === 'running' ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        return a.name.localeCompare(b.name);
      });

    return { stacks: builtStacks, standalones: filteredStandalones };
  }, [containers, claimedContainerIds, query, statusFilter]);

  const allQuickLinks = useMemo(
    () => [...snapshot.server.quickLinks, ...snapshot.detectedLinks],
    [snapshot.server.quickLinks, snapshot.detectedLinks]
  );

  const findMatchedLinks = (serviceName: string) => {
    const key = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key.length < 3) return [];
    return allQuickLinks.filter((l) => {
      const hay = `${l.id} ${l.name} ${l.description || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
      return hay.includes(key);
    });
  };

  const showInfraList = infraExpanded || query.trim().length > 0;
  const totalRunningServices =
    stacks.filter((s) => s.runningCount > 0).length +
    hostSuites.filter((s) => s.runningCount > 0).length +
    standalones.filter((c) => c.state === 'running').length +
    hostSingles.filter((s) => s.activeState === 'active').length;
  const totalServices = stacks.length + hostSuites.length + standalones.length + hostSingles.length;

  return (
    <div className="space-y-5">
      {/* Reverse Proxy Domains & TLS Certificate Topology (shown only when routes exist) */}
      {proxyRoutes.length > 0 && (
        <section className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-emerald-300 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              <span>反代域名与证书拓扑 ({proxyRoutes.length})</span>
            </div>
            <button
              onClick={loadProxies}
              disabled={loadingProxies}
              className="text-[11px] text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${loadingProxies ? 'animate-spin text-sky-400' : ''}`} />
              <span>刷新域名与证书</span>
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {proxyRoutes.map((route, idx) => {
              const days = route.tlsDaysLeft;
              const certColor =
                days === null || days === undefined
                  ? 'text-slate-500 bg-white/[0.04] border-white/[0.07]'
                  : days <= 7
                    ? 'text-rose-300 bg-rose-500/15 border-rose-500/30'
                    : days <= 20
                      ? 'text-amber-300 bg-amber-500/15 border-amber-500/30'
                      : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25';
              return (
                <div
                  key={`${route.engine}-${route.domain}-${idx}`}
                  className="bg-[#0f131b] border border-white/[0.07] hover:border-emerald-400/35 rounded-xl p-3.5 transition-all space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-400/25 text-sky-300">
                          {route.engine}
                        </span>
                        {route.url ? (
                          <a
                            href={route.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-semibold text-white hover:text-sky-300 truncate inline-flex items-center gap-1"
                          >
                            <span className="truncate">{route.domain}</span>
                            <ExternalLink className="w-3 h-3 shrink-0 text-slate-400" />
                          </a>
                        ) : (
                          <span className="text-xs font-semibold text-white truncate">{route.domain}</span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 truncate mt-1">
                        → {route.upstream}
                      </div>
                    </div>
                    {days !== null && days !== undefined && (
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded-md border shrink-0 inline-flex items-center gap-1 ${certColor}`}
                        title={route.tlsIssuer || 'TLS 证书剩余有效期'}
                      >
                        <ShieldCheck className="w-3 h-3" />
                        {days}天
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Search, Filter & Refresh Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[220px]">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索项目、容器、镜像或系统服务..."
              className="w-full bg-[#0f131b] border border-white/[0.08] focus:border-sky-400/50 focus:outline-none rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder:text-slate-500"
            />
          </div>

          <div className="inline-flex items-center bg-[#0f131b] border border-white/[0.08] rounded-xl p-0.5 text-[11px]">
            {(
              [
                ['all', '全部'],
                ['running', '运行中'],
                ['stopped', '已停止'],
              ] as const
            ).map(([k, lbl]) => (
              <button
                key={k}
                onClick={() => setStatusFilter(k)}
                className={`px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer ${
                  statusFilter === k ? 'bg-sky-500/20 text-sky-300 font-semibold' : 'text-slate-400 hover:text-white'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-200 px-3 py-2 rounded-xl cursor-pointer shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
          <span>刷新状态</span>
        </button>
      </div>

      {error && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* Primary View: All Deployed Services (Docker Stacks + Host App Suites + Single Services) */}
      <div className="space-y-5">
        {/* Section 1: Multi-Component Services (Compose Stacks + Host App Suites, Collapsed by Default) */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-sky-400" />
              <span>部署服务 ({totalRunningServices}/{totalServices} 运行中)</span>
            </h2>
            <span className="text-[11px] font-mono text-slate-500">
              {stacks.length + hostSuites.length} 个多组件项目 · {standalones.length + hostSingles.length} 个单体服务
            </span>
          </div>

          {totalServices === 0 ? (
            <div className="bg-[#0f131b] border border-white/[0.06] rounded-2xl p-8 text-center text-xs text-slate-500">
              {loading ? '正在读取部署服务与资源统计...' : '没有匹配的服务'}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Docker Compose Project Stacks */}
              {dockerAvailable &&
                stacks.map((stack) => {
                  const isRunning = stack.runningCount > 0;
                  const isAllRunning = stack.runningCount === stack.items.length;
                  const isExpanded = Boolean(expandedStacks[stack.project]) || (query.trim().length > 0 && !stack.project.toLowerCase().includes(query.trim().toLowerCase()));
                  const statusTone =
                    stack.unhealthyCount > 0
                      ? { dot: 'bg-rose-500', pill: 'bg-rose-500/15 border-rose-500/30 text-rose-300', label: `异常 (${stack.unhealthyCount})` }
                      : isAllRunning
                        ? { dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]', pill: 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300', label: `运行中 · ${stack.runningCount}/${stack.items.length}` }
                        : isRunning
                          ? {
                              dot: stack.hasOnlyCleanExited ? 'bg-emerald-400' : 'bg-amber-400',
                              pill: stack.hasOnlyCleanExited
                                ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300'
                                : 'bg-amber-500/12 border-amber-400/25 text-amber-300',
                              label: `运行中 · ${stack.runningCount}/${stack.items.length}`,
                            }
                          : { dot: 'bg-slate-600', pill: 'bg-white/[0.04] border-white/[0.08] text-slate-400', label: '已停止' };

                  return (
                    <div
                      key={stack.project}
                      className={`bg-[#0f131b] border rounded-2xl overflow-hidden transition-colors ${
                        isExpanded ? 'border-sky-400/30' : 'border-white/[0.07] hover:border-white/[0.14]'
                      }`}
                    >
                      {/* Main Service Card (Always Visible) */}
                      <div className="p-4 sm:p-5 space-y-3">
                        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                          {/* Left: Identity + Status + Aggregated Metrics */}
                          <div className="min-w-0 flex-1 space-y-2">
                            <div className="flex items-center gap-2.5 flex-wrap">
                              <button
                                onClick={() => toggleStack(stack.project)}
                                className="flex items-center gap-2 text-left group cursor-pointer min-w-0"
                                title={isExpanded ? '收起子容器' : '展开查看子容器'}
                              >
                                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusTone.dot}`} />
                                <span className="text-sm sm:text-base font-semibold text-white group-hover:text-sky-300 transition-colors truncate">
                                  {stack.project}
                                </span>
                              </button>
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 border border-sky-400/20 text-sky-300 shrink-0">
                                Compose
                              </span>
                              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border shrink-0 ${statusTone.pill}`}>
                                {statusTone.label}
                              </span>

                              {/* Aggregated Live CPU & Memory */}
                              {isRunning && (
                                <div className="flex items-center gap-2.5 text-[11px] font-mono text-slate-300 bg-[#090b10] border border-white/[0.06] rounded-lg px-2.5 py-0.5">
                                  <span className="inline-flex items-center gap-1">
                                    <Cpu className="w-3 h-3 text-sky-400" />
                                    {stack.totalCpu.toFixed(1)}%
                                  </span>
                                  <span className="text-slate-700">·</span>
                                  <span className="inline-flex items-center gap-1">
                                    <MemoryStick className="w-3 h-3 text-indigo-400" />
                                    {stack.totalMemBytes > 0 ? formatBytes(stack.totalMemBytes, 1) : '—'}
                                  </span>
                                </div>
                              )}
                            </div>

                            {/* Ports / Quick Access URLs + Composition + Directory */}
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              {stack.publicPorts.map(({ port, container }, idx) => (
                                <a
                                  key={`pub-${idx}`}
                                  href={port.quickUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 font-mono bg-sky-500/12 hover:bg-sky-500/22 border border-sky-400/25 text-sky-300 px-2 py-0.5 rounded-md transition-colors"
                                >
                                  <span>:{port.hostPort}</span>
                                  <span className="text-sky-400/70 text-[10px]">{container}</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ))}
                              {stack.internalPorts.slice(0, 4).map(({ port, container }, idx) => (
                                <span
                                  key={`int-${idx}`}
                                  className="inline-flex items-center gap-1 font-mono bg-white/[0.03] border border-white/[0.06] text-slate-400 px-2 py-0.5 rounded-md"
                                >
                                  <span>{port.hostIp === '127.0.0.1' ? '本机' : port.hostIp}:{port.hostPort}</span>
                                  <span className="text-slate-500 text-[10px]">{container}</span>
                                </span>
                              ))}
                              {stack.dir && (
                                <button
                                  onClick={() => onJumpFolder(stack.dir!)}
                                  title={`打开项目目录 ${stack.dir}`}
                                  className="inline-flex items-center gap-1 font-mono text-slate-400 hover:text-sky-300 bg-[#090b10] border border-white/[0.06] hover:border-sky-400/30 px-2 py-0.5 rounded-md cursor-pointer max-w-full"
                                >
                                  <FolderOpen className="w-3 h-3 text-amber-400/80 shrink-0" />
                                  <span className="truncate max-w-[220px]">{stack.dir}</span>
                                </button>
                              )}
                            </div>

                            {/* Compact Component Preview & Expand Trigger */}
                            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                              <button
                                onClick={() => toggleStack(stack.project)}
                                className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-sky-300 transition-colors cursor-pointer"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-sky-400" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5" />
                                )}
                                <span>
                                  {isExpanded ? '收起子容器' : `展开 ${stack.items.length} 个子容器`}
                                </span>
                              </button>
                              {!isExpanded && (
                                <div className="flex flex-wrap items-center gap-1 text-[10px] font-mono text-slate-500">
                                  {stack.items.slice(0, 6).map((c) => (
                                    <span
                                      key={c.id}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-white/[0.03] text-slate-400"
                                    >
                                      <span
                                        className={`w-1.5 h-1.5 rounded-full ${
                                          c.health === 'unhealthy'
                                            ? 'bg-rose-500'
                                            : c.state === 'running'
                                              ? 'bg-emerald-400/80'
                                              : 'bg-slate-600'
                                        }`}
                                      />
                                      {shortServiceLabel(c, stack.project)}
                                    </span>
                                  ))}
                                  {stack.items.length > 6 && <span>+{stack.items.length - 6}</span>}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Right: Project-Level Primary Action Controls */}
                          <div className="flex items-center gap-1.5 flex-wrap lg:justify-end shrink-0">
                            {isRunning ? (
                              <>
                                <button
                                  onClick={() => handleComposeAction(stack.project, stack.dir, 'restart')}
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-sky-500/20 border border-white/[0.08] text-slate-200 hover:text-sky-300 transition-colors cursor-pointer"
                                >
                                  <RotateCw className="w-3.5 h-3.5" />
                                  <span>重启</span>
                                </button>
                                <button
                                  onClick={() => handleComposeAction(stack.project, stack.dir, 'stop')}
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-rose-500/18 border border-white/[0.08] hover:border-rose-500/30 text-slate-200 hover:text-rose-300 transition-colors cursor-pointer"
                                >
                                  <Square className="w-3.5 h-3.5" />
                                  <span>停止</span>
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => handleComposeAction(stack.project, stack.dir, 'up')}
                                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-xl bg-emerald-500/18 hover:bg-emerald-500/28 border border-emerald-500/35 text-emerald-300 font-semibold transition-colors cursor-pointer"
                              >
                                <Play className="w-3.5 h-3.5" />
                                <span>启动</span>
                              </button>
                            )}

                            {stack.dir && (
                              <>
                                <button
                                  onClick={() => handleComposeAction(stack.project, stack.dir, 'pull_up')}
                                  title="拉取最新镜像并重建"
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/25 text-sky-300 transition-colors cursor-pointer"
                                >
                                  <ArrowDownToLine className="w-3.5 h-3.5" />
                                  <span>更新</span>
                                </button>
                                <button
                                  onClick={() => handleOpenComposeEditor(stack.project, stack.dir!)}
                                  title="查看 / 编辑 compose.yml"
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] text-slate-300 hover:text-white transition-colors cursor-pointer"
                                >
                                  <FileCode2 className="w-3.5 h-3.5 text-slate-400" />
                                  <span>配置</span>
                                </button>
                              </>
                            )}

                            <button
                              onClick={() =>
                                openDeleteModal({
                                  kind: 'stack',
                                  project: stack.project,
                                  dir: stack.dir,
                                  containers: stack.items,
                                })
                              }
                              title="删除整个服务栈"
                              className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.03] hover:bg-rose-500/18 border border-white/[0.08] hover:border-rose-500/35 text-slate-400 hover:text-rose-300 transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>删除</span>
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Collapsible Sub-Containers Drawer */}
                      {isExpanded && (
                        <div className="border-t border-white/[0.06] bg-[#0a0d14] divide-y divide-white/[0.04]">
                          {stack.items.map((c) => {
                            const cRunning = c.state === 'running';
                            return (
                              <div
                                key={c.id}
                                className="px-4 sm:px-5 py-2.5 flex flex-col lg:flex-row lg:items-center justify-between gap-2.5 hover:bg-white/[0.015]"
                              >
                                <div className="min-w-0 flex-1 space-y-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span
                                      className={`w-2 h-2 rounded-full shrink-0 ${
                                        c.health === 'unhealthy'
                                          ? 'bg-rose-500'
                                          : cRunning
                                            ? 'bg-emerald-400'
                                            : 'bg-slate-600'
                                      }`}
                                    />
                                    <span className="text-xs font-semibold text-slate-100 font-mono">
                                      {c.name}
                                    </span>
                                    <span className="text-[11px] text-slate-500 truncate max-w-full sm:max-w-sm font-mono">
                                      {c.image}
                                    </span>
                                    {c.health && (
                                      <span
                                        className={`text-[10px] font-mono px-1.5 py-0.2 rounded border ${
                                          c.health === 'healthy'
                                            ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
                                            : 'bg-rose-500/10 border-rose-500/25 text-rose-300'
                                        }`}
                                      >
                                        {c.health}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2 pl-4 text-[11px] text-slate-400">
                                    <span>{c.status}</span>
                                    {cRunning && (c.cpuPercent !== undefined || c.memUsage) && (
                                      <span className="font-mono text-[10px] text-slate-500">
                                        CPU {(c.cpuPercent ?? 0).toFixed(1)}% · {c.memUsage?.split('/')[0]?.trim() || '—'}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <div className="flex items-center gap-1.5 flex-wrap pl-4 lg:pl-0 shrink-0">
                                  {cRunning ? (
                                    <>
                                      <button
                                        onClick={() => handleDockerAction(c, 'restart')}
                                        disabled={busyId !== null}
                                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-sky-500/20 border border-white/[0.07] text-slate-300 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                                      >
                                        <RotateCw className={`w-3 h-3 ${busyId === `${c.id}-restart` ? 'animate-spin' : ''}`} />
                                        <span>重启</span>
                                      </button>
                                      <button
                                        onClick={() => handleDockerAction(c, 'stop')}
                                        disabled={busyId !== null}
                                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 border border-white/[0.07] text-slate-300 hover:text-rose-300 cursor-pointer disabled:opacity-40"
                                      >
                                        {busyId === `${c.id}-stop` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                                        <span>停止</span>
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      onClick={() => handleDockerAction(c, 'start')}
                                      disabled={busyId !== null}
                                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 cursor-pointer disabled:opacity-40"
                                    >
                                      {busyId === `${c.id}-start` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                                      <span>启动</span>
                                    </button>
                                  )}
                                  <button
                                    onClick={() => handleOpenDockerLogs(c)}
                                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-slate-300 hover:text-white cursor-pointer"
                                  >
                                    <FileText className="w-3 h-3" />
                                    <span>日志</span>
                                  </button>
                                  {cRunning && onOpenContainerTerminal && (
                                    <button
                                      onClick={() => onOpenContainerTerminal(c.name)}
                                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-emerald-500/20 border border-white/[0.07] text-slate-300 hover:text-emerald-300 cursor-pointer"
                                    >
                                      <Terminal className="w-3 h-3" />
                                      <span>终端</span>
                                    </button>
                                  )}
                                  <button
                                    onClick={() => openDeleteModal({ kind: 'container', container: c })}
                                    title="删除此子容器"
                                    className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-rose-500/18 border border-white/[0.07] text-slate-500 hover:text-rose-300 cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

              {/* Host App Suites (e.g. 1panel, cube-sandbox — grouped Systemd suites, collapsed by default) */}
              {hostSuites.map((suite) => {
                const suiteKey = `host:${suite.name}`;
                const isRunning = suite.runningCount > 0;
                const isExpanded =
                  Boolean(expandedStacks[suiteKey]) ||
                  (query.trim().length > 0 && !suite.name.toLowerCase().includes(query.trim().toLowerCase()));
                const matchedLinks = findMatchedLinks(suite.name);
                const statusTone =
                  suite.failedCount > 0
                    ? { dot: 'bg-rose-500', pill: 'bg-rose-500/15 border-rose-500/30 text-rose-300', label: `异常 (${suite.failedCount})` }
                    : isRunning
                      ? {
                          dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]',
                          pill: 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300',
                          label: `运行中 · ${suite.runningCount}/${suite.items.length}`,
                        }
                      : { dot: 'bg-slate-600', pill: 'bg-white/[0.04] border-white/[0.08] text-slate-400', label: '已停止' };

                return (
                  <div
                    key={suiteKey}
                    className={`bg-[#0f131b] border rounded-2xl overflow-hidden transition-colors ${
                      isExpanded ? 'border-indigo-400/35' : 'border-white/[0.07] hover:border-white/[0.14]'
                    }`}
                  >
                    <div className="p-4 sm:p-5 space-y-3">
                      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <button
                              onClick={() => toggleStack(suiteKey)}
                              className="flex items-center gap-2 text-left group cursor-pointer min-w-0"
                            >
                              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusTone.dot}`} />
                              <span className="text-sm sm:text-base font-semibold text-white group-hover:text-indigo-300 transition-colors truncate">
                                {suite.name}
                              </span>
                            </button>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/12 border border-indigo-400/25 text-indigo-300 shrink-0">
                              {suite.managedContainers.length > 0 ? '本机 + 容器套件' : '本机套件'}
                            </span>
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border shrink-0 ${statusTone.pill}`}>
                              {statusTone.label}
                            </span>
                            {suite.managedContainers.length > 0 && isRunning && (
                              <div className="flex items-center gap-2.5 text-[11px] font-mono text-slate-300 bg-[#090b10] border border-white/[0.06] rounded-lg px-2.5 py-0.5">
                                <span className="inline-flex items-center gap-1">
                                  <Cpu className="w-3 h-3 text-sky-400" />
                                  {suite.totalCpu.toFixed(1)}%
                                </span>
                                <span className="text-slate-700">·</span>
                                <span className="inline-flex items-center gap-1">
                                  <MemoryStick className="w-3 h-3 text-indigo-400" />
                                  {suite.totalMemBytes > 0 ? formatBytes(suite.totalMemBytes, 1) : '—'}
                                </span>
                              </div>
                            )}
                          </div>

                          {(matchedLinks.length > 0 || suite.publicPorts.length > 0 || suite.workingDir || suite.description) && (
                            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                              {matchedLinks.map((lk) => (
                                <a
                                  key={lk.id}
                                  href={lk.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 font-mono bg-sky-500/12 hover:bg-sky-500/22 border border-sky-400/25 text-sky-300 px-2 py-0.5 rounded-md transition-colors"
                                >
                                  <span>{lk.name}</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ))}
                              {suite.publicPorts.map(({ port, container }, idx) => (
                                <a
                                  key={`spub-${idx}`}
                                  href={port.quickUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 font-mono bg-sky-500/12 hover:bg-sky-500/22 border border-sky-400/25 text-sky-300 px-2 py-0.5 rounded-md transition-colors"
                                >
                                  <span>:{port.hostPort}</span>
                                  <span className="text-sky-400/70 text-[10px]">{container}</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </a>
                              ))}
                              {suite.workingDir && (
                                <button
                                  onClick={() => onJumpFolder(suite.workingDir!)}
                                  title={`打开项目目录 ${suite.workingDir}`}
                                  className="inline-flex items-center gap-1 font-mono text-slate-400 hover:text-sky-300 bg-[#090b10] border border-white/[0.06] hover:border-sky-400/30 px-2 py-0.5 rounded-md cursor-pointer max-w-full"
                                >
                                  <FolderOpen className="w-3 h-3 text-amber-400/80 shrink-0" />
                                  <span className="truncate max-w-[240px]">{suite.workingDir}</span>
                                </button>
                              )}
                              {suite.description && suite.publicPorts.length === 0 && !suite.workingDir && (
                                <span className="text-slate-400 truncate max-w-xl">{suite.description}</span>
                              )}
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            <button
                              onClick={() => toggleStack(suiteKey)}
                              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-indigo-300 transition-colors cursor-pointer"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5 text-indigo-400" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                              <span>
                                {isExpanded
                                  ? '收起明细'
                                  : suite.managedContainers.length > 0
                                    ? `展开 ${suite.items.length} 个服务 · ${suite.managedContainers.length} 个托管容器`
                                    : `展开 ${suite.items.length} 个子服务`}
                              </span>
                            </button>
                            {!isExpanded && (
                              <div className="flex flex-wrap items-center gap-1 text-[10px] font-mono text-slate-500">
                                {suite.items.slice(0, 6).map((s) => (
                                  <span
                                    key={s.name}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-white/[0.03] text-slate-400"
                                  >
                                    <span
                                      className={`w-1.5 h-1.5 rounded-full ${
                                        s.activeState === 'active'
                                          ? 'bg-emerald-400/80'
                                          : s.activeState === 'failed'
                                            ? 'bg-rose-500'
                                            : 'bg-slate-600'
                                      }`}
                                    />
                                    {s.name.replace(new RegExp(`^${suite.name}-`), '')}
                                  </span>
                                ))}
                                {suite.items.length > 6 && <span>+{suite.items.length - 6}</span>}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap lg:justify-end shrink-0">
                          {isRunning ? (
                            <>
                              <button
                                onClick={() => handleHostSuiteAction(suite, 'restart')}
                                disabled={busyId !== null}
                                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-sky-500/20 border border-white/[0.08] text-slate-200 hover:text-sky-300 transition-colors cursor-pointer disabled:opacity-40"
                              >
                                <RotateCw className={`w-3.5 h-3.5 ${busyId === `suite-${suite.name}-restart` ? 'animate-spin' : ''}`} />
                                <span>重启</span>
                              </button>
                              {!suite.allProtected && (
                                <button
                                  onClick={() => handleHostSuiteAction(suite, 'stop')}
                                  disabled={busyId !== null}
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-rose-500/18 border border-white/[0.08] hover:border-rose-500/30 text-slate-200 hover:text-rose-300 transition-colors cursor-pointer disabled:opacity-40"
                                >
                                  {busyId === `suite-${suite.name}-stop` ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Square className="w-3.5 h-3.5" />
                                  )}
                                  <span>停止</span>
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              onClick={() => handleHostSuiteAction(suite, 'start')}
                              disabled={busyId !== null}
                              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-xl bg-emerald-500/18 hover:bg-emerald-500/28 border border-emerald-500/35 text-emerald-300 font-semibold transition-colors cursor-pointer disabled:opacity-40"
                            >
                              {busyId === `suite-${suite.name}-start` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Play className="w-3.5 h-3.5" />
                              )}
                              <span>启动</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="border-t border-white/[0.06] bg-[#0a0d14] divide-y divide-white/[0.04]">
                        {suite.managedContainers.length > 0 && (
                          <>
                            <div className="px-4 sm:px-5 py-2 bg-white/[0.015] flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-400">
                              <span className="font-semibold uppercase tracking-wider text-sky-300">
                                托管的 Docker 容器 ({suite.managedContainers.filter((c) => c.state === 'running').length}/{suite.managedContainers.length})
                              </span>
                              <span className="text-slate-500">
                                由上方 Systemd 套件托管，整体启停请使用套件按钮
                              </span>
                            </div>
                            {suite.managedContainers.map((c) => {
                              const cRunning = c.state === 'running';
                              return (
                                <div
                                  key={`mc-${c.id}`}
                                  className="px-4 sm:px-5 py-2.5 flex flex-col lg:flex-row lg:items-center justify-between gap-2 hover:bg-white/[0.015]"
                                >
                                  <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span
                                        className={`w-2 h-2 rounded-full shrink-0 ${
                                          c.health === 'unhealthy'
                                            ? 'bg-rose-500'
                                            : cRunning
                                              ? 'bg-emerald-400'
                                              : 'bg-slate-600'
                                        }`}
                                      />
                                      <span className="text-xs font-semibold text-slate-100 font-mono">
                                        {c.name}
                                      </span>
                                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sky-500/10 border border-sky-400/20 text-sky-300">
                                        容器
                                      </span>
                                      <span className="text-[11px] text-slate-500 truncate max-w-full sm:max-w-sm font-mono">
                                        {c.image}
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2 pl-4 text-[11px] text-slate-400">
                                      <span>{c.status}</span>
                                      {cRunning && (c.cpuPercent !== undefined || c.memUsage) && (
                                        <span className="font-mono text-[10px] text-slate-500">
                                          CPU {(c.cpuPercent ?? 0).toFixed(1)}% · {c.memUsage?.split('/')[0]?.trim() || '—'}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5 pl-4 lg:pl-0 shrink-0 flex-wrap">
                                    <button
                                      onClick={() => handleOpenDockerLogs(c)}
                                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-slate-300 hover:text-white cursor-pointer"
                                    >
                                      <FileText className="w-3 h-3" />
                                      <span>日志</span>
                                    </button>
                                    {cRunning && onOpenContainerTerminal && (
                                      <button
                                        onClick={() => onOpenContainerTerminal(c.name)}
                                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-emerald-500/20 border border-white/[0.07] text-slate-300 hover:text-emerald-300 cursor-pointer"
                                      >
                                        <Terminal className="w-3 h-3" />
                                        <span>终端</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                            <div className="px-4 sm:px-5 py-2 bg-white/[0.015] text-[10px] font-mono font-semibold uppercase tracking-wider text-indigo-300">
                              Systemd 托管单元 ({suite.runningCount}/{suite.items.length})
                              {suite.partOf && <span className="ml-2 text-slate-500 font-normal">PartOf={suite.partOf}</span>}
                            </div>
                          </>
                        )}
                        {suite.items.map((svc) => {
                          const isActive = svc.activeState === 'active';
                          const isFailed = svc.activeState === 'failed';
                          const isProtected = PROTECTED_SYSTEMD.has(svc.name);
                          return (
                            <div
                              key={svc.name}
                              className="px-4 sm:px-5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-white/[0.015]"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span
                                    className={`w-2 h-2 rounded-full shrink-0 ${
                                      isActive ? 'bg-emerald-400' : isFailed ? 'bg-rose-500' : 'bg-slate-600'
                                    }`}
                                  />
                                  <span className="text-xs font-semibold font-mono text-slate-100 truncate">
                                    {svc.name}
                                  </span>
                                  <span className="text-[10px] font-mono text-slate-500">
                                    {svc.subState || svc.activeState}
                                  </span>
                                </div>
                                <div className="text-[11px] text-slate-500 truncate pl-4 mt-0.5">
                                  {svc.description}
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 pl-4 sm:pl-0 shrink-0 flex-wrap">
                                {isActive ? (
                                  <>
                                    <button
                                      onClick={() => handleSystemdAction(svc, 'restart')}
                                      disabled={busyId !== null}
                                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-sky-500/20 border border-white/[0.07] text-slate-300 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                                    >
                                      <RotateCw className={`w-3 h-3 ${busyId === `svc-${svc.name}-restart` ? 'animate-spin' : ''}`} />
                                      <span>重启</span>
                                    </button>
                                    {!isProtected && (
                                      <button
                                        onClick={() => handleSystemdAction(svc, 'stop')}
                                        disabled={busyId !== null}
                                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 border border-white/[0.07] text-slate-300 hover:text-rose-300 cursor-pointer disabled:opacity-40"
                                      >
                                        {busyId === `svc-${svc.name}-stop` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                                        <span>停止</span>
                                      </button>
                                    )}
                                  </>
                                ) : (
                                  <button
                                    onClick={() => handleSystemdAction(svc, 'start')}
                                    disabled={busyId !== null}
                                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 cursor-pointer disabled:opacity-40"
                                  >
                                    {busyId === `svc-${svc.name}-start` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                                    <span>启动</span>
                                  </button>
                                )}
                                <button
                                  onClick={() => handleOpenSystemdLogs(svc)}
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-slate-300 hover:text-white cursor-pointer"
                                >
                                  <FileText className="w-3 h-3" />
                                  <span>日志</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Section 2: Standalone Services (Single Docker Containers + Single Host Apps) */}
        {(standalones.length > 0 || hostSingles.length > 0) && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Box className="w-3.5 h-3.5 text-sky-400" />
                <span>
                  单体服务 (
                  {standalones.filter((c) => c.state === 'running').length +
                    hostSingles.filter((s) => s.activeState === 'active').length}
                  /{standalones.length + hostSingles.length} 运行)
                </span>
              </h3>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {dockerAvailable &&
                standalones.map((c) => {
                  const isRunning = c.state === 'running';
                  return (
                    <div
                      key={c.id}
                      className="bg-[#0f131b] border border-white/[0.07] hover:border-white/[0.14] rounded-2xl p-4 space-y-3 transition-colors flex flex-col justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  c.health === 'unhealthy'
                                    ? 'bg-rose-500'
                                    : isRunning
                                      ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.45)]'
                                      : 'bg-slate-600'
                                }`}
                              />
                              <span className="text-sm font-semibold text-white font-mono truncate">
                                {c.name}
                              </span>
                              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sky-500/10 border border-sky-400/20 text-sky-300">
                                Docker
                              </span>
                              <span
                                className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full border ${
                                  isRunning
                                    ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300'
                                    : 'bg-white/[0.04] border-white/[0.08] text-slate-400'
                                }`}
                              >
                                {isRunning ? '运行中' : '已停止'}
                              </span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-500 truncate mt-1 pl-4">
                              {c.image}
                            </div>
                          </div>

                          {isRunning && (c.cpuPercent !== undefined || c.memUsage) && (
                            <div className="text-[11px] font-mono text-slate-400 shrink-0 text-right">
                              <div className="text-slate-200">{(c.cpuPercent ?? 0).toFixed(1)}% CPU</div>
                              <div className="text-[10px] text-slate-500">{c.memUsage?.split('/')[0]?.trim() || '—'}</div>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 pl-4 text-[11px]">
                          <span className="text-slate-400">{c.status}</span>
                          {c.ports.map((p, idx) =>
                            p.quickUrl ? (
                              <a
                                key={idx}
                                href={p.quickUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 font-mono bg-sky-500/12 hover:bg-sky-500/22 border border-sky-400/25 text-sky-300 px-2 py-0.5 rounded-md"
                              >
                                <span>:{p.hostPort}</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            ) : (
                              <span
                                key={idx}
                                className="font-mono bg-white/[0.03] border border-white/[0.06] text-slate-400 px-2 py-0.5 rounded-md"
                              >
                                {p.hostIp}:{p.hostPort}→{p.containerPort}
                              </span>
                            )
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-white/[0.05] flex-wrap">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {isRunning ? (
                            <>
                              <button
                                onClick={() => handleDockerAction(c, 'restart')}
                                disabled={busyId !== null}
                                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-sky-500/20 border border-white/[0.07] text-slate-200 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                              >
                                <RotateCw className={`w-3 h-3 ${busyId === `${c.id}-restart` ? 'animate-spin' : ''}`} />
                                <span>重启</span>
                              </button>
                              <button
                                onClick={() => handleDockerAction(c, 'stop')}
                                disabled={busyId !== null}
                                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 border border-white/[0.07] text-slate-200 hover:text-rose-300 cursor-pointer disabled:opacity-40"
                              >
                                {busyId === `${c.id}-stop` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                                <span>停止</span>
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => handleDockerAction(c, 'start')}
                              disabled={busyId !== null}
                              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-emerald-500/18 hover:bg-emerald-500/28 border border-emerald-500/35 text-emerald-300 font-semibold cursor-pointer disabled:opacity-40"
                            >
                              {busyId === `${c.id}-start` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              <span>启动</span>
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenDockerLogs(c)}
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-slate-300 hover:text-white cursor-pointer"
                          >
                            <FileText className="w-3 h-3" />
                            <span>日志</span>
                          </button>
                          {isRunning && onOpenContainerTerminal && (
                            <button
                              onClick={() => onOpenContainerTerminal(c.name)}
                              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-emerald-500/20 border border-white/[0.07] text-slate-300 hover:text-emerald-300 cursor-pointer"
                            >
                              <Terminal className="w-3 h-3" />
                              <span>终端</span>
                            </button>
                          )}
                        </div>

                        <button
                          onClick={() => openDeleteModal({ kind: 'container', container: c })}
                          title="删除容器"
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.03] hover:bg-rose-500/18 border border-white/[0.07] hover:border-rose-500/35 text-slate-400 hover:text-rose-300 cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>删除</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

              {/* Single Host Applications (e.g. orvia, cloud-agent, caddy, x-ui, sing-box, atlasnode) */}
              {hostSingles.map((svc) => {
                const isActive = svc.activeState === 'active';
                const isFailed = svc.activeState === 'failed';
                const isProtected = PROTECTED_SYSTEMD.has(svc.name);
                const matchedLinks = findMatchedLinks(svc.name);
                return (
                  <div
                    key={`host-single-${svc.name}`}
                    className="bg-[#0f131b] border border-white/[0.07] hover:border-white/[0.14] rounded-2xl p-4 space-y-3 transition-colors flex flex-col justify-between"
                  >
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isActive
                              ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.45)]'
                              : isFailed
                                ? 'bg-rose-500'
                                : 'bg-slate-600'
                          }`}
                        />
                        <span className="text-sm font-semibold text-white font-mono truncate">
                          {svc.name}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-500/12 border border-indigo-400/25 text-indigo-300">
                          本机服务
                        </span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full border ${
                            isActive
                              ? 'bg-emerald-500/12 border-emerald-500/25 text-emerald-300'
                              : isFailed
                                ? 'bg-rose-500/12 border-rose-500/25 text-rose-300'
                                : 'bg-white/[0.04] border-white/[0.08] text-slate-400'
                          }`}
                        >
                          {isActive ? '运行中' : isFailed ? '异常' : '已停止'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 truncate pl-4">{svc.description}</div>
                      {matchedLinks.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pl-4">
                          {matchedLinks.map((lk) => (
                            <a
                              key={lk.id}
                              href={lk.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] font-mono bg-sky-500/12 hover:bg-sky-500/22 border border-sky-400/25 text-sky-300 px-2 py-0.5 rounded-md"
                            >
                              <span>{lk.name}</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-white/[0.05] flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {isActive ? (
                          <>
                            <button
                              onClick={() => handleSystemdAction(svc, 'restart')}
                              disabled={busyId !== null}
                              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-sky-500/20 border border-white/[0.07] text-slate-200 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                            >
                              <RotateCw className={`w-3 h-3 ${busyId === `svc-${svc.name}-restart` ? 'animate-spin' : ''}`} />
                              <span>重启</span>
                            </button>
                            {!isProtected ? (
                              <button
                                onClick={() => handleSystemdAction(svc, 'stop')}
                                disabled={busyId !== null}
                                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 border border-white/[0.07] text-slate-200 hover:text-rose-300 cursor-pointer disabled:opacity-40"
                              >
                                {busyId === `svc-${svc.name}-stop` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                                <span>停止</span>
                              </button>
                            ) : (
                              <span
                                title="核心连接服务受保护，禁止通过面板停止"
                                className="text-[10px] font-mono text-slate-500 px-2 py-1 rounded-lg bg-white/[0.03]"
                              >
                                受保护
                              </span>
                            )}
                          </>
                        ) : (
                          <button
                            onClick={() => handleSystemdAction(svc, 'start')}
                            disabled={busyId !== null}
                            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-emerald-500/18 hover:bg-emerald-500/28 border border-emerald-500/35 text-emerald-300 font-semibold cursor-pointer disabled:opacity-40"
                          >
                            {busyId === `svc-${svc.name}-start` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                            <span>启动</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleOpenSystemdLogs(svc)}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-slate-300 hover:text-white cursor-pointer"
                        >
                          <FileText className="w-3 h-3" />
                          <span>日志</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* Low-Weight Collapsible Infrastructure Systemd Services (ssh, docker, containerd, cron, tailscaled...) */}
      {infraSystemd.length > 0 && (
        <section className="bg-[#0f131b] border border-white/[0.06] rounded-2xl overflow-hidden">
          <button
            onClick={() => setInfraExpanded((v) => !v)}
            className="w-full px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-left hover:bg-white/[0.02] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              {showInfraList ? (
                <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
              )}
              <ServerCog className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span>系统基础底座 ({infraSystemd.filter((s) => s.activeState === 'active').length}/{infraSystemd.length} 运行)</span>
            </div>
            <span className="text-[11px] text-slate-500">
              {showInfraList ? '收起' : 'ssh · docker · containerd · tailscaled · cron 等底层守护进程，平时无需干预'}
            </span>
          </button>

          {showInfraList && (
            <div className="p-4 sm:p-5 pt-2 border-t border-white/[0.05] grid grid-cols-1 md:grid-cols-2 gap-3">
              {infraSystemd.map((svc) => {
              const isActive = svc.activeState === 'active';
              const isFailed = svc.activeState === 'failed';
              const isProtected = PROTECTED_SYSTEMD.has(svc.name);
              return (
                <div
                  key={svc.name}
                  className="bg-[#090b10] border border-white/[0.06] rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          isActive ? 'bg-emerald-400' : isFailed ? 'bg-rose-500' : 'bg-slate-600'
                        }`}
                      />
                      <span className="text-xs font-semibold font-mono text-white truncate">
                        {svc.name}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.2 rounded border ${
                          isActive
                            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                            : isFailed
                              ? 'bg-rose-500/10 border-rose-500/25 text-rose-300'
                              : 'bg-white/[0.04] border-white/[0.08] text-slate-400'
                        }`}
                      >
                        {svc.subState || svc.activeState}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 truncate mt-0.5 pl-4">
                      {svc.description}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 pl-4 sm:pl-0 shrink-0 flex-wrap">
                    {isActive ? (
                      <>
                        <button
                          onClick={() => handleSystemdAction(svc, 'restart')}
                          disabled={busyId !== null}
                          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-sky-500/20 border border-white/[0.07] text-slate-300 hover:text-sky-300 cursor-pointer disabled:opacity-40"
                        >
                          <RotateCw className={`w-3 h-3 ${busyId === `svc-${svc.name}-restart` ? 'animate-spin' : ''}`} />
                          <span>重启</span>
                        </button>
                        {!isProtected ? (
                          <button
                            onClick={() => handleSystemdAction(svc, 'stop')}
                            disabled={busyId !== null}
                            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 border border-white/[0.07] text-slate-300 hover:text-rose-300 cursor-pointer disabled:opacity-40"
                          >
                            {busyId === `svc-${svc.name}-stop` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                            <span>停止</span>
                          </button>
                        ) : (
                          <span
                            title="核心连接服务受保护，禁止通过面板停止"
                            className="text-[10px] font-mono text-slate-600 px-1.5 py-1 rounded bg-white/[0.02]"
                          >
                            保护
                          </span>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => handleSystemdAction(svc, 'start')}
                        disabled={busyId !== null}
                        className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 font-medium cursor-pointer disabled:opacity-40"
                      >
                        {busyId === `svc-${svc.name}-start` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                        <span>启动</span>
                      </button>
                    )}
                    <button
                      onClick={() => handleOpenSystemdLogs(svc)}
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-slate-300 hover:text-white cursor-pointer"
                    >
                      <FileText className="w-3 h-3" />
                      <span>日志</span>
                    </button>
                  </div>
                </div>
              );
            })}
            {infraSystemd.length === 0 && (
              <div className="col-span-full text-center py-4 text-xs text-slate-500">没有匹配的系统基础服务</div>
            )}
          </div>
        )}
      </section>
      )}

      {/* Safe Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-[#0f131b] border border-rose-500/30 rounded-2xl w-full max-w-md max-h-[90dvh] overflow-y-auto p-5 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    {deleteTarget.kind === 'stack'
                      ? `删除服务「${deleteTarget.project}」`
                      : `删除容器「${deleteTarget.container.name}」`}
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {deleteTarget.kind === 'stack'
                      ? `将停止并移除该栈下的 ${deleteTarget.containers.length} 个容器`
                      : '将强制停止并移除该 Docker 容器'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {deleteTarget.kind === 'stack' && (
              <div className="bg-[#090b10] border border-white/[0.06] rounded-xl p-3 space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  包含容器
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {deleteTarget.containers.map((c) => (
                    <span
                      key={c.id}
                      className="text-[11px] font-mono px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] text-slate-300"
                    >
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2.5 text-xs">
              <label className="flex items-start gap-2.5 bg-[#090b10] border border-white/[0.06] rounded-xl p-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteVolumes}
                  onChange={(e) => setDeleteVolumes(e.target.checked)}
                  className="mt-0.5 accent-rose-500 cursor-pointer"
                />
                <div>
                  <div className="text-slate-200 font-medium">同时删除关联数据卷 (Volumes)</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    默认不勾选以保留数据库与持久化数据；勾选后数据卷将被清空。
                  </div>
                </div>
              </label>

              {deleteTarget.kind === 'stack' && isSafeDirHint(deleteTarget.dir) && (
                <label className="flex items-start gap-2.5 bg-rose-500/[0.06] border border-rose-500/20 rounded-xl p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteDir}
                    onChange={(e) => setDeleteDir(e.target.checked)}
                    className="mt-0.5 accent-rose-500 cursor-pointer"
                  />
                  <div className="min-w-0">
                    <div className="text-rose-200 font-medium">同时彻底删除项目目录（不可恢复）</div>
                    <div className="text-[11px] font-mono text-rose-300/70 break-all mt-0.5">
                      {deleteTarget.dir}
                    </div>
                  </div>
                </label>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="px-3.5 py-2 rounded-xl text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleConfirmDelete}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs bg-rose-500 hover:bg-rose-400 text-white font-semibold cursor-pointer disabled:opacity-50"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                <span>{deleting ? '删除中...' : '确认删除'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Logs Modal */}
      {logsModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-[#0c0f16] border border-white/10 rounded-2xl w-full max-w-4xl max-h-[88dvh] sm:max-h-[82vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.07] flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white font-mono truncate">{logsModal.title}</span>
              <button
                onClick={() => setLogsModal(null)}
                className="text-slate-400 hover:text-white cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3.5 sm:p-4 bg-[#07090d]">
              {logsModal.loading ? (
                <div className="flex items-center justify-center py-12 text-xs text-slate-400 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在拉取日志...</span>
                </div>
              ) : (
                <pre className="text-[11px] leading-relaxed font-mono text-slate-300 whitespace-pre-wrap break-all">
                  {logsModal.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Compose YAML Inline Editor Modal */}
      {composeModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-[#0c0f16] border border-white/10 rounded-2xl w-full max-w-4xl h-[88dvh] sm:h-[82vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-white font-mono truncate">
                  {composeModal.project} · {composeModal.path || composeModal.dir}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleSaveComposeFile}
                  disabled={composeModal.loading || composeModal.saving || !composeModal.path}
                  className="flex items-center gap-1.5 text-xs bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{composeModal.saving ? '保存中...' : '保存'}</span>
                </button>
                <button
                  onClick={() => {
                    const { project, dir } = composeModal;
                    setComposeModal(null);
                    handleComposeAction(project, dir, 'up');
                  }}
                  disabled={composeModal.loading || !composeModal.path}
                  className="flex items-center gap-1.5 text-xs bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>应用 (up -d)</span>
                </button>
                <button
                  onClick={() => setComposeModal(null)}
                  className="text-slate-400 hover:text-white cursor-pointer ml-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {composeModal.msg && (
              <div className="px-4 sm:px-5 py-2 text-xs bg-sky-500/10 border-b border-sky-500/20 text-sky-200">
                {composeModal.msg}
              </div>
            )}

            <div className="flex-1 bg-[#07090d] flex">
              {composeModal.loading ? (
                <div className="flex-1 flex items-center justify-center text-xs text-slate-400 gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在加载 Compose 配置...</span>
                </div>
              ) : (
                <textarea
                  value={composeModal.content}
                  onChange={(e) =>
                    setComposeModal((prev) => (prev ? { ...prev, content: e.target.value } : prev))
                  }
                  spellCheck={false}
                  className="flex-1 w-full h-full bg-[#07090d] text-slate-200 font-mono text-xs leading-relaxed p-3.5 sm:p-4 focus:outline-none resize-none"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Compose Streaming Output Modal */}
      {streamModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-2.5 sm:p-4">
          <div className="bg-[#0c0f16] border border-white/10 rounded-2xl w-full max-w-4xl max-h-[88dvh] sm:max-h-[82vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 border-b border-white/[0.07] flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-white font-mono min-w-0">
                {streamModal.running && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400 shrink-0" />}
                <span className="truncate">{streamModal.title}</span>
              </div>
              <button
                onClick={() => setStreamModal(null)}
                disabled={streamModal.running}
                className="text-slate-400 hover:text-white cursor-pointer disabled:opacity-30 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre
              ref={streamPreRef}
              className="flex-1 overflow-auto p-3.5 sm:p-4 bg-[#07090d] text-[11px] leading-relaxed font-mono text-slate-200 whitespace-pre-wrap break-all"
            >
              {streamModal.output}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
