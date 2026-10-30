import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, userProfiles } from '../db/schema';
import {
  BRAINSTORM_BIO_MAX_LENGTH,
  BRAINSTORM_SKILL_NAME,
  BRAINSTORM_SKILL_PATH,
  type BrainstormTurnAcceptedResponse,
} from '../../shared/types/brainstorm';
import type {
  FrozenBrainstormTurn,
  InteractiveTurnAcceptedResponse,
} from '../../shared/types/durableInteractiveTurn';
import {
  BRAINSTORM_ARTIFACT_TYPE_LABELS,
  BRAINSTORM_UPDATE_ARTIFACT_TOOL,
  isBrainstormArtifactType,
  type BrainstormTurnIntent,
  type FrozenBrainstormArtifact,
} from '../../shared/types/brainstormArtifact';
import type { BrainstormSessionRow } from './brainstormThread';
import { resolveBrainstormLimits } from './brainstormLimits';
import { buildBrainstormTurnSources } from './brainstorm/sourceSpecification';
import { readOnlyOperations, toolPrefixFor, type GatewayTool } from './brainstorm/mcpReadGateway';
import type { SourceRecord } from './brainstorm/sourceWorkspaceStore';
import { resolveDataRoot } from '../utils/dataDir';
import * as ledger from './brainstormTurnLedger';
import { BrainstormLedgerConflict } from './brainstormTurnLedger';
import { BrainstormError, brainstormSessionService } from './brainstormSessionService';
import { DurableInteractiveTurnError } from './durableInteractiveTurnService';
import { trackEvent } from './telemetry';

type CreatorContext = FrozenBrainstormTurn['creatorContext'];

export interface SendBrainstormTurnInput {
  threadId: string;
  userId: string;
  turnId: string;
  text: string;
  model?: string;
  attachments?: import('../../shared/types/chat').ChatAttachment[];
  internalContext: string;
  brainstorm: FrozenBrainstormTurn;
}

export interface BrainstormOrchestrationDeps {
  isV2TransportEnabled: (userId: string, project: string) => Promise<boolean>;
  loadCreatorContext: (userId: string) => Promise<CreatorContext>;
  sendTurn: (input: SendBrainstormTurnInput) => Promise<InteractiveTurnAcceptedResponse>;
  retryRun: (input: {
    threadId: string;
    runId: string;
    userId: string;
    refreshedBrainstormArtifact: FrozenBrainstormArtifact;
  }) => Promise<InteractiveTurnAcceptedResponse>;
  loadArtifact: (session: BrainstormSessionRow) => Promise<FrozenBrainstormArtifact>;
  cancelThreadRun: (threadId: string) => Promise<void>;
  ledger: Pick<
    typeof ledger,
    | 'openTurn'
    | 'openRetryRow'
    | 'attachRun'
    | 'failOpenRow'
    | 'latestAssistantRow'
    | 'findMessage'
    | 'findAssistantByRun'
    | 'reconcileStreamingRows'
  >;
  setTitleIfEmpty: (sessionId: string, project: string, text: string, userId: string) => Promise<void>;
  prepareTurnContext: (session: BrainstormSessionRow) => Promise<Pick<FrozenBrainstormTurn, 'sourceLimits' | 'sources'>>;
}

export function capBio(bio: string | null | undefined): string | null {
  const trimmed = bio?.trim();
  if (!trimmed) return null;
  return trimmed.length > BRAINSTORM_BIO_MAX_LENGTH ? trimmed.slice(0, BRAINSTORM_BIO_MAX_LENGTH) : trimmed;
}

/** Plain-text creator context for the model prompt. */
export function formatCreatorContext(context: CreatorContext): string {
  return [
    '# Creator context',
    `- Name: ${context.displayName || 'Unknown'}`,
    `- Roles: ${context.roles.length > 0 ? context.roles.join(', ') : 'none listed'}`,
    `- Groups: ${context.groups.length > 0 ? context.groups.join(', ') : 'none listed'}`,
    `- Profile bio: ${context.bio ?? 'none'}`,
  ].join('\n');
}

