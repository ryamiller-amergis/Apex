import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ChatAttachment,
  ChatThread,
  ChatTurnSkill,
} from '../../shared/types/chat';
import type { EffortLevel } from '../../shared/types/effort';
import type { InteractiveWorkflowClass } from '../../shared/types/interactiveWorkflow';
import type {
  DurableInteractiveTurnSpecification,
  FrozenInteractiveMcpDescriptor,
  FrozenInteractiveToolGrant,
  InteractiveCapability,
  InteractiveDeadlinePolicy,
  InteractiveTurnAcceptedResponse,
} from '../../shared/types/durableInteractiveTurn';
import { isCanonicalUuid } from '../../shared/types/durableInteractiveTurn';
import type {
  ProjectSkillConfigResponse,
  QuickMcpPill,
  SkillProvider,
} from '../../shared/types/projectSettings';
import type { GroundingProfileId } from '../../shared/types/repoReader';
import { callerGroundingService } from './callerGroundingService';
import { groundingProfileResolver } from './groundingProfileResolver';
import type { ThreadAccessResult } from './threadAccessService';
import { resolveThreadAccess } from './threadAccessService';
import { resolveSkillConfig } from './projectSettingsService';
import { getSkillFile } from './skillCatalogFacade';
import {
  classifyInteractiveTurn,
  type InteractiveClassificationInput,
} from './interactiveTurnClassifier';
import {
  createInteractiveAttachmentStore,
  type InteractiveAttachmentStore,
} from './interactiveAttachmentStore';
import {
  resolveInteractiveDeadlinePolicy,
} from './interactiveDeadlinePolicy';
import {
  durableInteractiveTurnRepository,
  type DurableInteractiveTurnRepository,
} from './durableInteractiveTurnRepository';
import {
  encryptInteractiveToolGrant,
  type EncryptInteractiveToolGrantInput,
} from './interactiveToolGrantCrypto';

const DEFAULT_MODEL = 'composer-2';
const MAX_TRANSCRIPT_CHARS = 120_000;
const CHAT_WRITE_POLICY_LINES = [
  '# Repository and Azure DevOps write policy',
  '- Treat the repository checkout as read-only. Never create, edit, delete, or move files in it.',
  '- Create, update, comment on, link, or re-parent Azure DevOps work items only when the user directly requests that write in the current turn.',
  '- Informational questions and analysis must not mutate Azure DevOps.',
  '',
] as const;

type AllowedOperation = FrozenInteractiveToolGrant['allowedOperations'][number];

export type DurableInteractiveToolGrantInput = Readonly<{
  allowedOperations: ReadonlyArray<AllowedOperation>;
  delegatedAdoToken: string | null;
}>;

export type AdmitDurableInteractiveTurnInput = Readonly<{
  threadId: string;
  userId: string;
  workflowClass: InteractiveWorkflowClass;
  turnId: string;
  text: string;
  modelOverride?: string;
  attachments?: ReadonlyArray<ChatAttachment>;
  hidden?: boolean;
  turnSkill?: ChatTurnSkill;
  toolGrant?: DurableInteractiveToolGrantInput;
}>;

export interface DurableInteractiveTurnService {
  admit(
    input: AdmitDurableInteractiveTurnInput,
  ): Promise<InteractiveTurnAcceptedResponse>;
}

type FrozenGrounding = DurableInteractiveTurnSpecification['grounding'];

type ResolveGroundingInput = Readonly<{
  thread: ChatThread;
  userId: string;
}>;

type LoadSkillInput = Readonly<{
  thread: ChatThread;
  skill: ChatTurnSkill;
  grounding: FrozenGrounding;
}>;

