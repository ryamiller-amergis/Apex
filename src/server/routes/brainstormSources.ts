import { Router, type RequestHandler, type Response } from 'express';
import { promises as dns } from 'node:dns';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isFeatureEnabled } from '../services/featureFlagService';
import { listMcpServers } from '../services/mcpServerConnectionService';
import {
  assertCallerCanUseMcpServer,
  listMountedMcpTools,
} from '../services/mcpServerReadService';
import { listSkillConfigs } from '../services/projectSettingsService';
import {
  assertResolvedProjectRepositoryReady,
  getProjectRepositoryReadiness,
  isRepositoryReady,
  ProjectRepositoryNotReady,
} from '../services/projectRepositoryReadinessService';
import { getRepoCacheDir, readCachedOriginSha, readRepoCacheFreeBytes } from '../services/repoCacheService';
import {
  NonblockingRepoCacheLeaseUnavailableError,
  withRepoCacheLease,
} from '../services/repoCacheLeaseService';
import {
  cloneCachedCommit,
  cloneTemporaryAtSha,
  lockDownClone,
  measureDirectory,
  resolveTemporarySha,
} from '../services/brainstorm/gitSourceClone';
import { readOnlyOperations } from '../services/brainstorm/mcpReadGateway';
import type { SourceWorkspaceStore } from '../services/brainstorm/sourceWorkspaceStore';
import { BRAINSTORM_CREATE, BRAINSTORM_VIEW } from '../../shared/types/brainstorm';
import { appDefaultBrainstormLimits, resolveBrainstormLimits } from '../services/brainstormLimits';
import type { BrainstormSourceOptionsDto } from '../../shared/types/brainstormSources';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { assertCloneHostIsPublic, validateCloneUrl, validateRevision, type DnsLookup } from '../services/brainstorm/cloneUrlValidator';
import { createCitationService, createDrizzleCitationPersistence, type CitationService } from '../services/brainstorm/citationService';
import { createSourceWorkspaceManager, type SourceWorkspaceManager } from '../services/brainstorm/sourceWorkspaceManager';
import { createDrizzleSourceStore } from '../services/brainstorm/sourceWorkspaceStore';
import { createWorkspaceCleanup } from '../services/brainstorm/workspaceCleanupService';
import { resolveDataRoot } from '../utils/dataDir';
import {
  brainstormRepositoryMirrorDir,
  catalogReadiness,
  findBrainstormRepository,
  listBrainstormRepositories,
} from '../services/brainstormRepositoryCatalog';

const attachBody = z.union([
  z.object({ kind: z.literal('project-repository'), skillSettingsId: z.string().uuid() }),
  z.object({ kind: z.literal('temporary-repository'), cloneUrl: z.string(), revision: z.string() }),
  z.object({ kind: z.literal('mcp-server'), connectionId: z.string().uuid() }),
]);

export interface BrainstormSourcesDeps {
  manager: SourceWorkspaceManager;
  citations: CitationService;
  endSession: (input: { sessionId: string; project: string }) => Promise<{
    session: { id: string; state: 'ended'; endedAt: string };
    cleanup: 'complete' | 'pending';
  }>;
  loadLimits: (project: string) => Promise<ReturnType<typeof appDefaultBrainstormLimits>>;
  loadOptions: (project: string, sessionId: string, userId: string) => Promise<BrainstormSourceOptionsDto>;
  describeMcp: (project: string, connectionId: string, userId: string) => Promise<
    | { ok: true; displayName: string; readOnlyToolCount: number }
    | { ok: false; status: number; code: string; error: string }
  >;
  mcpEnabled: (project: string, userId: string) => Promise<boolean>;
  lookup: DnsLookup;
  read: RequestHandler;
  mutate: RequestHandler;
}

interface SessionRequest {
  brainstorm?: { project: string; session: { id: string; project: string } };
}