/** The artifact as of admission, plus how this turn may change it. */
export function formatArtifactContext(
  artifact: FrozenBrainstormArtifact,
  intent: BrainstormTurnIntent,
  mode?: import('../../shared/types/brainstormArtifact').BrainstormComposerMode,
): string {
  const typeLabel = artifact.type ? BRAINSTORM_ARTIFACT_TYPE_LABELS[artifact.type] : 'not chosen';
  const lines = [
    '# Current artifact',
    `- Type: ${typeLabel}`,
    `- Version: ${artifact.version}`,
    '',
    `To change the artifact, call the \`${BRAINSTORM_UPDATE_ARTIFACT_TOOL}\` tool with the complete revised Markdown. `
      + 'The change applies at once. Do not paste the whole artifact into chat; summarize what changed instead.',
  ];
  if (intent.kind === 'type_switch') {
    lines.push(
      '',
      `The creator switched the artifact type to ${BRAINSTORM_ARTIFACT_TYPE_LABELS[intent.targetType]}. `
        + 'Reshape the existing content into that type, keep what still applies, and call the tool once with the result.',
    );
  } else if (mode === 'explore') {
    lines.push(
      '',
      'The creator selected Explore mode (open Q&A and brainstorming). Focus on answering their question and exploring ideas in conversation. Do not rewrite or reshape the artifact unless they explicitly ask to update or draft it.',
    );
  } else if (mode && mode !== artifact.type) {
    lines.push(
      '',
      `The creator selected ${BRAINSTORM_ARTIFACT_TYPE_LABELS[mode]} mode for this message. `
        + `Draft or reshape the artifact as a ${BRAINSTORM_ARTIFACT_TYPE_LABELS[mode]} incorporating their request, and call \`${BRAINSTORM_UPDATE_ARTIFACT_TOOL}\` once with the complete Markdown.`,
    );
  } else if (mode) {
    lines.push(
      '',
      `The creator is working in ${BRAINSTORM_ARTIFACT_TYPE_LABELS[mode]} mode. Update the ${BRAINSTORM_ARTIFACT_TYPE_LABELS[mode]} artifact with \`${BRAINSTORM_UPDATE_ARTIFACT_TOOL}\` when this message settles content worth keeping.`,
    );
  } else if (artifact.type === null) {
    lines.push(
      '',
      'No artifact type is selected yet. Infer from the creator prompt whether an artifact is ready to be drafted or updated and which structure fits best (Discovery brief, Technical design, Architecture Decision Record, or Implementation plan).',
    );
  }
  if (artifact.markdown.trim().length === 0) {
    lines.push('', 'The artifact is empty.');
  } else {
    lines.push('', '----- BEGIN ARTIFACT -----', artifact.markdown, '----- END ARTIFACT -----');
  }
  return lines.join('\n');
}

export function formatSourcesContext(sources: FrozenBrainstormTurn['sources']): string {
  const lines = ['# Attached sources'];
  if (!sources || (
    sources.readRoots.length === 0
    && sources.mcpServers.length === 0
    && sources.unavailableSources.length === 0
  )) {
    lines.push('- None attached. Do not claim to have read repository code or connected data.');
    return lines.join('\n');
  }
  lines.push(
    'Evaluate the creator prompt first and inspect only the sources relevant to what they asked (skip tool calls for purely conceptual prompts, inspect a ready repository for codebase/architecture questions, and call only the MCP server tools whose purpose matches live-data questions):',
  );
  for (const root of sources.readRoots) {
    lines.push(
      `- Ready repository "${root.displayName}" (commit ${root.commitSha.slice(0, 12)}): `
        + `mounted read-only at \`sources/${root.sourceId}\`. `
        + 'Use `search_repo_code`, `list_repo_dir`, and `get_skill_file` on `sources/...` paths (do not use `shell`, `grep`, or `glob`, which cannot traverse the mounted directory junction).',
    );
  }
  for (const server of sources.mcpServers) {
    lines.push(
      `- Ready MCP server "${server.displayName}" (exposed on the \`brainstorm-artifact\` MCP namespace). Call a tool when its purpose matches the question:`,
    );
    if (server.tools.length === 0) {
      lines.push('  - read-only tools');
      continue;
    }
    for (const tool of server.tools) {
      lines.push(tool.summary ? `  - ${tool.toolName}: ${tool.summary}` : `  - ${tool.toolName}`);
    }
  }
  for (const unavailable of sources.unavailableSources) {
    lines.push(`- Unavailable "${unavailable.displayName}": ${unavailable.reason}`);
  }
  if (sources.instructions.trim()) {
    lines.push('', sources.instructions.trim());
  }
  return lines.join('\n');
}

