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
import type { FrozenBrainstormArtifact } from '../../shared/types/brainstormArtifact';
import { skillNameFromPath, skillPathCandidates } from '../../shared/skillPaths';
import type {
  DurableInteractiveTurnSpecification,
  FrozenBrainstormTurn,
  FrozenGuidedInterview,
  FrozenInteractiveMcpDescriptor,
  FrozenInteractiveToolGrant,
  InteractiveCapability,
  InteractiveClass,
  InteractiveDeadlinePolicy,
  InteractiveTurnAcceptedResponse,
} from '../../shared/types/durableInteractiveTurn';
import {
  INTERACTIVE_USER_SLOT_MAX_WAIT_MS,
  absoluteTurnMsForClass,
  isCanonicalUuid,
  isDurableInteractiveTurnSpecification,
  isDurableUserIdentity,
} from '../../shared/types/durableInteractiveTurn';
import type {
  ProjectSkillConfigResponse,
  QuickMcpPill,
} from '../../shared/types/projectSettings';
import { mcpServerChatInstructions } from '../../shared/types/mcpServers';
import type { GroundingProfileId } from '../../shared/types/repoReader';
import type { RepoReader } from '../../shared/types/repoReader';
import { callerGroundingService } from './callerGroundingService';
import { runGroundingService } from './runGroundingService';
import { groundingProfileResolver } from './groundingProfileResolver';
import { RepoReaderError } from './repoReader';
import { isRepositorySyncingError } from './repoRead/mirrorHydration';
import { buildRepositoryContextPack } from './repositoryContextPack';
import type { ThreadAccessResult } from './threadAccessService';
import { resolveThreadAccess } from './threadAccessService';
import { resolveSkillConfig } from './projectSettingsService';
import {
  buildDocumentAssistantEditGuidance,
  resolveDocumentAssistantType,
} from './documentAssistantGuidance';
import { isFeatureEnabled } from './featureFlagService';
import { trackEvent } from './telemetry';
import { isMaxviewConfigured } from './maxviewAuthService';
import {
  classifyInteractiveTurn,
  type InteractiveClassificationInput,
} from './interactiveTurnClassifier';
import {
  createInteractiveAttachmentStore,
  type InteractiveAttachmentStore,
} from './interactiveAttachmentStore';
import {
  resolveGroundingPreparationTimeoutMs,
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
import { readInterviewBaBrief } from './interviewBaBrief';
import {
  buildGuidedInterviewTurnPrompt,
  deriveGuidedInterviewTurn,
  guidedInterviewRepositoryPhase,
  usesGuidedInterview,
  wrapGuidedInterviewPrompt,
} from './guidedInterviewState';
import { getSkillFile } from './skillCatalogFacade';
import { db } from '../db/drizzle';
import { sql } from 'drizzle-orm';

const PLAYBOOK_INTERVIEW_STEP_FLAG = 'playbook-interview-step';
const BACKGROUND_GROUNDING_FLAG = 'interview-background-grounding';

const DEFAULT_MODEL = 'composer-2.5';
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_RECAP_QUESTION_CHARS = 400;
const MAX_RECAP_ANSWER_CHARS = 1_500;
const CHAT_WRITE_POLICY_LINES = [
  '# Repository and Azure DevOps write policy',
  '- Treat the repository checkout as read-only. Never create, edit, delete, or move files in it.',
  '- Create, update, comment on, link, or re-parent Azure DevOps work items only when the user directly requests that write in the current turn.',
  '- Informational questions and analysis must not mutate Azure DevOps.',
  '',
] as const;
// Keep in step with the legacy kickoff prompt's interactive-question block;
// the chat UI renders `a. text` lines as clickable options.
const INTERACTIVE_QUESTION_UI_LINES = [
  '# UI rendering — interactive questions',
  'This chat has an interactive question UI. When you ask the user a multiple-choice question:',
  '',
  '1. Format each option as `a. text`, `b. text`, etc. on its own line — the UI renders these as clickable buttons the user can select.',
  "2. **Ask only ONE question per message.** After presenting a question, STOP and wait for the user's answer before continuing. Do NOT batch multiple questions into a single response.",
  '3. You may include context, analysis, or trade-offs BEFORE the question in the same message, but the message must end with exactly one set of options.',
  "4. After receiving an answer, acknowledge it, incorporate it into your thinking, then ask the next question. The user's answers may change which questions you ask next.",
  '5. You do NOT have an AskQuestion tool — format questions directly in your text output using the `a. text` pattern described above.',
  "6. Picker answers arrive as `Q<n> · <question>` then `Answer: ...`. `Q<n>` is the UI's running counter and may not match your own question labels; match each answer to the question text it quotes.",
  '',
] as const;
const HOME_CHAT_TURN_CONTRACT_LINES = [
  '# Conversational turn contract',
  '- Do all repository reads before writing the answer.',
  '- Do not narrate tool use, emit progress commentary, or continue researching after answering.',
  '- Emit exactly one user-facing answer for this turn. Once the answer is emitted, the turn is complete.',
  '',
] as const;
const KICKOFF_CONTEXT_FILE_REFERENCE = /`?\.ai-pilot\/kickoff-context\.md`?/g;
const INLINE_THREAD_CONTEXT_REFERENCE = 'the `# Thread context` section of this prompt';
// The worker clears `.ai-pilot/kickoff-transcript.md` before each turn.
const KICKOFF_TRANSCRIPT_NOTE =
  'This section is the full content of `.ai-pilot/kickoff-transcript.md`. That file is not on disk for this session; wherever the skill or request refers to it, read this section instead.';

/**
 * Instructions an agent needs once per session: the chat UI contract, the
 * Home turn contract, and document-assistant staging rules. V2 inlines the
 * kickoff context instead of writing `.ai-pilot/kickoff-context.md`, so file
 * references in the shared document guidance point at that section instead.
 */
function sessionInstructions(
  thread: ChatThread,
  workflowClass: InteractiveWorkflowClass,
): string[] {
  if (thread.kickoff.assistantType === 'mcp-server') {
    return [
      ...mcpServerChatInstructions(thread.kickoff.pillLabel ?? 'MCP server'),
      '',
    ];
  }
  const documentGuidance = buildDocumentAssistantEditGuidance(thread.kickoff).map(
    (line) =>
      line
        .replace(KICKOFF_CONTEXT_FILE_REFERENCE, INLINE_THREAD_CONTEXT_REFERENCE)
        .replace(/\bRead this file\b/g, 'Read that section'),
  );
  return [
    ...INTERACTIVE_QUESTION_UI_LINES,
    ...(workflowClass === 'home-chat' ? HOME_CHAT_TURN_CONTRACT_LINES : []),
    ...(documentGuidance.length > 0 ? [...documentGuidance, ''] : []),
  ];
}

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
  /**
   * The effort the turn sends, already checked against the model's Cursor
   * parameters; null sends none. Omitted uses the thread's effort.
   */
  effort?: EffortLevel | null;
  attachments?: ReadonlyArray<ChatAttachment>;
  hidden?: boolean;
  turnSkill?: ChatTurnSkill;
  toolGrant?: DurableInteractiveToolGrantInput;
  /** Specialist findings for the model prompt. The visible user message stays `text`. */
  internalContext?: string;
  /** Required for, and only for, workflow class `brainstorm`. */
  brainstorm?: FrozenBrainstormTurn;
}>;