async function resolveProjectSource(project: string, skillSettingsId: string) {
  const catalog = await findBrainstormRepository(project, skillSettingsId).catch(() => null);
  if (catalog) {
    const readiness = catalogReadiness(catalog.status, catalog.error);
    if (!readiness.ready || !catalog.commitSha) {
      return {
        ok: false as const,
        status: 409 as const,
        code: 'PROJECT_REPOSITORY_NOT_READY',
        error: readiness.text,
      };
    }
    const host = new URL(catalog.cloneUrl).hostname.toLowerCase();
    return {
      ok: true as const,
      displayName: catalog.displayName,
      sha: catalog.commitSha,
      cacheDir: brainstormRepositoryMirrorDir(catalog.id),
      provider: host === 'github.com' || host === 'www.github.com' ? 'github' as const : 'ado' as const,
      repository: catalog.displayName,
      groundingProject: project,
    };
  }
  try {
    await assertResolvedProjectRepositoryReady({
      project,
      settingsId: skillSettingsId,
      surface: 'brainstorm-source',
    });
  } catch (err) {
    if (err instanceof ProjectRepositoryNotReady) {
      return {
        ok: false as const,
        status: 409 as const,
        code: 'PROJECT_REPOSITORY_NOT_READY',
        error: 'A project administrator must clone this repository before it can be attached.',
      };
    }
    return { ok: false as const, status: 404 as const, code: 'NOT_FOUND', error: 'Source not found' };
  }
  const configs = await listSkillConfigs();
  const config = configs.find((item) => item.id === skillSettingsId && item.project === project);
  if (!config?.skillRepo || !config.skillBranch) {
    return { ok: false as const, status: 404 as const, code: 'NOT_FOUND', error: 'Source not found' };
  }
  const provider = config.skillProvider === 'github' ? 'github' as const : 'ado' as const;
  const sha = await readCachedOriginSha({
    provider: provider === 'github' ? 'github' : 'azure_devops',
    project: config.project,
    repository: config.skillRepo,
    branch: config.skillBranch,
  });
  if (!sha) {
    return {
      ok: false as const,
      status: 409 as const,
      code: 'PROJECT_REPOSITORY_NOT_READY',
      error: 'A project administrator must clone this repository before it can be attached.',
    };
  }
  return {
    ok: true as const,
    displayName: config.friendlyName || config.skillRepo,
    sha,
    cacheDir: getRepoCacheDir({ provider, project: config.project, repo: config.skillRepo, branch: config.skillBranch }),
    provider,
    repository: config.skillRepo,
    groundingProject: config.project,
  };
}

async function describeMcpSource(project: string, connectionId: string, userId: string) {
  try {
    await assertCallerCanUseMcpServer({ project, connectionId, userId });
  } catch {
    return { ok: false as const, status: 404, code: 'NOT_FOUND', error: 'Source not found' };
  }
  const tools = readOnlyOperations(await listMountedMcpTools(connectionId));
  if (tools.length === 0) {
    return { ok: false as const, status: 422, code: 'MCP_NO_READ_TOOLS', error: 'No read-only tools available' };
  }
  return { ok: true as const, displayName: tools[0]?.summary || 'MCP server', readOnlyToolCount: tools.length };
}

async function loadSourceOptions(
  project: string,
  sessionId: string,
  userId: string,
  store: SourceWorkspaceStore,
): Promise<BrainstormSourceOptionsDto> {
  const limits = await resolveBrainstormLimits(project);
  const attached = await store.listSession(sessionId, project);
  const configs = (await listSkillConfigs()).filter((item) => item.project === project);
  const repositories = await Promise.all(configs.map(async (config) => {
    const readiness = await getProjectRepositoryReadiness(config.id, { project }).catch(() => null);
    const ready = Boolean(readiness && isRepositoryReady(readiness));
    return {
      skillSettingsId: config.id,
      displayName: config.friendlyName || config.skillRepo,
      ready,
      readinessText: ready
        ? 'Ready to attach'
        : 'A project administrator must clone this repository before it can be attached.',
      alreadyAttached: attached.some((row) => row.refId === config.id && row.state !== 'removed'),
    };
  }));
  const mcpEnabled = await isFeatureEnabled('mcp-servers', { project, userId, caller: 'brainstorm' }).catch(() => false);
  const connections = mcpEnabled ? await listMcpServers(project).catch(() => []) : [];
  const mcpServers = connections.map((server) => ({
    connectionId: server.id,
    displayName: server.name,
    readOnlyToolCount: readOnlyOperations(server.operations).length,
    alreadyAttached: attached.some((row) => row.kind === 'mcp-server' && row.refId === server.id && row.state !== 'removed'),
  }));
  const catalogRows = await listBrainstormRepositories(project).catch(() => []);
  const catalog = catalogRows.map((row) => {
    const readiness = catalogReadiness(row.status, row.error);
    return {
      skillSettingsId: row.id,
      displayName: row.displayName,
      ready: readiness.ready,
      readinessText: readiness.text,
      alreadyAttached: attached.some((item) => item.refId === row.id && item.state !== 'removed'),
    };
  });
  return {
    repositories,
    catalog,
    mcpServers,
    mcpEnabled,
    limits: {
      maxWorkspaceBytes: limits.workspaceMaxBytes,
      maxConcurrentClones: limits.maxConcurrentClones,
    },
  };
}