async function defaultLoadCreatorContext(userId: string): Promise<CreatorContext> {
  const [{ getUserRoleNames }, { getUserGroupNames }] = await Promise.all([
    import('./rbacService'),
    import('./groupService'),
  ]);
  const [user, profile, roles, groups] = await Promise.all([
    db.select({ displayName: appUsers.displayName }).from(appUsers).where(eq(appUsers.oid, userId)).limit(1),
    db.select({ bio: userProfiles.bio }).from(userProfiles).where(eq(userProfiles.userOid, userId)).limit(1),
    getUserRoleNames(userId).catch(() => [] as string[]),
    getUserGroupNames(userId).catch(() => [] as string[]),
  ]);
  return {
    displayName: user[0]?.displayName ?? '',
    roles,
    groups,
    bio: capBio(profile[0]?.bio),
  };
}

async function defaultIsV2TransportEnabled(userId: string, project: string): Promise<boolean> {
  const { isFeatureEnabled } = await import('./featureFlagService');
  return isFeatureEnabled('ai-runs-v2-transport', { userId, project, caller: 'brainstorm' }).catch(() => false);
}

async function defaultSendTurn(input: SendBrainstormTurnInput): Promise<InteractiveTurnAcceptedResponse> {
  const { sendMessage } = await import('./chatAgentService');
  const submission = await sendMessage(
    input.threadId,
    input.text,
    input.model,
    input.attachments ?? [],
    {
      turnId: input.turnId,
      turnIdPolicy: 'required',
      requesterUserId: input.userId,
      turnSkill: { name: BRAINSTORM_SKILL_NAME, path: BRAINSTORM_SKILL_PATH },
      internalContext: input.internalContext,
      brainstorm: input.brainstorm,
      legacyCompletion: 'detach',
    },
  );
  if (submission.route !== 'durable') throw new BrainstormError('transport_unavailable', 409);
  return submission.response;
}

async function defaultRetryRun(input: {
  threadId: string;
  runId: string;
  userId: string;
  refreshedBrainstormArtifact: FrozenBrainstormArtifact;
}): Promise<InteractiveTurnAcceptedResponse> {
  const { durableInteractiveTurnService } = await import('./durableInteractiveTurnService');
  return durableInteractiveTurnService.retry(input);
}

async function defaultLoadArtifact(session: BrainstormSessionRow): Promise<FrozenBrainstormArtifact> {
  const { brainstormArtifactStore } = await import('./brainstormArtifactVersionStore');
  return brainstormArtifactStore.resolveArtifactContext(session.id, session.project);
}

async function defaultCancelThreadRun(threadId: string): Promise<void> {
  const { cancelRun } = await import('./chatAgentService');
  await cancelRun(threadId);
}

const SHA_40 = /^[a-f0-9]{40}$/i;

export interface DefaultBrainstormSourceResolvers {
  listCatalogRepos: (project: string) => Promise<Array<{
    id: string;
    displayName: string;
    cloneUrl: string;
    status: string;
    commitSha: string | null;
    workspacePath: string;
  }>>;
  listProjectSkillRepos: (project: string) => Promise<Array<{
    id: string;
    displayName: string;
    repository: string;
    provider: 'github' | 'ado';
    commitSha: string;
    workspacePath?: string | null;
  }>>;
  isMcpEnabled: (project: string, userId: string) => Promise<boolean>;
  listProjectMcpServers: (project: string) => Promise<Array<{
    id: string;
    name: string;
    operations: Array<{ id: string; summary?: string }>;
  }>>;
}

