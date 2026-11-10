import { createHash } from 'node:crypto';
import path from 'node:path';
import { WebSocket } from 'ws';
import type {
  EditablePreviewChangeSet,
  EditablePreviewSessionLifecycle,
  EditablePreviewSessionProvider,
  EditablePreviewSessionSnapshot,
  EditablePreviewSessionSpec,
  EditablePreviewTask,
  EditablePreviewTransportSnapshot,
  EditablePreviewWorkspaceSnapshot,
  ProviderInspectResult,
  ProviderMutationResult,
} from './buildPreviewProviderContracts';
import {
  EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
} from './buildPreviewProviderContracts';
import {
  acceptedMutation,
  clone,
  dockerResourceLimits,
  DockerMutationLedger,
  isDockerResourceMissing,
  providerFailure,
  type DockerCommandRunner,
} from './dockerPreviewRuntime';
import {
  detachRuntimeApis,
  STUDIO_API_PROXY_TARGET,
} from './studioRuntimeApiLink';

export interface ResolvedEditablePreviewSource {
  path: string;
  digest: string;
}

export interface ResolvedEditablePreviewChangeSet {
  path: string;
  digest: string;
  deletePaths?: readonly string[];
}

type TransportChecks = EditablePreviewTransportSnapshot['checks'];

export interface DockerEditablePreviewSessionProviderOptions {
  docker: DockerCommandRunner;
  resolveSourceSnapshot: (
    source: EditablePreviewSessionSnapshot['spec']['source']
  ) => Promise<ResolvedEditablePreviewSource>;
  resolveChangeSet: (
    changeSet: EditablePreviewChangeSet
  ) => Promise<ResolvedEditablePreviewChangeSet>;
  probeTransport?: (url: string) => Promise<TransportChecks>;
  now?: () => Date;
  studioDockerfile?: string;
}

export interface DockerEditablePreviewSessionProvider extends EditablePreviewSessionProvider {
  readonly sessionCount: number;
}

interface DockerStudioResource {
  handle: string;
  sessionId: string;
  networkName: string;
  containerName: string;
  proxyContainerName: string;
  imageName: string;
}

interface SessionRecord {
  resource: DockerStudioResource;
  snapshot: EditablePreviewSessionSnapshot;
}

interface DockerContainerState {
  Status?: string;
  Running?: boolean;
  Paused?: boolean;
  ExitCode?: number;
}

interface PersistedStudioSessionState {
  contractVersion: typeof EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION;
  spec: EditablePreviewSessionSpec;
  workspace: EditablePreviewWorkspaceSnapshot;
  expiresAt: string;
}

const STUDIO_SESSION_STATE_PATH = '/home/studio/.apex-session.json';

const TASK_COMMANDS: Readonly<Record<EditablePreviewTask, readonly string[]>> =
  {
    typecheck: [
      'corepack',
      'pnpm',
      '-r',
      '--workspace-concurrency=1',
      'run',
      'typecheck',
    ],
    // Fast edits are restricted to apps/web/src and packages/ui/src. Running
    // the entire Golden Stack suite also executes repository-fixture and
    // database tests that are unrelated to the preview update.
    unit_test: [
      'corepack',
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--project',
      'unit',
      'apps/web/src',
      'packages/ui/src',
      '--maxWorkers=1',
    ],
    quality_check: ['corepack', 'pnpm', 'check'],
    production_build: ['corepack', 'pnpm', 'build'],
  };