async function retireClone(dir: string): Promise<'removed' | 'missing' | 'failed'> {
  const trash = `${dir}.removing-${Date.now()}`;
  try {
    await fs.rename(dir, trash);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'failed';
  }
  void fs.rm(trash, { recursive: true, force: true }).catch(() => {});
  return 'removed';
}

function sendFailure(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code });
}

export function createBrainstormSourcesRouter(deps: BrainstormSourcesDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/sources', requirePermission(BRAINSTORM_VIEW), deps.read, async (req, res, next) => {
    try {
      const { project, session } = (req as SessionRequest).brainstorm!;
      res.status(200).json(await deps.manager.list(session.id, project));
    } catch (err) {
      next(err);
    }
  });

  router.get('/sources/options', requirePermission(BRAINSTORM_VIEW), deps.read, async (req, res, next) => {
    try {
      const { project, session } = (req as SessionRequest).brainstorm!;
      res.status(200).json(await deps.loadOptions(project, session.id, getUserId(req)));
    } catch (err) {
      next(err);
    }
  });

  router.get('/citations', requirePermission(BRAINSTORM_VIEW), deps.read, async (req, res, next) => {
    try {
      const { project, session } = (req as SessionRequest).brainstorm!;
      const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : undefined;
      res.status(200).json(await deps.citations.list(session.id, project, messageId));
    } catch (err) {
      next(err);
    }
  });

  router.post('/sources', requirePermission(BRAINSTORM_CREATE), deps.mutate, async (req, res, next) => {
    try {
      const { project, session } = (req as SessionRequest).brainstorm!;
      const parsed = attachBody.safeParse(req.body);
      if (!parsed.success) {
        sendFailure(res, 400, 'INVALID_BODY', 'The source could not be read.');
        return;
      }
      const limits = await deps.loadLimits(project);
      const body = parsed.data;
      if (body.kind === 'project-repository') {
        const result = await deps.manager.attachProject({
          sessionId: session.id, project, skillSettingsId: body.skillSettingsId, limits,
        });
        if (!result.ok) {
          sendFailure(res, result.status, result.code, result.error);
          return;
        }
        res.status(result.status).json({ source: result.source });
        if (result.clone) void deps.manager.completeProjectClone(result.source.id, session.id, project, limits);
        return;
      }
      if (body.kind === 'mcp-server') {
        const mcpOn = await deps.mcpEnabled(project, getUserId(req));
        // @feature-flag:mcp-servers start winner=enabled
        if (!mcpOn) {
          // @feature-flag:mcp-servers disabled-start
          sendFailure(res, 409, 'MCP_DISABLED', 'MCP servers are off for this project.');
          return;
          // @feature-flag:mcp-servers disabled-end
        }
        // @feature-flag:mcp-servers enabled-start
        const described = await deps.describeMcp(project, body.connectionId, getUserId(req));
        if (!described.ok) {
          sendFailure(res, described.status, described.code, described.error);
          return;
        }
        const result = await deps.manager.attachMcp({
          sessionId: session.id,
          project,
          connectionId: body.connectionId,
          displayName: described.displayName,
          readOnlyToolCount: described.readOnlyToolCount,
        });
        res.status(result.status).json({ source: result.source });
        // @feature-flag:mcp-servers enabled-end
        // @feature-flag:mcp-servers end
        return;
      }
      const urlCheck = validateCloneUrl(body.cloneUrl);
      if (!urlCheck.ok) {
        sendFailure(res, 400, urlCheck.code, urlCheck.error);
        return;
      }
      const revisionCheck = validateRevision(body.revision);
      if (!revisionCheck.ok) {
        sendFailure(res, 400, revisionCheck.code, revisionCheck.error);
        return;
      }
      const hostCheck = await assertCloneHostIsPublic(urlCheck.url, deps.lookup);
      if (!hostCheck.ok) {
        sendFailure(res, 400, hostCheck.code, hostCheck.error);
        return;
      }
      const result = await deps.manager.attachTemporary({
        sessionId: session.id,
        project,
        cloneUrl: urlCheck.url.toString(),
        revision: body.revision.trim(),
        displayName: urlCheck.url.hostname + urlCheck.url.pathname,
        limits,
      });
      if (!result.ok) {
        sendFailure(res, result.status, result.code, result.error);
        return;
      }
      res.status(result.status).json({ source: result.source });
      if (result.clone) void deps.manager.completeTemporaryClone(result.source.id, session.id, project, limits);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/sources/:sourceId', requirePermission(BRAINSTORM_CREATE), deps.mutate, async (req, res, next) => {
    try {
      const { project, session } = (req as SessionRequest).brainstorm!;
      const result = await deps.manager.remove(req.params.sourceId, session.id, project);
      if (!result.ok) {
        sendFailure(res, result.status, result.code, result.error);
        return;
      }
      res.status(200).json({ source: result.source });
    } catch (err) {
      next(err);
    }
  });

  router.post('/end', requirePermission(BRAINSTORM_CREATE), deps.mutate, async (req, res, next) => {
    try {
      const { project, session } = (req as SessionRequest).brainstorm!;
      res.status(200).json(await deps.endSession({ sessionId: session.id, project }));
    } catch (err) {
      const coded = err as { status?: number; code?: string };
      if (coded.status && coded.code) {
        sendFailure(res, coded.status, coded.code, coded.code);
        return;
      }
      next(err);
    }
  });

  return router;
}