type ServiceDependencies = Readonly<{
  repository: DurableInteractiveTurnRepository;
  attachmentStore: InteractiveAttachmentStore;
  resolveThreadAccess: (
    userId: string,
    threadId: string,
  ) => Promise<ThreadAccessResult | null>;
  resolveSkillConfig: typeof resolveSkillConfig;
  loadSkill: (
    input: LoadSkillInput,
  ) => Promise<{ path: string; content: string } | null>;
  resolveGrounding: (
    input: ResolveGroundingInput,
  ) => Promise<FrozenGrounding>;
  resolveDeadlines: (
    input: Readonly<{
      interactiveClass: 'fast' | 'agentic';
      requiresRepositoryPreparation: boolean;
    }>,
  ) => InteractiveDeadlinePolicy;
  encryptToolGrant: (
    input: EncryptInteractiveToolGrantInput,
  ) => FrozenInteractiveToolGrant;
  now: () => Date;
}>;

export class DurableInteractiveTurnError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TURN_ID'
      | 'THREAD_ACTIVE_TURN'
      | 'TURN_ID_CONFLICT'
      | 'USER_INTERACTIVE_LIMIT'
      | 'USER_AGENTIC_LIMIT'
      | 'INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED'
      | 'INTERACTIVE_V2_GROUNDING_UNAVAILABLE',
    readonly status: 400 | 409 | 422 | 429,
  ) {
    super(code);
    this.name = 'DurableInteractiveTurnError';
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizeHashText(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

function selectedSkill(
  thread: ChatThread,
  turnSkill: ChatTurnSkill | undefined,
): ChatTurnSkill | null {
  const selectedPath = turnSkill?.path ?? thread.kickoff.skillPath;
  if (!selectedPath?.trim()) return null;
  const normalizedPath = normalizePath(selectedPath.trim());
  const fallbackName =
    normalizedPath.split('/').filter(Boolean).slice(-2, -1)[0] ??
    normalizedPath;
  return {
    name:
      turnSkill?.name?.trim() ||
      thread.kickoff.pillLabel?.trim() ||
      fallbackName,
    path: normalizedPath,
  };
}

function configuredSkillPaths(
  config: ProjectSkillConfigResponse | null,
): Set<string> {
  const paths = new Set<string>();
  if (!config) return paths;
  for (const [key, value] of Object.entries(config)) {
    if (
      /skillpath$/i.test(key) &&
      typeof value === 'string' &&
      value.trim()
    ) {
      paths.add(normalizePath(value).toLowerCase());
    }
  }
  for (const pill of config.quickSkillPills ?? []) {
    if (pill.skillPath?.trim()) {
      paths.add(normalizePath(pill.skillPath).toLowerCase());
    }
  }
  for (const option of config.interviewSkillOptions ?? []) {
    if (option.path?.trim()) {
      paths.add(normalizePath(option.path).toLowerCase());
    }
  }
  return paths;
}

function registeredSkillName(
  skillPath: string,
  config: ProjectSkillConfigResponse | null,
): string | null {
  const normalized = normalizePath(skillPath).toLowerCase();
  const pill = config?.quickSkillPills?.find(
    (candidate) =>
      normalizePath(candidate.skillPath).toLowerCase() === normalized,
  );
  if (pill?.label.trim()) return pill.label.trim();
  const option = config?.interviewSkillOptions?.find(
    (candidate) => normalizePath(candidate.path).toLowerCase() === normalized,
  );
  return option?.friendlyName?.trim() || null;
}

function capabilityMetadata(
  thread: ChatThread,
  skill: ChatTurnSkill | null,
  config: ProjectSkillConfigResponse | null,
  attachmentCount: number,
  toolGrant: DurableInteractiveToolGrantInput | undefined,
): InteractiveClassificationInput['capabilityMetadata'] {
  const capabilities: InteractiveCapability[] = ['plain-chat'];
  if (attachmentCount > 0) capabilities.push('attachments');
  if (
    thread.kickoff.mcpPill ||
    thread.kickoff.webResearchEnabled ||
    thread.kickoff.assistantType === 'calendar-work-item'
  ) {
    capabilities.push('mcp');
  }
  if (toolGrant) capabilities.push('ado');

  if (!skill) {
    return { status: 'known', capabilities };
  }
  const configured = configuredSkillPaths(config);
  const pathWasFrozenOnThread =
    normalizePath(thread.kickoff.skillPath ?? '').toLowerCase() ===
    skill.path.toLowerCase();
  if (!pathWasFrozenOnThread && !configured.has(skill.path.toLowerCase())) {
    return { status: 'unknown' };
  }
  return { status: 'known', capabilities };
}

function classHasCapability(
  reasons: ReadonlyArray<string>,
  capability: InteractiveCapability,
): boolean {
  return reasons.includes(`capability:${capability}`);
}

function isStdioMcp(pill: QuickMcpPill | undefined): boolean {
  return pill?.transport === 'stdio';
}

function visibleTranscript(
  thread: ChatThread,
): DurableInteractiveTurnSpecification['transcript'] {
  const visible = thread.messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'agent') &&
        !message.hidden &&
        message.toolName !== '_reasoning' &&
        message.text.trim().length > 0,
    )
    .map((message) => ({
      id: message.id,
      role: message.role === 'agent' ? ('agent' as const) : ('user' as const),
      text: message.text,
      timestamp: message.ts,
    }));
  let retainedChars = visible.reduce(
    (total, message) => total + message.text.length,
    0,
  );
  while (visible.length > 1 && retainedChars > MAX_TRANSCRIPT_CHARS) {
    retainedChars -= visible.shift()?.text.length ?? 0;
  }
  if (visible.length === 1 && retainedChars > MAX_TRANSCRIPT_CHARS) {
    visible[0] = {
      ...visible[0],
      text: visible[0].text.slice(-MAX_TRANSCRIPT_CHARS),
    };
  }
  return visible;
}

