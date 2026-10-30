/**
 * FEAT-002 source workspace, cleanup, citations, and the MCP read gateway.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sanitizePlainText } from '../../shared/utils/sanitizePlainText';
import { BRAINSTORM_SOURCE_BASE_INSTRUCTIONS, cloneLimitMessage, sizeLimitMessage } from '../../shared/types/brainstormSources';
import { isBrainstormTurnSources } from '../../shared/types/aiRunV2BrainstormSpec';
import { appDefaultBrainstormLimits, DEFAULT_MAX_CONCURRENT_CLONES } from '../services/brainstormLimits';
import { credentialsForCloneUrl } from '../services/brainstorm/cloneCredentials';
import { isBlockedCloneAddress, validateCloneUrl, validateRevision } from '../services/brainstorm/cloneUrlValidator';
import { createCitationService, type CitationPersistence, type StoredCitation } from '../services/brainstorm/citationService';
import { createMcpReadGateway, mcpCallsFor, resetMcpCallLog } from '../services/brainstorm/mcpReadGateway';
import { buildBrainstormTurnSources } from '../services/brainstorm/sourceSpecification';
import { createSourceWorkspaceManager, type SourceManagerDeps } from '../services/brainstorm/sourceWorkspaceManager';
import type { BrainstormSourceKind, BrainstormSourceState } from '../../shared/types/brainstormSources';
import {
  sourceWorkspacePath,
  type SourcePatch,
  type SourceRecord,
  type SourceWorkspaceStore,
} from '../services/brainstorm/sourceWorkspaceStore';
import { createWorkspaceCleanup } from '../services/brainstorm/workspaceCleanupService';
import { brainstormRepositoryMirrorDir } from '../services/brainstormRepositoryCatalog';
import {
  candidateSourcePaths,
  mountBrainstormSources,
} from '../services/interactiveActorHost/brainstormSourceMount';
import type { McpServerOperation } from '../../shared/types/mcpServers';

const SESSION = '10000000-0000-4000-8000-000000000001';
const PROJECT = 'alpha';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const LIMITS = appDefaultBrainstormLimits({ BRAINSTORM_INACTIVITY_MINUTES: '30' });

function row(partial: Partial<SourceRecord> & Pick<SourceRecord, 'id' | 'kind'>): SourceRecord {
  return {
    sessionId: SESSION,
    project: PROJECT,
    displayName: partial.kind,
    cloneUrl: null,
    requestedRevision: null,
    commitSha: null,
    state: 'preparing',
    refId: null,
    reasonCode: null,
    reasonText: null,
    sizeBytes: null,
    mcpReadOnlyToolCount: null,
    groundingProvider: null,
    groundingProject: null,
    groundingRepository: null,
    updatedAt: '2026-10-29T12:00:00.000Z',
    workspaceRemovedAt: null,
    ...partial,
  };
}

function memoryStore(seed: SourceRecord[] = []): SourceWorkspaceStore & { rows: SourceRecord[]; ended: { state: string; version: number; endedAt: string | null; lastActivityAt: string }; activeRun: boolean } {
  const rows = [...seed];
  let seq = 1;
  const ended = { state: 'active', version: 1, endedAt: null as string | null, lastActivityAt: '2026-10-29T12:00:00.000Z' };
  let tail = Promise.resolve();
  const api = {
    rows,
    ended,
    activeRun: false,
    async listSession(sessionId: string, project: string) {
      return rows.filter((item) => item.sessionId === sessionId && item.project === project && item.state !== 'removed');
    },
    async findById(id: string, sessionId: string, project: string) {
      return rows.find((item) => item.id === id && item.sessionId === sessionId && item.project === project) ?? null;
    },
    async findDuplicate(sessionId: string, kind: BrainstormSourceKind, refId: string | null, cloneUrl: string | null, revision: string | null) {
      return rows.find((item) => item.sessionId === sessionId && item.kind === kind && item.state !== 'removed'
        && (kind === 'temporary-repository' ? item.cloneUrl === cloneUrl && item.requestedRevision === revision : item.refId === refId)) ?? null;
    },
    async insertIfSlot(limit: number, input: { sessionId: string; project: string; kind: BrainstormSourceKind; displayName: string; cloneUrl?: string | null; requestedRevision?: string | null; refId?: string | null; state?: BrainstormSourceState }) {
      const run = tail.then(async () => {
        const cloning = rows.filter((item) => item.project === input.project && (item.state === 'preparing' || item.state === 'restoring')).length;
        if (cloning >= limit) return { ok: false as const, cloning };
        const created = row({
          id: `10000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`,
          kind: input.kind,
          sessionId: input.sessionId,
          project: input.project,
          displayName: input.displayName,
          cloneUrl: input.cloneUrl ?? null,
          requestedRevision: input.requestedRevision ?? null,
          refId: input.refId ?? null,
          state: input.state ?? 'preparing',
        });
        rows.push(created);
        return { ok: true as const, row: created };
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    async insert(input: { sessionId: string; project: string; kind: BrainstormSourceKind; displayName: string; refId?: string | null; state?: BrainstormSourceState; mcpReadOnlyToolCount?: number | null }) {
      const created = row({
        id: `10000000-0000-4000-8000-${String(seq++).padStart(12, '0')}`,
        kind: input.kind,
        sessionId: input.sessionId,
        project: input.project,
        displayName: input.displayName,
        refId: input.refId ?? null,
        state: input.state ?? 'ready',
        mcpReadOnlyToolCount: input.mcpReadOnlyToolCount ?? null,
      });
      rows.push(created);
      return created;
    },
    async compareAndSet(id: string, from: BrainstormSourceState[], patch: SourcePatch) {
      const found = rows.find((item) => item.id === id && from.includes(item.state));
      if (!found) return null;
      Object.assign(found, patch, { state: patch.state ?? found.state });
      return { ...found };
    },
    async touchActivity(_sessionId: string, atIso: string) { ended.lastActivityAt = atIso; },
    async hasActiveRun() { return api.activeRun; },
    async sessionState() { return { state: ended.state, version: ended.version, lastActivityAt: ended.lastActivityAt }; },
    async markEnded(_sessionId: string, _project: string, expectedVersion: number, atIso: string) {
      if (ended.state === 'ended' && ended.endedAt) return { conflict: true as const, state: 'ended', endedAt: ended.endedAt };
      if (ended.version !== expectedVersion || ended.state !== 'active') return { conflict: true as const, state: ended.state, endedAt: ended.endedAt };
      ended.state = 'ended';
      ended.endedAt = atIso;
      ended.version += 1;
      return { id: SESSION, state: 'ended' as const, endedAt: atIso, alreadyEnded: false };
    },
    async listInactive(cutoffIso: string) {
      const ready = rows.some((item) => item.state === 'ready' && item.sessionId === SESSION);
      if (ended.state === 'active' && ready && ended.lastActivityAt <= cutoffIso) {
        return [{ sessionId: SESSION, project: PROJECT, lastActivityAt: ended.lastActivityAt }];
      }
      return [];
    },
    async listStale(olderThanIso: string) {
      return rows.filter((item) => (item.state === 'preparing' || item.state === 'restoring') && item.updatedAt <= olderThanIso);
    },
  };
  return api;
}

function managerFor(
  store: SourceWorkspaceStore,
  gitOverrides: Partial<SourceManagerDeps['git']> = {},
  fileOverrides: Partial<SourceManagerDeps['files']> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    manager: createSourceWorkspaceManager({
      store,
      dataRoot: path.join(os.tmpdir(), 'brainstorm-test'),
      now: () => new Date('2026-10-29T12:30:00.000Z'),
      pollMs: 5,
      minFreeBytes: 1,
      files: {
        measure: async () => 10,
        remove: async () => { calls.push('remove'); },
        renameAway: async () => 'removed',
        exists: async () => false,
        freeBytes: async () => 100,
        ...fileOverrides,
      },
      git: {
        cloneFromCache: async () => { calls.push('clone'); },
        resolveTemporary: async () => ({ sha: SHA }),
        cloneTemporary: async () => 'ok',
        lockDown: async () => { calls.push('lock'); },
        ...gitOverrides,
      },
      projects: {
        resolve: async () => ({
          ok: true,
          displayName: 'Apex',
          sha: SHA,
          cacheDir: '/cache/apex',
          provider: 'github',
          repository: 'org/apex',
          groundingProject: PROJECT,
        }),
      },
    }),
  };
}

describe('FEAT-002 clone URL validation — PBI-006 (d) / VT-02', () => {
  it.each([
    'http://github.com/org/repo.git',
    'ssh://github.com/org/repo.git',
    'https://user:pw@github.com/org/repo.git',
    'https://10.0.0.5/repo.git',
    'https://github.com:8443/org/repo.git',
  ])('rejects %s before a row exists', (value) => {
    expect(validateCloneUrl(value).ok).toBe(false);
  });

  it('drops an organization name from an Azure DevOps URL and keeps the password out', () => {
    const cleaned = validateCloneUrl('https://amergis@dev.azure.com/amergis/MaxView/_git/MaxView');
    expect(cleaned.ok).toBe(true);
    if (cleaned.ok) expect(cleaned.url.toString()).toBe('https://dev.azure.com/amergis/MaxView/_git/MaxView');
  });

  it('rejects a short commit id and a revision that starts with a dash', () => {
    expect(validateRevision('-x').ok).toBe(false);
    expect(validateRevision('abc123').ok).toBe(false);
    expect(validateRevision('a'.repeat(40)).ok).toBe(true);
    expect(validateRevision('main').ok).toBe(true);
  });

  it('blocks loopback, private, and metadata addresses', () => {
    expect(isBlockedCloneAddress('127.0.0.1')).toBe(true);
    expect(isBlockedCloneAddress('10.1.1.1')).toBe(true);
    expect(isBlockedCloneAddress('169.254.169.254')).toBe(true);
    expect(isBlockedCloneAddress('8.8.8.8')).toBe(false);
  });
});

describe('FEAT-002 platform credentials — TBI-004 DoD-1', () => {
  it('AC credential: sends the platform token only for GitHub and the ADO host, never inside the URL', () => {
    const env = { GITHUB_TOKEN: 'gh-secret', ADO_ORG: 'https://dev.azure.com/asm', ADO_PAT: 'ado-secret' };
    const github = credentialsForCloneUrl(new URL('https://github.com/asm/apex.git'), env);
    expect(github.secret).toBe('gh-secret');
    const header = github.env.GIT_CONFIG_VALUE_0 ?? '';
    const decoded = Buffer.from(header.replace('Authorization: Basic ', ''), 'base64').toString('utf8');
    expect(decoded).toContain('gh-secret');
    expect(header).not.toContain('https://github.com');
    expect(header).not.toContain('gh-secret');
    const gitlab = credentialsForCloneUrl(new URL('https://gitlab.com/asm/apex.git'), env);
    expect(gitlab.secret).toBeNull();
    expect(JSON.stringify(gitlab.env)).not.toContain('gh-secret');
    const ado = credentialsForCloneUrl(new URL('https://dev.azure.com/asm/project/_git/repo'), env);
    expect(ado.secret).toBe('ado-secret');
  });
});

describe('FEAT-002 limits default — TBI-004', () => {
  it('uses 5 GiB, 3 concurrent clones, and 30 minutes when the project has no row', () => {
    const limits = appDefaultBrainstormLimits({});
    expect(limits.maxConcurrentClones).toBe(DEFAULT_MAX_CONCURRENT_CLONES);
    expect(limits.maxConcurrentClones).toBe(3);
    expect(limits.workspaceMaxBytes).toBe(5 * 1024 * 1024 * 1024);
    expect(limits.inactivityMs).toBe(30 * 60_000);
  });
});

describe('FEAT-002 source manager — PBI-005 / PBI-006 / PBI-010', () => {
  it('PBI-005 (a) / VT-04 pins the resolved SHA and locks the clone down', async () => {
    const store = memoryStore();
    const { manager, calls } = managerFor(store);
    const attached = await manager.attachProject({ sessionId: SESSION, project: PROJECT, skillSettingsId: '20000000-0000-4000-8000-000000000002', limits: LIMITS });
    expect(attached.ok && attached.status).toBe(202);
    if (!attached.ok) return;
    const ready = await manager.completeProjectClone(attached.source.id, SESSION, PROJECT, LIMITS);
    expect(ready?.state).toBe('ready');
    expect(ready?.commitSha).toBe(SHA);
    expect(calls).toEqual(expect.arrayContaining(['clone', 'lock']));
  });

  it('PBI-005 (c) / VT-07 refuses the fourth clone and names the limit', async () => {
    const store = memoryStore([
      row({ id: '10000000-0000-4000-8000-000000000011', kind: 'project-repository', state: 'preparing', sessionId: '10000000-0000-4000-8000-000000000021' }),
      row({ id: '10000000-0000-4000-8000-000000000012', kind: 'project-repository', state: 'preparing', sessionId: '10000000-0000-4000-8000-000000000022' }),
      row({ id: '10000000-0000-4000-8000-000000000013', kind: 'project-repository', state: 'restoring', sessionId: '10000000-0000-4000-8000-000000000023' }),
    ]);
    const limited = { ...LIMITS, maxConcurrentClones: 3 };
    const { manager } = managerFor(store);
    const refused = await manager.attachProject({ sessionId: SESSION, project: PROJECT, skillSettingsId: '20000000-0000-4000-8000-000000000099', limits: limited });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('CLONE_LIMIT_REACHED');
    expect(refused.error).toBe(cloneLimitMessage(3));
  });

  it('PBI-005 (c) / VT-08 aborts a clone that passes the size cap and names 5 GiB', async () => {
    const store = memoryStore();
    const { manager } = managerFor(store, {
      cloneFromCache: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    }, { measure: async () => LIMITS.workspaceMaxBytes + 1 });
    const attached = await manager.attachProject({ sessionId: SESSION, project: PROJECT, skillSettingsId: '20000000-0000-4000-8000-000000000002', limits: LIMITS });
    if (!attached.ok) throw new Error('attach failed');
    const failed = await manager.completeProjectClone(attached.source.id, SESSION, PROJECT, LIMITS);
    expect(failed?.state).toBe('failed');
    expect(failed?.reasonCode).toBe('SIZE_LIMIT');
    expect(failed?.reasonText).toBe(sizeLimitMessage(LIMITS.workspaceMaxBytes));
  });

  it('PBI-006 (b) / VT-10 records an unreachable temporary repository as failed and removes the directory', async () => {
    const store = memoryStore();
    const { manager, calls } = managerFor(store, { resolveTemporary: async () => ({ error: 'UNREACHABLE' }) });
    const attached = await manager.attachTemporary({
      sessionId: SESSION, project: PROJECT, cloneUrl: 'https://github.com/asm/private.git', revision: 'main', displayName: 'private', limits: LIMITS,
    });
    if (!attached.ok) throw new Error('attach failed');
    const failed = await manager.completeTemporaryClone(attached.source.id, SESSION, PROJECT, LIMITS);
    expect(failed?.state).toBe('failed');
    expect(failed?.reasonCode).toBe('UNREACHABLE');
    expect(failed?.state).not.toBe('ready');
    expect(calls).toContain('remove');
  });

  it('PBI-010 (a) / VT-31 restores a cleaned source at the recorded SHA', async () => {
    const store = memoryStore([row({
      id: '10000000-0000-4000-8000-000000000031',
      kind: 'project-repository',
      state: 'cleaned',
      commitSha: SHA,
      refId: '20000000-0000-4000-8000-000000000002',
      groundingProvider: 'github',
      groundingRepository: 'org/apex',
    })]);
    let observed: string | null = null;
    const { manager } = managerFor(store, {
      cloneFromCache: async (input: { sha: string }) => {
        observed = store.rows[0].state;
        expect(input.sha).toBe(SHA);
      },
    });
    const settled = await manager.ensureSourcesReady(SESSION, PROJECT, LIMITS);
    expect(observed).toBe('restoring');
    expect(settled.ready[0]?.commitSha).toBe(SHA);
    expect(settled.ready[0]?.state).toBe('ready');
  });

  it('PBI-010 (b) / VT-32 leaves an unrestorable source unavailable', async () => {
    const store = memoryStore([row({
      id: '10000000-0000-4000-8000-000000000032',
      kind: 'temporary-repository',
      state: 'cleaned',
      commitSha: SHA,
      cloneUrl: 'https://github.com/asm/gone.git',
    })]);
    const { manager } = managerFor(store, { cloneTemporary: async () => { throw new Error('repository not found'); } });
    const settled = await manager.ensureSourcesReady(SESSION, PROJECT, LIMITS);
    expect(settled.unavailable[0]?.state).toBe('unavailable');
    expect(settled.unavailable[0]?.reasonText).toMatch(/could not be restored/);
  });

  it('TBI-004 / VT-36 refuses removal while a turn is running', async () => {
    const store = memoryStore([row({ id: '10000000-0000-4000-8000-000000000033', kind: 'project-repository', state: 'ready', commitSha: SHA })]);
    store.activeRun = true;
    const { manager, calls } = managerFor(store);
    const refused = await manager.remove('10000000-0000-4000-8000-000000000033', SESSION, PROJECT);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('RUN_IN_PROGRESS');
    expect(calls).not.toContain('remove');
  });
});

describe('FEAT-002 cleanup — PBI-009 / PBI-010', () => {
  it('PBI-010 (a2) and (c) / VT-29 / VT-30 deletes clones at 30:00 and keeps them at 29:59', async () => {
    const store = memoryStore([row({ id: '10000000-0000-4000-8000-000000000041', kind: 'project-repository', state: 'ready', commitSha: SHA })]);
    const removed: string[] = [];
    const cleanup = createWorkspaceCleanup({
      store,
      dataRoot: '/data',
      nowMs: () => Date.parse('2026-10-29T12:30:00.000Z'),
      files: {
        renameAway: async (dir) => { removed.push(dir); return 'removed'; },
        remove: async () => {},
        listChildren: async () => [],
      },
      lease: { run: async (_id, _wait, fn) => fn() },
    });
    store.ended.lastActivityAt = '2026-10-29T12:00:01.000Z';
    const kept = await cleanup.sweepInactive(30 * 60_000);
    expect(kept.cleaned).toBe(0);
    expect(store.rows[0].state).toBe('ready');
    store.ended.lastActivityAt = '2026-10-29T12:00:00.000Z';
    const swept = await cleanup.sweepInactive(30 * 60_000);
    expect(swept.cleaned).toBe(1);
    expect(store.rows[0].state).toBe('cleaned');
    expect(store.ended.state).toBe('active');
    expect(removed[0]).toContain('10000000-0000-4000-8000-000000000041');
  });

  it('never marks an MCP server cleaned during an idle sweep, and heals one that was', async () => {
    const mcpRow = row({ id: '10000000-0000-4000-8000-000000000049', kind: 'mcp-server', state: 'ready' });
    const store = memoryStore([mcpRow]);
    const cleanup = createWorkspaceCleanup({
      store,
      dataRoot: '/data',
      nowMs: () => Date.parse('2026-10-29T12:30:00.000Z'),
      files: {
        renameAway: async () => 'removed',
        remove: async () => {},
        listChildren: async () => [],
      },
      lease: { run: async (_id, _wait, fn) => fn() },
    });
    store.ended.lastActivityAt = '2026-10-29T12:00:00.000Z';
    await cleanup.sweepInactive(30 * 60_000);
    expect(store.rows[0].state).toBe('ready');

    store.rows[0].state = 'cleaned';
    const { manager } = managerFor(store);
    const listed = await manager.list(SESSION, PROJECT);
    expect(listed[0]?.state).toBe('ready');
  });

  it('PBI-009 (a) (c) / VT-25 / VT-27 ends the session, removes clones, and repeats the same result', async () => {
    const store = memoryStore([row({ id: '10000000-0000-4000-8000-000000000042', kind: 'project-repository', state: 'ready', commitSha: SHA })]);
    let renames = 0;
    const cleanup = createWorkspaceCleanup({
      store,
      dataRoot: '/data',
      nowMs: () => Date.parse('2026-10-29T12:40:00.000Z'),
      files: {
        renameAway: async () => { renames += 1; return 'removed'; },
        remove: async () => {},
        listChildren: async () => [],
      },
      lease: { run: async (_id, _wait, fn) => fn() },
    });
    const first = await cleanup.endSession({ sessionId: SESSION, project: PROJECT });
    expect(first.session.state).toBe('ended');
    expect(first.cleanup).toBe('complete');
    expect(store.rows[0].state).toBe('removed');
    const again = await cleanup.endSession({ sessionId: SESSION, project: PROJECT });
    expect(again.session.endedAt).toBe(first.session.endedAt);
    expect(renames).toBe(1);
  });
});

describe('FEAT-002 MCP gateway — PBI-007 / TBI-005', () => {
  const connectionId = '30000000-0000-4000-8000-000000000003';
  const operations = [
    { id: 'search', method: 'GET', path: '/search', summary: 'Search', readOnly: true, source: 'mcp' },
    { id: 'delete_user', method: 'POST', path: '/users', summary: 'Delete', readOnly: false, source: 'mcp' },
  ] as unknown as McpServerOperation[];

  beforeEach(() => resetMcpCallLog());

  it('PBI-007 (c) (d) / VT-14 / VT-15 lists only read-only tools and does not call a write tool', async () => {
    const call = jest.fn();
    const gateway = createMcpReadGateway({
      loadConnection: async () => ({ id: connectionId, project: PROJECT, displayName: 'Directory', operations, secret: 'super-secret' }),
      callOperation: call,
      isAttached: async () => true,
    });
    const tools = gateway.listTools({ id: connectionId, project: PROJECT, displayName: 'Directory', operations });
    expect(tools.map((tool) => tool.toolId)).toEqual(['search']);
    expect(tools[0].toolName).toContain('__search');
    const refused = await gateway.invoke({
      project: PROJECT,
      sessionId: SESSION,
      runId: '40000000-0000-4000-8000-000000000004',
      userId: 'u1',
      connectionId,
      toolName: 'delete_user',
      allowedToolNames: tools.map((tool) => tool.toolName),
    });
    expect(refused.ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
    expect(JSON.stringify(refused)).not.toContain('super-secret');
  });

  it('TBI-005 / VT-19 does not refuse a creator who is absent from allowedUserIds', async () => {
    const call = jest.fn().mockResolvedValue({ body: { ok: true } });
    const gateway = createMcpReadGateway({
      loadConnection: async () => ({
        id: connectionId,
        project: PROJECT,
        displayName: 'Directory',
        operations,
        secret: 'super-secret',
      }),
      callOperation: call,
      isAttached: async () => true,
    });
    const tools = gateway.listTools({ id: connectionId, project: PROJECT, displayName: 'Directory', operations });
    const result = await gateway.invoke({
      project: PROJECT,
      sessionId: SESSION,
      runId: '40000000-0000-4000-8000-000000000004',
      userId: 'u1',
      connectionId,
      toolName: tools[0].toolName,
      allowedToolNames: [tools[0].toolName],
    });
    expect(result.ok).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(mcpCallsFor(SESSION, '40000000-0000-4000-8000-000000000004')).toEqual([{ connectionId, toolId: 'search' }]);
  });
});

describe('FEAT-002 citations — PBI-008 / TBI-006', () => {
  it('PBI-008 (b) / VT-23 strips script, handlers, and javascript URLs', () => {
    const clean = sanitizePlainText('<script>alert(1)</script><img src=x onerror=1> [x](javascript:alert(1))');
    expect(clean).not.toMatch(/script|onerror|javascript:/i);
  });

  it('PBI-008 (a) / VT-20 stores the database SHA and ignores a model revision', async () => {
    const saved: StoredCitation[] = [];
    const persistence: CitationPersistence = {
      async insert(input) {
        const stored: StoredCitation = {
          id: '50000000-0000-4000-8000-000000000005',
          messageId: input.messageId,
          sourceKind: input.sourceKind,
          sourceName: input.sourceName,
          path: input.path,
          mcpServerName: input.mcpServerName,
          mcpToolId: input.mcpToolId,
          pinnedRevision: input.pinnedRevision,
          claimText: input.claimText,
          createdAt: '2026-10-29T12:00:00.000Z',
        };
        saved.push(stored);
        return stored;
      },
      async list() { return saved; },
      async messageStatus() { return 'completed'; },
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'brainstorm-cite-'));
    const sourceId = '10000000-0000-4000-8000-000000000051';
    const workspace = path.join(dir, 'brainstorm-workspaces', SESSION, sourceId);
    await writeFile(path.join(dir, 'ignore'), 'x').catch(() => {});
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
    const store = memoryStore([row({
      id: sourceId,
      kind: 'project-repository',
      state: 'ready',
      commitSha: SHA,
      displayName: 'Apex',
    })]);
    const service = createCitationService({
      store,
      dataRoot: dir,
      files: {
        async lstat(filePath) {
          try {
            const { lstat } = await import('node:fs/promises');
            const stat = await lstat(filePath);
            return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() };
          } catch {
            return null;
          }
        },
      },
      persistence,
    });
    const savedCitation = await service.recordRepository({
      sessionId: SESSION,
      project: PROJECT,
      messageId: '60000000-0000-4000-8000-000000000006',
      sourceId,
      requestedPath: 'src/a.ts',
      claim: 'The module exports a',
    });
    const traversal = await service.recordRepository({
      sessionId: SESSION,
      project: PROJECT,
      messageId: '60000000-0000-4000-8000-000000000006',
      sourceId,
      requestedPath: '../../etc/passwd',
      claim: 'nope',
    });
    expect(savedCitation.ok).toBe(true);
    if (savedCitation.ok) expect(savedCitation.citation.revision).toBe(SHA);
    expect(traversal).toEqual({ ok: false, reason: 'bad-path' });
    expect(saved.some((item) => item.claimText.includes('export const'))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('FEAT-002 specification — VT-38', () => {
  it('refuses a source section that drops a required field', () => {
    const sources = buildBrainstormTurnSources({
      ready: [],
      unavailable: [{ ...row({ id: '10000000-0000-4000-8000-000000000061', kind: 'project-repository', state: 'unavailable', displayName: 'Apex', reasonText: 'gone' }) }],
      mcpTools: [],
      limits: LIMITS,
      dataRoot: '/data',
    });
    expect(sources.instructions).toContain('was not searched');
    expect(sources.instructions).toContain(BRAINSTORM_SOURCE_BASE_INSTRUCTIONS.split('\n')[0]);
    expect(isBrainstormTurnSources(sources)).toBe(true);
    const broken = { ...sources, readRoots: undefined };
    expect(isBrainstormTurnSources(broken)).toBe(false);
  });
});

describe('FEAT-002 schema — VT-12', () => {
  it('adds no content or credential column on sources or citations', async () => {
    const sql = await readFile(path.resolve(__dirname, '../../../migrations/20261029183000_b5a1_brainstorm-project-limits.sql'), 'utf8');
    const up = sql.split('-- Down Migration')[0].replace(/--.*$/gm, '');
    expect(up).not.toMatch(/content|credential|secret|blob|password/i);
    expect(up).toContain('brainstorm_project_limits');
  });
});

describe('Brainstorm cloud vs local workspace mount paths', () => {
  it('places new catalog mirrors and session workspaces under <dataRoot>/workspaces while falling back to existing local directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'brainstorm-paths-'));
    const { mkdir } = await import('node:fs/promises');
    const repoId = '10000000-0000-4000-8000-000000000091';
    const sourceId = '10000000-0000-4000-8000-000000000092';

    try {
      // Default for new clones is inside `<dataRoot>/workspaces/...` (shared Azure Files mount)
      expect(brainstormRepositoryMirrorDir(repoId, dir)).toBe(
        path.join(dir, 'workspaces', 'brainstorm-repo-mirrors', repoId),
      );
      expect(sourceWorkspacePath(dir, SESSION, sourceId)).toBe(
        path.join(dir, 'workspaces', 'brainstorm-workspaces', SESSION, sourceId),
      );

      // Existing local directories at `<dataRoot>/brainstorm-...` still resolve until refreshed
      const legacyMirror = path.join(dir, 'brainstorm-repo-mirrors', repoId);
      const legacyWorkspace = path.join(dir, 'brainstorm-workspaces', SESSION, sourceId);
      await mkdir(legacyMirror, { recursive: true });
      await mkdir(legacyWorkspace, { recursive: true });

      expect(brainstormRepositoryMirrorDir(repoId, dir)).toBe(legacyMirror);
      expect(sourceWorkspacePath(dir, SESSION, sourceId)).toBe(legacyWorkspace);

      // Once the shared `/workspaces/...` directory exists, it takes precedence
      const sharedMirror = path.join(dir, 'workspaces', 'brainstorm-repo-mirrors', repoId);
      await mkdir(sharedMirror, { recursive: true });
      expect(brainstormRepositoryMirrorDir(repoId, dir)).toBe(sharedMirror);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves candidate source paths across App Service (/workspaces) and V2 actor container root mounts', async () => {
    expect(
      candidateSourcePaths('/home/data/ai-pilot/workspaces/brainstorm-repo-mirrors/repo-1'),
    ).toEqual([
      '/home/data/ai-pilot/workspaces/brainstorm-repo-mirrors/repo-1',
      '/home/data/ai-pilot/brainstorm-repo-mirrors/repo-1',
    ]);

    expect(
      candidateSourcePaths('/home/data/ai-pilot/brainstorm-repo-mirrors/repo-1'),
    ).toEqual([
      '/home/data/ai-pilot/brainstorm-repo-mirrors/repo-1',
      '/home/data/ai-pilot/workspaces/brainstorm-repo-mirrors/repo-1',
    ]);

    const dest = await mkdtemp(path.join(os.tmpdir(), 'brainstorm-mount-dest-'));
    const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
    const checkout = jest.fn();

    try {
      await mountBrainstormSources({
        sources: {
          readRoots: [
            {
              sourceId: 'source-cloud-1',
              kind: 'project-repository',
              displayName: 'MatterWorx',
              workspacePath: '/home/data/ai-pilot/workspaces/brainstorm-repo-mirrors/repo-1',
              commitSha: SHA,
              provider: 'ado',
              project: PROJECT,
              repository: 'MatterWorx',
            },
          ],
          unavailableSources: [],
          mcpServers: [],
          instructions: '',
        },
        destination: dest,
        signal: AbortSignal.timeout(10_000),
        // Simulate V2 container where the Azure Files share is mounted at `/home/data/ai-pilot`
        pathExists: async (target) => target === '/home/data/ai-pilot/brainstorm-repo-mirrors/repo-1',
        runGit: async (args, cwd) => {
          gitCalls.push({ args, cwd });
        },
        checkout,
      });

      expect(checkout).not.toHaveBeenCalled();
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});