export type RetryDurableInteractiveTurnInput = Readonly<{
  threadId: string;
  runId: string;
  userId: string;
  toolGrant?: DurableInteractiveToolGrantInput;
  /** Brainstorm retries re-freeze the artifact so the retried change builds on the current version. */
  refreshedBrainstormArtifact?: FrozenBrainstormArtifact;
}>;

export type DurableInteractiveRetrySource = Readonly<{
  interactiveClass: InteractiveClass;
  specification: DurableInteractiveTurnSpecification;
}>;

export interface DurableInteractiveTurnService {
  admit(
    input: AdmitDurableInteractiveTurnInput,
  ): Promise<InteractiveTurnAcceptedResponse>;
  retry(
    input: RetryDurableInteractiveTurnInput,
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
  registration: DurableInteractiveSkillRegistration;
  builtInRoots: ReadonlyArray<BuiltInSkillRoot>;
  /** Without grounding, read a project skill from the branch tip instead of failing. */
  readBranchTip?: boolean;
}>;

export type DurableInteractiveSkillRegistration =
  | 'project'
  | 'built-in'
  | 'unknown';

export type BuiltInSkillRoot = Readonly<{
  requestPrefix: string;
  absolutePath: string;
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
  builtInSkillRoots: ReadonlyArray<BuiltInSkillRoot>;
  resolveGrounding: (
    input: ResolveGroundingInput,
  ) => Promise<FrozenGrounding>;
  hasPinnedGrounding: (thread: ChatThread) => Promise<boolean>;
  optionalGroundingWaitMs: number;
  loadRepositoryContext?: (
    grounding: NonNullable<FrozenGrounding>,
  ) => Promise<RepositoryContextDocuments | null>;
  resolveMaxviewCapability: (
    input: Readonly<{ userId: string; project: string }>,
  ) => Promise<'disabled' | 'enabled' | 'unavailable'>;
  resolveDeadlines: (
    input: Readonly<{
      interactiveClass: 'fast' | 'agentic';
      requiresRepositoryPreparation: boolean;
    }>,
  ) => InteractiveDeadlinePolicy;
  encryptToolGrant: (
    input: EncryptInteractiveToolGrantInput,
  ) => FrozenInteractiveToolGrant;
  loadRetrySource: (
    input: Readonly<{ threadId: string; runId: string }>,
  ) => Promise<DurableInteractiveRetrySource | null>;
  isGuidedInterviewEnabled: (
    input: Readonly<{ userId: string; project: string }>,
  ) => Promise<boolean>;
  isBackgroundGroundingEnabled: (
    input: Readonly<{ userId: string; project: string }>,
  ) => Promise<boolean>;
  /** Raw `context.md` for the application brief when the grounded read had none. */
  loadInterviewContext: (thread: ChatThread) => Promise<string | null>;
  trackEvent: typeof trackEvent;
  now: () => Date;
}>;

export const DEFAULT_OPTIONAL_GROUNDING_WAIT_MS = 3_000;

async function resolveWithin<T>(
  work: Promise<T | null>,
  waitMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([work.catch(() => null), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (result as { rows?: T[] } | undefined)?.rows ?? [];
}

export async function loadDurableInteractiveRetrySource(input: Readonly<{
  threadId: string;
  runId: string;
}>): Promise<DurableInteractiveRetrySource | null> {
  if (!isCanonicalUuid(input.threadId) || !isCanonicalUuid(input.runId)) {
    return null;
  }
  const result = await db.execute(sql`
    SELECT
      r.interactive_class,
      a.spec_snapshot
    FROM agent_runs r
    INNER JOIN ai_run_attempts a ON a.run_id = r.id
    WHERE r.id = ${input.runId}
      AND r.thread_id = ${input.threadId}
    ORDER BY a.attempt_number DESC
    LIMIT 1
  `);
  const row = resultRows<{
    interactive_class: InteractiveClass;
    spec_snapshot: unknown;
  }>(result)[0];
  if (!row) return null;
  const raw =
    typeof row.spec_snapshot === 'string'
      ? (JSON.parse(row.spec_snapshot) as unknown)
      : row.spec_snapshot;
  if (!isDurableInteractiveTurnSpecification(raw)) return null;
  return {
    interactiveClass: row.interactive_class,
    specification: raw,
  };
}

export class DurableInteractiveTurnError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TURN_ID'
      | 'INVALID_REQUESTER_ID'
      | 'THREAD_ACTIVE_TURN'
      | 'TURN_ID_CONFLICT'
      | 'RUN_NOT_RETRYABLE'
      | 'USER_INTERACTIVE_LIMIT'
      | 'USER_AGENTIC_LIMIT'
      | 'INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED'
      | 'INTERACTIVE_V2_GROUNDING_UNAVAILABLE'
      | 'INTERACTIVE_V2_GROUNDING_PREPARING'
      | 'INTERACTIVE_V2_SKILL_UNAVAILABLE'
      | 'INTERACTIVE_V2_MAXVIEW_UNAVAILABLE',
    readonly status: 400 | 409 | 422 | 429,
  ) {
    super(code);
    this.name = 'DurableInteractiveTurnError';
  }
}

/** Preparation outlived the admission wait; it keeps running for the next try. */
export class GroundingStillPreparingError extends Error {
  constructor() {
    super('Repository preparation is still running');
    this.name = 'GroundingStillPreparingError';
  }
}

async function waitForPreparation(
  ready: Promise<void>,
  waitMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GroundingStillPreparingError()), waitMs);
  });
  try {
    await Promise.race([ready, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailableSkill(): DurableInteractiveTurnError {
  return new DurableInteractiveTurnError(
    'INTERACTIVE_V2_SKILL_UNAVAILABLE',
    422,
  );
}

function strictPortableSkillPath(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed)
  ) {
    throw unavailableSkill();
  }
  const segments = trimmed.replace(/\\/g, '/').split('/');
  if (
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..',
    )
  ) {
    throw unavailableSkill();
  }
  return segments.join('/');
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function isAllowlistedBuiltInSkillPath(
  skillPath: string,
  roots: ReadonlyArray<BuiltInSkillRoot>,
): boolean {
  let normalized: string;
  try {
    normalized = strictPortableSkillPath(skillPath);
  } catch {
    return false;
  }
  return roots.some((root) => {
    const prefix = strictPortableSkillPath(root.requestPrefix);
    return normalized.startsWith(`${prefix}/`);
  });
}

export const DURABLE_SKILL_SYNC_WAIT_MS = 60_000;
export const DURABLE_SKILL_SYNC_RETRY_MS = 3_000;

export type DurableSkillSyncWait = Readonly<{
  waitMs: number;
  retryMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}>;

const DEFAULT_SKILL_SYNC_WAIT: DurableSkillSyncWait = {
  waitMs: DURABLE_SKILL_SYNC_WAIT_MS,
  retryMs: DURABLE_SKILL_SYNC_RETRY_MS,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

function warnSkillUnavailable(skillPath: string, reason: string): void {
  console.warn(
    `[durable-interactive] skill unavailable path=${skillPath} reason=${reason}`,
  );
}

function describeSkillLoadError(error: unknown): string {
  if (error instanceof RepoReaderError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) {
    return `${error.name}: ${error.message
      .replace(/\/\/[^/@\s]+@/g, '//***@')
      .slice(0, 200)}`;
  }
  return 'unknown error';
}

/**
 * The repo read service answers "syncing" while it fetches a commit its mirror
 * has not seen yet, such as the first read after a push to the branch.
 */
async function readPinnedSkill(
  reader: Pick<RepoReader, 'readFile'>,
  skillPath: string,
  syncWait: DurableSkillSyncWait,
): Promise<string> {
  const deadline = syncWait.now() + syncWait.waitMs;
  for (;;) {
    try {
      return await reader.readFile(skillPath);
    } catch (error) {
      if (
        !isRepositorySyncingError(error)
        || syncWait.now() + syncWait.retryMs > deadline
      ) {
        throw error;
      }
      await syncWait.sleep(syncWait.retryMs);
    }
  }
}

export async function loadDurableInteractiveSkill(
  input: Readonly<{
    path: string;
    registration: DurableInteractiveSkillRegistration;
    pinnedReader: Pick<RepoReader, 'readFile'> | null;
    /** The path is Apex's default, so the bundled copy may stand in for a missing repo copy. */
    bundledFallback?: boolean;
  }>,
  options: Readonly<{
    builtInRoots: ReadonlyArray<BuiltInSkillRoot>;
    syncWait?: DurableSkillSyncWait;
  }>,
): Promise<{ path: string; content: string }> {
  const normalized = strictPortableSkillPath(input.path);
  switch (input.registration) {
    case 'unknown':
      warnSkillUnavailable(normalized, 'skill is not registered for the project');
      throw unavailableSkill();
    case 'project':
      break;
    case 'built-in':
      break;
    default: {
      const unhandled: never = input.registration;
      throw new Error(
        `Unsupported interactive skill registration: ${String(unhandled)}`,
      );
    }
  }

  if (input.registration === 'project') {
    if (!input.pinnedReader) {
      warnSkillUnavailable(normalized, 'no pinned repository reader');
      throw unavailableSkill();
    }
    // Stored paths can name a root the repository does not use (for example
    // `.agents/skills` in a repo that keeps skills under `.cursor/skills`),
    // so try every discovery root, as the in-process path does.
    const skillName = skillNameFromPath(normalized);
    const candidates = skillName
      ? skillPathCandidates(skillName, normalized)
      : [normalized];
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const content = await readPinnedSkill(
          input.pinnedReader,
          candidate,
          options.syncWait ?? DEFAULT_SKILL_SYNC_WAIT,
        );
        if (typeof content === 'string') return { path: candidate, content };
        failures.push(`repository returned no file content (${candidate})`);
      } catch (error) {
        failures.push(`${describeSkillLoadError(error)} (${candidate})`);
        if (isRepositorySyncingError(error)) break;
      }
    }
    if (input.bundledFallback) {
      for (const candidate of candidates) {
        const bundled = readBuiltInSkill(candidate, options.builtInRoots);
        if (bundled) {
          console.warn(
            `[durable-interactive] using bundled skill path=${candidate}; repository copy unavailable: ${failures.join('; ')}`,
          );
          return bundled;
        }
      }
    }
    warnSkillUnavailable(normalized, failures.join('; '));
    throw unavailableSkill();
  }

  const builtIn = readBuiltInSkill(normalized, options.builtInRoots);
  if (!builtIn) throw unavailableSkill();
  return builtIn;
}