function promptWithAttachments(
  text: string,
  attachments: DurableInteractiveTurnSpecification['currentMessage']['attachments'],
): string {
  const messageText =
    text.trim() || 'Please use the uploaded files as additional context.';
  if (attachments.length === 0) return messageText;
  return [
    messageText,
    '',
    '# Uploaded context files for this turn',
    'The user attached these files. Read them before responding when relevant.',
    ...attachments.map((attachment) => {
      const imageHint = attachment.contentType.startsWith('image/')
        ? ' [IMAGE]'
        : '';
      return `- ${attachment.name} (${attachment.contentType}, ${attachment.sizeBytes} bytes): \`${attachment.materializedPath}\`${imageHint}`;
    }),
  ].join('\n');
}

function currentPrompt(
  text: string,
  skill: ChatTurnSkill | null,
  frozenSkill: DurableInteractiveTurnSpecification['skill'],
  attachments: DurableInteractiveTurnSpecification['currentMessage']['attachments'],
): string {
  return [
    ...CHAT_WRITE_POLICY_LINES,
    ...(skill ? [`Run skill: ${skill.name} (\`${skill.path}\`)`, ''] : []),
    ...(frozenSkill
      ? [
          `# Pre-loaded skill content (${frozenSkill.path})`,
          frozenSkill.content,
          '',
          'The skill content above is already loaded. Follow it for this turn.',
          '',
        ]
      : []),
    'User request:',
    promptWithAttachments(text, attachments),
  ].join('\n');
}

function recreationPrompt(input: {
  thread: ChatThread;
  transcript: DurableInteractiveTurnSpecification['transcript'];
  currentPrompt: string;
}): string {
  const transcript = input.transcript.flatMap((entry, index) => [
    `--- message ${index + 1} | role=${entry.role} | timestamp=${entry.timestamp} ---`,
    entry.text,
    '',
  ]);
  return [
    '# Apex interactive turn',
    `Project: ${input.thread.kickoff.project}`,
    `Repository: ${input.thread.kickoff.repo}`,
    ...(input.thread.kickoff.freeformContext
      ? ['', '# Thread context', input.thread.kickoff.freeformContext]
      : []),
    '',
    '# Durable visible conversation',
    ...transcript,
    '# Current turn',
    input.currentPrompt,
  ].join('\n');
}