export async function resolveDefaultBrainstormSources(input: {
  session: BrainstormSessionRow;
  settled: { ready: SourceRecord[]; unavailable: SourceRecord[] };
  explicitMcpTools: GatewayTool[];
  resolvers: DefaultBrainstormSourceResolvers;
}): Promise<{ ready: SourceRecord[]; unavailable: SourceRecord[]; mcpTools: GatewayTool[] }> {
  const { session, settled, explicitMcpTools, resolvers } = input;
  const hasExplicitRepo = settled.ready.some((row) => row.kind !== 'mcp-server')
    || settled.unavailable.some((row) => row.kind !== 'mcp-server');
  const hasExplicitMcp = settled.ready.some((row) => row.kind === 'mcp-server')
    || settled.unavailable.some((row) => row.kind === 'mcp-server');

  const defaultRepoRows: SourceRecord[] = [];
  if (!hasExplicitRepo) {
    const [catalogRepos, skillRepos] = await Promise.all([
      resolvers.listCatalogRepos(session.project).catch(() => []),
      resolvers.listProjectSkillRepos(session.project).catch(() => []),
    ]);
    const seenNames = new Set<string>();
    for (const repo of catalogRepos) {
      if (repo.status !== 'ready' || !repo.commitSha || !SHA_40.test(repo.commitSha)) continue;
      let provider: 'github' | 'ado' = 'ado';
      try {
        const host = new URL(repo.cloneUrl).hostname.toLowerCase();
        if (host === 'github.com' || host === 'www.github.com' || host.endsWith('.github.com')) {
          provider = 'github';
        }
      } catch {
        provider = 'ado';
      }
      const sha = repo.commitSha.toLowerCase();
      defaultRepoRows.push({
        id: repo.id,
        sessionId: session.id,
        project: session.project,
        kind: 'project-repository',
        displayName: repo.displayName,
        cloneUrl: null,
        requestedRevision: sha,
        commitSha: sha,
        state: 'ready',
        refId: repo.id,
        reasonCode: null,
        reasonText: null,
        sizeBytes: null,
        mcpReadOnlyToolCount: null,
        groundingProvider: provider,
        groundingProject: session.project,
        groundingRepository: repo.displayName,
        updatedAt: session.updatedAt,
        workspaceRemovedAt: null,
        workspacePath: repo.workspacePath,
      });
      seenNames.add(repo.displayName.trim().toLowerCase());
    }
    for (const repo of skillRepos) {
      if (!repo.commitSha || !SHA_40.test(repo.commitSha)) continue;
      const displayKey = repo.displayName.trim().toLowerCase();
      const repoKey = repo.repository.trim().toLowerCase();
      if (seenNames.has(displayKey) || seenNames.has(repoKey)) continue;
      const sha = repo.commitSha.toLowerCase();
      defaultRepoRows.push({
        id: repo.id,
        sessionId: session.id,
        project: session.project,
        kind: 'project-repository',
        displayName: repo.displayName,
        cloneUrl: null,
        requestedRevision: sha,
        commitSha: sha,
        state: 'ready',
        refId: repo.id,
        reasonCode: null,
        reasonText: null,
        sizeBytes: null,
        mcpReadOnlyToolCount: null,
        groundingProvider: repo.provider,
        groundingProject: session.project,
        groundingRepository: repo.repository,
        updatedAt: session.updatedAt,
        workspaceRemovedAt: null,
        ...(repo.workspacePath ? { workspacePath: repo.workspacePath } : {}),
      });
      seenNames.add(displayKey);
      seenNames.add(repoKey);
    }
  }

  const defaultMcpTools: GatewayTool[] = [];
  if (!hasExplicitMcp) {
    const mcpOn = await resolvers.isMcpEnabled(session.project, session.creatorId).catch(() => false);
    if (mcpOn) {
      const servers = await resolvers.listProjectMcpServers(session.project).catch(() => []);
      for (const server of servers) {
        const prefix = toolPrefixFor(server.name, server.id);
        for (const operation of server.operations) {
          defaultMcpTools.push({
            toolName: `${prefix}__${operation.id}`,
            toolId: operation.id,
            connectionId: server.id,
            displayName: server.name,
            toolPrefix: prefix,
            ...(operation.summary?.trim() ? { summary: operation.summary.trim().slice(0, 160) } : {}),
          });
        }
      }
    }
  }

  return {
    ready: [...settled.ready, ...defaultRepoRows],
    unavailable: settled.unavailable,
    mcpTools: [...explicitMcpTools, ...defaultMcpTools],
  };
}

