import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ServerConfig, ServerSnapshot } from './types';
import { LoginScreen } from './components/LoginScreen';
import { Sidebar } from './components/Sidebar';
import { FleetOverview } from './components/FleetOverview';
import { CompareView } from './components/CompareView';
import { ServerDetail, type ServerTab } from './components/ServerDetail';
import { AddServerModal } from './components/AddServerModal';
import { SettingsModal } from './components/SettingsModal';
import { ServerDetailSkeleton } from './components/Skeleton';

const VALID_SERVER_TABS: ReadonlySet<ServerTab> = new Set<ServerTab>([
  'overview',
  'services',
  'network',
  'nodequality',
  'firewall',
  'assets',
  'files',
  'terminal',
  'keys',
]);

interface RouteState {
  viewMode: 'overview' | 'compare' | 'server';
  selectedId: string | null;
  tab: ServerTab;
}

function normalizeServerTab(raw?: string): ServerTab {
  if (!raw) return 'overview';
  const cleaned = raw.toLowerCase();
  if (cleaned === 'quality') return 'nodequality';
  return VALID_SERVER_TABS.has(cleaned as ServerTab) ? (cleaned as ServerTab) : 'overview';
}

function parseHashRoute(hash: string): RouteState {
  const trimmed = hash.replace(/^#\/?/, '').split('?')[0].replace(/\/+$/, '');
  if (!trimmed) {
    return { viewMode: 'overview', selectedId: null, tab: 'overview' };
  }
  const parts = trimmed.split('/');
  const head = parts[0]?.toLowerCase();
  if (head === 'compare') {
    return { viewMode: 'compare', selectedId: null, tab: 'overview' };
  }
  if ((head === 'server' || head === 'servers') && parts[1]) {
    let id = parts[1];
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
      // keep raw segment on malformed percent encoding
    }
    return {
      viewMode: 'server',
      selectedId: id,
      tab: normalizeServerTab(parts[2]),
    };
  }
  return { viewMode: 'overview', selectedId: null, tab: 'overview' };
}