function readBuiltInSkill(
  normalized: string,
  builtInRoots: ReadonlyArray<BuiltInSkillRoot>,
): { path: string; content: string } | null {
  for (const root of builtInRoots) {
    const prefix = strictPortableSkillPath(root.requestPrefix);
    if (!normalized.startsWith(`${prefix}/`)) continue;
    const suffix = normalized.slice(prefix.length + 1);
    try {
      const realRoot = fs.realpathSync(root.absolutePath);
      const candidate = path.resolve(realRoot, ...suffix.split('/'));
      if (!isContainedPath(realRoot, candidate)) return null;
      const metadata = fs.lstatSync(candidate);
      if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
      const realCandidate = fs.realpathSync(candidate);
      if (!isContainedPath(realRoot, realCandidate)) return null;
      return {
        path: normalized,
        content: fs.readFileSync(realCandidate, 'utf8'),
      };
    } catch {
      return null;
    }
  }
  return null;
}

const DEFAULT_BUILT_IN_SKILL_ROOTS: ReadonlyArray<BuiltInSkillRoot> = [
  {
    requestPrefix: '.cursor/skills',
    absolutePath: path.resolve(process.cwd(), '.cursor', 'skills'),
  },
  {
    requestPrefix: '.agents/skills',
    absolutePath: path.resolve(process.cwd(), '.agents', 'skills'),
  },
];

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
  // Skill paths are stored repository-root relative with a leading slash
  // (`/.cursor/skills/...`).
  const normalizedPath = strictPortableSkillPath(normalizePath(selectedPath.trim()));
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