function frozenMcpDescriptors(
  thread: ChatThread,
  hasAdoCapability: boolean,
  grounding: FrozenGrounding,
): FrozenInteractiveMcpDescriptor[] {
  const descriptors: FrozenInteractiveMcpDescriptor[] = [];
  const pill = thread.kickoff.mcpPill;
  if (pill?.transport === 'http') {
    const headerEnvRefs = Object.fromEntries(
      Object.entries(pill.headers ?? {}).flatMap(([header, value]) => {
        const match = value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i);
        return match ? [[header, match[1]]] : [];
      }),
    );
    descriptors.push({
      kind: 'external-http-proxy',
      serverName: pill.mcpServerName,
      url: pill.url,
      headerEnvRefs,
    });
  }
  if (thread.kickoff.assistantType === 'calendar-work-item') {
    descriptors.push({
      kind: 'internal-proxy',
      serverName: 'calendar-assistant',
      ...(thread.kickoff.calendarAssistantSessionId
        ? { calendarSessionId: thread.kickoff.calendarAssistantSessionId }
        : {}),
      enableRepoBrowse: false,
    });
  }
  if (hasAdoCapability) {
    descriptors.push({
      kind: 'internal-proxy',
      serverName: 'ado-skills',
      ...(grounding?.profileId ? { profileId: grounding.profileId } : {}),
      enableRepoBrowse: Boolean(grounding),
    });
  }
  return descriptors;
}