function studioSuffix(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

/** Docker names for a Studio session, so a runtime launcher can join its network. */
export function studioNetworkNameFor(sessionId: string): string {
  return studioResource(sessionId).networkName;
}

function studioResource(sessionId: string): DockerStudioResource {
  const suffix = studioSuffix(sessionId);
  return {
    handle: `docker-editable-preview:${sessionId}`,
    sessionId,
    networkName: `apex-studio-network-${suffix}`,
    containerName: `apex-studio-app-${suffix}`,
    proxyContainerName: `apex-studio-proxy-${suffix}`,
    imageName: `apex/full-stack-express-studio:${suffix}`,
  };
}

function studioTaskResource(
  resource: DockerStudioResource,
  idempotencyKey: string
): { containerName: string; imageName: string } {
  const suffix = createHash('sha256')
    .update(`${resource.sessionId}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 16);
  return {
    containerName: `apex-studio-task-${suffix}`,
    imageName: `apex/studio-check:${suffix}`,
  };
}

function studioLabels(
  snapshot: EditablePreviewSessionSnapshot['spec']['correlation']
): readonly string[] {
  return [
    '--label',
    'com.amergis.apex.studio=true',
    '--label',
    `com.amergis.apex.studio-session=${snapshot.sessionId}`,
    '--label',
    `com.amergis.apex.build-run=${snapshot.buildRunId}`,
    '--label',
    `com.amergis.apex.draft-revision=${snapshot.draftRevisionId}`,
    '--label',
    `com.amergis.apex.template-version=${snapshot.templateVersion}`,
  ];
}

function parseContainerState(stdout: string): DockerContainerState {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Docker returned an invalid studio container state.');
  }
  return parsed as DockerContainerState;
}

function parsePersistedStudioSessionState(
  stdout: string
): PersistedStudioSessionState {
  const parsed = JSON.parse(
    stdout.trim()
  ) as Partial<PersistedStudioSessionState>;
  const spec = parsed.spec;
  const workspace = parsed.workspace;
  if (
    parsed.contractVersion !== EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION ||
    !spec ||
    spec.contractVersion !== EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION ||
    !workspace ||
    workspace.writable !== true ||
    !Number.isInteger(workspace.version) ||
    workspace.version < 0 ||
    !Array.isArray(workspace.appliedChangeSets) ||
    workspace.version !== workspace.appliedChangeSets.length ||
    workspace.baseSnapshotDigest !== spec.source.snapshotDigest ||
    typeof parsed.expiresAt !== 'string'
  ) {
    throw new Error('Docker returned invalid persisted Studio session state.');
  }
  return parsed as PersistedStudioSessionState;
}

function parsePublishedPort(stdout: string): {
  host: string;
  port: number;
} {
  const line = stdout.trim().split(/\r?\n/)[0] ?? '';
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(line);
  const port = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Docker did not return a loopback studio port.');
  }
  return {
    host: match[1] === '[::1]' ? '::1' : match[1],
    port,
  };
}

function safeWorkspacePath(relativePath: string): string | null {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('../')
  ) {
    return null;
  }
  return `/workspace/${relativePath}`;
}

function allTransportsReady(checks: TransportChecks): boolean {
  return EDITABLE_PREVIEW_REQUIRED_TRANSPORTS.every(
    (transport) => checks[transport] === 'ready'
  );
}

function operationFailure(
  operation: string,
  error: unknown
): ProviderMutationResult {
  const message = error instanceof Error ? error.message : String(error);
  return providerFailure(
    'provider_unavailable',
    `Docker could not ${operation}.`,
    true,
    { reason: message.slice(0, 500) }
  );
}

function isPersistedStudioStateMissing(error: unknown): boolean {
  const candidate = error as {
    message?: unknown;
    stderr?: unknown;
    stdout?: unknown;
  };
  const text = [candidate?.message, candidate?.stderr, candidate?.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return (
    text.includes(STUDIO_SESSION_STATE_PATH) &&
    /no such file|cannot open/i.test(text)
  );
}

function websocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function probeStudioHttpReadiness(
  url: string,
  timeoutMs = 3_000
): Promise<{ ready: boolean; hmrToken: string | null }> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ready: false, hmrToken: null };

    // Studio starts before the isolated runtime exists. Requiring the proxied
    // API health route here creates a startup cycle: Studio waits for runtime,
    // while runtime launch waits for Studio. Runtime health and browser
    // behavior are checked after Apex links the two containers.
    const clientResponse = await fetch(new URL('@vite/client', url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const clientSource = clientResponse.ok ? await clientResponse.text() : '';
    const hmrToken =
      /const wsToken = "([A-Za-z0-9_-]+)"/.exec(clientSource)?.[1] ?? null;
    return { ready: clientResponse.ok, hmrToken };
  } catch {
    return { ready: false, hmrToken: null };
  }
}

export async function probeViteHmrTransport(
  url: string,
  timeoutMs = 3_000
): Promise<TransportChecks> {
  const readiness = await probeStudioHttpReadiness(url, timeoutMs);
  const http: TransportChecks['http'] = readiness.ready ? 'ready' : 'failed';
  const hmrToken = readiness.hmrToken;

  return new Promise((resolve) => {
    let websocket: TransportChecks['websocket'] = 'failed';
    let viteHmr: TransportChecks['vite_hmr'] = 'failed';
    let settled = false;
    const socketUrl = new URL(websocketUrl(url));
    if (hmrToken) {
      socketUrl.searchParams.set('token', hmrToken);
    }
    const socket = new WebSocket(socketUrl, 'vite-hmr', {
      headers: { Origin: new URL(url).origin },
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve({ http, websocket, vite_hmr: viteHmr });
    };
    const timeout = setTimeout(finish, timeoutMs);
    socket.once('open', () => {
      websocket = 'ready';
    });
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: unknown };
        if (message.type === 'connected') {
          viteHmr = 'ready';
          finish();
        }
      } catch {
        // Ignore non-JSON frames while waiting for Vite's connected message.
      }
    });
    socket.once('error', finish);
    socket.once('close', finish);
  });
}

export function createDockerEditablePreviewSessionProvider(
  options: DockerEditablePreviewSessionProviderOptions
): DockerEditablePreviewSessionProvider {
  const now = options.now ?? (() => new Date());
  const probeTransport = options.probeTransport ?? probeViteHmrTransport;
  const studioDockerfile = options.studioDockerfile ?? 'Dockerfile.studio';
  const records = new Map<string, SessionRecord>();
  const handlesBySessionId = new Map<string, string>();
  const mutations = new DockerMutationLedger();
  let nextOperation = 1;

  const accepted = (handle: string): ProviderMutationResult =>
    acceptedMutation(`docker-studio-operation-${nextOperation++}`, handle);

  const activeRecord = (
    handle: string,
    operation: string
  ): SessionRecord | ProviderMutationResult => {
    const record = records.get(handle);
    if (!record) {
      return providerFailure(
        'not_found',
        `Editable preview session ${handle} was not found.`,
        false
      );
    }
    if (
      ['terminated', 'failed', 'expired'].includes(record.snapshot.lifecycle)
    ) {
      return providerFailure(
        'invalid_argument',
        `Cannot ${operation} a session in ${record.snapshot.lifecycle}.`,
        false
      );
    }
    return record;
  };

  const removeNamedResource = async (
    kind: 'container' | 'network' | 'image',
    name: string
  ): Promise<void> => {
    const args =
      kind === 'container'
        ? ['rm', '--force', name]
        : kind === 'network'
          ? ['network', 'rm', name]
          : ['image', 'rm', '--force', name];
    try {
      await options.docker.run(args);
    } catch (error) {
      if (!isDockerResourceMissing(error)) throw error;
    }
  };

  const removeStaleResources = async (
    resource: DockerStudioResource
  ): Promise<void> => {
    await removeNamedResource('container', resource.proxyContainerName);
    await removeNamedResource('container', resource.containerName);
    await detachRuntimeApis(options.docker, resource.networkName);
    await removeNamedResource('network', resource.networkName);
  };

  const persistStudioState = async (record: SessionRecord): Promise<void> => {
    const state: PersistedStudioSessionState = {
      contractVersion: EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
      spec: clone(record.snapshot.spec),
      workspace: clone(record.snapshot.workspace),
      expiresAt: record.snapshot.expiresAt,
    };
    const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString(
      'base64url'
    );
    await options.docker.run([
      'exec',
      record.resource.containerName,
      'node',
      '-e',
      [
        "const fs=require('node:fs');",
        'const target=process.argv[1];',
        "const temporary=target+'.tmp';",
        "fs.writeFileSync(temporary,Buffer.from(process.argv[2],'base64url'),{mode:0o600});",
        'fs.renameSync(temporary,target);',
      ].join(''),
      STUDIO_SESSION_STATE_PATH,
      encoded,
    ]);
  };

  const inspectContainerIfPresent = async (
    containerName: string
  ): Promise<DockerContainerState | null> => {
    try {
      const result = await options.docker.run([
        'inspect',
        '--format',
        '{{json .State}}',
        containerName,
      ]);
      return parseContainerState(result.stdout);
    } catch (error) {
      if (isDockerResourceMissing(error)) return null;
      throw error;
    }
  };

  const adoptExistingSession = async (
    resource: DockerStudioResource,
    requestedSpec: EditablePreviewSessionSpec
  ): Promise<SessionRecord | null> => {
    const [application, proxy] = await Promise.all([
      inspectContainerIfPresent(resource.containerName),
      inspectContainerIfPresent(resource.proxyContainerName),
    ]);
    if (!application && !proxy) return null;

    if (
      !application ||
      !proxy ||
      !application.Running ||
      !proxy.Running ||
      application.Paused ||
      proxy.Paused ||
      ['exited', 'dead'].includes(application.Status ?? '') ||
      ['exited', 'dead'].includes(proxy.Status ?? '')
    ) {
      await removeStaleResources(resource);
      return null;
    }

    let persistedBytes: string;
    try {
      const result = await options.docker.run([
        'exec',
        resource.containerName,
        'cat',
        STUDIO_SESSION_STATE_PATH,
      ]);
      persistedBytes = result.stdout;
    } catch (error) {
      if (!isPersistedStudioStateMissing(error)) throw error;
      await removeStaleResources(resource);
      return null;
    }
    let persisted: PersistedStudioSessionState;
    try {
      persisted = parsePersistedStudioSessionState(persistedBytes);
    } catch {
      await removeStaleResources(resource);
      return null;
    }

    if (
      persisted.spec.correlation.sessionId !==
        requestedSpec.correlation.sessionId ||
      persisted.spec.correlation.buildRunId !==
        requestedSpec.correlation.buildRunId ||
      persisted.spec.correlation.templateVersion !==
        requestedSpec.correlation.templateVersion ||
      Date.parse(persisted.expiresAt) <= now().getTime()
    ) {
      await removeStaleResources(resource);
      return null;
    }

    const record: SessionRecord = {
      resource,
      snapshot: {
        spec: clone(persisted.spec),
        lifecycle: 'starting',
        workspace: clone(persisted.workspace),
        transport: null,
        expiresAt: persisted.expiresAt,
        failureCode: null,
      },
    };
    records.set(resource.handle, record);
    handlesBySessionId.set(resource.sessionId, resource.handle);
    return record;
  };

  const cleanup = async (record: SessionRecord): Promise<void> => {
    const { resource } = record;
    await removeStaleResources(resource);
    await removeNamedResource('image', resource.imageName);
    record.snapshot.transport = null;
    record.snapshot.workspace.writable = false;
  };

  const inspectActive = async (record: SessionRecord): Promise<void> => {
    const { resource, snapshot } = record;
    const [application, proxy] = await Promise.all([
      options.docker.run([
        'inspect',
        '--format',
        '{{json .State}}',
        resource.containerName,
      ]),
      options.docker.run([
        'inspect',
        '--format',
        '{{json .State}}',
        resource.proxyContainerName,
      ]),
    ]);
    const applicationState = parseContainerState(application.stdout);
    const proxyState = parseContainerState(proxy.stdout);
    if (applicationState.Paused || proxyState.Paused) {
      snapshot.lifecycle = 'suspended';
      snapshot.transport = null;
      return;
    }
    if (
      !applicationState.Running ||
      !proxyState.Running ||
      ['exited', 'dead'].includes(applicationState.Status ?? '') ||
      ['exited', 'dead'].includes(proxyState.Status ?? '')
    ) {
      snapshot.lifecycle = 'failed';
      snapshot.failureCode = 'internal_error';
      snapshot.transport = null;
      return;
    }
    const portResult = await options.docker.run([
      'port',
      resource.proxyContainerName,
      '3000/tcp',
    ]);
    const published = parsePublishedPort(portResult.stdout);
    const host = published.host === '::1' ? '[::1]' : published.host;
    const checks = await probeTransport(`http://${host}:${published.port}/`);
    snapshot.transport = {
      upstreamRef: `docker-loopback:${published.host}:${published.port}`,
      checks,
    };
    snapshot.lifecycle = allTransportsReady(checks) ? 'ready' : 'starting';
  };

  const mutateLifecycle = async (
    operation: 'suspend' | 'resume',
    input: { idempotencyKey: string; handle: string },
    allowed: readonly EditablePreviewSessionLifecycle[],
    next: EditablePreviewSessionLifecycle,
    dockerCommand: 'pause' | 'unpause'
  ): Promise<ProviderMutationResult> =>
    mutations.apply(operation, input.idempotencyKey, input, async () => {
      const candidate = activeRecord(input.handle, operation);
      if (!('snapshot' in candidate)) return candidate;
      if (!allowed.includes(candidate.snapshot.lifecycle)) {
        return providerFailure(
          'invalid_argument',
          `Cannot ${operation} a session in ${candidate.snapshot.lifecycle}.`,
          false
        );
      }
      try {
        await options.docker.run([
          dockerCommand,
          candidate.resource.containerName,
          candidate.resource.proxyContainerName,
        ]);
      } catch (error) {
        return operationFailure(operation, error);
      }
      candidate.snapshot.lifecycle = next;
      candidate.snapshot.transport = null;
      return accepted(input.handle);
    });

  const provider: DockerEditablePreviewSessionProvider = {
    get sessionCount() {
      return records.size;
    },

    async start(input) {
      return mutations.apply('start', input.idempotencyKey, input, async () => {
        if (input.spec.policy.egress !== 'denied') {
          return providerFailure(
            'policy_denied',
            'The local Docker Studio provider supports denied egress only.',
            false
          );
        }
        const nowMs = now().getTime();
        const expiresAtMs = Date.parse(input.spec.expiresAt);
        if (
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= nowMs ||
          expiresAtMs > nowMs + input.spec.policy.maxRuntimeSeconds * 1_000
        ) {
          return providerFailure(
            'invalid_argument',
            'Session expiry must be in the future and within maxRuntimeSeconds.',
            false
          );
        }
        if (
          EDITABLE_PREVIEW_REQUIRED_TRANSPORTS.some(
            (transport) => !input.spec.requiredTransports.includes(transport)
          )
        ) {
          return providerFailure(
            'invalid_argument',
            'Editable sessions require HTTP, WebSocket, and Vite HMR transports.',
            false
          );
        }
        if (handlesBySessionId.has(input.spec.correlation.sessionId)) {
          return providerFailure(
            'conflict',
            `Session ${input.spec.correlation.sessionId} already exists.`,
            false
          );
        }

        const resource = studioResource(input.spec.correlation.sessionId);
        try {
          const adopted = await adoptExistingSession(resource, input.spec);
          if (adopted) return accepted(adopted.resource.handle);
          await removeStaleResources(resource);
        } catch (error) {
          return operationFailure(
            'reconcile the editable preview session',
            error
          );
        }

        const source = await options.resolveSourceSnapshot(input.spec.source);
        if (source.digest !== input.spec.source.snapshotDigest) {
          return providerFailure(
            'invalid_argument',
            'Resolved source snapshot digest does not match the request.',
            false
          );
        }
        const labels = studioLabels(input.spec.correlation);
        const snapshot: EditablePreviewSessionSnapshot = {
          spec: clone(input.spec),
          lifecycle: 'starting',
          workspace: {
            writable: true,
            version: 0,
            baseSnapshotDigest: input.spec.source.snapshotDigest,
            appliedChangeSets: [],
          },
          transport: null,
          expiresAt: input.spec.expiresAt,
          failureCode: null,
        };
        const record = { resource, snapshot };
        try {
          await options.docker.run([
            'build',
            '--file',
            path.join(source.path, studioDockerfile),
            '--tag',
            resource.imageName,
            source.path,
          ]);
          await options.docker.run([
            'network',
            'create',
            '--internal',
            resource.networkName,
          ]);
          await options.docker.run([
            'run',
            '--detach',
            '--name',
            resource.containerName,
            '--network',
            resource.networkName,
            '--network-alias',
            'studio-app',
            ...labels,
            ...dockerResourceLimits('studio'),
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=67108864',
            '--env',
            `APEX_API_PROXY_TARGET=${STUDIO_API_PROXY_TARGET}`,
            resource.imageName,
            'node',
            'scripts/preview/studio-runner.mjs',
          ]);
          await options.docker.run([
            'run',
            '--detach',
            '--name',
            resource.proxyContainerName,
            ...labels,
            ...dockerResourceLimits('proxy'),
            '--publish',
            '127.0.0.1:0:3000',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=16777216',
            '--env',
            'APEX_PREVIEW_UPSTREAM_HOST=studio-app',
            '--env',
            'APEX_PREVIEW_UPSTREAM_PORT=5173',
            resource.imageName,
            'node',
            'scripts/preview/runner-tcp-proxy.mjs',
          ]);
          await options.docker.run([
            'network',
            'connect',
            resource.networkName,
            resource.proxyContainerName,
          ]);
          await persistStudioState(record);
        } catch (error) {
          await removeStaleResources(resource).catch(() => undefined);
          await removeNamedResource('image', resource.imageName).catch(
            () => undefined
          );
          return operationFailure('start the editable preview session', error);
        }

        records.set(resource.handle, record);
        handlesBySessionId.set(
          input.spec.correlation.sessionId,
          resource.handle
        );
        return accepted(resource.handle);
      });
    },

    async inspect(
      input
    ): Promise<ProviderInspectResult<EditablePreviewSessionSnapshot>> {
      const record = records.get(input.handle);
      if (!record) {
        return {
          handle: input.handle,
          phase: 'unknown',
          snapshot: null,
          error: {
            code: 'not_found',
            message: `Editable preview session ${input.handle} was not found.`,
            retryable: false,
          },
          observedAt: now().toISOString(),
        };
      }
      if (
        !['terminated', 'failed', 'expired'].includes(
          record.snapshot.lifecycle
        ) &&
        Date.parse(record.snapshot.expiresAt) <= now().getTime()
      ) {
        try {
          await cleanup(record);
          record.snapshot.lifecycle = 'expired';
        } catch {
          record.snapshot.lifecycle = 'failed';
          record.snapshot.failureCode = 'provider_unavailable';
        }
      } else if (
        !['terminated', 'failed', 'expired', 'suspended'].includes(
          record.snapshot.lifecycle
        )
      ) {
        try {
          await inspectActive(record);
        } catch (error) {
          return {
            handle: input.handle,
            phase: 'unknown',
            snapshot: clone(record.snapshot),
            error: {
              code: 'provider_unavailable',
              message: 'Docker could not inspect the editable preview session.',
              retryable: true,
              details: {
                reason:
                  error instanceof Error
                    ? error.message.slice(0, 500)
                    : String(error).slice(0, 500),
              },
            },
            observedAt: now().toISOString(),
          };
        }
      }

      const lifecycle = record.snapshot.lifecycle;
      const phase =
        lifecycle === 'failed'
          ? 'failed'
          : ['ready', 'suspended', 'terminated', 'expired'].includes(lifecycle)
            ? 'succeeded'
            : 'running';
      return {
        handle: input.handle,
        phase,
        snapshot: clone(record.snapshot),
        error:
          phase === 'failed'
            ? {
                code: record.snapshot.failureCode ?? 'internal_error',
                message: 'The editable preview session failed.',
                retryable: false,
              }
            : null,
        observedAt: now().toISOString(),
      };
    },

    async applyChangeSet(input) {
      return mutations.apply(
        'apply-change-set',
        input.idempotencyKey,
        input,
        async () => {
          const candidate = activeRecord(input.handle, 'apply a change set to');
          if (!('snapshot' in candidate)) return candidate;
          if (candidate.snapshot.lifecycle !== 'ready') {
            return providerFailure(
              'not_ready',
              `Cannot apply a change set in ${candidate.snapshot.lifecycle}.`,
              true
            );
          }
          if (
            candidate.snapshot.workspace.version !==
            input.expectedWorkspaceVersion
          ) {
            return providerFailure(
              'conflict',
              `Expected workspace version ${input.expectedWorkspaceVersion}, but the current version is ${candidate.snapshot.workspace.version}.`,
              false
            );
          }
          const resolved = await options.resolveChangeSet(input.changeSet);
          if (resolved.digest !== input.changeSet.digest) {
            return providerFailure(
              'invalid_argument',
              'Resolved change-set digest does not match the request.',
              false
            );
          }
          const deletePaths = (resolved.deletePaths ?? []).map(
            safeWorkspacePath
          );
          if (deletePaths.some((entry) => entry === null)) {
            return providerFailure(
              'invalid_argument',
              'The change set contains an unsafe deletion path.',
              false
            );
          }

          candidate.snapshot.lifecycle = 'applying_change';
          try {
            for (const deletePath of deletePaths) {
              await options.docker.run([
                'exec',
                candidate.resource.containerName,
                'rm',
                '-rf',
                '--',
                deletePath as string,
              ]);
            }
            await options.docker.run([
              'cp',
              `${resolved.path}${path.sep}.`,
              `${candidate.resource.containerName}:/workspace`,
            ]);
          } catch (error) {
            candidate.snapshot.lifecycle = 'failed';
            candidate.snapshot.failureCode = 'provider_unavailable';
            candidate.snapshot.transport = null;
            return operationFailure('apply the Studio change set', error);
          }

          candidate.snapshot.workspace.appliedChangeSets = [
            ...candidate.snapshot.workspace.appliedChangeSets,
            clone(input.changeSet),
          ];
          candidate.snapshot.workspace.version += 1;
          candidate.snapshot.lifecycle = 'restarting';
          try {
            await persistStudioState(candidate);
          } catch (error) {
            candidate.snapshot.lifecycle = 'failed';
            candidate.snapshot.failureCode = 'provider_unavailable';
            candidate.snapshot.transport = null;
            return operationFailure(
              'persist the Studio workspace state',
              error
            );
          }
          const currentUpstream =
            candidate.snapshot.transport?.upstreamRef.match(
              /^docker-loopback:([^:]+):([0-9]+)$/
            );
          if (currentUpstream) {
            const host =
              currentUpstream[1] === '::1' ? '[::1]' : currentUpstream[1];
            const checks = await probeTransport(
              `http://${host}:${currentUpstream[2]}/`
            );
            candidate.snapshot.transport = {
              upstreamRef: `docker-loopback:${currentUpstream[1]}:${currentUpstream[2]}`,
              checks,
            };
            if (allTransportsReady(checks)) {
              candidate.snapshot.lifecycle = 'ready';
            }
          }
          return accepted(input.handle);
        }
      );
    },

    async runTask(input) {
      return mutations.apply(
        'run-task',
        input.idempotencyKey,
        input,
        async () => {
          const candidate = activeRecord(input.handle, 'run a task in');
          if (!('snapshot' in candidate)) return candidate;
          if (candidate.snapshot.lifecycle !== 'ready') {
            return providerFailure(
              'not_ready',
              `Cannot run a task in ${candidate.snapshot.lifecycle}.`,
              true
            );
          }
          if (
            candidate.snapshot.workspace.version !==
            input.expectedWorkspaceVersion
          ) {
            return providerFailure(
              'conflict',
              `Expected workspace version ${input.expectedWorkspaceVersion}, but the current version is ${candidate.snapshot.workspace.version}.`,
              false
            );
          }
          const taskResource = studioTaskResource(
            candidate.resource,
            input.idempotencyKey
          );
          try {
            await options.docker.run([
              'commit',
              '--no-pause',
              candidate.resource.containerName,
              taskResource.imageName,
            ]);
            await options.docker.run([
              'run',
              '--rm',
              '--name',
              taskResource.containerName,
              ...dockerResourceLimits('studio-task'),
              // docker cp creates changed workspace paths as root. The task
              // snapshot is isolated, has no mounts or network, and needs
              // limited file-owner capabilities so build tests can create
              // output and cache directories without mutating Studio.
              '--user',
              '0:0',
              '--network',
              'none',
              '--cap-drop',
              'ALL',
              '--cap-add',
              'DAC_OVERRIDE',
              '--cap-add',
              'FOWNER',
              '--security-opt',
              'no-new-privileges',
              '--tmpfs',
              '/tmp:rw,noexec,nosuid,size=67108864',
              // The preview-only API target must not alter repository tests.
              '--env',
              'APEX_API_PROXY_TARGET=',
              taskResource.imageName,
              ...TASK_COMMANDS[input.task],
            ]);
          } catch (error) {
            return operationFailure(`run the ${input.task} Studio task`, error);
          } finally {
            await options.docker
              .run(['rm', '--force', taskResource.containerName])
              .catch(() => undefined);
            await options.docker
              .run(['image', 'rm', '--force', taskResource.imageName])
              .catch(() => undefined);
          }
          return accepted(input.handle);
        }
      );
    },

    async renew(input) {
      return mutations.apply('renew', input.idempotencyKey, input, async () => {
        const candidate = activeRecord(input.handle, 'renew');
        if (!('snapshot' in candidate)) return candidate;
        const nowMs = now().getTime();
        const expiresAtMs = Date.parse(input.expiresAt);
        if (
          !Number.isFinite(expiresAtMs) ||
          expiresAtMs <= nowMs ||
          expiresAtMs >
            nowMs + candidate.snapshot.spec.policy.maxRuntimeSeconds * 1_000
        ) {
          return providerFailure(
            'invalid_argument',
            'Session renewal must be in the future and within maxRuntimeSeconds.',
            false
          );
        }
        candidate.snapshot.expiresAt = input.expiresAt;
        candidate.snapshot.spec.expiresAt = input.expiresAt;
        try {
          await persistStudioState(candidate);
        } catch (error) {
          return operationFailure('persist the Studio session renewal', error);
        }
        return accepted(input.handle);
      });
    },

    async suspend(input) {
      return mutateLifecycle(
        'suspend',
        input,
        ['ready', 'starting', 'restarting'],
        'suspended',
        'pause'
      );
    },

    async resume(input) {
      return mutateLifecycle(
        'resume',
        input,
        ['suspended'],
        'starting',
        'unpause'
      );
    },

    async destroy(input) {
      return mutations.apply(
        'destroy',
        input.idempotencyKey,
        input,
        async () => {
          const record = records.get(input.handle);
          if (!record) {
            return providerFailure(
              'not_found',
              `Editable preview session ${input.handle} was not found.`,
              false
            );
          }
          if (record.snapshot.lifecycle === 'terminated') {
            return accepted(input.handle);
          }
          record.snapshot.lifecycle = 'terminating';
          try {
            await cleanup(record);
          } catch (error) {
            record.snapshot.lifecycle = 'failed';
            record.snapshot.failureCode = 'provider_unavailable';
            return operationFailure(
              'destroy the editable preview session',
              error
            );
          }
          record.snapshot.lifecycle = 'terminated';
          return accepted(input.handle);
        }
      );
    },
  };

  return provider;
}