async function defaultPrepareTurnContext(
  session: BrainstormSessionRow,
): Promise<Pick<FrozenBrainstormTurn, 'sourceLimits' | 'sources'>> {
  const limits = await resolveBrainstormLimits(session.project);
  const { brainstormSourceRuntime } = await import('../routes/brainstormSources');
  const { listMountedMcpTools } = await import('./mcpServerReadService');
  const runtime = brainstormSourceRuntime();
  const settled = await runtime.manager.ensureSourcesReady(session.id, session.project, limits);
  const explicitMcpTools: GatewayTool[] = [];
  for (const row of settled.ready) {
    if (row.kind !== 'mcp-server' || !row.refId) continue;
    const prefix = toolPrefixFor(row.displayName, row.refId);
    for (const operation of readOnlyOperations(await listMountedMcpTools(row.refId))) {
      explicitMcpTools.push({
        toolName: `${prefix}__${operation.id}`,
        toolId: operation.id,
        connectionId: row.refId,
        displayName: row.displayName,
        toolPrefix: prefix,
        ...(operation.summary?.trim() ? { summary: operation.summary.trim().slice(0, 160) } : {}),
      });
    }
  }
  const merged = await resolveDefaultBrainstormSources({
    session,
    settled,
    explicitMcpTools,
    resolvers: {
      listCatalogRepos: async (project) => {
        const { brainstormRepositoryMirrorDir, listBrainstormRepositories } = await import('./brainstormRepositoryCatalog');
        const rows = await listBrainstormRepositories(project);
        return rows.map((row) => ({
          id: row.id,
          displayName: row.displayName,
          cloneUrl: row.cloneUrl,
          status: row.status,
          commitSha: row.commitSha,
          workspacePath: brainstormRepositoryMirrorDir(row.id),
        }));
      },
      listProjectSkillRepos: async (project) => {
        const [{ listSkillConfigs }, { getProjectRepositoryReadiness }, { readCachedOriginSha }, { sharedReadCheckoutService }] = await Promise.all([
          import('./projectSettingsService'),
          import('./projectRepositoryReadinessService'),
          import('./repoCacheService'),
          import('./grounding/sharedReadCheckoutService'),
        ]);
        const configs = (await listSkillConfigs())
          .filter((item) => item.project === project && Boolean(item.skillRepo?.trim()) && Boolean(item.skillBranch?.trim()))
          .sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? -1 : 1));
        const resolved: Array<{
          id: string;
          displayName: string;
          repository: string;
          provider: 'github' | 'ado';
          commitSha: string;
          workspacePath?: string | null;
        }> = [];
        for (const config of configs) {
          const provider = config.skillProvider === 'github' ? 'github' as const : 'ado' as const;
          const repoName = config.skillRepo.trim();
          const branchName = config.skillBranch.trim();
          const [readiness, cachedSha] = await Promise.all([
            getProjectRepositoryReadiness(config.id, { project }).catch(() => null),
            readCachedOriginSha({
              provider: provider === 'github' ? 'github' : 'azure_devops',
              project: config.project,
              repository: repoName,
              branch: branchName,
            }).catch(() => null),
          ]);
          const sha = (readiness?.sha && SHA_40.test(readiness.sha) ? readiness.sha : null)
            ?? (cachedSha && SHA_40.test(cachedSha) ? cachedSha : null)
            ?? (config.repositoryCheckoutSha && SHA_40.test(config.repositoryCheckoutSha) ? config.repositoryCheckoutSha : null);
          if (!sha) continue;
          const sharedReady = sharedReadCheckoutService.getReady({
            provider,
            project: config.project,
            repo: repoName,
            branch: branchName,
            sha,
          });
          resolved.push({
            id: config.id,
            displayName: config.friendlyName?.trim() || repoName,
            repository: repoName,
            provider,
            commitSha: sha,
            workspacePath: sharedReady?.workspacePath ?? null,
          });
        }
        return resolved;
      },
      isMcpEnabled: async (project, userId) => {
        const { isFeatureEnabled } = await import('./featureFlagService');
        return isFeatureEnabled('mcp-servers', { project, userId, caller: 'brainstorm' }).catch(() => false);
      },
      listProjectMcpServers: async (project) => {
        const { listMcpServers } = await import('./mcpServerConnectionService');
        const servers = await listMcpServers(project).catch(() => []);
        return Promise.all(
          servers.map(async (server) => ({
            id: server.id,
            name: server.name,
            operations: readOnlyOperations(
              await listMountedMcpTools(server.id).catch(() => server.operations ?? []),
            ),
          })),
        );
      },
    },
  });
  return {
    sourceLimits: limits,
    sources: buildBrainstormTurnSources({
      ready: merged.ready,
      unavailable: merged.unavailable,
      mcpTools: merged.mcpTools,
      limits,
      dataRoot: resolveDataRoot(),
    }),
  };
}

