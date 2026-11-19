export interface CachedAdapterEntry<THandle> {
  readonly sessionKey: string;
  readonly compatibilityKey: string;
  readonly handle: THandle;
  lastUsedAt: number;
}

export class AdapterAgentCache<THandle extends { dispose(): Promise<void> }> {
  private readonly entries = new Map<string, CachedAdapterEntry<THandle>>();
  private readonly unresumableIds = new Set<string>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(0, maxEntries);
  }

  getCompatible(
    sessionKey: string,
    compatibilityKey: string,
    nowMs = Date.now(),
  ): THandle | null {
    const entry = this.entries.get(sessionKey);
    if (!entry) return null;
    if (entry.compatibilityKey !== compatibilityKey) return null;
    entry.lastUsedAt = nowMs;
    // Refresh insertion order for LRU eviction when full.
    this.entries.delete(sessionKey);
    this.entries.set(sessionKey, entry);
    return entry.handle;
  }

  peek(sessionKey: string): CachedAdapterEntry<THandle> | undefined {
    return this.entries.get(sessionKey);
  }

  async put(
    sessionKey: string,
    compatibilityKey: string,
    handle: THandle,
    nowMs = Date.now(),
  ): Promise<void> {
    const existing = this.entries.get(sessionKey);
    if (existing && existing.handle !== handle) {
      this.entries.delete(sessionKey);
      await existing.handle.dispose().catch(() => {});
    }
    if (this.maxEntries === 0) {
      return;
    }
    while (this.entries.size >= this.maxEntries && !this.entries.has(sessionKey)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (evicted) {
        await evicted.handle.dispose().catch(() => {});
      }
    }
    this.entries.set(sessionKey, {
      sessionKey,
      compatibilityKey,
      handle,
      lastUsedAt: nowMs,
    });
  }

  async release(sessionKey: string): Promise<void> {
    const existing = this.entries.get(sessionKey);
    if (!existing) return;
    this.entries.delete(sessionKey);
    await existing.handle.dispose().catch(() => {});
  }

  async evictIdle(cutoffMs: number): Promise<string[]> {
    const evictedKeys: string[] = [];
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.lastUsedAt <= cutoffMs) {
        this.entries.delete(key);
        evictedKeys.push(key);
        await entry.handle.dispose().catch(() => {});
      }
    }
    return evictedKeys;
  }

  markUnresumable(agentId: string): void {
    const trimmed = agentId.trim();
    if (trimmed) this.unresumableIds.add(trimmed);
  }

  isUnresumable(agentId: string): boolean {
    return this.unresumableIds.has(agentId.trim());
  }

  async clear(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((entry) => entry.handle.dispose().catch(() => {})));
  }
}
