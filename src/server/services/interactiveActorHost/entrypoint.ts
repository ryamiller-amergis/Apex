/**
 * FEAT-007 / TBI-010 — long-running Azure Container Apps host for the
 * interactive AI-runs lane.
 *
 * Boots a Dapr server that registers the interactive session actor type for
 * this host's Dapr app ID (one activation per `threadId`) and exposes a single `dispatch` service-invocation
 * method. The Apex API (App Service, no Dapr sidecar) posts turn dispatches to
 * this host's ingress; the handler resolves the thread's actor proxy through
 * the local Dapr sidecar and invokes `handleTurn`. The actor then fetches the
 * frozen bootstrap snapshot, runs the turn over a warm grounded checkout, and
 * streams batched events back through the fenced runner ingest.
 *
 * Client fan-out is NOT owned here: the durable spine is `agent_run_events`
 * (written by ingest) and the WebSocket gateway is mounted on the App Service.
 * This host never owns a client socket and never logs prompt/snapshot/secret.
 */
import {
  ActorId,
  ActorProxyBuilder,
  CommunicationProtocolEnum,
  DaprServer,
  HttpMethod,
  type DaprInvokerCallbackContent,
} from '@dapr/dapr';
import crypto from 'crypto';
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
// Side-effect: initialize Application Insights when the connection string is set.
import '../telemetry';
import { resolveDataRoot } from '../../utils/dataDir';
import { exitAfterFlush } from '../../utils/processExit';
import {
  isInteractiveActorBootstrap,
  type InteractiveActorBootstrap,
} from '../../../shared/types/aiRunIngest';
import type { RepoReader, RepositoryIdentity } from '../../../shared/types/repoReader';
import { getAiRunnerCallbackToken } from '../aiRunsCallbackToken';
import {
  createAiRunsCallbackClient,
  retriedCallbackBudgetMs,
} from '../aiRunsWorker/callbackClient';
import {
  artifactContainerName,
  resolveArtifactContainerClient,
} from '../aiRunV2/artifactContainer';
import { createArtifactUploader } from '../aiRunsV2Worker/artifactUploader';
import { resolveShutdownDrainMs } from '../aiRunsV2Worker/shutdownDrain';
import { interactiveLiveBus } from '../interactiveLiveBus';
import { LocalCheckoutReader } from '../localCheckoutReader';
import { boundedSearchLimit } from '../repoReader';
import { BareRepoReader } from '../repoRead/bareRepoReader';
import {
  RepoServiceReader,
  resolveRepoReadServiceUrl,
} from '../repoRead/repoServiceReader';
import { acquireInteractiveCursorAgent } from './interactiveCursorExecution';
import {
  checkoutWithDiskReclaim,
  createGroundedRepositoryCheckout,
} from './groundedRepositoryCheckout';
import {
  createInteractiveSessionActor,
  type WarmThreadCheckout,
} from './interactiveSessionActor';
import { collectInteractiveArtifacts } from './interactiveArtifactCollector';
import { materializeInteractiveWorkspace } from './interactiveWorkspaceMaterializer';
import { mountBrainstormSources, turnReadSources } from './brainstormSourceMount';
import { defaultRunGit } from '../grounding/bundleCheckout';
import { createPerThreadTurnQueue } from './perThreadTurnQueue';
import {
  createActorInvocationStallTracker,
  createCachedHealthCheck,
  createDaprSidecarClient,
  createSidecarHealthMonitor,
  interactiveHealthRoute,
  type ActorInvocationStallTracker,
} from './sidecarHealth';
import {
  createInteractiveShutdownDrain,
  interactiveInFlightInvocations,
} from './shutdownDrain';
import {
  interactiveSessionActorClassFor,
  setInteractiveActorRuntime,
  type IInteractiveSessionActor,
} from './interactiveSessionActorClass';

const INTERACTIVE_CALLBACK_REQUEST_TIMEOUT_MS = 12_000;

/**
 * The actor replies once the dispatch fence is verified. This must outlast the
 * bootstrap read with all its retries: the timed-out call is not cancelled, so
 * a shorter limit fails a turn the actor is still about to start.
 */
export const INTERACTIVE_ACTOR_INVOKE_TIMEOUT_MS =
  retriedCallbackBudgetMs(INTERACTIVE_CALLBACK_REQUEST_TIMEOUT_MS) + 10_000;

