import type { SourceRecord, SourceWorkspaceStore } from './sourceWorkspaceStore';
import { sourceWorkspacePath } from './sourceWorkspaceStore';

export const CLONE_TIMEOUT_MS = 15 * 60_000;
export const STALE_GRACE_MS = 5 * 60_000;
export const REMOVING_LINGER_MS = 10 * 60_000;

export interface CleanupFiles {
  renameAway(dir: string): Promise<'removed' | 'missing' | 'failed'>;
  remove(dir: string): Promise<void>;
  listChildren(dir: string): Promise<string[]>;
}

export interface CleanupLease {
  /** Returns 'busy' when waitMs is 0 and the session lease is held. */
  run<T>(sessionId: string, waitMs: number, fn: () => Promise<T>): Promise<T | 'busy'>;
}

export interface WorkspaceCleanupDeps {
  store: SourceWorkspaceStore;
  files: CleanupFiles;
  dataRoot: string;
  lease: CleanupLease;
  nowMs: () => number;
  hasActiveRun?: (sessionId: string) => Promise<boolean>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

async function retireDirectory(
  deps: WorkspaceCleanupDeps,
  sessionId: string,
  sourceId: string,
): Promise<'removed' | 'missing' | 'failed'> {
  return deps.files.renameAway(sourceWorkspacePath(deps.dataRoot, sessionId, sourceId));
}

export function createWorkspaceCleanup(deps: WorkspaceCleanupDeps) {
  const hasActiveRun = deps.hasActiveRun ?? ((sessionId: string) => deps.store.hasActiveRun(sessionId));

  return {
    async sweepInactive(inactivityMs: number): Promise<{ cleaned: number; skippedBusy: number; scanned: number }> {
      const cutoff = iso(deps.nowMs() - inactivityMs);
      const candidates = await deps.store.listInactive(cutoff);
      let cleaned = 0;
      let skippedBusy = 0;
      for (const candidate of candidates) {
        const outcome = await deps.lease.run(candidate.sessionId, 0, async () => {
          const fresh = await deps.store.sessionState(candidate.sessionId);
          if (!fresh || fresh.state !== 'active' || fresh.lastActivityAt > cutoff) return 'skip' as const;
          if (await hasActiveRun(candidate.sessionId)) return 'skip' as const;
          const sources = await deps.store.listSession(candidate.sessionId, candidate.project);
          for (const source of sources) {
            if (source.kind === 'mcp-server' || source.state !== 'ready') continue;
            const retired = await retireDirectory(deps, candidate.sessionId, source.id);
            if (retired === 'failed') continue;
            await deps.store.compareAndSet(source.id, ['ready'], { state: 'cleaned' });
          }
          return 'cleaned' as const;
        });
        if (outcome === 'busy' || outcome === 'skip') skippedBusy += 1;
        else cleaned += 1;
      }
      return { cleaned, skippedBusy, scanned: candidates.length };
    },

    async reconcile(): Promise<{ removed: number; interrupted: number }> {
      const nowMs = deps.nowMs();
      const staleBefore = iso(nowMs - CLONE_TIMEOUT_MS - STALE_GRACE_MS);
      const stale = await deps.store.listStale(staleBefore);
      let interrupted = 0;
      for (const row of stale) {
        const next = row.state === 'restoring' ? 'unavailable' : 'failed';
        const updated = await deps.store.compareAndSet(row.id, [row.state], {
          state: next,
          reasonCode: 'INTERRUPTED',
          reasonText: 'The clone was interrupted.',
        });
        if (updated) {
          interrupted += 1;
          await deps.files.remove(sourceWorkspacePath(deps.dataRoot, row.sessionId, row.id)).catch(() => {});
        }
      }
      const roots = [
        `${deps.dataRoot}/workspaces/brainstorm-workspaces`,
        `${deps.dataRoot}/brainstorm-workspaces`,
      ];
      let removed = 0;
      for (const root of roots) {
        const sessions = await deps.files.listChildren(root);
        for (const name of sessions) {
          if (name.includes('.removing-') && nameEndsOlderThan(name, nowMs - REMOVING_LINGER_MS)) {
            await deps.files.remove(`${root}/${name}`).catch(() => {});
            removed += 1;
            continue;
          }
          const session = await deps.store.sessionState(name).catch(() => null);
          if (!session || session.state === 'ended' || session.state === 'failed') {
            await deps.files.remove(`${root}/${name}`).catch(() => {});
            removed += 1;
          }
        }
      }
      return { removed, interrupted };
    },

    async endSession(input: { sessionId: string; project: string }): Promise<{
      session: { id: string; state: 'ended'; endedAt: string };
      cleanup: 'complete' | 'pending';
    }> {
      const current = await deps.store.sessionState(input.sessionId);
      if (!current) throw Object.assign(new Error('NOT_FOUND'), { status: 404, code: 'NOT_FOUND' });
      const at = iso(deps.nowMs());
      const marked = await deps.store.markEnded(input.sessionId, input.project, current.version, at);
      if ('conflict' in marked) {
        if (marked.state === 'ended' && marked.endedAt) {
          return { session: { id: input.sessionId, state: 'ended', endedAt: marked.endedAt }, cleanup: 'complete' };
        }
        throw Object.assign(new Error('SESSION_NOT_ACTIVE'), { status: 409, code: 'SESSION_NOT_ACTIVE' });
      }
      const sources = await deps.store.listSession(input.sessionId, input.project);
      let pending = false;
      const outcome = await deps.lease.run(input.sessionId, 15_000, async () => {
        for (const source of sources) {
          if (source.kind === 'mcp-server') {
            await deps.store.compareAndSet(source.id, [source.state], { state: 'removed', workspaceRemovedAt: at });
            continue;
          }
          await deps.store.compareAndSet(source.id, [source.state, 'removing'], { state: 'removing' });
          const renamed = await retireDirectory(deps, input.sessionId, source.id);
          if (renamed === 'failed') {
            pending = true;
            await deps.store.compareAndSet(source.id, ['removing'], {
              reasonCode: 'CLEANUP_FAILED',
              reasonText: 'The clone could not be removed. Cleanup will retry.',
            });
            continue;
          }
          await deps.store.compareAndSet(source.id, ['removing'], { state: 'removed', workspaceRemovedAt: at });
        }
      });
      if (outcome === 'busy') pending = true;
      return {
        session: { id: marked.id, state: 'ended', endedAt: marked.endedAt },
        cleanup: pending ? 'pending' : 'complete',
      };
    },
  };
}

function nameEndsOlderThan(name: string, cutoffMs: number): boolean {
  const match = name.match(/\.removing-(\d+)$/);
  if (!match) return false;
  return Number(match[1]) <= cutoffMs;
}

export type ReadyOrUnavailable = { ready: SourceRecord[]; unavailable: SourceRecord[] };
