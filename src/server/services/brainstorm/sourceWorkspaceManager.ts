import { REPO_CACHE_MIN_FREE_BYTES } from '../repoCacheService';
import {
  cloneLimitMessage,
  sizeLimitMessage,
  type BrainstormSourceDto,
  type BrainstormSourceState,
} from '../../../shared/types/brainstormSources';
import type { FrozenBrainstormTurn } from '../../../shared/types/durableInteractiveTurn';
import { redactCloneFailure } from './cloneCredentials';
import {
  sourceWorkspacePath,
  type SourcePatch,
  type SourceRecord,
  type SourceWorkspaceStore,
} from './sourceWorkspaceStore';

export interface ProjectSourceResolution {
  ok: true;
  displayName: string;
  sha: string;
  cacheDir: string;
  provider: 'github' | 'ado';
  repository: string;
  groundingProject: string;
}

export interface SourceManagerDeps {
  store: SourceWorkspaceStore;
  dataRoot: string;
  now?: () => Date;
  pollMs?: number;
  minFreeBytes?: number;
  track?: (name: string, properties: Record<string, string | number>) => void;
  files: {
    measure(dir: string): Promise<number>;
    remove(dir: string): Promise<void>;
    renameAway(dir: string): Promise<'removed' | 'missing' | 'failed'>;
    exists(dir: string): Promise<boolean>;
    freeBytes(): Promise<number | null>;
  };
  git: {
    cloneFromCache(input: { cacheDir: string; destination: string; sha: string; signal: AbortSignal }): Promise<void>;
    resolveTemporary(input: { url: string; revision: string; signal: AbortSignal }): Promise<{ sha: string } | { error: 'UNREACHABLE' | 'REVISION_NOT_FOUND' }>;
    cloneTemporary(input: { url: string; sha: string; destination: string; signal: AbortSignal }): Promise<'ok' | 'moved'>;
    lockDown(destination: string): Promise<void>;
  };
  projects: {
    resolve(project: string, skillSettingsId: string): Promise<ProjectSourceResolution | { ok: false; status: 404 | 409; code: string; error: string }>;
  };
}

export type AttachFailure = { ok: false; status: number; code: string; error: string };
export type AttachSuccess = { ok: true; status: 200 | 201 | 202; source: BrainstormSourceDto; clone: boolean };

function toDto(row: SourceRecord): BrainstormSourceDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    displayName: row.displayName,
    cloneUrl: row.kind === 'temporary-repository' ? row.cloneUrl : null,
    requestedRevision: row.requestedRevision,
    commitSha: row.commitSha,
    state: row.state,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    sizeBytes: row.sizeBytes,
    mcpReadOnlyToolCount: row.mcpReadOnlyToolCount,
    updatedAt: row.updatedAt,
  };
}

async function usedBytes(rows: SourceRecord[], measure: SourceManagerDeps['files']['measure'], dataRoot: string): Promise<number> {
  let total = 0;
  for (const row of rows) {
    if (row.kind === 'mcp-server' || row.state === 'removed' || row.state === 'cleaned') continue;
    if (row.sizeBytes) {
      total += row.sizeBytes;
      continue;
    }
    const dir = sourceWorkspacePath(dataRoot, row.sessionId, row.id);
    total += await measure(dir).catch(() => 0);
  }
  return total;
}