export interface BrainstormSourceRuntime extends Omit<BrainstormSourcesDeps, 'read' | 'mutate'> {
  runMaintenance(): Promise<void>;
}

let runtime: BrainstormSourceRuntime | null = null;

export function brainstormSourceRuntime(): BrainstormSourceRuntime {
  if (runtime) return runtime;
  const store = createDrizzleSourceStore();
  const dataRoot = resolveDataRoot();
  const manager = createSourceWorkspaceManager({
    store,
    dataRoot,
    files: {
      measure: (dir) => measureDirectory(dir),
      remove: async (dir) => { await fs.rm(dir, { recursive: true, force: true }); },
      renameAway: (dir) => retireClone(dir),
      exists: async (dir) => {
        try {
          await fs
            .stat(path.join(dir, '.apex-brainstorm-ready'))
            .catch(() => fs.stat(path.join(dir, '.git')));
          return true;
        } catch {
          return false;
        }
      },
      freeBytes: () => readRepoCacheFreeBytes().catch(() => null),
    },
    git: {
      cloneFromCache: (input) => cloneCachedCommit(input),
      resolveTemporary: (input) => resolveTemporarySha(input),
      cloneTemporary: (input) => cloneTemporaryAtSha(input),
      lockDown: (destination) => lockDownClone(destination),
    },
    projects: { resolve: resolveProjectSource },
  });
  const cleanup = createWorkspaceCleanup({
    store,
    dataRoot,
    nowMs: () => Date.now(),
    files: {
      renameAway: (dir) => retireClone(dir),
      remove: async (dir) => { await fs.rm(dir, { recursive: true, force: true }); },
      listChildren: async (dir) => fs.readdir(dir).catch(() => []),
    },
    lease: {
      async run(sessionId, waitMs, fn) {
        try {
          return await withRepoCacheLease(`brainstorm-session-workspace:${sessionId}`, async () => fn(), { waitMs });
        } catch (err) {
          if (err instanceof NonblockingRepoCacheLeaseUnavailableError) return 'busy';
          throw err;
        }
      },
    },
  });
  runtime = {
    manager,
    citations: createCitationService({
      store,
      dataRoot,
      files: {
        async lstat(filePath) {
          try {
            const stat = await fs.lstat(filePath);
            return { isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() };
          } catch {
            return null;
          }
        },
      },
      persistence: createDrizzleCitationPersistence(),
    }),
    endSession: (input) => cleanup.endSession(input),
    loadLimits: (project) => resolveBrainstormLimits(project),
    loadOptions: (project, sessionId, userId) => loadSourceOptions(project, sessionId, userId, store),
    describeMcp: describeMcpSource,
    mcpEnabled: async (project, userId) => {
      const { isFeatureEnabled } = await import('../services/featureFlagService');
      return isFeatureEnabled('mcp-servers', { project, userId, caller: 'brainstorm' }).catch(() => false);
    },
    lookup: async (hostname) => {
      const looked = await dns.lookup(hostname, { all: true });
      return looked.map((entry) => entry.address);
    },
    runMaintenance: async () => {
      const limits = appDefaultBrainstormLimits();
      await cleanup.sweepInactive(limits.inactivityMs);
      await cleanup.reconcile();
    },
  };
  return runtime;
}

export function buildBrainstormSourcesDeps(
  guards: Pick<BrainstormSourcesDeps, 'read' | 'mutate'>,
): BrainstormSourcesDeps {
  return { ...brainstormSourceRuntime(), ...guards };
}