function formatHashRoute(route: RouteState): string {
  if (route.viewMode === 'compare') return '#/compare';
  if (route.viewMode === 'server' && route.selectedId) {
    return `#/server/${encodeURIComponent(route.selectedId)}/${route.tab || 'overview'}`;
  }
  return '#/';
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  const [snapshots, setSnapshots] = useState<ServerSnapshot[]>([]);
  const [loadingFleet, setLoadingFleet] = useState(false);
  const [fleetLoadedOnce, setFleetLoadedOnce] = useState(false);

  const initialRoute = parseHashRoute(typeof window !== 'undefined' ? window.location.hash : '');
  const [viewMode, setViewMode] = useState<'overview' | 'compare' | 'server'>(initialRoute.viewMode);
  const [selectedId, setSelectedId] = useState<string | null>(initialRoute.selectedId);
  const [initialTab, setInitialTab] = useState<ServerTab>(initialRoute.tab);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const applyRoute = useCallback((next: RouteState, replace = false) => {
    setViewMode(next.viewMode);
    setSelectedId(next.selectedId);
    setInitialTab(next.tab);
    const targetHash = formatHashRoute(next);
    if (window.location.hash !== targetHash) {
      if (replace) {
        window.history.replaceState(null, '', targetHash);
      } else {
        window.location.hash = targetHash;
      }
    }
  }, []);

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', '#/');
    }
    const onHashChange = () => {
      const parsed = parseHashRoute(window.location.hash);
      setViewMode(parsed.viewMode);
      setSelectedId(parsed.selectedId);
      setInitialTab(parsed.tab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const res = await api.authStatus();
      setAuthenticated(res.authenticated);
    } catch {
      setAuthenticated(false);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  const fetchFleet = useCallback(async (fresh = false) => {
    setLoadingFleet(true);
    try {
      const res = await api.getFleetSnapshots(fresh);
      setSnapshots(res.snapshots);
      setFleetLoadedOnce(true);
    } catch {
      // handled via unauthorized event or inline state
    } finally {
      setLoadingFleet(false);
    }
  }, []);

  const refreshSingleSnapshot = useCallback(async (id: string, fresh = true) => {
    try {
      const { snapshot } = await api.getServerSnapshot(id, fresh);
      setSnapshots((prev) => prev.map((s) => (s.server.id === id ? snapshot : s)));
    } catch {
      // ignore transient error
    }
  }, []);

  useEffect(() => {
    checkAuth();
    const onUnauth = () => setAuthenticated(false);
    window.addEventListener('atlasnode:unauthorized', onUnauth);
    return () => window.removeEventListener('atlasnode:unauthorized', onUnauth);
  }, [checkAuth]);

  useEffect(() => {
    if (!authenticated) return;
    fetchFleet();
    // Refresh fleet summary calmly every 30s (detail view uses real-time 2s SSE)
    const timer = setInterval(fetchFleet, 30_000);
    return () => clearInterval(timer);
  }, [authenticated, fetchFleet]);

  // Fall back to overview if the hash references a non-existent server ID after fleet loads
  useEffect(() => {
    if (!fleetLoadedOnce || viewMode !== 'server' || !selectedId) return;
    const exists = snapshots.some((s) => s.server.id === selectedId);
    if (!exists) {
      applyRoute({ viewMode: 'overview', selectedId: null, tab: 'overview' }, true);
    }
  }, [fleetLoadedOnce, viewMode, selectedId, snapshots, applyRoute]);

  const handleSelectServer = useCallback(
    (id: string, tab?: string) => {
      applyRoute({
        viewMode: 'server',
        selectedId: id,
        tab: normalizeServerTab(tab),
      });
    },
    [applyRoute]
  );

  const handleTabChange = useCallback(
    (tab: ServerTab) => {
      if (!selectedId) return;
      applyRoute({
        viewMode: 'server',
        selectedId,
        tab,
      });
    },
    [selectedId, applyRoute]
  );

  const handleServerUpdated = (updated: ServerConfig) => {
    setSnapshots((prev) =>
      prev.map((s) => (s.server.id === updated.id ? { ...s, server: updated } : s))
    );
  };

  const handleLogout = async () => {
    await api.logout();
    setAuthenticated(false);
    setSnapshots([]);
    setFleetLoadedOnce(false);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#090b10] flex items-center justify-center text-xs font-mono text-slate-500">
        AtlasNode initializing...
      </div>
    );
  }

  if (!authenticated) {
    return <LoginScreen onSuccess={() => setAuthenticated(true)} />;
  }

  const activeSnapshot =
    viewMode === 'server' && selectedId
      ? snapshots.find((s) => s.server.id === selectedId) || null
      : null;

  return (
    <div className="min-h-screen bg-[#090b10] text-[#e8ecf4] flex">
      <Sidebar
        snapshots={snapshots}
        selectedId={viewMode === 'server' ? selectedId : null}
        activeView={viewMode}
        loading={loadingFleet}
        onSelectOverview={() =>
          applyRoute({ viewMode: 'overview', selectedId: null, tab: 'overview' })
        }
        onSelectCompare={() =>
          applyRoute({ viewMode: 'compare', selectedId: null, tab: 'overview' })
        }
        onSelectServer={(id) => handleSelectServer(id, 'overview')}
        onAddServer={() => setShowAddModal(true)}
        onOpenSettings={() => setShowSettings(true)}
        onRefresh={() => fetchFleet(true)}
        onLogout={handleLogout}
      />

      <div className="flex-1 min-w-0">
        {activeSnapshot ? (
          <ServerDetail
            snapshot={activeSnapshot}
            initialTab={initialTab}
            onTabChange={handleTabChange}
            onRefreshSnapshot={() => refreshSingleSnapshot(activeSnapshot.server.id)}
            onServerUpdated={handleServerUpdated}
            onServerDeleted={() => {
              applyRoute({ viewMode: 'overview', selectedId: null, tab: 'overview' }, true);
              fetchFleet();
            }}
          />
        ) : viewMode === 'server' && !fleetLoadedOnce ? (
          <ServerDetailSkeleton />
        ) : viewMode === 'compare' ? (
          <CompareView snapshots={snapshots} onSelectServer={handleSelectServer} />
        ) : (
          <FleetOverview
            snapshots={snapshots}
            loading={loadingFleet}
            onSelectServer={handleSelectServer}
            onAddServer={() => setShowAddModal(true)}
          />
        )}
      </div>

      {showAddModal && (
        <AddServerModal
          existingServers={snapshots.map((s) => s.server)}
          onClose={() => setShowAddModal(false)}
          onAdded={fetchFleet}
        />
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