function requestHash(input: {
  text: string;
  model: string;
  skill: DurableInteractiveTurnSpecification['skill'];
  attachments: DurableInteractiveTurnSpecification['currentMessage']['attachments'];
}): string {
  const canonical = {
    text: normalizeHashText(input.text),
    model: normalizeHashText(input.model.trim()),
    skill:
      input.skill === null
        ? null
        : {
            name: normalizeHashText(input.skill.name.trim()),
            path: normalizePath(input.skill.path),
            sha256: input.skill.sha256,
          },
    attachments: input.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      sha256: attachment.sha256,
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

async function defaultLoadSkill(
  input: LoadSkillInput,
): Promise<{ path: string; content: string } | null> {
  if (input.grounding) {
    try {
      const reader =
        await groundingProfileResolver.resolveConnectionProfile(
          input.grounding.profileId as GroundingProfileId,
        );
      const content = await reader?.readFile(input.skill.path);
      if (content) return { path: input.skill.path, content };
    } catch {
      // Continue to the established provider/local fallback.
    }
  }
  const provider: SkillProvider = input.thread.kickoff.skillProvider ?? 'ado';
  const branch =
    input.thread.kickoff.skillBranch ??
    input.thread.kickoff.branch ??
    'main';
  try {
    const content = await getSkillFile(
      input.thread.kickoff.project,
      input.thread.kickoff.repo,
      input.skill.path,
      branch,
      provider,
    );
    if (content) return { path: input.skill.path, content };
  } catch {
    // The checked-out server source is the established local skill fallback.
  }

  const localPath = path.resolve(process.cwd(), input.skill.path);
  try {
    const metadata = fs.lstatSync(localPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    return {
      path: input.skill.path,
      content: fs.readFileSync(localPath, 'utf8'),
    };
  } catch {
    return null;
  }
}

async function defaultResolveGrounding(
  input: ResolveGroundingInput,
): Promise<FrozenGrounding> {
  const repository = {
    provider: input.thread.kickoff.skillProvider ?? 'ado',
    repo: input.thread.kickoff.repo,
    branch:
      input.thread.kickoff.skillBranch ??
      input.thread.kickoff.branch ??
      'main',
  } as const;
  const start = () =>
    callerGroundingService.start({
      caller: 'durable-interactive',
      userId: input.userId,
      run: {
        runType: 'chat',
        runId: input.thread.id,
        project: input.thread.kickoff.project,
      },
      repository,
      reauthorize: async () => true,
      readOnlyShareable: true,
      sandboxCwd: input.thread.workspaceDir,
    });
  let selection = await start();
  if (selection.mode === 'preparing') {
    if (!selection.waitUntilReady) return null;
    await selection.waitUntilReady();
    selection = await start();
  }
  if (selection.mode !== 'local') return null;
  return {
    provider: repository.provider,
    project: input.thread.kickoff.project,
    repository: repository.repo,
    sha: selection.resolvedSha,
    profileId: selection.profileId,
  };
}

let resolvedDefaultAttachmentStore: InteractiveAttachmentStore | null = null;

const lazyDefaultAttachmentStore: InteractiveAttachmentStore = {
  upload(input) {
    resolvedDefaultAttachmentStore ??= createInteractiveAttachmentStore();
    return resolvedDefaultAttachmentStore.upload(input);
  },
};

function defaultDependencies(): ServiceDependencies {
  return {
    repository: durableInteractiveTurnRepository,
    attachmentStore: lazyDefaultAttachmentStore,
    resolveThreadAccess,
    resolveSkillConfig,
    loadSkill: defaultLoadSkill,
    resolveGrounding: defaultResolveGrounding,
    resolveDeadlines: resolveInteractiveDeadlinePolicy,
    encryptToolGrant: encryptInteractiveToolGrant,
    now: () => new Date(),
  };
}

export function createDurableInteractiveTurnService(
  dependencies: Partial<ServiceDependencies> = {},
): DurableInteractiveTurnService {
  const deps = { ...defaultDependencies(), ...dependencies };

  return {
    async admit(input) {
      if (!isCanonicalUuid(input.turnId)) {
        throw new DurableInteractiveTurnError('INVALID_TURN_ID', 400);
      }
      const access = await deps.resolveThreadAccess(
        input.userId,
        input.threadId,
      );
      if (!access) {
        throw Object.assign(new Error('Thread not found'), { status: 404 });
      }
      const thread = access.thread;
      const attachments = [...(input.attachments ?? [])];
      const initiallySelectedSkill = selectedSkill(thread, input.turnSkill);
      const config = await deps.resolveSkillConfig({
        project: thread.kickoff.project,
        settingsId: thread.kickoff.skillSettingsId ?? undefined,
      });
      const skill =
        initiallySelectedSkill && !input.turnSkill
          ? {
              ...initiallySelectedSkill,
              name:
                thread.kickoff.pillLabel?.trim() ||
                registeredSkillName(initiallySelectedSkill.path, config) ||
                initiallySelectedSkill.name,
            }
          : initiallySelectedSkill;
      if (isStdioMcp(thread.kickoff.mcpPill)) {
        throw new DurableInteractiveTurnError(
          'INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED',
          422,
        );
      }

      const metadata = capabilityMetadata(
        thread,
        skill,
        config,
        attachments.length,
        input.toolGrant,
      );
      const classification = classifyInteractiveTurn({
        effort: (thread.kickoff.effort as EffortLevel | undefined) ?? null,
        skillPath: skill?.path ?? null,
        capabilityMetadata: metadata,
      });
      const requiresRepositoryPreparation = classHasCapability(
        classification.reasons,
        'workspace',
      );

      const immutableAttachments = [];
      for (const attachment of attachments) {
        immutableAttachments.push(
          await deps.attachmentStore.upload({
            threadId: input.threadId,
            turnId: input.turnId,
            attachment,
          }),
        );
      }

      const grounding = requiresRepositoryPreparation
        ? await deps.resolveGrounding({ thread, userId: input.userId })
        : null;
      if (requiresRepositoryPreparation && grounding === null) {
        throw new DurableInteractiveTurnError(
          'INTERACTIVE_V2_GROUNDING_UNAVAILABLE',
          422,
        );
      }

      const model =
        input.modelOverride?.trim() ||
        thread.kickoff.model?.trim() ||
        DEFAULT_MODEL;
      const loadedSkill = skill
        ? await deps.loadSkill({ thread, skill, grounding })
        : null;
      if (skill && !loadedSkill) {
        throw new DurableInteractiveTurnError(
          'INTERACTIVE_V2_GROUNDING_UNAVAILABLE',
          422,
        );
      }
      const frozenSkill =
        skill && loadedSkill
          ? {
              name: skill.name,
              path: normalizePath(loadedSkill.path),
              sha256: createHash('sha256')
                .update(loadedSkill.content, 'utf8')
                .digest('hex'),
              content: loadedSkill.content,
            }
          : null;
      const deadlines = deps.resolveDeadlines({
        interactiveClass: classification.interactiveClass,
        requiresRepositoryPreparation,
      });
      const expiresAt = new Date(
        deps.now().getTime() + deadlines.absoluteTurnMs,
      ).toISOString();
      const hasAdoCapability =
        input.toolGrant !== undefined ||
        classHasCapability(classification.reasons, 'ado');
      const toolGrant = hasAdoCapability
        ? deps.encryptToolGrant({
            userId: input.userId,
            projectId: thread.kickoff.project,
            allowedOperations:
              input.toolGrant?.allowedOperations ?? ['ado:read'],
            delegatedAdoToken:
              input.toolGrant?.delegatedAdoToken ?? null,
            expiresAt,
          })
        : null;
      const transcript = visibleTranscript(thread);
      const messageText =
        input.text.trim() || 'Uploaded files for context.';
      const preparedCurrentPrompt = currentPrompt(
        input.text,
        skill,
        frozenSkill,
        immutableAttachments,
      );
      const specification: DurableInteractiveTurnSpecification = {
        schemaVersion: 1,
        kind: 'interactive-turn',
        turnId: input.turnId,
        threadId: input.threadId,
        userId: input.userId,
        projectId: thread.kickoff.project,
        interactiveClass: classification.interactiveClass,
        workflowClass: input.workflowClass,
        model,
        effort: thread.kickoff.effort ?? null,
        skill: frozenSkill,
        currentMessage: {
          id: input.turnId,
          text: messageText,
          hidden: Boolean(input.hidden),
          attachments: immutableAttachments,
        },
        transcript,
        grounding,
        mcpServers: frozenMcpDescriptors(
          thread,
          hasAdoCapability,
          grounding,
        ),
        toolGrant,
        currentPrompt: preparedCurrentPrompt,
        recreationPrompt: recreationPrompt({
          thread,
          transcript,
          currentPrompt: preparedCurrentPrompt,
        }),
        deadlines,
      };
      const admitted = await deps.repository.admit({
        turnId: input.turnId,
        requestHash: requestHash({
          text: input.text,
          model,
          skill: frozenSkill,
          attachments: immutableAttachments,
        }),
        threadId: input.threadId,
        userId: input.userId,
        projectId: thread.kickoff.project,
        interactiveClass: classification.interactiveClass,
        messageText,
        hidden: Boolean(input.hidden),
        attachments: immutableAttachments,
        specification,
      });

      switch (admitted.status) {
        case 'queued':
        case 'dispatched':
          return {
            turnId: admitted.turnId,
            runId: admitted.runId,
            status: admitted.status,
            interactiveClass: admitted.interactiveClass,
          };
        case 'thread_active':
          throw new DurableInteractiveTurnError('THREAD_ACTIVE_TURN', 409);
        case 'turn_conflict':
          throw new DurableInteractiveTurnError('TURN_ID_CONFLICT', 409);
        case 'user_limit':
          throw new DurableInteractiveTurnError(admitted.code, 429);
        default: {
          const unhandled: never = admitted;
          throw new Error(
            `Unsupported durable admission result: ${String(unhandled)}`,
          );
        }
      }
    },
  };
}

export const durableInteractiveTurnService =
  createDurableInteractiveTurnService();
