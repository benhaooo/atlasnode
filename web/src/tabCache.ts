// Lightweight in-memory client tab cache so switching tabs renders instantaneously
// without flashing skeletons, while still letting backend SWR/fresh fetches update seamlessly.

interface TabCacheItem<T> {
  data: T;
  cachedAt?: string;
}

const store = new Map<string, TabCacheItem<unknown>>();

export function getTabCache<T>(namespace: string, serverId: string): TabCacheItem<T> | undefined {
  return store.get(`${namespace}:${serverId}`) as TabCacheItem<T> | undefined;
}

export function setTabCache<T>(namespace: string, serverId: string, data: T, cachedAt?: string): void {
  store.set(`${namespace}:${serverId}`, { data, cachedAt });
}

export function clearTabCache(namespace: string, serverId?: string): void {
  if (serverId) {
    store.delete(`${namespace}:${serverId}`);
    return;
  }
  for (const k of Array.from(store.keys())) {
    if (k.startsWith(`${namespace}:`)) store.delete(k);
  }
}
