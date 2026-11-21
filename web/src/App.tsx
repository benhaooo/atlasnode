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

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  const [snapshots, setSnapshots] = useState<ServerSnapshot[]>([]);
  const [loadingFleet, setLoadingFleet] = useState(false);
  const [viewMode, setViewMode] = useState<'overview' | 'compare' | 'server'>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [initialTab, setInitialTab] = useState<ServerTab>('overview');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

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

  const handleSelectServer = (id: string, tab?: string) => {
    setSelectedId(id);
    setViewMode('server');
    setInitialTab((tab as ServerTab) || 'overview');
  };

  const handleServerUpdated = (updated: ServerConfig) => {
    setSnapshots((prev) =>
      prev.map((s) => (s.server.id === updated.id ? { ...s, server: updated } : s))
    );
  };

  const handleLogout = async () => {
    await api.logout();
    setAuthenticated(false);
    setSnapshots([]);
    setSelectedId(null);
    setViewMode('overview');
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
        onSelectOverview={() => {
          setSelectedId(null);
          setViewMode('overview');
        }}
        onSelectCompare={() => {
          setSelectedId(null);
          setViewMode('compare');
        }}
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
            onRefreshSnapshot={() => refreshSingleSnapshot(activeSnapshot.server.id)}
            onServerUpdated={handleServerUpdated}
            onServerDeleted={() => {
              setSelectedId(null);
              setViewMode('overview');
              fetchFleet();
            }}
          />
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