const defaultDeps: BrainstormOrchestrationDeps = {
  isV2TransportEnabled: defaultIsV2TransportEnabled,
  loadCreatorContext: defaultLoadCreatorContext,
  sendTurn: defaultSendTurn,
  retryRun: defaultRetryRun,
  loadArtifact: defaultLoadArtifact,
  cancelThreadRun: defaultCancelThreadRun,
  ledger: {
    openTurn: ledger.openTurn,
    openRetryRow: ledger.openRetryRow,
    attachRun: ledger.attachRun,
    failOpenRow: ledger.failOpenRow,
    latestAssistantRow: ledger.latestAssistantRow,
    findMessage: ledger.findMessage,
    findAssistantByRun: ledger.findAssistantByRun,
    reconcileStreamingRows: ledger.reconcileStreamingRows,
  },
  prepareTurnContext: defaultPrepareTurnContext,
  setTitleIfEmpty: (sessionId, project, text, userId) =>
    brainstormSessionService.setTitleIfEmpty(sessionId, project, text, userId),
};

function translateAdmissionError(err: unknown): unknown {
  if (err instanceof BrainstormError) return err;
  if (err instanceof BrainstormLedgerConflict) return new BrainstormError('turn_in_progress', 409);
  if (err instanceof DurableInteractiveTurnError) {
    if (err.code === 'THREAD_ACTIVE_TURN') return new BrainstormError('turn_in_progress', 409);
    if (err.code === 'RUN_NOT_RETRYABLE') return new BrainstormError('not_retryable', 409);
  }
  const record = err as { status?: number; message?: string };
  if (record?.status === 409 && record.message === 'transport_unavailable') {
    return new BrainstormError('transport_unavailable', 409);
  }
  return err;
}

function accepted(
  response: InteractiveTurnAcceptedResponse,
  messageId: string,
): BrainstormTurnAcceptedResponse {
  return {
    turnId: response.turnId,
    runId: response.runId,
    status: response.status,
    interactiveClass: response.interactiveClass,
    messageId,
  };
}