export function createSourceWorkspaceManager(deps: SourceManagerDeps) {
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? 2_000;
  const minFreeBytes = deps.minFreeBytes ?? REPO_CACHE_MIN_FREE_BYTES;
  const track = deps.track ?? (() => {});

  async function fail(row: SourceRecord, reasonCode: string, reasonText: string, from: BrainstormSourceState[]): Promise<SourceRecord> {
    const destination = sourceWorkspacePath(deps.dataRoot, row.sessionId, row.id);
    await deps.files.remove(destination).catch(() => {});
    const next = await deps.store.compareAndSet(row.id, from, {
      state: from.includes('restoring') ? 'unavailable' : 'failed',
      reasonCode,
      reasonText,
    });
    return next ?? row;
  }

  async function runBoundedClone(
    row: SourceRecord,
    limits: FrozenBrainstormTurn['sourceLimits'],
    run: (signal: AbortSignal) => Promise<void>,
  ): Promise<'ok' | 'size'> {
    const destination = sourceWorkspacePath(deps.dataRoot, row.sessionId, row.id);
    const others = (await deps.store.listSession(row.sessionId, row.project)).filter((item) => item.id !== row.id);
    const already = await usedBytes(others, deps.files.measure, deps.dataRoot);
    const controller = new AbortController();
    const timer = setInterval(() => {
      void deps.files.measure(destination).then((size) => {
        if (already + size > limits.workspaceMaxBytes) controller.abort();
      }).catch(() => {});
    }, pollMs);
    try {
      await run(controller.signal);
      const size = await deps.files.measure(destination).catch(() => 0);
      if (controller.signal.aborted || already + size > limits.workspaceMaxBytes) {
        await deps.files.remove(destination).catch(() => {});
        return 'size';
      }
      return 'ok';
    } catch (err) {
      if (controller.signal.aborted) {
        await deps.files.remove(destination).catch(() => {});
        return 'size';
      }
      throw err;
    } finally {
      clearInterval(timer);
    }
  }

  async function markReady(
    row: SourceRecord,
    from: BrainstormSourceState[],
    sha: string,
    grounding: { provider: 'github' | 'ado'; project: string; repository: string },
    started: number,
  ): Promise<SourceRecord> {
    const destination = sourceWorkspacePath(deps.dataRoot, row.sessionId, row.id);
    await deps.git.lockDown(destination);
    const sizeBytes = await deps.files.measure(destination).catch(() => 0);
    const next = await deps.store.compareAndSet(row.id, from, {
      state: 'ready',
      commitSha: sha,
      reasonCode: null,
      reasonText: null,
      sizeBytes,
      groundingProvider: grounding.provider,
      groundingProject: grounding.project,
      groundingRepository: grounding.repository,
    });
    track('brainstorm.source.attach', {
      kind: row.kind,
      outcome: 'ready',
      reasonCode: '',
      durationMs: Date.now() - started,
      sizeBytes,
    });
    return next ?? { ...row, state: 'ready', commitSha: sha, sizeBytes };
  }

  return {
    toDto,

    async list(sessionId: string, project: string): Promise<BrainstormSourceDto[]> {
      const rows = await deps.store.listSession(sessionId, project);
      const out: SourceRecord[] = [];
      for (const row of rows) {
        if (row.kind === 'mcp-server' && (row.state === 'cleaned' || row.state === 'unavailable')) {
          const healed = await deps.store.compareAndSet(row.id, [row.state], {
            state: 'ready',
            reasonCode: null,
            reasonText: null,
          });
          out.push(healed ?? { ...row, state: 'ready', reasonCode: null, reasonText: null });
          continue;
        }
        if (row.kind !== 'mcp-server' && (row.state === 'cleaned' || row.state === 'unavailable') && row.commitSha) {
          const destination = sourceWorkspacePath(deps.dataRoot, sessionId, row.id);
          if (await deps.files.exists(destination)) {
            const healed = await deps.store.compareAndSet(row.id, [row.state], {
              state: 'ready',
              reasonCode: null,
              reasonText: null,
            });
            out.push(healed ?? { ...row, state: 'ready', reasonCode: null, reasonText: null });
            continue;
          }
        }
        out.push(row);
      }
      return out.map(toDto);
    },

    async attachProject(input: {
      sessionId: string;
      project: string;
      skillSettingsId: string;
      limits: FrozenBrainstormTurn['sourceLimits'];
    }): Promise<AttachSuccess | AttachFailure> {
      const existing = await deps.store.findDuplicate(input.sessionId, 'project-repository', input.skillSettingsId, null, null);
      if (existing) return { ok: true, status: 200, source: toDto(existing), clone: false };
      const resolved = await deps.projects.resolve(input.project, input.skillSettingsId);
      if (!resolved.ok) return { ok: false, status: resolved.status, code: resolved.code, error: resolved.error };
      const free = await deps.files.freeBytes();
      if (free !== null && free < minFreeBytes) {
        return { ok: false, status: 409, code: 'CLONE_LIMIT_REACHED', error: 'Not enough free disk to clone another repository.' };
      }
      const slot = await deps.store.insertIfSlot(input.limits.maxConcurrentClones, {
        sessionId: input.sessionId,
        project: input.project,
        kind: 'project-repository',
        displayName: resolved.displayName,
        refId: input.skillSettingsId,
        requestedRevision: resolved.sha,
        state: 'preparing',
      });
      if (!slot.ok) {
        track('brainstorm.source.attach', { kind: 'project-repository', outcome: 'refused', reasonCode: 'CLONE_LIMIT', durationMs: 0, sizeBytes: 0 });
        return { ok: false, status: 409, code: 'CLONE_LIMIT_REACHED', error: cloneLimitMessage(input.limits.maxConcurrentClones) };
      }
      await deps.store.touchActivity(input.sessionId, now().toISOString());
      return { ok: true, status: 202, source: toDto(slot.row), clone: true };
    },

    async attachTemporary(input: {
      sessionId: string;
      project: string;
      cloneUrl: string;
      revision: string;
      displayName: string;
      limits: FrozenBrainstormTurn['sourceLimits'];
    }): Promise<AttachSuccess | AttachFailure> {
      const existing = await deps.store.findDuplicate(input.sessionId, 'temporary-repository', null, input.cloneUrl, input.revision);
      if (existing) return { ok: true, status: 200, source: toDto(existing), clone: false };
      const free = await deps.files.freeBytes();
      if (free !== null && free < minFreeBytes) {
        return { ok: false, status: 409, code: 'CLONE_LIMIT_REACHED', error: 'Not enough free disk to clone another repository.' };
      }
      const slot = await deps.store.insertIfSlot(input.limits.maxConcurrentClones, {
        sessionId: input.sessionId,
        project: input.project,
        kind: 'temporary-repository',
        displayName: input.displayName,
        cloneUrl: input.cloneUrl,
        requestedRevision: input.revision,
        state: 'preparing',
      });
      if (!slot.ok) {
        return { ok: false, status: 409, code: 'CLONE_LIMIT_REACHED', error: cloneLimitMessage(input.limits.maxConcurrentClones) };
      }
      await deps.store.touchActivity(input.sessionId, now().toISOString());
      return { ok: true, status: 202, source: toDto(slot.row), clone: true };
    },

    async attachMcp(input: {
      sessionId: string;
      project: string;
      connectionId: string;
      displayName: string;
      readOnlyToolCount: number;
    }): Promise<AttachSuccess> {
      const existing = await deps.store.findDuplicate(input.sessionId, 'mcp-server', input.connectionId, null, null);
      if (existing) return { ok: true, status: 200, source: toDto(existing), clone: false };
      const row = await deps.store.insert({
        sessionId: input.sessionId,
        project: input.project,
        kind: 'mcp-server',
        displayName: input.displayName,
        refId: input.connectionId,
        state: 'ready',
        mcpReadOnlyToolCount: input.readOnlyToolCount,
      });
      await deps.store.touchActivity(input.sessionId, now().toISOString());
      return { ok: true, status: 201, source: toDto(row), clone: false };
    },

    async completeProjectClone(sourceId: string, sessionId: string, project: string, limits: FrozenBrainstormTurn['sourceLimits']): Promise<SourceRecord | null> {
      const row = await deps.store.findById(sourceId, sessionId, project);
      if (!row || row.state !== 'preparing' || !row.refId) return row;
      const started = Date.now();
      const resolved = await deps.projects.resolve(project, row.refId);
      if (!resolved.ok) {
        return fail(row, 'NOT_READY', resolved.error, ['preparing']);
      }
      const destination = sourceWorkspacePath(deps.dataRoot, sessionId, sourceId);
      const pinned = /^[a-f0-9]{40}$/i.test(row.requestedRevision ?? '') ? row.requestedRevision! : resolved.sha;
      try {
        const bounded = await runBoundedClone(row, limits, (signal) => deps.git.cloneFromCache({
          cacheDir: resolved.cacheDir,
          destination,
          sha: pinned,
          signal,
        }));
        if (bounded === 'size') {
          const failed = await fail(row, 'SIZE_LIMIT', sizeLimitMessage(limits.workspaceMaxBytes), ['preparing']);
          track('brainstorm.source.attach', { kind: row.kind, outcome: 'failed', reasonCode: 'SIZE_LIMIT', durationMs: Date.now() - started, sizeBytes: 0 });
          return failed;
        }
        return markReady(row, ['preparing'], pinned, {
          provider: resolved.provider,
          project: resolved.groundingProject,
          repository: resolved.repository,
        }, started);
      } catch (err) {
        const reasonText = redactCloneFailure((err as Error).message || 'The clone failed.', []);
        const failed = await fail(row, 'UNREACHABLE', reasonText || 'The clone failed.', ['preparing']);
        track('brainstorm.source.attach', { kind: row.kind, outcome: 'failed', reasonCode: 'UNREACHABLE', durationMs: Date.now() - started, sizeBytes: 0 });
        return failed;
      }
    },

    async completeTemporaryClone(sourceId: string, sessionId: string, project: string, limits: FrozenBrainstormTurn['sourceLimits']): Promise<SourceRecord | null> {
      const row = await deps.store.findById(sourceId, sessionId, project);
      if (!row || row.state !== 'preparing' || !row.cloneUrl || !row.requestedRevision) return row;
      const started = Date.now();
      const destination = sourceWorkspacePath(deps.dataRoot, sessionId, sourceId);
      try {
        const resolved = await deps.git.resolveTemporary({ url: row.cloneUrl, revision: row.requestedRevision, signal: AbortSignal.timeout(15_000) });
        if ('error' in resolved) {
          const text = resolved.error === 'UNREACHABLE'
            ? 'The repository could not be reached.'
            : 'That revision does not exist.';
          const failed = await fail(row, resolved.error, text, ['preparing']);
          track('brainstorm.source.attach', { kind: row.kind, outcome: 'failed', reasonCode: resolved.error, durationMs: Date.now() - started, sizeBytes: 0 });
          return failed;
        }
        const sha = resolved.sha;
        const bounded = await runBoundedClone(row, limits, async (signal) => {
          const outcome = await deps.git.cloneTemporary({ url: row.cloneUrl!, sha, destination, signal });
          if (outcome === 'moved') throw new Error('REVISION_MOVED');
        });
        if (bounded === 'size') {
          return fail(row, 'SIZE_LIMIT', sizeLimitMessage(limits.workspaceMaxBytes), ['preparing']);
        }
        const provider = new URL(row.cloneUrl).hostname.toLowerCase().endsWith('github.com') ? 'github' : 'ado';
        const repository = row.cloneUrl.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || row.displayName;
        return markReady(row, ['preparing'], sha, { provider, project, repository }, started);
      } catch (err) {
        const moved = (err as Error).message === 'REVISION_MOVED';
        const failed = await fail(
          row,
          moved ? 'REVISION_MOVED' : 'UNREACHABLE',
          moved ? 'The revision moved while cloning. Try again.' : redactCloneFailure((err as Error).message || 'The clone failed.', []),
          ['preparing'],
        );
        return failed;
      }
    },

    async remove(sourceId: string, sessionId: string, project: string): Promise<AttachSuccess | AttachFailure> {
      if (await deps.store.hasActiveRun(sessionId)) {
        return { ok: false, status: 409, code: 'RUN_IN_PROGRESS', error: 'A turn is still running. Cancel it before removing a source.' };
      }
      const row = await deps.store.findById(sourceId, sessionId, project);
      if (!row || row.state === 'removed') {
        if (!row) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Source not found' };
        return { ok: true, status: 200, source: toDto(row), clone: false };
      }
      const removing = await deps.store.compareAndSet(row.id, ['ready', 'failed', 'cleaned', 'unavailable', 'preparing', 'removing'], {
        state: 'removing',
      });
      const target = removing ?? row;
      const destination = sourceWorkspacePath(deps.dataRoot, sessionId, sourceId);
      const renamed = await deps.files.renameAway(destination);
      if (renamed === 'failed') {
        const pending = await deps.store.compareAndSet(row.id, ['removing'], {
          reasonCode: 'CLEANUP_FAILED',
          reasonText: 'The clone could not be removed. Cleanup will retry.',
        });
        return { ok: true, status: 200, source: toDto(pending ?? target), clone: false };
      }
      const removed = await deps.store.compareAndSet(row.id, ['removing'], {
        state: 'removed',
        workspaceRemovedAt: now().toISOString(),
        reasonCode: null,
        reasonText: null,
      });
      await deps.store.touchActivity(sessionId, now().toISOString());
      return { ok: true, status: 200, source: toDto(removed ?? { ...target, state: 'removed' }), clone: false };
    },

    async ensureSourcesReady(sessionId: string, project: string, _limits: FrozenBrainstormTurn['sourceLimits']): Promise<{
      ready: SourceRecord[];
      unavailable: SourceRecord[];
    }> {
      const session = await deps.store.sessionState(sessionId);
      if (!session || session.state !== 'active') {
        throw Object.assign(new Error('SESSION_NOT_ACTIVE'), { code: 'SESSION_NOT_ACTIVE', status: 409 });
      }
      await deps.store.touchActivity(sessionId, now().toISOString());
      const rows = await deps.store.listSession(sessionId, project);
      for (const row of rows) {
        if (row.kind === 'mcp-server' && (row.state === 'cleaned' || row.state === 'unavailable')) {
          await deps.store.compareAndSet(row.id, [row.state], {
            state: 'ready',
            reasonCode: null,
            reasonText: null,
          });
        }
      }
      const pending = rows.filter((row) => row.kind !== 'mcp-server' && (
        row.state === 'cleaned' || row.state === 'unavailable' || row.state === 'ready'
      ));
      for (const row of pending) {
        const destination = sourceWorkspacePath(deps.dataRoot, sessionId, row.id);
        const present = Boolean(row.commitSha) && await deps.files.exists(destination);
        if (present) {
          if (row.state !== 'ready') {
            await deps.store.compareAndSet(row.id, [row.state], {
              state: 'ready',
              reasonCode: null,
              reasonText: null,
            });
          }
          continue;
        }
        if (!row.commitSha) continue;
        const restoring = await deps.store.compareAndSet(row.id, [row.state], { state: 'restoring', reasonCode: null, reasonText: null });
        if (!restoring) continue;
        try {
          if (row.kind === 'project-repository' && row.refId) {
            const resolved = await deps.projects.resolve(project, row.refId);
            if (!resolved.ok) throw new Error('unreachable');
            await deps.git.cloneFromCache({ cacheDir: resolved.cacheDir, destination, sha: row.commitSha, signal: AbortSignal.timeout(180_000) });
          } else if (row.cloneUrl) {
            const outcome = await deps.git.cloneTemporary({ url: row.cloneUrl, sha: row.commitSha, destination, signal: AbortSignal.timeout(180_000) });
            if (outcome === 'moved') throw new Error('unreachable');
          } else {
            throw new Error('unreachable');
          }
          await deps.git.lockDown(destination);
          await deps.store.compareAndSet(row.id, ['restoring'], { state: 'ready', commitSha: row.commitSha, reasonCode: null, reasonText: null });
        } catch {
          await deps.files.remove(destination).catch(() => {});
          await deps.store.compareAndSet(row.id, ['restoring'], {
            state: 'unavailable',
            reasonCode: 'UNREACHABLE',
            reasonText: 'The repository could not be restored.',
          });
        }
      }
      const settled = await deps.store.listSession(sessionId, project);
      return {
        ready: settled.filter((row) => row.state === 'ready'),
        unavailable: settled.filter((row) => row.state === 'unavailable' || row.state === 'failed' || row.state === 'cleaned'),
      };
    },

    workspacePath(sessionId: string, sourceId: string): string {
      return sourceWorkspacePath(deps.dataRoot, sessionId, sourceId);
    },
  };
}

export type SourceWorkspaceManager = ReturnType<typeof createSourceWorkspaceManager>;

export function applyPatch(row: SourceRecord, patch: SourcePatch): SourceRecord {
  return {
    ...row,
    ...patch,
    state: patch.state ?? row.state,
    commitSha: patch.commitSha === undefined ? row.commitSha : patch.commitSha,
  };
}