export class ActorInvokeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Interactive actor invocation timed out after ${timeoutMs}ms`);
    this.name = 'ActorInvokeTimeoutError';
  }
}

function withinActorInvokeTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActorInvokeTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Warm checkout carrying the reader the execution factory needs. */
type ReaderCheckout = WarmThreadCheckout & { reader: RepoReader };

function parseBrainstormSourcePath(
  requestedPath: string,
  readRoots: ReadonlyArray<{
    sourceId: string;
    displayName: string;
    repository: string;
  }> = [],
): { sourceId: string; innerPath: string } | null {
  const trimmed = requestedPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed || trimmed === 'sources') return null;

  const withoutPrefix = trimmed.startsWith('sources/')
    ? trimmed.slice('sources/'.length)
    : trimmed;
  const slash = withoutPrefix.indexOf('/');
  const head = slash === -1 ? withoutPrefix : withoutPrefix.slice(0, slash);
  const innerPath = slash === -1 ? '' : withoutPrefix.slice(slash + 1);
  if (!head) return null;

  if (readRoots.length > 0) {
    const headLower = head.toLowerCase();
    const matched = readRoots.find((root) => {
      const bareRepo = (root.repository.split('/').pop() || root.repository).toLowerCase();
      return (
        root.sourceId.toLowerCase() === headLower ||
        root.displayName.trim().toLowerCase() === headLower ||
        root.repository.trim().toLowerCase() === headLower ||
        bareRepo === headLower
      );
    });
    if (matched) {
      return { sourceId: matched.sourceId, innerPath };
    }
  }

  if (trimmed.startsWith('sources/')) {
    return { sourceId: head, innerPath };
  }
  return null;
}

function inferBrainstormSourceFromQuery(
  query: string,
  readRoots: ReadonlyArray<{
    sourceId: string;
    displayName: string;
    repository: string;
  }>,
): string | null {
  const matches: string[] = [];
  for (const root of readRoots) {
    const candidates = new Set(
      [
        root.displayName.trim(),
        root.repository.trim(),
        root.repository.split('/').pop()?.trim() ?? '',
      ].filter((name) => name.length >= 3),
    );
    for (const candidate of candidates) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(query)) {
        matches.push(root.sourceId);
        break;
      }
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function safeCacheSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'repo'
  );
}

function candidateLocalBareMirrorDirs(identity: RepositoryIdentity): string[] {
  const cacheBase = path.join(resolveDataRoot(), 'repo-cache');
  const bareRepo =
    identity.provider === 'github'
      ? identity.repo.split('/').pop() || identity.repo
      : identity.repo;
  const candidates: string[] = [];
  for (const repoVariant of new Set([bareRepo, identity.repo])) {
    const rawIdentity = [identity.provider, identity.project, repoVariant].join('\0');
    const readable = [
      identity.provider,
      safeCacheSlug(identity.project),
      safeCacheSlug(repoVariant),
    ].join('-');
    const hash = crypto.createHash('sha256').update(rawIdentity).digest('hex').slice(0, 12);
    candidates.push(path.join(cacheBase, `${readable}-${hash}.git`));
  }
  return candidates;
}

async function openLocalBareMirrorReader(
  identity: RepositoryIdentity,
): Promise<RepoReader | null> {
  for (const mirrorPath of candidateLocalBareMirrorDirs(identity)) {
    try {
      await fs.stat(path.join(mirrorPath, 'HEAD'));
      const bareRepo =
        identity.provider === 'github'
          ? identity.repo.split('/').pop() || identity.repo
          : identity.repo;
      const reader = new BareRepoReader({
        identity: { ...identity, repo: bareRepo },
        mirrorPath,
      });
      await reader.listDir('');
      return reader;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

export function createBrainstormWorkspaceReader(input: {
  destination: string;
  primaryReader: RepoReader;
  remotePrimaryReader: RepoReader | null;
  bootstrap: InteractiveActorBootstrap;
  openBareSourceReader?: (root: {
    provider: 'github' | 'ado';
    project: string;
    repository: string;
    commitSha: string;
  }) => Promise<RepoReader | null>;
}): RepoReader {
  const readRoots = turnReadSources(input.bootstrap.specification)?.readRoots ?? [];
  if (readRoots.length === 0) return input.primaryReader;

  const localReader = new LocalCheckoutReader({
    checkoutPath: input.destination,
    identity: input.primaryReader.identity,
  });
  const serviceUrl = resolveRepoReadServiceUrl();
  const grounding = input.bootstrap.specification.grounding;

  const hasLocalSourceCheckout = async (sourceId: string): Promise<boolean> => {
    try {
      await fs.stat(path.join(input.destination, 'sources', sourceId, '.git'));
      return true;
    } catch {
      return false;
    }
  };

  const remoteReaderForSource = async (sourceId: string): Promise<RepoReader | null> => {
    const root = readRoots.find((item) => item.sourceId === sourceId);
    if (!root) return null;
    if (input.openBareSourceReader) {
      const bareReader = await input.openBareSourceReader(root).catch(() => null);
      if (bareReader) return bareReader;
    }
    if (
      input.remotePrimaryReader &&
      grounding &&
      grounding.sha.toLowerCase() === root.commitSha.toLowerCase()
    ) {
      return input.remotePrimaryReader;
    }
    const identity: RepositoryIdentity = {
      provider: root.provider,
      project: root.project,
      repo: root.repository,
      sha: root.commitSha,
    };
    const localBare = await openLocalBareMirrorReader(identity);
    if (localBare) return localBare;
    if (serviceUrl) {
      return new RepoServiceReader({
        identity,
        baseUrl: serviceUrl,
      });
    }
    return null;
  };

  return {
    identity: input.primaryReader.identity,
    async readFile(filePath: string): Promise<string> {
      const parsed = parseBrainstormSourcePath(filePath, readRoots);
      if (!parsed) {
        return input.primaryReader.readFile(filePath);
      }
      if (await hasLocalSourceCheckout(parsed.sourceId)) {
        return localReader.readFile(`sources/${parsed.sourceId}/${parsed.innerPath}`);
      }
      const remote = await remoteReaderForSource(parsed.sourceId);
      if (remote) {
        return remote.readFile(parsed.innerPath);
      }
      return localReader.readFile(`sources/${parsed.sourceId}/${parsed.innerPath}`);
    },
    async listDir(dirPath: string) {
      const normalized = dirPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (normalized === 'sources') {
        return readRoots.map((root) => ({
          path: `/sources/${root.sourceId}`,
          name: root.sourceId,
          isFolder: true,
        }));
      }
      const parsed = parseBrainstormSourcePath(dirPath, readRoots);
      if (!parsed) {
        return input.primaryReader.listDir(dirPath);
      }
      const canonicalDir = parsed.innerPath
        ? `sources/${parsed.sourceId}/${parsed.innerPath}`
        : `sources/${parsed.sourceId}`;
      if (await hasLocalSourceCheckout(parsed.sourceId)) {
        return localReader.listDir(canonicalDir);
      }
      const remote = await remoteReaderForSource(parsed.sourceId);
      if (remote) {
        const entries = await remote.listDir(parsed.innerPath);
        return entries.map((entry) => ({
          ...entry,
          path: `/sources/${parsed.sourceId}/${entry.path.replace(/^\/+/, '')}`,
        }));
      }
      return localReader.listDir(canonicalDir);
    },
    async searchCode(query: string, limit?: number, scopedPath?: string) {
      const explicitScope = scopedPath?.trim()
        ? parseBrainstormSourcePath(scopedPath, readRoots)
        : null;
      const inferredSourceId =
        !explicitScope && !scopedPath?.trim()
          ? inferBrainstormSourceFromQuery(query, readRoots)
          : null;
      const parsedScope =
        explicitScope ??
        (inferredSourceId ? { sourceId: inferredSourceId, innerPath: '' } : null);

      if (parsedScope) {
        const innerScope = parsedScope.innerPath || undefined;
        const canonicalScope = innerScope
          ? `sources/${parsedScope.sourceId}/${innerScope}`
          : `sources/${parsedScope.sourceId}`;
        if (await hasLocalSourceCheckout(parsedScope.sourceId)) {
          return localReader.searchCode(query, limit, canonicalScope).catch(() => []);
        }
        const remote = await remoteReaderForSource(parsedScope.sourceId);
        if (!remote) return [];
        const hits = await remote
          .searchCode(query, limit, ...(innerScope ? [innerScope] : []))
          .catch(() => []);
        const byScopedPath = new Map<string, (typeof hits)[number]>();
        for (const hit of hits) {
          const prefixedPath = `sources/${parsedScope.sourceId}/${hit.path.replace(/^\/+/, '')}`;
          if (!byScopedPath.has(prefixedPath)) {
            byScopedPath.set(prefixedPath, { ...hit, path: prefixedPath });
          }
        }
        return [...byScopedPath.values()];
      }

      const maxResults = boundedSearchLimit(limit);
      const nonSourceScope = scopedPath?.trim() || undefined;
      if (nonSourceScope && nonSourceScope.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') !== 'sources') {
        return input.primaryReader
          .searchCode(query, limit, nonSourceScope)
          .catch(() => []);
      }

      const byPath = new Map<string, Awaited<ReturnType<RepoReader['searchCode']>>[number]>();
      const primaryShaInRoots = Boolean(
        grounding &&
          readRoots.some(
            (root) => root.commitSha.toLowerCase() === grounding.sha.toLowerCase(),
          ),
      );
      if (!primaryShaInRoots && !nonSourceScope) {
        const primaryResults = await input.primaryReader
          .searchCode(query, maxResults)
          .catch(() => []);
        for (const item of primaryResults) {
          if (byPath.size >= maxResults) break;
          if (!byPath.has(item.path)) byPath.set(item.path, item);
        }
      }

      for (const root of readRoots) {
        if (byPath.size >= maxResults) break;
        const remaining = maxResults - byPath.size;
        if (await hasLocalSourceCheckout(root.sourceId)) {
          const localHits = await localReader
            .searchCode(query, remaining, `sources/${root.sourceId}`)
            .catch(() => []);
          for (const hit of localHits) {
            if (byPath.size >= maxResults) break;
            if (!byPath.has(hit.path)) byPath.set(hit.path, hit);
          }
          continue;
        }
        const remote = await remoteReaderForSource(root.sourceId);
        if (!remote) continue;
        const hits = await remote.searchCode(query, remaining).catch(() => []);
        for (const hit of hits) {
          if (byPath.size >= maxResults) break;
          const prefixedPath = `sources/${root.sourceId}/${hit.path.replace(/^\/+/, '')}`;
          if (!byPath.has(prefixedPath)) {
            byPath.set(prefixedPath, { ...hit, path: prefixedPath });
          }
        }
      }
      return [...byPath.values()];
    },
  };
}

async function openPinnedReaderForBootstrap(
  bootstrap: InteractiveActorBootstrap,
): Promise<RepoReader | null> {
  const grounding = bootstrap.specification.grounding;
  if (!grounding) return null;
  const identity: RepositoryIdentity = {
    provider: grounding.provider,
    project: grounding.project,
    repo: grounding.repository,
    sha: grounding.sha,
  };
  const localBareReader = await openLocalBareMirrorReader(identity);
  if (localBareReader) {
    return localBareReader;
  }
  const serviceUrl = resolveRepoReadServiceUrl();
  if (!serviceUrl) {
    if (bootstrap.specification.workflowClass === 'brainstorm') {
      return null;
    }
    throw new Error(
      'Pinned grounding repository is unavailable: repo-read service URL is not configured',
    );
  }
  try {
    const reader = new RepoServiceReader({ identity, baseUrl: serviceUrl });
    await reader.listDir('');
    return reader;
  } catch (error) {
    if (bootstrap.specification.workflowClass === 'brainstorm') {
      return null;
    }
    const reason =
      error instanceof Error ? error.message : 'pinned repo-read open failed';
    throw new Error(`Pinned grounding repository is unavailable: ${reason}`);
  }
}

export interface InteractiveDispatchRequest {
  threadId: string;
  runId: string;
  dispatchMessageId: string;
}

interface InteractiveDispatchInvoker {
  listen(
    methodName: string,
    callback: (data: DaprInvokerCallbackContent) => Promise<unknown>,
    options: { method: HttpMethod }
  ): Promise<unknown>;
}

function parseDispatchBody(body: string | undefined): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Interactive dispatch body must be valid JSON');
  }
}

/**
 * Serialize an unknown thrown value into structured, log-safe fields. The
 * dispatch and fatal handlers previously logged only error.name, which reduced
 * every actor failure to the opaque errorType "Error" - impossible to
 * diagnose without a redeploy. We now surface message, stack, and any nested
 * `cause` so the failing stage (grounding, checkout, Cursor SDK) is visible in
 * Container Apps logs. These frames never contain prompt/snapshot/secret data.
 */
function describeError(error: unknown): {
  errorType: string;
  errorMessage?: string;
  errorStack?: string;
  errorCause?: string;
} {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return {
      errorType: error.name || 'Error',
      errorMessage: error.message,
      errorStack: error.stack,
      errorCause:
        cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : cause != null
            ? String(cause)
            : undefined,
    };
  }
  let errorMessage: string;
  try {
    errorMessage = typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    errorMessage = String(error);
  }
  return { errorType: 'UnknownError', errorMessage };
}

export function parseInteractiveDispatchRequest(
  content: DaprInvokerCallbackContent
): InteractiveDispatchRequest {
  const payload = parseDispatchBody(
    content.body
  ) as Partial<InteractiveDispatchRequest> | null;
  if (
    !payload ||
    typeof payload.threadId !== 'string' ||
    typeof payload.runId !== 'string' ||
    typeof payload.dispatchMessageId !== 'string'
  ) {
    throw new Error(
      'Interactive dispatch requires threadId, runId, and dispatchMessageId'
    );
  }
  return {
    threadId: payload.threadId,
    runId: payload.runId,
    dispatchMessageId: payload.dispatchMessageId,
  };
}

export interface InteractiveDispatchDrain {
  isDraining(): boolean;
  track<T>(work: () => Promise<T>): Promise<T>;
}

const NO_DISPATCH_DRAIN: InteractiveDispatchDrain = {
  isDraining: () => false,
  track: (work) => work(),
};

export async function registerInteractiveDispatchHandler(
  invoker: InteractiveDispatchInvoker,
  resolveActor: (threadId: string) => IInteractiveSessionActor,
  recoverActorFailure?: (
    payload: InteractiveDispatchRequest,
    error: unknown
  ) => Promise<void>,
  drain: InteractiveDispatchDrain = NO_DISPATCH_DRAIN,
  actorInvokeTimeoutMs: number = INTERACTIVE_ACTOR_INVOKE_TIMEOUT_MS,
  invocationStall?: Pick<ActorInvocationStallTracker, 'recordCompleted' | 'recordTimedOut'>
): Promise<void> {
  await invoker.listen(
    'dispatch',
    async (content) => {
      let payload: InteractiveDispatchRequest;
      try {
        payload = parseInteractiveDispatchRequest(content);
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'InteractiveDispatchRejected',
            ...describeError(error),
          })
        );
        return { accepted: false };
      }
      // The orchestrator retries a refused dispatch, which then lands on a replica
      // that is not shutting down.
      if (drain.isDraining()) {
        console.warn(
          JSON.stringify({
            event: 'InteractiveDispatchRefusedDraining',
            threadId: payload.threadId,
            runId: payload.runId,
            dispatchMessageId: payload.dispatchMessageId,
          })
        );
        return { accepted: false };
      }
      console.log(
        JSON.stringify({
          event: 'InteractiveDispatchAccepted',
          threadId: payload.threadId,
          runId: payload.runId,
          dispatchMessageId: payload.dispatchMessageId,
        })
      );
      const actor = resolveActor(payload.threadId);
      void drain
        .track(() =>
          withinActorInvokeTimeout(
            actor.handleTurn({
              runId: payload.runId,
              dispatchMessageId: payload.dispatchMessageId,
            }),
            actorInvokeTimeoutMs
          )
        )
        .then((outcome) => {
          invocationStall?.recordCompleted();
          console.log(
            JSON.stringify({
              event: 'InteractiveDispatchCompleted',
              threadId: payload.threadId,
              runId: payload.runId,
              dispatchMessageId: payload.dispatchMessageId,
              status: outcome.status,
            })
          );
        })
        .catch(async (error) => {
          const timedOut = error instanceof ActorInvokeTimeoutError;
          console.error(
            JSON.stringify({
              event: 'InteractiveDispatchFailed',
              threadId: payload.threadId,
              runId: payload.runId,
              dispatchMessageId: payload.dispatchMessageId,
              ...describeError(error),
            })
          );
          if (!recoverActorFailure) {
            if (timedOut) invocationStall?.recordTimedOut();
            return;
          }
          try {
            await recoverActorFailure(payload, error);
            // Recovery reached App Service, so the actor call itself is what
            // stalled; an App Service outage must not restart healthy replicas.
            if (timedOut) invocationStall?.recordTimedOut();
            console.log(
              JSON.stringify({
                event: 'InteractiveDispatchFailureRecovered',
                threadId: payload.threadId,
                runId: payload.runId,
                dispatchMessageId: payload.dispatchMessageId,
              })
            );
          } catch (recoveryError) {
            console.error(
              JSON.stringify({
                event: 'InteractiveDispatchFailureRecoveryFailed',
                threadId: payload.threadId,
                runId: payload.runId,
                dispatchMessageId: payload.dispatchMessageId,
                ...describeError(recoveryError),
              })
            );
          }
        });
      return { accepted: true };
    },
    { method: HttpMethod.POST }
  );
}

export async function main(): Promise<void> {
  const callbackBaseUrl =
    process.env.APEX_CALLBACK_URL?.trim() ||
    process.env.AI_RUNS_APEX_CALLBACK_BASE_URL?.trim() ||
    '';
  if (!callbackBaseUrl) {
    throw new Error('APEX_CALLBACK_URL is required');
  }
  const serverPort =
    process.env.AI_RUNS_INTERACTIVE_TARGET_PORT?.trim() ||
    process.env.PORT?.trim() ||
    '8080';

  // Bootstrap is fetched before the execution specification exists, so this
  // limit cannot come from it. Four attempts plus backoff stay under the
  // reaper's 60s start timeout.
  const callback = createAiRunsCallbackClient({
    callbackBaseUrl,
    getToken: getAiRunnerCallbackToken,
    requestTimeoutMs: INTERACTIVE_CALLBACK_REQUEST_TIMEOUT_MS,
  });

  const repositoryCheckout = createGroundedRepositoryCheckout();

  const turnQueue = createPerThreadTurnQueue();

  // Single shared logic core: thread-keyed warm checkout + live Agent cache.
  const logic = createInteractiveSessionActor({
    turnQueue,
    openWarmCheckout: async (_threadId, snapshot) => {
      // Dynamic import keeps the actor-host static graph free of App Service
      // workspace helpers that transitively import PostgreSQL.
      const { openGroundedReader } = await import('../aiRunsWorker/workspace');
      const reader = await openGroundedReader(snapshot);
      const checkout: ReaderCheckout = {
        workspacePath: snapshot.workspaceRef,
        reader,
      };
      return checkout;
    },
    acquireAgent: (snapshot, checkout, options) =>
      acquireInteractiveCursorAgent(
        {
          model: snapshot.model,
          effort: snapshot.effort ?? null,
          workspaceRef: snapshot.workspaceRef,
          interviewPhase: null,
        },
        (checkout as ReaderCheckout).reader,
        {
          resumeAgentId: options.resumeAgentId,
          mcpServers: options.mcpServers ?? {},
        },
      ).then((acquired) => acquired.handle),
    acquireDurableAgent: async (bootstrap, checkout, options) =>
      acquireInteractiveCursorAgent(
        {
          model: bootstrap.specification.model,
          effort: bootstrap.specification.effort,
          workspaceRef: checkout.workspacePath,
          interviewPhase: bootstrap.specification.guidedInterview?.phase ?? null,
        },
        (checkout as ReaderCheckout).reader,
        {
          resumeAgentId: options.resumeAgentId,
          mcpServers: bootstrap.mcpServers,
        },
      ),
    materializeWorkspace: async (bootstrap, destination, signal, options) => {
      const grounding = bootstrap.specification.grounding;
      const isBrainstorm = bootstrap.specification.workflowClass === 'brainstorm';
      await fs.mkdir(destination, { recursive: true });
      const checkout =
        grounding && !isBrainstorm
          ? await checkoutWithDiskReclaim({
              repositoryCheckout,
              grounding,
              destination,
              signal,
              reclaimDisk: options?.reclaimDisk,
              log: (result, retried) =>
                console.log(
                  JSON.stringify({
                    event: 'InteractiveRepositoryCheckout',
                    runId: bootstrap.runId,
                    status: result.status,
                    detail: result.status === 'ready' ? result.source : result.reason,
                    durationMs: result.durationMs,
                    ...(retried ? { retriedAfterReclaim: true } : {}),
                  }),
                ),
            })
          : null;

      const openBareReaderForGrounding = async (
        target: NonNullable<typeof grounding>,
      ): Promise<RepoReader | null> => {
        const bare = await repositoryCheckout.ensureBare(target, signal);
        if (bare.status !== 'ready') return null;
        return new BareRepoReader({
          identity: bare.identity,
          mirrorPath: bare.mirrorPath,
        });
      };

      const reader =
        checkout?.status === 'ready'
          ? new LocalCheckoutReader({
              checkoutPath: destination,
              identity: checkout.identity,
            })
          : isBrainstorm
            ? null
            : await openPinnedReaderForBootstrap(bootstrap);
      // Turn outputs from a prior turn on this thread must not be re-uploaded.
      await fs
        .rm(path.join(destination, '.ai-pilot', 'output'), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
      await fs
        .rm(path.join(destination, '.ai-pilot', 'kickoff-transcript.md'), {
          force: true,
        })
        .catch(() => {});
      // A retried turn rewrites its own attachments, which are created exclusively.
      await fs
        .rm(
          path.join(
            destination,
            '.ai-pilot',
            'attachments',
            bootstrap.specification.turnId,
          ),
          { recursive: true, force: true },
        )
        .catch(() => {});
      // For Brainstorm turns, local directory clones on the same machine are
      // linked immediately, while cloud Blob bundles are read directly from
      // bare repositories (`ensureBare` + `BareRepoReader`) without unpacking
      // multi-GB working trees into `destination/sources/` before the turn starts.
      // Interview reference repositories follow the Brainstorm path: a missing
      // local clone is read lazily from its bare mirror rather than failing the turn.
      const readsSourcesLazily =
        isBrainstorm || bootstrap.specification.workflowClass === 'interview';
      const readSources = turnReadSources(bootstrap.specification);
      await mountBrainstormSources({
        sources: readSources,
        destination,
        signal,
        runGit: async (args, cwd) => {
          await defaultRunGit(cwd ? ['-C', cwd, ...args] : args, { signal });
        },
        checkout: readsSourcesLazily
          ? async () => ({ status: 'deferred' })
          : (sourceGrounding, sourceDestination, sourceSignal) =>
              repositoryCheckout.checkout(
                sourceGrounding,
                sourceDestination,
                sourceSignal,
              ),
      });
      if (isBrainstorm || (readSources?.readRoots.length ?? 0) > 0) {
        const rootsToWarm = readSources?.readRoots ?? [];
        void (async () => {
          if (isBrainstorm && grounding && !signal.aborted) {
            await repositoryCheckout.ensureBare(grounding, signal).catch(() => {});
          }
          for (const root of rootsToWarm) {
            if (signal.aborted) break;
            await repositoryCheckout
              .ensureBare(
                {
                  provider: root.provider,
                  project: root.project,
                  repository: root.repository,
                  sha: root.commitSha,
                  profileId: 'brainstorm-source',
                },
                signal,
              )
              .catch(() => {});
          }
        })();
      }
      await materializeInteractiveWorkspace({
        reader: null,
        destination,
        attachments: bootstrap.specification.currentMessage.attachments,
        readAttachment: async (attachment) => {
          const client = resolveArtifactContainerClient(
            attachment.blobRef.container,
          );
          return client
            .getBlockBlobClient(attachment.blobRef.key)
            .downloadToBuffer();
        },
        signal,
      });

      let resolvedPrimaryReader: RepoReader | null = reader;
      const resolveBrainstormPrimaryReader = async (): Promise<RepoReader> => {
        if (resolvedPrimaryReader) return resolvedPrimaryReader;
        if (grounding) {
          const bare = await openBareReaderForGrounding(grounding).catch(() => null);
          if (bare) {
            resolvedPrimaryReader = bare;
            return bare;
          }
        }
        const pinned = await openPinnedReaderForBootstrap(bootstrap).catch(() => null);
        if (pinned) {
          resolvedPrimaryReader = pinned;
          return pinned;
        }
        resolvedPrimaryReader = new LocalCheckoutReader({
          checkoutPath: destination,
          identity: {
            provider: grounding?.provider ?? 'ado',
            project: bootstrap.specification.projectId,
            repo: grounding?.repository ?? 'empty',
            sha: grounding?.sha ?? 'none',
          },
        });
        return resolvedPrimaryReader;
      };

      const baseReader: RepoReader =
        reader ??
        (isBrainstorm
          ? {
              identity: {
                provider: grounding?.provider ?? 'ado',
                project: bootstrap.specification.projectId,
                repo: grounding?.repository ?? 'empty',
                sha: grounding?.sha ?? 'none',
              },
              readFile: async (filePath) =>
                (await resolveBrainstormPrimaryReader()).readFile(filePath),
              listDir: async (dirPath) =>
                (await resolveBrainstormPrimaryReader()).listDir(dirPath),
              searchCode: async (query, limit, scopedPath) =>
                (await resolveBrainstormPrimaryReader()).searchCode(
                  query,
                  limit,
                  scopedPath,
                ),
            }
          : new LocalCheckoutReader({
              checkoutPath: destination,
              identity: {
                provider: 'ado',
                project: bootstrap.specification.projectId,
                repo: 'empty',
                sha: 'none',
              },
            }));
      return {
        workspacePath: destination,
        reader: createBrainstormWorkspaceReader({
          destination,
          primaryReader: baseReader,
          remotePrimaryReader: checkout?.status === 'ready' ? null : reader,
          bootstrap,
          openBareSourceReader: (root) =>
            openBareReaderForGrounding({
              provider: root.provider,
              project: root.project,
              repository: root.repository,
              sha: root.commitSha,
              profileId: 'brainstorm-source',
            }),
        }),
        dispose: () => repositoryCheckout.release(destination),
      } as ReaderCheckout;
    },
    uploadAttemptArtifacts: async (bootstrap, workspacePath, signal) => {
      const collected = await collectInteractiveArtifacts(workspacePath);
      // A turn with no workspace outputs still has to finish. Blob is only
      // needed when there is a file to store.
      if (collected.length === 0) return undefined;
      const container = artifactContainerName();
      const uploader = createArtifactUploader({
        target: {
          runId: bootstrap.runId,
          attemptId: bootstrap.attemptId,
          attemptNumber: bootstrap.attemptNumber,
          container,
        },
      });
      return uploader.uploadAll(
        collected.map((file) => ({
          path: file.relativePath,
          content: file.content,
        })),
        signal,
      );
    },
    postIngest: (projectId, runId, body) =>
      callback.postIngest(projectId, runId, body),
    // Live token/tool/phase fan-out over Redis (ephemeral). No-op when Redis
    // is unconfigured — durability then rides ingest + client safety-net poll.
    publishLive: (threadId, envelope) =>
      interactiveLiveBus.publish(threadId, envelope),
  });
  // Eagerly connect the publisher so first-token latency isn't paid lazily.
  await interactiveLiveBus.init();
  setInteractiveActorRuntime({ logic, callback });

  const shutdownDrain = createInteractiveShutdownDrain({
    drainMs: resolveShutdownDrainMs(process.env.AI_RUNS_V2_SHUTDOWN_DRAIN_MS),
    activeTurnCount: () =>
      turnQueue.activeThreadCount() + interactiveInFlightInvocations.count(),
    dispose: () => logic.disposeAll(),
    exit: (code) => void exitAfterFlush(code),
  });
  process.on('SIGTERM', () => shutdownDrain.shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdownDrain.shutdown('SIGINT'));

  const actorClass = interactiveSessionActorClassFor(
    process.env.AI_RUNS_INTERACTIVE_DAPR_APP_ID,
  );
  const sidecar = createDaprSidecarClient(process.env.DAPR_HTTP_PORT?.trim() || '3500');
  const invocationStall = createActorInvocationStallTracker();
  const sidecarHealth = createSidecarHealthMonitor({
    actorType: actorClass.name,
    fetchMetadata: sidecar.fetchMetadata,
    invocationStall: () => invocationStall.stalledDetail(),
    requestSidecarShutdown: sidecar.requestSidecarShutdown,
    now: Date.now,
  });
  const httpApp = express();
  httpApp.get('/health', interactiveHealthRoute(createCachedHealthCheck(() => sidecarHealth.check())));

  const server = new DaprServer({
    serverPort,
    communicationProtocol: CommunicationProtocolEnum.HTTP,
    serverHttp: httpApp,
  });

  await server.actor.init();
  await server.actor.registerActor(actorClass);

  const proxyBuilder = new ActorProxyBuilder<IInteractiveSessionActor>(
    actorClass,
    server.client
  );

  // The API POSTs { threadId, runId, dispatchMessageId }; Dapr wraps the JSON
  // request body in DaprInvokerCallbackContent before invoking this handler.
  await registerInteractiveDispatchHandler(
    server.invoker,
    (threadId) => proxyBuilder.build(new ActorId(threadId)),
    async (payload) => {
      // `/dispatch` returns before the long-running actor invocation finishes.
      // If Dapr cannot deliver that invocation (for example, it routes to a
      // restarting replica), no actor exists to write a terminal event. Resolve
      // the fenced bootstrap here and finish the run through the same durable
      // ingest path used by the actor so the client can retry immediately.
      const bootstrap = await callback.getBootstrap({
        runId: payload.runId,
        dispatchMessageId: payload.dispatchMessageId,
      });
      // Only an attempt that never started gets the start-failure terminal; a
      // running or finished attempt owns its own outcome.
      if (
        isInteractiveActorBootstrap(bootstrap) &&
        bootstrap.attemptStatus !== 'queued' &&
        bootstrap.attemptStatus !== 'dispatched'
      ) {
        return;
      }
      const projectId = bootstrap.projectId;
      await callback.postIngest(projectId, payload.runId, {
        dispatchMessageId: payload.dispatchMessageId,
        kind: 'terminal',
        status: 'failed',
        phase: 'completion',
        detail: 'Interactive agent could not start. Please retry.',
        ...(isInteractiveActorBootstrap(bootstrap)
          ? { attemptId: bootstrap.attemptId }
          : {}),
      });
    },
    {
      isDraining: () => shutdownDrain.isDraining(),
      track: (work) => interactiveInFlightInvocations.track(work),
    },
    INTERACTIVE_ACTOR_INVOKE_TIMEOUT_MS,
    invocationStall
  );

  await server.start();
  console.log(
    JSON.stringify({
      event: 'InteractiveActorHostStarted',
      serverPort,
      actorType: actorClass.name,
    })
  );
}

if (require.main === module) {
  // Resident service, so only the failure path exits: hanging here would leave
  // a replica the platform still considers up but that serves nothing.
  main().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'InteractiveActorHostFatal',
        ...describeError(error),
      })
    );
    return exitAfterFlush(1);
  });
}