export function createBrainstormOrchestrationService(deps: BrainstormOrchestrationDeps = defaultDeps) {
  return {
    /** Admits one creator turn on V2. Callers have already checked `mutate` access. */
    async runTurn(input: {
      session: BrainstormSessionRow;
      userId: string;
      turnId: string;
      text: string;
      model?: string;
      mode?: import('../../shared/types/brainstormArtifact').BrainstormComposerMode;
      attachments?: import('../../shared/types/chat').ChatAttachment[];
      intent?: BrainstormTurnIntent;
    }): Promise<BrainstormTurnAcceptedResponse> {
      const { session, userId, turnId, text, model, mode, attachments } = input;
      if (!(await deps.isV2TransportEnabled(userId, session.project))) {
        throw new BrainstormError('transport_unavailable', 409);
      }

      let opened: ledger.OpenedTurn;
      try {
        opened = await deps.ledger.openTurn({ sessionId: session.id, project: session.project, turnId, text });
      } catch (err) {
        throw translateAdmissionError(err);
      }

      let response: InteractiveTurnAcceptedResponse;
      try {
        const [creatorContext, prepared, artifact] = await Promise.all([
          deps.loadCreatorContext(userId),
          deps.prepareTurnContext(session),
          deps.loadArtifact(session),
        ]);
        const intent: BrainstormTurnIntent = input.intent
          ?? (mode && isBrainstormArtifactType(mode) && mode !== artifact.type
            ? { kind: 'type_switch', targetType: mode }
            : { kind: 'chat' });
        const brainstorm: FrozenBrainstormTurn = {
          sessionId: session.id,
          creatorContext,
          sourceLimits: prepared.sourceLimits,
          sources: prepared.sources,
          artifact,
          intent,
        };
        response = await deps.sendTurn({
          threadId: session.chatThreadId,
          userId,
          turnId,
          text,
          ...(model?.trim() ? { model: model.trim() } : {}),
          ...(attachments?.length ? { attachments } : {}),
          internalContext: [
            formatCreatorContext(creatorContext),
            formatSourcesContext(prepared.sources),
            formatArtifactContext(artifact, intent, mode),
          ].join('\n\n'),
          brainstorm,
        });
      } catch (err) {
        if (!opened.existing) await deps.ledger.failOpenRow(opened.assistant.id, 'run_not_started').catch(() => {});
        throw translateAdmissionError(err);
      }

      if (!opened.assistant.runId) await deps.ledger.attachRun(opened.assistant.id, response.runId);
      if (!opened.existing) {
        await deps.setTitleIfEmpty(session.id, session.project, text, userId).catch(() => {});
        trackEvent('brainstorm.turn.admitted', {
          project: session.project,
          sessionId: session.id,
          runId: response.runId,
          interactiveClass: response.interactiveClass,
        });
      }
      return accepted(response, opened.assistant.id);
    },

    /**
     * Retries the latest failed or cancelled, unsuperseded assistant row by run identity.
     * A repeated retry of the same run returns the replacement already made.
     */
    async retryFailedTurn(input: {
      session: BrainstormSessionRow;
      userId: string;
      runId: string;
    }): Promise<BrainstormTurnAcceptedResponse> {
      const { session, userId, runId } = input;
      const failed = await deps.ledger.findAssistantByRun(session.id, runId);
      if (!failed || (failed.status !== 'failed' && failed.status !== 'cancelled')) {
        throw new BrainstormError('not_retryable', 409);
      }

      if (failed.supersededByMessageId) {
        const replacement = await deps.ledger.findMessage(session.id, failed.supersededByMessageId);
        if (replacement?.runId) {
          return {
            turnId: replacement.turnId,
            runId: replacement.runId,
            status: replacement.status === 'streaming' ? 'running' : replacement.status,
            interactiveClass: 'unknown',
            messageId: replacement.id,
          };
        }
        throw new BrainstormError('not_retryable', 409);
      }

      const latest = await deps.ledger.latestAssistantRow(session.id);
      if (latest?.id !== failed.id) throw new BrainstormError('not_retryable', 409);
      if (!(await deps.isV2TransportEnabled(userId, session.project))) {
        throw new BrainstormError('transport_unavailable', 409);
      }

      let response: InteractiveTurnAcceptedResponse;
      try {
        const refreshedBrainstormArtifact = await deps.loadArtifact(session);
        response = await deps.retryRun({ threadId: session.chatThreadId, runId, userId, refreshedBrainstormArtifact });
      } catch (err) {
        throw translateAdmissionError(err);
      }
      let replacement: ledger.BrainstormMessageRow;
      try {
        replacement = await deps.ledger.openRetryRow({ failed, runId: response.runId });
      } catch (err) {
        throw translateAdmissionError(err);
      }
      trackEvent('brainstorm.turn.retried', {
        project: session.project,
        sessionId: session.id,
        runId: response.runId,
      });
      return accepted(response, replacement.id);
    },

    async cancel(input: { session: BrainstormSessionRow }): Promise<void> {
      await deps.cancelThreadRun(input.session.chatThreadId);
      await deps.ledger.reconcileStreamingRows(input.session.id, input.session.chatThreadId);
    },
  };
}

export type BrainstormOrchestrationService = ReturnType<typeof createBrainstormOrchestrationService>;

export const brainstormOrchestrationService = createBrainstormOrchestrationService();