function skillRegistration(
  thread: ChatThread,
  turnSkill: ChatTurnSkill | undefined,
  skill: ChatTurnSkill | null,
  config: ProjectSkillConfigResponse | null,
  builtInRoots: ReadonlyArray<BuiltInSkillRoot>,
): DurableInteractiveSkillRegistration | null {
  if (!skill) return null;
  const normalized = strictPortableSkillPath(skill.path).toLowerCase();
  const frozenOnThread =
    !turnSkill &&
    normalizePath(thread.kickoff.skillPath ?? '').toLowerCase() === normalized;
  if (frozenOnThread || configuredSkillPaths(config).has(normalized)) {
    return 'project';
  }
  if (isAllowlistedBuiltInSkillPath(skill.path, builtInRoots)) {
    return 'built-in';
  }
  return 'unknown';
}

function capabilityMetadata(
  thread: ChatThread,
  skill: ChatTurnSkill | null,
  registration: DurableInteractiveSkillRegistration | null,
  attachmentCount: number,
  toolGrant: DurableInteractiveToolGrantInput | undefined,
  maxviewEnabled: boolean,
): InteractiveClassificationInput['capabilityMetadata'] {
  const capabilities: InteractiveCapability[] = ['plain-chat'];
  if (attachmentCount > 0) capabilities.push('attachments');
  if (
    thread.kickoff.mcpPill ||
    thread.kickoff.webResearchEnabled ||
    thread.kickoff.assistantType === 'calendar-work-item' ||
    thread.kickoff.assistantType === 'mcp-server' ||
    resolveDocumentAssistantType(thread.kickoff)
  ) {
    capabilities.push('mcp');
  }
  if (toolGrant) capabilities.push('ado');
  if (maxviewEnabled) {
    capabilities.push('mcp', 'tool-heavy');
  }

  if (!skill) {
    return { status: 'known', capabilities };
  }
  if (registration === 'unknown') {
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

function clipped(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function lastQuestion(agentText: string): string {
  const lines = agentText.split('\n').map((line) => line.trim()).filter(Boolean);
  const question = [...lines].reverse().find((line) => /\?(\*\*)?$/.test(line));
  return clipped(question ?? lines[lines.length - 1] ?? '', MAX_RECAP_QUESTION_CHARS);
}

/**
 * A live agent receives only the newest reply, so its own memory is otherwise
 * the only record of earlier answers. Question-driven sessions resend the
 * saved question/answer pairs every turn so an answered question is not
 * asked again.
 *
 * The UI can show a second agent question before the user answers the first
 * (a race it guards against separately), so the transcript may hold more
 * than one outstanding agent question at once. Pair each user reply with the
 * specific question it quotes — the UI's `Q<n> · <question>` answer format
 * echoes the question text verbatim — rather than always the most recently
 * asked one. An outstanding question with no quoted reply stays out of the
 * recap entirely, so the model is never told it was answered.
 */
function answersSoFar(
  transcript: DurableInteractiveTurnSpecification['transcript'],
  workflowClass: InteractiveWorkflowClass,
): string[] {
  if (workflowClass !== 'interview' && workflowClass !== 'adr') return [];
  const entries: string[] = [];
  const pendingQuestions: string[] = [];
  for (const entry of transcript) {
    if (entry.role === 'agent') {
      pendingQuestions.push(lastQuestion(entry.text));
      continue;
    }
    const answer = clipped(entry.text, MAX_RECAP_ANSWER_CHARS);
    if (pendingQuestions.length === 0) {
      entries.push(`${entries.length + 1}. Original request: ${answer}`);
      continue;
    }
    const quotedIndex = pendingQuestions.findIndex(
      (question) => question.length > 0 && entry.text.includes(question),
    );
    // No explicit quote (plain free-text reply): assume it answers the
    // earliest still-open question, matching the normal one-question flow.
    const matchedIndex = quotedIndex >= 0 ? quotedIndex : 0;
    const [question] = pendingQuestions.splice(matchedIndex, 1);
    entries.push(
      `${entries.length + 1}. You asked: ${question}\n   User answered: ${answer}`,
    );
  }
  if (entries.length === 0) return [];
  return [
    "# Answers so far (from Apex's saved conversation)",
    'These are the user\'s earlier replies, each with the question you had just asked. Treat every question listed here as answered. Do not ask it again unless the user changes the answer.',
    ...entries,
    '',
  ];
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
  instructions: ReadonlyArray<string>,
  skillScope: 'turn' | 'session',
  internalContext?: string,
): string {
  const context = internalContext?.trim();
  return [
    ...CHAT_WRITE_POLICY_LINES,
    ...instructions,
    ...(context ? [context, ''] : []),
    ...(skill ? [`Run skill: ${skill.name} (\`${skill.path}\`)`, ''] : []),
    ...(frozenSkill
      ? [
          `# Pre-loaded skill content (${frozenSkill.path})`,
          frozenSkill.content,
          '',
          // A mid-thread turn skill is one-off; the thread skill is sent once and must persist.
          ...(skillScope === 'turn'
            ? ['The skill content above is already loaded. Follow it for this turn.']
            : [
                'The skill content above is already loaded and governs this whole session, not only this turn. Later messages will not repeat it.',
                "Follow the skill's instructions exactly and completely. The skill defines everything: which repo files to load, how to interact with the user, what to produce, and when to produce it.",
                "Do not add steps, skip steps, or modify the skill's behavior in any way.",
              ]),
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
  repositoryContextPack: string | null;
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
    ...(input.thread.kickoff.transcript
      ? [
          '',
          '# Kickoff transcript',
          KICKOFF_TRANSCRIPT_NOTE,
          '',
          input.thread.kickoff.transcript,
        ]
      : []),
    ...(input.repositoryContextPack ? ['', input.repositoryContextPack] : []),
    '',
    '# Durable visible conversation',
    ...transcript,
    '# Current turn',
    input.currentPrompt,
  ].join('\n');
}

type RepositoryContextDocuments = Readonly<{
  contextContent: string | null;
  agentsContent: string | null;
}>;

async function defaultLoadRepositoryContext(
  grounding: NonNullable<FrozenGrounding>,
): Promise<RepositoryContextDocuments | null> {
  const reader = await groundingProfileResolver.resolveConnectionProfile(
    grounding.profileId as GroundingProfileId,
  );
  const read = (filePath: string) =>
    reader.readFile(filePath).catch(() => null);
  const [contextContent, agentsContent] = await Promise.all([
    read('context.md'),
    read('AGENTS.md'),
  ]);
  return { contextContent, agentsContent };
}

/** ADR authoring never calls MaxView tools, so `maxview-mcp` cannot block it. */
export function workflowUsesMaxview(
  workflowClass: InteractiveWorkflowClass,
): boolean {
  switch (workflowClass) {
    case 'adr':
    case 'brainstorm':
      return false;
    case 'interview':
    case 'home-chat':
    case 'ask-apex':
    case 'assistant':
      return true;
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unhandled workflow class: ${String(unhandled)}`);
    }
  }
}

/**
 * Interview sessions (including ADR interviews, which classify as `interview`)
 * avoid broad repository search, matching the in-process path.
 */
export function workflowAllowsRepositorySearch(
  workflowClass: InteractiveWorkflowClass,
): boolean {
  switch (workflowClass) {
    case 'interview':
    case 'brainstorm':
      return false;
    case 'adr':
    case 'home-chat':
    case 'ask-apex':
    case 'assistant':
      return true;
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unhandled workflow class: ${String(unhandled)}`);
    }
  }
}

function frozenMcpDescriptors(
  thread: ChatThread,
  hasAdoCapability: boolean,
  maxviewEnabled: boolean,
  grounding: FrozenGrounding,
): FrozenInteractiveMcpDescriptor[] {
  if (thread.kickoff.assistantType === 'mcp-server' && thread.kickoff.mcpServerId) {
    return [{
      kind: 'internal-proxy',
      serverName: 'mcp-server',
      connectionId: thread.kickoff.mcpServerId,
      boundUserId: thread.userId,
      enableRepoBrowse: false,
    }];
  }
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
  // Document assistants stage edits through ado-skills `update_*` tools.
  if (hasAdoCapability || resolveDocumentAssistantType(thread.kickoff)) {
    descriptors.push({
      kind: 'internal-proxy',
      serverName: 'ado-skills',
      ...(grounding?.profileId ? { profileId: grounding.profileId } : {}),
      enableRepoBrowse: Boolean(grounding),
    });
  }
  if (maxviewEnabled) {
    descriptors.push({
      kind: 'internal-proxy',
      serverName: 'maxview',
      enableRepoBrowse: false,
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
  if (input.registration !== 'project') {
    return loadDurableInteractiveSkill(
      {
        path: input.skill.path,
        registration: input.registration,
        pinnedReader: null,
      },
      { builtInRoots: input.builtInRoots },
    );
  }
  let pinnedReader: Pick<RepoReader, 'readFile'>;
  if (hasSeparateSkillRepo(input.thread)) {
    pinnedReader = branchTipReader(input.thread);
  } else if (!input.grounding) {
    if (!input.readBranchTip) {
      warnSkillUnavailable(input.skill.path, 'repository grounding is not ready');
      throw unavailableSkill();
    }
    pinnedReader = branchTipReader(input.thread);
  } else {
    try {
      pinnedReader =
        await groundingProfileResolver.resolveConnectionProfile(
          input.grounding.profileId as GroundingProfileId,
        );
    } catch (error) {
      warnSkillUnavailable(
        input.skill.path,
        `grounding profile unavailable: ${describeSkillLoadError(error)}`,
      );
      throw unavailableSkill();
    }
  }
  const kickoffSkillPath = normalizePath(input.thread.kickoff.skillPath ?? '');
  return loadDurableInteractiveSkill(
    {
      path: input.skill.path,
      registration: input.registration,
      pinnedReader,
      bundledFallback:
        input.thread.kickoff.skillPathIsAppDefault === true &&
        kickoffSkillPath.toLowerCase() === normalizePath(input.skill.path).toLowerCase(),
    },
    { builtInRoots: input.builtInRoots },
  );
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
      shareAcrossInstances: true,
    });
  let selection = await start();
  if (selection.mode === 'preparing') {
    if (!selection.waitUntilReady) return null;
    await waitForPreparation(
      selection.waitUntilReady(),
      resolveGroundingPreparationTimeoutMs(),
    );
    selection = await start();
  }
  if (selection.mode !== 'local') return null;
  await groundingProfileResolver.whenShared(selection.profileId);
  return {
    provider: repository.provider,
    project: input.thread.kickoff.project,
    repository: repository.repo,
    sha: selection.resolvedSha,
    profileId: selection.profileId,
  };
}

export async function resolveDurableMaxviewCapability(
  input: Readonly<{ userId: string; project: string }>,
  dependencies: Readonly<{
    evaluate: typeof isFeatureEnabled;
    isConfigured: typeof isMaxviewConfigured;
  }> = {
    evaluate: isFeatureEnabled,
    isConfigured: isMaxviewConfigured,
  },
): Promise<'disabled' | 'enabled' | 'unavailable'> {
  let enabled = false;
  try {
    enabled = await dependencies.evaluate('maxview-mcp', {
      userId: input.userId,
      project: input.project,
    });
  } catch {
    return 'disabled';
  }
  if (!enabled) return 'disabled';
  return dependencies.isConfigured() ? 'enabled' : 'unavailable';
}

/**
 * Guided interviews run on V2 only where the Playbook interview step is on;
 * elsewhere V2 interviews keep the open-ended prompt.
 */
async function defaultIsGuidedInterviewEnabled(
  input: Readonly<{ userId: string; project: string }>,
): Promise<boolean> {
  try {
    return await isFeatureEnabled(PLAYBOOK_INTERVIEW_STEP_FLAG, input);
  } catch {
    return false;
  }
}

async function defaultHasPinnedGrounding(thread: ChatThread): Promise<boolean> {
  const rows = await runGroundingService.getGroundings({
    runType: 'chat',
    runId: thread.id,
    project: thread.kickoff.project,
  });
  return rows.some((row) => row.repoRole === 'target' && row.isActive);
}

async function defaultIsBackgroundGroundingEnabled(
  input: Readonly<{ userId: string; project: string }>,
): Promise<boolean> {
  try {
    return await isFeatureEnabled(BACKGROUND_GROUNDING_FLAG, input);
  } catch {
    return false;
  }
}

function skillRepoOf(thread: ChatThread): string {
  return thread.kickoff.skillRepo?.trim() || thread.kickoff.repo;
}

/** The skill lives outside the grounding repository, so the grounded reader cannot load it. */
function hasSeparateSkillRepo(thread: ChatThread): boolean {
  return skillRepoOf(thread) !== thread.kickoff.repo;
}

function branchTipReader(thread: ChatThread): Pick<RepoReader, 'readFile'> {
  const { kickoff } = thread;
  return {
    readFile: (filePath) =>
      getSkillFile(
        kickoff.project,
        skillRepoOf(thread),
        filePath,
        kickoff.skillBranch ?? kickoff.branch ?? 'main',
        kickoff.skillProvider ?? 'ado',
      ),
  };
}

async function defaultLoadInterviewContext(
  thread: ChatThread,
): Promise<string | null> {
  return branchTipReader(thread).readFile('context.md');
}

async function resolveGuidedInterview(
  thread: ChatThread,
  input: Readonly<{ userId: string; text: string }>,
  deps: ServiceDependencies,
): Promise<FrozenGuidedInterview | null> {
  if (!usesGuidedInterview(thread.kickoff.skillPath)) return null;
  const enabled = await deps.isGuidedInterviewEnabled({
    userId: input.userId,
    project: thread.kickoff.project,
  });
  if (!enabled) return null;
  const turn = deriveGuidedInterviewTurn(thread.messages, input.text);
  return { phase: guidedInterviewRepositoryPhase(turn), turn };
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
    builtInSkillRoots: DEFAULT_BUILT_IN_SKILL_ROOTS,
    resolveGrounding: defaultResolveGrounding,
    hasPinnedGrounding: defaultHasPinnedGrounding,
    optionalGroundingWaitMs: DEFAULT_OPTIONAL_GROUNDING_WAIT_MS,
    loadRepositoryContext: defaultLoadRepositoryContext,
    resolveMaxviewCapability: resolveDurableMaxviewCapability,
    resolveDeadlines: resolveInteractiveDeadlinePolicy,
    encryptToolGrant: encryptInteractiveToolGrant,
    loadRetrySource: loadDurableInteractiveRetrySource,
    isGuidedInterviewEnabled: defaultIsGuidedInterviewEnabled,
    isBackgroundGroundingEnabled: defaultIsBackgroundGroundingEnabled,
    loadInterviewContext: defaultLoadInterviewContext,
    trackEvent,
    now: () => new Date(),
  };
}

export function createDurableInteractiveTurnService(
  dependencies: Partial<ServiceDependencies> = {},
): DurableInteractiveTurnService {
  const deps = { ...defaultDependencies(), ...dependencies };
  const backgroundGrounding = new Map<
    string,
    Promise<'ready' | 'still-preparing' | 'failed'>
  >();

  const prepareGroundingInBackground = (input: ResolveGroundingInput): void => {
    const threadId = input.thread.id;
    if (backgroundGrounding.has(threadId)) return;
    const preparation = deps
      .resolveGrounding(input)
      .then(
        () => 'ready' as const,
        (error: unknown) => {
          if (error instanceof GroundingStillPreparingError) {
            return 'still-preparing' as const;
          }
          console.warn(
            JSON.stringify({
              event: 'InteractiveBackgroundGroundingFailed',
              threadId,
              reason: error instanceof Error ? error.message : String(error),
            }),
          );
          return 'failed' as const;
        },
      )
      .finally(() => {
        backgroundGrounding.delete(threadId);
      });
    backgroundGrounding.set(threadId, preparation);
  };

  return {
    async admit(input) {
      if (!isCanonicalUuid(input.turnId)) {
        throw new DurableInteractiveTurnError('INVALID_TURN_ID', 400);
      }
      if (!isDurableUserIdentity(input.userId)) {
        throw new DurableInteractiveTurnError('INVALID_REQUESTER_ID', 400);
      }
      const admitStartedAt = deps.now().getTime();
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
      // Independent lookups start together; awaiting them in the original
      // order keeps which validation error wins unchanged.
      const configLookup = deps.resolveSkillConfig({
        project: thread.kickoff.project,
        settingsId: thread.kickoff.skillSettingsId ?? undefined,
      });
      const maxviewLookup = workflowUsesMaxview(input.workflowClass)
        ? deps.resolveMaxviewCapability({
            userId: input.userId,
            project: thread.kickoff.project,
          })
        : Promise.resolve('disabled' as const);
      const guidedInterviewLookup = resolveGuidedInterview(thread, input, deps);
      // @feature-flag:interview-background-grounding start winner=enabled
      const backgroundGroundingLookup = guidedInterviewLookup.then(
        (guided) =>
          guided?.phase === 'product'
            // @feature-flag:interview-background-grounding enabled-start
            ? deps.isBackgroundGroundingEnabled({
                userId: input.userId,
                project: thread.kickoff.project,
              })
            // @feature-flag:interview-background-grounding enabled-end
            : false,
      );
      // @feature-flag:interview-background-grounding end
      for (const lookup of [
        configLookup,
        maxviewLookup,
        backgroundGroundingLookup,
      ]) {
        void lookup.catch(() => undefined);
      }
      const config = await configLookup;
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
      const registration = skillRegistration(
        thread,
        input.turnSkill,
        skill,
        config,
        deps.builtInSkillRoots,
      );
      if (registration === 'unknown') throw unavailableSkill();
      if (isStdioMcp(thread.kickoff.mcpPill)) {
        throw new DurableInteractiveTurnError(
          'INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED',
          422,
        );
      }
      const maxviewCapability = await maxviewLookup;
      if (maxviewCapability === 'unavailable') {
        throw new DurableInteractiveTurnError(
          'INTERACTIVE_V2_MAXVIEW_UNAVAILABLE',
          422,
        );
      }
      const maxviewEnabled = maxviewCapability === 'enabled';

      const metadata = capabilityMetadata(
        thread,
        skill,
        registration,
        attachments.length,
        input.toolGrant,
        maxviewEnabled,
      );
      const classification = classifyInteractiveTurn({
        effort: (thread.kickoff.effort as EffortLevel | undefined) ?? null,
        skillPath: skill?.path ?? null,
        capabilityMetadata: metadata,
      });
      const skillNeedsRepository = classHasCapability(
        classification.reasons,
        'workspace',
      ) || registration === 'project';
      const guidedInterview = await guidedInterviewLookup;
      // Discovery and Delivery carry the application brief instead of AGENTS.md.
      const productPhaseInterview = guidedInterview?.phase === 'product';
      const groundInBackground = await backgroundGroundingLookup;
      // Discovery and Delivery cannot read the repository, so their turns go
      // out on the branch-tip skill and brief while the thread's pin is prepared
      // for Technical. Keeping these turns ungrounded also keeps the worker's
      // workspace, and so its warm agent, the same across the product phase.
      const requiresRepositoryPreparation =
        skillNeedsRepository && !groundInBackground;
      // An MCP connection chat answers from that server alone. Brainstorm has no
      // repository until Source-Backed Exploration attaches one.
      const skipRepositoryGrounding =
        thread.kickoff.assistantType === 'mcp-server' || input.workflowClass === 'brainstorm';

      const immutableAttachments = [];
      for (
        let attachmentIndex = 0;
        attachmentIndex < attachments.length;
        attachmentIndex += 1
      ) {
        const attachment = attachments[attachmentIndex];
        immutableAttachments.push(
          await deps.attachmentStore.upload({
            threadId: input.threadId,
            turnId: input.turnId,
            attachmentIndex,
            attachment,
          }),
        );
      }

      const setupDoneAt = deps.now().getTime();
      let grounding: FrozenGrounding = null;
      if (skipRepositoryGrounding) {
        grounding = null;
      } else if (groundInBackground) {
        if (thread.kickoff.repo) {
          prepareGroundingInBackground({ thread, userId: input.userId });
        }
      } else if (requiresRepositoryPreparation) {
        // The background preparation already spent the admission wait; waiting
        // again would let one admit block for twice the bound.
        if ((await backgroundGrounding.get(thread.id)) === 'still-preparing') {
          throw new DurableInteractiveTurnError(
            'INTERACTIVE_V2_GROUNDING_PREPARING',
            422,
          );
        }
        try {
          grounding = await deps.resolveGrounding({
            thread,
            userId: input.userId,
          });
        } catch (error) {
          if (error instanceof GroundingStillPreparingError) {
            throw new DurableInteractiveTurnError(
              'INTERACTIVE_V2_GROUNDING_PREPARING',
              422,
            );
          }
          throw new DurableInteractiveTurnError(
            'INTERACTIVE_V2_GROUNDING_UNAVAILABLE',
            422,
          );
        }
      }
      if (!skipRepositoryGrounding && requiresRepositoryPreparation && grounding === null) {
        throw new DurableInteractiveTurnError(
          'INTERACTIVE_V2_GROUNDING_UNAVAILABLE',
          422,
        );
      }
      // Plain chat still reads the thread's repository when it is available;
      // without a pinned SHA the agent's read tools see an empty workspace.
      // Preparation keeps running after the wait expires, so a later turn
      // on the same thread finds the repository ready.
      if (
        !skipRepositoryGrounding &&
        !groundInBackground &&
        !requiresRepositoryPreparation &&
        thread.kickoff.repo
      ) {
        const resolution = deps.resolveGrounding({
          thread,
          userId: input.userId,
        });
        void resolution.catch(() => undefined);
        // Once a thread is pinned, an expired short wait would send an
        // ungrounded turn and move the worker to another workspace.
        const pinned = await deps.hasPinnedGrounding(thread).catch(() => false);
        grounding = pinned
          ? await resolution.catch(() => null)
          : await resolveWithin(resolution, deps.optionalGroundingWaitMs);
      }
      const groundingDoneAt = deps.now().getTime();
      const repositoryContext =
        grounding && deps.loadRepositoryContext
          ? await deps.loadRepositoryContext(grounding).catch(() => null)
          : null;
      const promptText = guidedInterview
        ? wrapGuidedInterviewPrompt(
            buildGuidedInterviewTurnPrompt(
              thread.messages,
              input.text,
              guidedInterview.turn,
            ),
            guidedInterview.phase,
            await readInterviewBaBrief(async () =>
              repositoryContext?.contextContent ??
              deps.loadInterviewContext(thread),
            ),
          )
        : input.text;
      const repositoryContextPack = repositoryContext && !productPhaseInterview
        ? buildRepositoryContextPack({
            project: thread.kickoff.project,
            repo: thread.kickoff.repo,
            branch: thread.kickoff.branch ?? 'main',
            provider: grounding?.provider ?? 'ado',
            contextContent: repositoryContext.contextContent,
            agentsContent: repositoryContext.agentsContent,
            searchAvailable: workflowAllowsRepositorySearch(input.workflowClass),
          })
        : null;

      const model =
        input.modelOverride?.trim() ||
        thread.kickoff.model?.trim() ||
        DEFAULT_MODEL;
      const loadedSkill = skill
        ? await deps.loadSkill({
            thread,
            skill,
            grounding,
            registration: registration ?? 'unknown',
            builtInRoots: deps.builtInSkillRoots,
            readBranchTip: groundInBackground,
          })
        : null;
      if (skill && !loadedSkill) {
        throw new DurableInteractiveTurnError(
          'INTERACTIVE_V2_SKILL_UNAVAILABLE',
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
      // Whether this turn waits for a user slot is only known inside the admission transaction.
      const expiresAt = new Date(
        deps.now().getTime() +
          deadlines.absoluteTurnMs +
          INTERACTIVE_USER_SLOT_MAX_WAIT_MS,
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
      const resolvedSessionInstructions = sessionInstructions(
        thread,
        input.workflowClass,
      );
      const firstTurnPrompt = currentPrompt(
        promptText,
        skill,
        frozenSkill,
        immutableAttachments,
        resolvedSessionInstructions,
        input.turnSkill ? 'turn' : 'session',
        input.internalContext,
      );
      // A live or resumed agent already holds the thread skill from its first
      // turn. Resending it every turn makes step-by-step skills (interviews)
      // restart their procedure and repeat answered questions.
      const threadSkillAlreadyLoaded =
        !input.turnSkill && transcript.some((entry) => entry.role === 'agent');
      // A guided turn already carries the full prior Q&A.
      const preparedCurrentPrompt = threadSkillAlreadyLoaded
        ? currentPrompt(
            promptText,
            null,
            null,
            immutableAttachments,
            [
              ...(thread.kickoff.assistantType === 'mcp-server'
                ? resolvedSessionInstructions
                : []),
              ...(guidedInterview
                ? []
                : answersSoFar(transcript, input.workflowClass)),
            ],
            'session',
            input.internalContext,
          )
        : firstTurnPrompt;
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
        effort:
          input.effort === undefined
            ? thread.kickoff.effort ?? null
            : input.effort,
        skill: frozenSkill,
        currentMessage: {
          id: input.turnId,
          text: messageText,
          hidden: Boolean(input.hidden),
          attachments: immutableAttachments,
        },
        transcript,
        grounding,
        mcpServers: [
          ...frozenMcpDescriptors(
            thread,
            hasAdoCapability,
            maxviewEnabled,
            grounding,
          ).filter(
            (descriptor) =>
              !productPhaseInterview || descriptor.serverName !== 'ado-skills',
          ),
          ...(input.brainstorm
            ? [{ kind: 'internal-proxy', serverName: 'brainstorm-artifact', enableRepoBrowse: false } as const]
            : []),
        ],
        toolGrant,
        currentPrompt: preparedCurrentPrompt,
        recreationPrompt: recreationPrompt({
          thread,
          transcript,
          currentPrompt: firstTurnPrompt,
          repositoryContextPack,
        }),
        deadlines,
        ...(guidedInterview ? { guidedInterview } : {}),
        ...(input.brainstorm ? { brainstorm: input.brainstorm } : {}),
      };
      const promptDoneAt = deps.now().getTime();
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
      const admittedAt = deps.now().getTime();
      deps.trackEvent(
        'InteractiveTurnAdmission',
        {
          status: admitted.status,
          workflowClass: input.workflowClass,
          interactiveClass: classification.interactiveClass,
          interviewPhase: guidedInterview?.phase ?? 'none',
          groundInBackground: String(groundInBackground),
          grounded: String(grounding !== null),
        },
        {
          setupMs: setupDoneAt - admitStartedAt,
          groundingMs: groundingDoneAt - setupDoneAt,
          promptMs: promptDoneAt - groundingDoneAt,
          persistMs: admittedAt - promptDoneAt,
          totalMs: admittedAt - admitStartedAt,
        },
      );

      switch (admitted.status) {
        case 'queued':
        case 'dispatched':
        case 'running':
        case 'completed':
        case 'failed':
        case 'cancelled':
          return {
            turnId: admitted.turnId,
            runId: admitted.runId,
            status: admitted.status,
            interactiveClass: admitted.interactiveClass,
            idempotent: admitted.idempotent,
            ...(admitted.shouldReflectThreadState === undefined
              ? {}
              : {
                  shouldReflectThreadState:
                    admitted.shouldReflectThreadState,
                }),
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

    async retry(input) {
      if (!isCanonicalUuid(input.runId)) {
        throw Object.assign(new Error('Thread not found'), { status: 404 });
      }
      if (!isDurableUserIdentity(input.userId)) {
        throw new DurableInteractiveTurnError('INVALID_REQUESTER_ID', 400);
      }
      const access = await deps.resolveThreadAccess(
        input.userId,
        input.threadId,
      );
      if (!access) {
        throw Object.assign(new Error('Thread not found'), { status: 404 });
      }

      const source = await deps.loadRetrySource({
        threadId: input.threadId,
        runId: input.runId,
      });
      if (!source) {
        throw Object.assign(new Error('Thread not found'), { status: 404 });
      }

      const requiresRepositoryPreparation =
        source.specification.deadlines.repositoryPreparationMs !== null;
      const refreshedDeadlines = deps.resolveDeadlines({
        interactiveClass: source.interactiveClass,
        requiresRepositoryPreparation,
      });
      if (
        refreshedDeadlines.absoluteTurnMs !==
        absoluteTurnMsForClass(source.interactiveClass)
      ) {
        throw new Error(
          'Retry deadline policy absoluteTurnMs must match interactive class',
        );
      }

      const previousGrant = source.specification.toolGrant;
      const needsToolGrant = previousGrant !== null || input.toolGrant !== undefined;
      const expiresAt = new Date(
        deps.now().getTime() +
          refreshedDeadlines.absoluteTurnMs +
          INTERACTIVE_USER_SLOT_MAX_WAIT_MS,
      ).toISOString();
      const refreshedToolGrant = needsToolGrant
        ? deps.encryptToolGrant({
            userId: input.userId,
            projectId: source.specification.projectId,
            allowedOperations:
              input.toolGrant?.allowedOperations ??
              previousGrant?.allowedOperations ??
              ['ado:read'],
            delegatedAdoToken: input.toolGrant?.delegatedAdoToken ?? null,
            expiresAt,
          })
        : null;

      const retried = await deps.repository.retry({
        threadId: input.threadId,
        runId: input.runId,
        userId: input.userId,
        refreshedToolGrant,
        refreshedDeadlines,
        ...(input.refreshedBrainstormArtifact
          ? { refreshedBrainstormArtifact: input.refreshedBrainstormArtifact }
          : {}),
      });

      switch (retried.status) {
        case 'queued':
        case 'dispatched':
        case 'running':
        case 'completed':
        case 'failed':
        case 'cancelled':
          return {
            turnId: retried.turnId,
            runId: retried.runId,
            status: retried.status,
            interactiveClass: retried.interactiveClass,
          };
        case 'thread_active':
          throw new DurableInteractiveTurnError('THREAD_ACTIVE_TURN', 409);
        case 'user_limit':
          throw new DurableInteractiveTurnError(retried.code, 429);
        case 'not_retryable':
          throw new DurableInteractiveTurnError('RUN_NOT_RETRYABLE', 409);
        default: {
          const unhandled: never = retried;
          throw new Error(
            `Unsupported durable retry result: ${String(unhandled)}`,
          );
        }
      }
    },
  };
}

export const durableInteractiveTurnService =
  createDurableInteractiveTurnService();
