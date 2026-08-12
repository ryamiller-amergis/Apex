import { Agent, CursorAgentError } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk/dist/cjs/agent.js';
import type {
  LocalAgentOptions,
  McpServerConfig,
} from '@cursor/sdk/dist/cjs/options.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { v4 as uuidv4 } from 'uuid';
import type {
  ChatAttachment,
  ChatAttachmentMeta,
  ChatThread,
  ChatMessage,
  ChatThreadKickoff,
  AgentRunEventEnvelope,
  AgentRunPhase,
  BindingContinuityDecision,
  BindingRecreationReason,
  GroundingBinding,
  SseEvent,
  SseErrorCode,
} from '../../shared/types/chat';
import { isAzureWwwroot, resolveDataRoot } from '../utils/dataDir';
import {
  recordAiUsage,
  estimateTokens,
  resolveFeatureFromKickoff,
} from './aiUsageService';
import {
  upsertThread as pgUpsertThread,
  insertMessage as pgInsertMessage,
  listThreadsByUser as pgListThreadsByUser,
  searchThreads as pgSearchThreads,
  loadFullThread as pgLoadFullThread,
  deleteThread as pgDeleteThread,
  clearStaleRun,
} from './chatThreadRepository';
import { db } from '../db/drizzle';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  interviews,
  adrs,
  prds,
  designDocs,
  testCases,
  devSessions,
  agentRuns,
  chatThreads,
} from '../db/schema';
import {
  isThreadRunAlive,
  resolveAgentRunHardLimitMs,
  resolveAgentFirstEventTimeoutMs,
} from './agentRunReaperService';
import { enqueue } from './agentRunLifecycleService';
import {
  INTERACTIVE_LANE,
  INTERACTIVE_WORKFLOW_FLAG,
  type InteractiveWorkflowClass,
} from '../../shared/types/interactiveWorkflow';
import { interactiveWorkflowRouter } from './interactiveWorkflowRouter';
import { interactiveLiveBus } from './interactiveLiveBus';
import { isExternalRunAbortEvent } from './agentRunAbort';
import { syncPrdContent } from './prdService';
import { notifyAiCompletion } from './aiCompletionNotifier';
import {
  syncDesignDocContent,
  syncValidationResult,
  syncPerFeatureDesignDocs,
} from './designDocService';
import {
  markTestCaseFailed,
  syncTestCaseOutput,
  triggerTestCaseGeneration,
} from './testCaseService';
import type { ValidationScorecard } from '../../shared/types/interview';
import type {
  ChatThreadSearchResult,
  ChatThreadSummary,
} from '../../shared/types/chat';
import { retryWithBackoff } from '../utils/retry';
import { trackAgentError, trackEvent } from './telemetry';
import {
  clearRunEventSequence,
  finalizeOwnedAgentRun,
  finalizeReconciledAgentRun,
  nextRunEventSequence,
  notifyRunEvent,
  RUN_EVENT_SOURCE_INSTANCE,
  subscribeRunEvents,
} from './pgNotifyService';
import { isMaxviewConfigured } from './maxviewAuthService';
import {
  isFeatureEnabled,
  isLifecycleBindingEnabledForCaller,
} from './featureFlagService';
import {
  getMyWorkSessionContext,
  logMyWorkSession,
  type MyWorkLogContext,
  type MyWorkLogLevel,
} from './myWorkSessionLogger';
import {
  McpTimeoutError,
  raceWithTimeout,
  resolveAgentMcpToolTimeoutMs,
} from '../mcp/mcpTimeout';
import {
  clearToolInFlight,
  createMcpToolDeadlineController,
  createFirstEventDeadline,
  markToolInFlight,
  type InFlightToolCall,
  type McpToolDeadlineController,
} from './inFlightToolTracker';
import { buildRepositoryContextPack } from './repositoryContextPack';
import {
  callerGroundingSelectionToBinding,
  callerGroundingService,
  evaluateBindingContinuity,
  type CallerGroundingSelection,
} from './callerGroundingService';
import type {
  GroundingProfileId,
  RepoReader,
} from '../../shared/types/repoReader';
import { groundingTelemetry } from './groundingTelemetry';
import { groundingProfileResolver } from './groundingProfileResolver';
import { createNativeReadTools } from './nativeReadToolAdapter';
import {
  createCursorRunEventEnvelope,
  CursorExecutionWaitError,
  executeCursorExecutionCore,
  sanitizeCursorTerminalDetail,
  ThinkingPhaseCoalescer,
  type CursorExecutionRun,
} from './cursorExecutionCore';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { RepositoryPreparationTarget } from './repositoryPreparationService';

export { ThinkingPhaseCoalescer } from './cursorExecutionCore';

// ── Configuration ─────────────────────────────────────────────────────────────

const DATA_ROOT = resolveDataRoot();
const WORKSPACE_BASE = process.env.AI_PILOT_WORKSPACE_DIR
  ? path.resolve(process.env.AI_PILOT_WORKSPACE_DIR)
  : isAzureWwwroot()
    ? path.join(DATA_ROOT, 'workspaces')
    : path.join(os.tmpdir(), 'ai-pilot-workspaces');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INTERVIEW_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const GROUNDING_PREPARATION_TIMEOUT_MS = 2 * 60 * 1000;
// After this much thread inactivity, a resumed SDK session is likely cold and
// prone to emitting zero events. Proactively recreate the agent (with history)
// instead of resuming a stale session. Overridable for tests/tuning.
const AGENT_STALE_RESUME_MS = (() => {
  const parsed = Number(process.env.AGENT_STALE_RESUME_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000; // 10 minutes
})();

// ── In-memory state ───────────────────────────────────────────────────────────

interface ThreadState {
  thread: ChatThread;
  /** SSE subscriber callbacks for this thread */
  subscribers: Set<(event: SseEvent, envelope?: AgentRunEventEnvelope) => void>;
  /** Live Cursor SDK agent — null between turns */
  agent: SDKAgent | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Cached flag — true when the thread backs an interview row (gets longer idle timeout) */
  isInterviewThread: boolean;
  /** True when the thread backs a dev-session (gets extended run timeout for sequential implementation) */
  isDevSession: boolean;
  /** One reader/profile selection, fixed for the lifetime of the caller. */
  grounding: CallerGroundingSelection | null;
  /**
   * In-flight `ensureThreadGrounding` promise. Interactive dispatch may time out
   * and fall through to in-process while materialize is still running; sharing
   * this promise prevents a second checkout from blocking behind the first
   * lease holder.
   */
  groundingInFlight: Promise<CallerGroundingSelection> | null;
  /** Binding derived from the exact acquired selection. */
  resolvedGroundingBinding: GroundingBinding | null;
  /** Authoritative continuity classification retained for FEAT-003 routing. */
  bindingContinuity: BindingContinuityDecision | null;
  /** Server-local checkout used only while this process owns the profile. */
  groundingWorkspaceDir: string | null;
}

const threads = new Map<string, ThreadState>();
const lastTokenProgressWriteAt = new Map<string, number>();
const eventDrivenRunIds = new Set<string>();

function runtimeWorkspaceDir(state: ThreadState): string {
  return state.groundingWorkspaceDir ?? state.thread.workspaceDir;
}

/**
 * Cap concurrent local Cursor agents per App Service instance. Interview →
 * design-doc kickoff spawns one agent per backlog feature in a tight loop;
 * unbounded local CLIs share the same VM RAM and previously correlated with
 * unhandled SDK EPIPE crashes taking down the whole site.
 */
function resolveMaxConcurrentLocalAgents(): number {
  const parsed = Number(process.env.MAX_CONCURRENT_LOCAL_AGENTS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
}

let activeLocalAgentSlots = 0;
const localAgentSlotWaiters: Array<() => void> = [];

async function acquireLocalAgentSlot(threadId: string): Promise<void> {
  const max = resolveMaxConcurrentLocalAgents();
  if (activeLocalAgentSlots < max) {
    activeLocalAgentSlots++;
    console.log(
      `[chat] Acquired local agent slot (${activeLocalAgentSlots}/${max}) threadId=${threadId}`
    );
    return;
  }
  console.log(
    `[chat] Waiting for local agent slot (${activeLocalAgentSlots}/${max}) threadId=${threadId}`
  );
  await new Promise<void>((resolve) => {
    localAgentSlotWaiters.push(resolve);
  });
  activeLocalAgentSlots++;
  console.log(
    `[chat] Acquired local agent slot after wait (${activeLocalAgentSlots}/${max}) threadId=${threadId}`
  );
}

function releaseLocalAgentSlot(threadId: string): void {
  activeLocalAgentSlots = Math.max(0, activeLocalAgentSlots - 1);
  const next = localAgentSlotWaiters.shift();
  if (next) next();
  console.log(
    `[chat] Released local agent slot (${activeLocalAgentSlots}/${resolveMaxConcurrentLocalAgents()}) threadId=${threadId}`
  );
}

// ── Output file helpers ───────────────────────────────────────────────────────

/**
 * Returns the path of the first file in `dir` whose name matches `pattern`,
 * or null if not found / dir doesn't exist.
 */
function findOutputFile(dir: string, pattern: RegExp): string | null {
  const all = findAllOutputFiles(dir, pattern);
  return all.length > 0 ? all[0] : null;
}

/**
 * Returns all file paths in `dir` (recursively) whose names match `pattern`,
 * sorted alphabetically so multi-feature output is deterministic.
 */
function findAllOutputFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && pattern.test(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(
          ...findAllOutputFiles(path.join(dir, entry.name), pattern)
        );
      }
    }
    results.sort();
    return results;
  } catch {
    return [];
  }
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(WORKSPACE_BASE, { recursive: true });
  cleanupStaleWorkspaces();
}

function persistThread(thread: ChatThread) {
  pgUpsertThread(thread).catch((err: Error) =>
    console.error('[chat] pg upsertThread failed:', err.message)
  );
}

async function loadThread(threadId: string): Promise<ChatThread | null> {
  return pgLoadFullThread(threadId);
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

/**
 * Remove workspace dirs whose session.json is older than 2 hours.
 * Called at startup to clean up after server restarts mid-session.
 */
function logWorkspaceContents(workspaceDir: string, context: string): void {
  try {
    if (!fs.existsSync(workspaceDir)) {
      console.warn(
        `[chat] ${context}: workspace does not exist (${workspaceDir})`
      );
      return;
    }
    const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
    if (!fs.existsSync(outputDir)) {
      console.warn(
        `[chat] ${context}: output dir does not exist (${outputDir})`
      );
      const topLevel = fs.readdirSync(workspaceDir, {
        recursive: true,
      }) as string[];
      console.warn(
        `[chat] ${context}: workspace files: ${topLevel.slice(0, 30).join(', ')}`
      );
      return;
    }
    const outputFiles = fs.readdirSync(outputDir, {
      recursive: true,
    }) as string[];
    console.warn(
      `[chat] ${context}: output dir files (${outputFiles.length}): ${outputFiles.slice(0, 30).join(', ')}`
    );
  } catch {
    console.warn(`[chat] ${context}: failed to list workspace contents`);
  }
}

function cleanupStaleWorkspaces() {
  if (!fs.existsSync(WORKSPACE_BASE)) return;
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const dir of fs.readdirSync(WORKSPACE_BASE)) {
    const sessionFile = path.join(
      WORKSPACE_BASE,
      dir,
      '.ai-pilot',
      'session.json'
    );
    if (fs.existsSync(sessionFile)) {
      const stat = fs.statSync(sessionFile);
      if (stat.mtimeMs < twoHoursAgo) {
        fs.rmSync(path.join(WORKSPACE_BASE, dir), {
          recursive: true,
          force: true,
        });
      }
    }
  }
}

function injectKickoffFiles(
  workspaceDir: string,
  kickoff: ChatThreadKickoff,
  threadId: string
): void {
  const aiPilotDir = path.join(workspaceDir, '.ai-pilot');
  fs.mkdirSync(aiPilotDir, { recursive: true });
  fs.mkdirSync(path.join(aiPilotDir, 'output'), { recursive: true });

  if (kickoff.transcript) {
    fs.writeFileSync(
      path.join(aiPilotDir, 'kickoff-transcript.md'),
      kickoff.transcript,
      'utf-8'
    );
  }

  if (kickoff.freeformContext) {
    fs.writeFileSync(
      path.join(aiPilotDir, 'kickoff-context.md'),
      kickoff.freeformContext,
      'utf-8'
    );
  }

  // Write a session marker so the skill can reference provenance
  fs.writeFileSync(
    path.join(aiPilotDir, 'session.json'),
    JSON.stringify(
      {
        threadId,
        skillPath: kickoff.skillPath,
        project: kickoff.project,
        repo: kickoff.repo,
        branch: kickoff.branch,
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf-8'
  );
}

function sanitizeAttachmentName(name: string, index: number): string {
  const fallback = `attachment-${index + 1}.txt`;
  const baseName = path.basename(name || fallback);
  const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return sanitized || fallback;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function writeMessageAttachments(
  workspaceDir: string,
  turnId: string,
  attachments: ChatAttachment[]
): Promise<ChatAttachmentMeta[]> {
  if (attachments.length === 0) return [];

  const attachmentsDir = path.join(
    workspaceDir,
    '.ai-pilot',
    'attachments',
    turnId
  );
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const results: ChatAttachmentMeta[] = [];
  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    const fileName = `${String(index + 1).padStart(2, '0')}-${sanitizeAttachmentName(attachment.name, index)}`;
    const absolutePath = path.join(attachmentsDir, fileName);
    if (attachment.encoding === 'base64') {
      fs.writeFileSync(absolutePath, Buffer.from(attachment.content, 'base64'));
    } else {
      fs.writeFileSync(absolutePath, attachment.content, 'utf-8');
    }

    const isDocx =
      attachment.name.toLowerCase().endsWith('.docx') ||
      attachment.type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    if (isDocx && attachment.encoding === 'base64') {
      try {
        const docxBuffer = Buffer.from(attachment.content, 'base64');
        const extractedText = await extractDocxText(docxBuffer);
        const txtFileName = fileName.replace(/\.docx$/i, '.txt');
        fs.writeFileSync(
          path.join(attachmentsDir, txtFileName),
          extractedText,
          'utf-8'
        );
        results.push({
          id: attachment.id,
          name: attachment.name.replace(/\.docx$/i, '.txt'),
          type: 'text/plain',
          size: Buffer.byteLength(extractedText, 'utf-8'),
          path: path.posix.join(
            '.ai-pilot',
            'attachments',
            turnId,
            txtFileName
          ),
        });
        continue;
      } catch (err) {
        console.warn(
          `[chat] Failed to extract text from ${attachment.name}, falling back to raw file:`,
          err
        );
      }
    }

    results.push({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      path: path.posix.join('.ai-pilot', 'attachments', turnId, fileName),
    });
  }
  return results;
}

function buildPromptWithAttachments(
  text: string,
  attachments: ChatAttachmentMeta[]
): string {
  if (attachments.length === 0) return text;

  const messageText =
    text.trim() || 'Please use the uploaded files as additional context.';
  const attachmentLines = attachments.map((attachment) => {
    const isImage = attachment.type.startsWith('image/');
    const hint = isImage
      ? ' [IMAGE -- use the Read tool to view this file]'
      : '';
    return `- ${attachment.name} (${attachment.type || 'text/plain'}, ${attachment.size} bytes): \`${attachment.path}\`${hint}`;
  });

  return [
    messageText,
    '',
    '# Uploaded context files for this turn',
    'The user attached these files. They have been written into the local sandbox workspace; read them before responding when they are relevant.',
    ...attachmentLines,
  ].join('\n');
}

/**
 * Resolve a key/value map where values may reference environment variables.
 * Values matching "${VAR_NAME}" are replaced with process.env.VAR_NAME at runtime.
 */
function resolveEnvRefs(map: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    const match = value.match(/^\$\{([^}]+)\}$/);
    resolved[key] = match ? (process.env[match[1]] ?? '') : value;
  }
  return resolved;
}

function appendMcpQuery(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${value}`;
}

/**
 * Build the mcpServers map for the Cursor SDK agent.
 * Always includes ado-skills; conditionally adds any MCP pill selected for this thread.
 * When `maxviewEnabled` is set, the always-on MaxView timecard-debug MCP proxy is
 * added (gated by the `maxview-mcp` feature flag + server config in the caller).
 * Supports both HTTP and stdio transport (matching the SDK's McpServerConfig union type).
 */
export function isDocumentAssistant(
  assistantType: ChatThreadKickoff['assistantType']
): boolean {
  return (
    assistantType === 'adr' ||
    assistantType === 'prd' ||
    assistantType === 'design-doc'
  );
}

export function isRepositoryReadingChatCaller(
  kickoff: ChatThreadKickoff,
  isDevSession: boolean
): boolean {
  return !isDevSession && kickoff.assistantType !== 'calendar-work-item';
}

/** Prefer explicit assistantType; fall back to freeform context markers for older threads. */
export function resolveDocumentAssistantType(
  kickoff: ChatThreadKickoff
): 'adr' | 'prd' | 'design-doc' | undefined {
  if (
    kickoff.assistantType === 'adr' ||
    kickoff.assistantType === 'prd' ||
    kickoff.assistantType === 'design-doc'
  ) {
    return kickoff.assistantType;
  }
  const ctx = kickoff.freeformContext;
  if (!ctx) return undefined;
  if (/^document_operation:\s*validation\s*$/m.test(ctx)) return undefined;
  if (/^adr_id:\s*\S+/m.test(ctx)) return 'adr';
  if (/^prd_id:\s*\S+/m.test(ctx)) return 'prd';
  if (/^doc_id:\s*\S+/m.test(ctx)) return 'design-doc';
  return undefined;
}

export type GroundingCallerKey =
  | 'interview'
  | 'prd'
  | 'design-doc'
  | 'agent-home'
  | 'walkthrough'
  | 'design-module';

export function resolveGroundingCallerKey(
  kickoff: ChatThreadKickoff
): GroundingCallerKey {
  const assistantType = resolveDocumentAssistantType(kickoff);
  if (assistantType === 'adr') return 'interview';
  if (assistantType === 'prd' || assistantType === 'design-doc') {
    return assistantType;
  }

  const skillPath = kickoff.skillPath?.replace(/\\/g, '/').toLowerCase() ?? '';
  if (skillPath.includes('walkthrough-')) return 'walkthrough';
  if (skillPath.includes('design-module-')) return 'design-module';
  if (
    skillPath.includes('/to-prd/') ||
    skillPath.includes('prd-spec-review') ||
    skillPath.includes('/prd-assistant/')
  ) {
    return 'prd';
  }
  if (
    skillPath.includes('prd-design-spec') ||
    skillPath.includes('design-spec') ||
    skillPath.includes('design-doc')
  ) {
    return 'design-doc';
  }
  if (
    skillPath.includes('grill-with-docs') ||
    skillPath.includes('grill-design') ||
    skillPath.includes('kick-off') ||
    skillPath.includes('adr-interview') ||
    skillPath.includes('adr-finalize')
  ) {
    return 'interview';
  }

  return 'agent-home';
}

export function buildMcpServers(
  kickoff: ChatThreadKickoff,
  adoSkillsUrl: string,
  options?: {
    maxviewEnabled?: boolean;
    calendarSessionId?: string;
    restrictRepoSearch?: boolean;
    groundingProfileId?: GroundingProfileId;
    enableRepoBrowse?: boolean;
    /**
     * When native (in-process) repository reads are engaged, the provider
     * repo-read MCP servers are redundant. In that case we DE-MOUNT any server
     * whose sole purpose is repository reading (github-repo), and mount
     * ado-skills only when it is still required for document write-back.
     */
    nativeReads?: boolean;
  }
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  const port = process.env.PORT ?? '3001';

  // Calendar assistant threads use a restricted MCP that only exposes the
  // propose_work_item_changes tool — never the general ado-skills MCP.
  if (
    kickoff.assistantType === 'calendar-work-item' &&
    options?.calendarSessionId
  ) {
    servers['calendar-assistant'] = {
      url: `http://localhost:${port}/mcp/calendar-assistant/${options.calendarSessionId}`,
    };
    return servers;
  }

  // ADO-backed projects use ado-skills MCP for repo browse + skill load.
  // GitHub-backed projects pre-fetch skills server-side, but still need
  // github-repo MCP for search_repo_code / list_repo_dir / get_skill_file
  // (e.g. Design Module scoping against the connected skill repo).
  //
  // github-repo is a purely read-only repository server. When native reads are
  // engaged, in-process customTools cover every read, so we de-mount it entirely
  // (no idle connection, no residual list_skills escape hatch back to GitHub).
  if (kickoff.skillProvider === 'github' && !options?.nativeReads) {
    const profilePath = options?.groundingProfileId
      ? `/grounding/${options.groundingProfileId}`
      : '';
    let githubUrl = `http://localhost:${port}/mcp/github-repo${profilePath}${
      options?.restrictRepoSearch ? '?profile=interview' : ''
    }`;
    if (options?.enableRepoBrowse === false) {
      githubUrl = appendMcpQuery(githubUrl, 'enableRepoBrowse', 'false');
    }
    servers['github-repo'] = {
      url: githubUrl,
    };
  }

  // Document assistants (ADR / PRD / design-doc) need update_* write-back tools
  // which live on ado-skills. Mount it for ADO projects always, and ALSO for
  // GitHub-backed document assistants — those tools only touch Postgres and do
  // not require ADO credentials.
  //
  // Native checkout tools replace only repository browsing. Keep ado-skills
  // for ADO callers so work-item and wiki tools remain available, while
  // enableRepoBrowse=false strips the redundant repository-read surface.
  const documentAssistant = Boolean(resolveDocumentAssistantType(kickoff));
  if (kickoff.skillProvider !== 'github' || documentAssistant) {
    const profilePath = options?.groundingProfileId
      ? `/grounding/${options.groundingProfileId}`
      : '';
    let groundedAdoSkillsUrl = `${adoSkillsUrl}${profilePath}`;
    if (options?.enableRepoBrowse === false) {
      groundedAdoSkillsUrl = appendMcpQuery(
        groundedAdoSkillsUrl,
        'enableRepoBrowse',
        'false'
      );
    }
    servers['ado-skills'] = {
      url: `${groundedAdoSkillsUrl}${
        options?.restrictRepoSearch
          ? `${groundedAdoSkillsUrl.includes('?') ? '&' : '?'}profile=interview`
          : ''
      }`,
    };
  }

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    if (pill.transport === 'stdio') {
      servers[pill.mcpServerName] = {
        type: 'stdio',
        command: pill.command,
        ...(pill.args ? { args: pill.args } : {}),
        ...(pill.env ? { env: resolveEnvRefs(pill.env) } : {}),
      };
    } else {
      servers[pill.mcpServerName] = {
        url: pill.url,
        ...(pill.headers ? { headers: resolveEnvRefs(pill.headers) } : {}),
      };
    }
  }

  if (options?.maxviewEnabled) {
    servers['maxview'] = {
      url: `http://localhost:${process.env.PORT ?? 3001}/mcp/maxview`,
    };
  }

  return servers;
}

export interface RepositoryReadRuntime {
  nativeReads: boolean;
  local: LocalAgentOptions;
  mcpServers: Record<string, McpServerConfig>;
  repoReader?: RepoReader;
}

function targetedRepositoryName(kickoff: ChatThreadKickoff): string {
  if (kickoff.skillProvider !== 'github') return kickoff.repo;
  return kickoff.repo.split('/').pop() || kickoff.repo;
}

function isExactGroundingReader(
  reader: RepoReader,
  grounding: Extract<CallerGroundingSelection, { mode: 'local' }>,
  kickoff: ChatThreadKickoff
): boolean {
  return (
    reader.identity.provider === (kickoff.skillProvider ?? 'ado') &&
    reader.identity.project === kickoff.project &&
    reader.identity.repo === targetedRepositoryName(kickoff) &&
    reader.identity.sha === grounding.resolvedSha
  );
}

export async function prepareRepositoryReadRuntime(options: {
  grounding: CallerGroundingSelection;
  kickoff: ChatThreadKickoff;
  adoSkillsUrl: string;
  sandboxCwd: string;
  maxviewEnabled?: boolean;
  calendarSessionId?: string;
  restrictRepoSearch?: boolean;
}): Promise<RepositoryReadRuntime> {
  const requestedNative =
    options.grounding.mode === 'local' && options.grounding.nativeReads;
  let repoReader: RepoReader | undefined;

  if (requestedNative && options.grounding.mode === 'local') {
    try {
      const resolved = await groundingProfileResolver.resolveConnectionProfile(
        options.grounding.profileId
      );
      if (
        isExactGroundingReader(resolved, options.grounding, options.kickoff)
      ) {
        repoReader = resolved;
      }
    } catch {
      repoReader = undefined;
    }
  }

  const nativeReads = Boolean(repoReader);
  if (requestedNative && !nativeReads) {
    groundingTelemetry.fallback(
      {
        caller: resolveGroundingCallerKey(options.kickoff),
        project: options.kickoff.project,
        provider:
          options.kickoff.skillProvider === 'github'
            ? 'github'
            : 'azure_devops',
        repository: targetedRepositoryName(options.kickoff),
        branch: options.kickoff.branch,
      },
      'native-read-reader-resolution-failed'
    );
  }
  const groundingProfileId =
    options.grounding.mode === 'local' && !requestedNative
      ? options.grounding.profileId
      : undefined;
  const mcpServers = buildMcpServers(options.kickoff, options.adoSkillsUrl, {
    maxviewEnabled: options.maxviewEnabled,
    calendarSessionId: options.calendarSessionId,
    restrictRepoSearch: options.restrictRepoSearch,
    groundingProfileId,
    enableRepoBrowse: !nativeReads,
    nativeReads,
  });
  const local: LocalAgentOptions = {
    cwd: options.sandboxCwd,
    ...(repoReader ? { customTools: createNativeReadTools(repoReader) } : {}),
  };

  return {
    nativeReads,
    local,
    mcpServers,
    repoReader,
  };
}

/**
 * Whether the always-on MaxView timecard-debug MCP should be wired into this
 * thread's agent. Requires both server-side config (env) and the `maxview-mcp`
 * feature flag being enabled for the user/project. Fails closed on any error.
 */
async function isMaxviewMcpEnabled(
  userId: string,
  project: string
): Promise<boolean> {
  if (!isMaxviewConfigured()) return false;
  try {
    return await isFeatureEnabled('maxview-mcp', { userId, project });
  } catch (err) {
    console.error(
      '[chat] maxview-mcp flag check failed:',
      (err as Error).message
    );
    return false;
  }
}

/** System-prompt guidance describing the MaxView timecard-debug MCP tools. */
function buildMaxviewPromptHint(): string {
  return [
    `# MaxView timecard debugging (via \`maxview\` MCP server)`,
    `You have access to the read-only \`maxview\` MCP server for debugging MaxView timecards. Use it whenever the user asks about a specific timecard, its RecruitCare integration, or its status history. All results are PHI/PII-masked and scoped to the service account's data visibility. Available tools:`,
    `- \`get_timecard_detail(timecardId)\` — a single timecard's masked detail (entries, status, hours, presence flags); returns null when not found`,
    `- \`search_timecards(employeeId?, worksiteId?, statusId?, startDate?, endDate?, page?, pageSize?)\` — search timecards (dates default to the last 3 months; pageSize capped at 100)`,
    `- \`get_timecard_integration(timecardId)\` — MaxView↔RecruitCare integration diagnostics (status, blocking reasons, scrubbed errors, field-level match/mismatch flags)`,
    `- \`get_timecard_history(timecardId)\` — status-change history (acting user masked; status, timestamp, comment-presence preserved)`,
    `Always call these tools instead of guessing timecard data. If a lookup returns null, tell the user the timecard was not found.`,
  ].join('\n');
}

function buildScopePolicyLines(kickoff: ChatThreadKickoff): string[] {
  if (kickoff.pillBypassScopePolicy) return [];
  const project = kickoff.project;
  const lines = [
    ``,
    `# Scope policy — STRICTLY ENFORCED`,
    `This assistant exists exclusively to help the ${project} team with internal organisational and project work. You MUST NOT answer questions that have no connection to this project, its codebase, team processes, or org-level work.`,
    ``,
    `Allowed topics:`,
    `- This project's codebase, architecture, code review, or implementation questions`,
    `- Work items, sprint planning, ADO, team processes, and delivery workflows`,
    `- PRDs, design docs, technical specs, and decisions for this project`,
    `- Running or discussing skills from this project's repo`,
    `- Technical concepts directly relevant to the project's stack`,
    ``,
    `Out of scope — REFUSE THESE:`,
    `- General knowledge, trivia, entertainment, news, or public datasets (e.g. movie ratings, housing market trends, stock prices, weather, sports results)`,
    `- Any topic with no plausible connection to ${project} or the organisation`,
    ``,
    `When a question is out of scope, respond with this exact message and nothing else:`,
    `"I can't help with that here. This assistant is scoped to internal project and organisational questions for **${project}**. Please ask about the project codebase, work items, team processes, or technical documentation."`,
    ``,
    `You MAY draw on your training knowledge to give richer answers on in-scope topics (e.g. TypeScript patterns, REST design, testing strategies) — but only when the question is clearly related to this project's work.`,
  ];

  // Narrow carve-out for greenfield product-discovery interviews with live web research enabled.
  // This relaxes the "refuse web/general" rule ONLY for research in service of building this project —
  // it is not a full bypass, and unrelated general-knowledge requests are still refused.
  if (kickoff.webResearchEnabled) {
    lines.push(
      ``,
      `# Live web research — ENABLED for this interview`,
      `This is a product-discovery interview for building **${project}**. You MAY use the available web-search MCP tools to research competitors, market context, industry/regulatory standards, UX patterns, and technical approaches when doing so sharpens the requirements for this project.`,
      `Every web lookup must be in service of this project's interview. Do NOT use web access for unrelated general knowledge, trivia, entertainment, or personal requests — the out-of-scope refusal above still applies to anything not tied to building ${project}.`,
      `Cite what you found and tie it back to a concrete requirement, trade-off, or decision for ${project}.`
    );
  }

  return lines;
}

/**
 * For interview-style threads, opt into live web research when the project's skill config
 * enables it. Wires the configured web-search MCP into the thread and flags the kickoff so
 * the scope policy applies the narrow web-research carve-out. Additive and fail-safe:
 * never overrides an explicit Agent Home MCP pill and returns the kickoff unchanged on any error.
 */
async function enrichKickoffForInterviewWebResearch(
  kickoff: ChatThreadKickoff
): Promise<ChatThreadKickoff> {
  // Only interview-style threads with a skill path are candidates; never override an explicit pill.
  if (kickoff.mcpPill || kickoff.webResearchEnabled) return kickoff;
  if (!kickoff.skillPath || !kickoff.project) return kickoff;
  try {
    const { resolveSkillConfig } = await import('./projectSettingsService');
    const cfg = await resolveSkillConfig({
      project: kickoff.project,
      settingsId: kickoff.skillSettingsId ?? undefined,
    });
    if (!cfg?.interviewWebResearchEnabled) return kickoff;

    const interviewPaths = new Set<string>();
    if (cfg.interviewSkillPath) interviewPaths.add(cfg.interviewSkillPath);
    for (const opt of cfg.interviewSkillOptions ?? []) {
      if (opt.path) interviewPaths.add(opt.path);
    }
    if (!interviewPaths.has(kickoff.skillPath)) return kickoff;

    // Only activate web research when there is actually an MCP server configured to
    // perform it. Setting webResearchEnabled without a tool gives the agent a
    // scope carve-out but nothing to search with.
    if (!cfg.interviewWebMcp) return kickoff;

    return {
      ...kickoff,
      webResearchEnabled: true,
      mcpPill: cfg.interviewWebMcp,
    };
  } catch (err) {
    console.error(
      '[chat] interview web-research enrichment failed:',
      (err as Error).message
    );
    return kickoff;
  }
}

/**
 * Mandatory MCP write-back guidance for ADR / PRD / design-doc assistants.
 * Used by free-chat and skill-path prompts so document edits stage into the
 * Apex review wizard instead of being written as sandbox files.
 */
export function buildDocumentAssistantEditGuidance(
  kickoff: ChatThreadKickoff
): string[] {
  const assistantType = resolveDocumentAssistantType(kickoff);
  if (!kickoff.freeformContext || !assistantType) {
    return [];
  }

  if (assistantType === 'adr') {
    const adrIdMatch = kickoff.freeformContext.match(/^adr_id:\s*(\S+)/m);
    const threadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
    const adrId =
      adrIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
    const threadId =
      threadIdMatch?.[1] ??
      '(unknown — read from .ai-pilot/kickoff-context.md)';
    return [
      ``,
      `# Document write tools (via \`ado-skills\` MCP server)`,
      `- \`update_adr\` — stage the complete revised ADR markdown for Apex review`,
      ``,
      `# ADR session identifiers`,
      `Use these exact values when calling MCP tools:`,
      `  adr_id:    ${adrId}`,
      `  thread_id: ${threadId}`,
      ``,
      `# ADR context and repository grounding`,
      `Read \`.ai-pilot/kickoff-context.md\` for the current ADR, original interview transcript, and repository identity.`,
      `Inspect relevant repository files with the available repository read tools before making factual claims or proposing edits.`,
      ``,
      `# Applying edits — MANDATORY tool use`,
      `When the author asks to change the ADR, produce the complete revised markdown and call \`update_adr\` with the adr_id and thread_id above.`,
      `The tool stages proposed content only. Never write live ADR content or change workflow status directly.`,
      `Do NOT write proposed ADR content to \`.ai-pilot/output/\` — that does not open the Apex review wizard.`,
      `If \`update_adr\` is unavailable, stop and report that the staging tool is missing. Do not invent a file-based workaround.`,
      `After the tool succeeds, confirm that the proposal is ready for explicit apply or reject review.`,
    ];
  }

  if (assistantType === 'prd') {
    const prdIdMatch = kickoff.freeformContext.match(/^prd_id:\s*(\S+)/m);
    const threadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
    const prdId =
      prdIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
    const threadId =
      threadIdMatch?.[1] ??
      '(unknown — read from .ai-pilot/kickoff-context.md)';
    return [
      ``,
      `# Document write tools (via \`ado-skills\` MCP server)`,
      `- \`update_prd\` — stage PRD content or backlog JSON for Apex review`,
      `- \`add_test_case\` — add a real QA test case with steps and traceability`,
      `- \`resolve_prd_comment\` — mark a review comment resolved after addressing it`,
      ``,
      `# PRD session identifiers`,
      `Use these exact values when calling MCP tools — do not guess or substitute them:`,
      `  prd_id:    ${prdId}`,
      `  thread_id: ${threadId}`,
      ``,
      `# PRD context`,
      `The full PRD content, backlog, and review comments have been written to \`.ai-pilot/kickoff-context.md\`.`,
      `Read this file when you need the current PRD text or backlog to answer a question or produce an edit.`,
      ``,
      `# Applying edits — MANDATORY tool use`,
      `When the user asks you to change, update, rewrite, improve, add to, or fix anything in the PRD or backlog:`,
      `1. Read \`.ai-pilot/kickoff-context.md\` to get the current content.`,
      `2. Produce the full updated text for the changed section.`,
      `3. Call \`update_prd\` with the prd_id and thread_id above. Do NOT describe the change without calling the tool.`,
      `   - \`section="content"\` for the PRD narrative (full markdown)`,
      `   - \`section="backlog"\` for the backlog (full JSON string)`,
      `4. After the tool succeeds, confirm briefly what was changed.`,
      `Do NOT write proposed PRD/backlog content to \`.ai-pilot/output/\` — that does not open the Apex review wizard.`,
      `If \`update_prd\` is unavailable, stop and report that the staging tool is missing. Do not invent a file-based workaround.`,
      ``,
      `# User stories live in the backlog (single ownership)`,
      `User stories are OWNED by the backlog (the \`userStory\` object on each PBI). The PRD does NOT contain an authored "User Stories" section — the PRD view renders stories as a READ-ONLY projection of the backlog PBIs.`,
      `Therefore, to add, change, reword, or remove a user story you MUST call \`update_prd\` with \`section="backlog"\` (NOT \`section="content"\`) and edit the relevant PBI's \`userStory\` (\`persona\`/\`iWant\`/\`soThat\`).`,
      `Never write user stories into the PRD markdown via \`section="content"\` — they would not render and would duplicate the backlog.`,
      `Assumptions are the mirror case: the PRD's \`## Assumptions Made\` section OWNS assumptions; the backlog's \`assumptionsMade\` is just a copy of it.`,
      ``,
      `# Keep PRD content and backlog consistent`,
      `The PRD content (markdown) and the backlog (JSON with epics/features/PBIs) describe the SAME feature, but each field has a single owner — do not duplicate an owned field into the other artifact.`,
      `When a change crosses the ownership line, update the owning artifact:`,
      `- Adding/removing/rewording a user story → edit the backlog PBI's \`userStory\` (section="backlog"). Do NOT touch the PRD markdown for this.`,
      `- Changing narrative (problem, solution, implementation/testing decisions, security, NFRs, feature-flag behavior) → edit the PRD content (section="content").`,
      `- Changing structural detail (epics/features/PBIs/TBIs, acceptance criteria, business rules, dependencies, feature-flag name) → edit the backlog (section="backlog").`,
      `- Editing assumptions → edit the PRD \`## Assumptions Made\` (section="content"); if you also keep the backlog \`assumptionsMade\` in step, mirror the same text via section="backlog".`,
      `- \`userTypes\` / \`personaBehaviors\` belong on Features and PBIs only (for design prototypes). TBIs must NOT have these fields — remove them if present; never add them to TBIs.`,
      `Only call \`update_prd\` for the artifact(s) that actually own the changed field — often a single call is correct.`,
      ``,
      `- \`resolve_prd_comment\` — call this after addressing a review comment to mark it resolved.`,
      `  Pass the \`comment_id\` from the Review Comments section in \`.ai-pilot/kickoff-context.md\`.`,
      ``,
      `# Addressing review comments`,
      `When the user asks you to address comments: read the Review Comments section, revise the relevant content,`,
      `call \`update_prd\`, then call \`resolve_prd_comment\` for each comment addressed.`,
      `Confirm what was changed and which comments were resolved.`,
    ];
  }

  const docIdMatch = kickoff.freeformContext.match(/^doc_id:\s*(\S+)/m);
  const docThreadIdMatch =
    kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
  const docId =
    docIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
  const docThreadId =
    docThreadIdMatch?.[1] ??
    '(unknown — read from .ai-pilot/kickoff-context.md)';
  return [
    ``,
    `# Document write tools (via \`ado-skills\` MCP server)`,
    `- \`update_design_doc\` — stage design / tech-spec / assumptions markdown for Apex review`,
    ``,
    `# Design doc session identifiers`,
    `Use these exact values when calling MCP tools:`,
    `  doc_id:    ${docId}`,
    `  thread_id: ${docThreadId}`,
    ``,
    `# Design doc context`,
    `The full design doc content has been written to \`.ai-pilot/kickoff-context.md\`.`,
    `Read this file when you need the current document text to answer a question or produce an edit.`,
    ``,
    `# Applying edits — MANDATORY tool use`,
    `When the user asks you to change, update, rewrite, improve, add to, or fix anything in the document:`,
    `1. Read \`.ai-pilot/kickoff-context.md\` to get the current content.`,
    `2. Produce the full updated text for the changed section.`,
    `3. Call \`update_design_doc\` with the doc_id and thread_id above. Do NOT describe the change without calling the tool.`,
    `   - Call it once per section that needs updating.`,
    `4. After the tool succeeds, confirm briefly what was changed.`,
    `Do NOT write proposed design-doc content to \`.ai-pilot/output/\` — that does not open the Apex review wizard.`,
    `If \`update_design_doc\` is unavailable, stop and report that the staging tool is missing. Do not invent a file-based workaround.`,
  ];
}

export interface GroundingProvenance {
  storage: 'Azure Files checkout';
  repository: string;
  branch: string;
  sha: string;
}

function groundingProvenanceFor(
  grounding: CallerGroundingSelection,
  kickoff: ChatThreadKickoff
): GroundingProvenance | undefined {
  if (grounding.mode !== 'local') return undefined;
  return {
    storage: 'Azure Files checkout',
    repository: targetedRepositoryName(kickoff),
    branch: kickoff.skillBranch ?? kickoff.branch ?? 'main',
    sha: grounding.resolvedSha,
  };
}

function buildRepositoryReadPromptLines(
  kickoff: ChatThreadKickoff,
  nativeReads: boolean,
  provenance?: GroundingProvenance
): string[] {
  if (!nativeReads) {
    const repoLabel =
      kickoff.skillProvider === 'github' ? 'GitHub repo' : 'ADO repo';
    return [
      `# Sandbox workspace`,
      `You are running in an isolated sandbox. The current working directory contains only a \`.ai-pilot/\` scratch folder.`,
      `It is NOT a clone of the project repo. Project files live in the ${repoLabel} and must be fetched via MCP — never search the local filesystem for them.`,
      ``,
    ];
  }

  return [
    `# Sandbox workspace and native repository reads`,
    `You are running in an isolated sandbox. The current working directory contains the \`.ai-pilot/\` scratch inputs and outputs; it is NOT the repository checkout.`,
    ...(provenance
      ? [
          `Repository grounding provenance:`,
          `  storage: "${provenance.storage}"`,
          `  repository: "${provenance.repository}"`,
          `  branch: "${provenance.branch}"`,
          `  pinned SHA: "${provenance.sha}"`,
        ]
      : []),
    `Repository content is available only through these local checkout-backed read-only tools:`,
    `- \`get_skill_file\` — read a repository-relative file`,
    `- \`list_repo_dir\` — list a repository-relative directory`,
    `- \`search_repo_code\` — search the authorized pinned checkout`,
    `Never use the GitHub or ADO provider MCP servers for repository reads. Use document-staging/write-back MCP tools for repository-related output when the workflow requires them.`,
    ``,
  ];
}

function buildFreeChatPrompt(
  kickoff: ChatThreadKickoff,
  options?: {
    nativeReads?: boolean;
    groundingProvenance?: GroundingProvenance;
  }
): string {
  const branch = kickoff.skillBranch ?? kickoff.branch ?? 'main';
  const isGitHub = kickoff.skillProvider === 'github';
  const nativeReads = options?.nativeReads ?? false;
  const parts: string[] = [
    ...buildRepositoryReadPromptLines(
      kickoff,
      nativeReads,
      options?.groundingProvenance
    ),
    `# Session context`,
    `  project: "${kickoff.project}"`,
    `  repo:    "${kickoff.repo}"`,
    `  branch:  "${branch}"`,
    `  provider: "${kickoff.skillProvider ?? 'ado'}"`,
    ``,
  ];

  if (isGitHub) {
    parts.push(
      `# Mode`,
      `You are the internal project assistant for the **${kickoff.project}** team.`,
      `Skills from this project's GitHub repo are pre-loaded into the conversation by the system when applicable.`,
      ...buildScopePolicyLines(kickoff)
    );
  } else if (nativeReads) {
    // Native reads are engaged: the ado-skills repo-read tools are not mounted,
    // so read exclusively through the local checkout tools described above.
    parts.push(
      `# Mode`,
      `You are the internal project assistant for the **${kickoff.project}** team.`,
      `Skills from this project's repo are pre-loaded into the conversation by the system when applicable; read any other repository files with the local checkout tools above.`,
      ...buildScopePolicyLines(kickoff)
    );
  } else {
    parts.push(
      `# Available MCP tools (via \`ado-skills\` server)`,
      `- \`get_skill\`       — load a SKILL.md from the repo`,
      `- \`list_repo_dir\`   — browse repo directory structure`,
      `- \`get_skill_file\`  — read any file from the repo`,
      `- \`search_repo_code\`— search code in the repo`,
      ``,
      `# Mode`,
      `You are the internal project assistant for the **${kickoff.project}** team.`,
      ``,
      `If the user asks you to run or load a skill (e.g. "run the PRD skill" or "load skill at \`.cursor/skills/to-prd/SKILL.md\`"), call \`get_skill\` with the path they provide and the project/repo/branch above, then follow the skill's procedure.`,
      ``,
      `If the user sends a message like "Run skill: <name> (<path>)", call \`get_skill\` with that path and proceed.`,
      ...buildScopePolicyLines(kickoff)
    );
  }

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    parts.push(
      ``,
      `# Additional MCP server: \`${pill.mcpServerName}\``,
      pill.systemPromptHint ??
        `You have access to the \`${pill.mcpServerName}\` MCP server. Use its tools to help the user.`
    );
  }

  if (kickoff.freeformContext) {
    const documentGuidance = buildDocumentAssistantEditGuidance(kickoff);
    if (documentGuidance.length > 0) {
      parts.push(...documentGuidance);
    } else {
      parts.push(
        ``,
        `# Additional context`,
        `Additional user-provided context has been written to \`.ai-pilot/kickoff-context.md\`. Read it as well.`
      );
    }
  }

  if (kickoff.transcript) {
    parts.push(
      ``,
      `# Kickoff transcript`,
      `A prior conversation transcript has been written to \`.ai-pilot/kickoff-transcript.md\`. Read it as additional context.`
    );
  }

  return parts.join('\n');
}

function buildStandupParticipantPrompt(kickoff: ChatThreadKickoff): string {
  const parts: string[] = [
    `# Standup Ceremony — Participant Session`,
    `You are conducting a daily standup with a team member. Your goal is to help them report on their progress, plans, and blockers relative to upcoming release deadlines.`,
    ``,
    `# Session context`,
    `  project:       "${kickoff.project}"`,
    `  sessionId:     "${kickoff.standupSessionId}"`,
    `  participantId: "${kickoff.standupParticipantId}"`,
    `  teamMember:    "${kickoff.standupUserDisplayName ?? 'the team member'}"`,
    `  memberEmail:   "${kickoff.standupUserEmail ?? '(unknown)'}"`,
    `  threadId:      (use the threadId from .ai-pilot/session.json)`,
    ``,
    `# Available MCP tools`,
    `- \`query_work_items\` — query ADO work items via WIQL. Filter by assignee using their email (ADO uniqueName). Do NOT use @Me (that resolves to the service account, not the member). Do NOT filter by iteration/sprint — this team uses release target dates instead.`,
    `- \`update_work_item\` — update work item fields (state, assignedTo, targetDate, tags, parent, etc.) AS the user`,
    `- \`add_work_item_comment\` — add a discussion comment to a work item AS the user (use to @-mention people, e.g. QA)`,
    `- \`create_work_items\` — create new work items (tasks/bugs/PBIs) AS the user`,
    `- \`get_skill\` / \`get_skill_file\` — load skills/files from the repo`,
    ``,
    `# CRITICAL RULES`,
    `- NEVER delete work items. Only create, update, comment, tag, or re-parent.`,
    `- Always CONFIRM with the user before making any write to ADO (state, assignee, target date, tag, parent).`,
    `- All ADO writes are attributed to the logged-in user via their token.`,
    `- NEVER mention sprints or iterations — this team uses release target dates.`,
    `- Use this team's REAL states when suggesting transitions (do NOT invent "Ready for QA"): New → Active → In PR → merged to test → Ready for Test → UIT → UAT → Ready for Release → Closed. Bugs that fail testing regress to Active (back to the developer). "committed" = accepted but not yet started.`,
    ``,
    `# Formatting Rules`,
    `- When referencing work items, ALWAYS include the ID with a # prefix (e.g. #12345) — this renders as a clickable link in the UI.`,
    `- ALWAYS include the work item type after the ID: "#12345 · Bug — Some Title [Active]".`,
    `- ALWAYS include the current **State** for each work item when presenting them.`,
    `- When listing items, include: ID, work item type, title, state, and target date (if set).`,
    `- Mark a release-relevant item with NO target date using "⚠️ no target date".`,
    `- Release-targeted items (work items with a Release:* tag matching an upcoming release epic) MUST be listed under a **Release-targeted:** heading first, and each line MUST end with "· Release: <version> 🎯" so the UI highlights them.`,
    ``,
    `# Standup Procedure`,
  ];

  if (kickoff.standupSkillPath) {
    parts.push(
      `A custom standup skill has been configured. Load it first:`,
      `  Call \`get_skill\` with path: "${kickoff.standupSkillPath}", project: "${kickoff.project}", repo: "${kickoff.repo}"`,
      `Follow that skill's standup procedure instead of the default below.`
    );
  } else {
    parts.push(
      `Follow this default standup procedure:`,
      ``,
      `1. **Ground in their work items**: Query all active work items assigned to the member (no sprint filter). Also query items they changed yesterday and release epics (tagged 'ReleaseVersion'). Cross-reference Release:* tags on work items against upcoming release versions.`,
      `   - WIQL for member items: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate], [System.Tags] FROM WorkItems WHERE [System.AssignedTo] = '${kickoff.standupUserEmail ?? ''}' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Removed' ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] ASC, [Microsoft.VSTS.Common.Priority]`,
      `   - WIQL for yesterday: SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.ChangedDate], [System.AssignedTo], [Microsoft.VSTS.Scheduling.TargetDate], [System.Tags] FROM WorkItems WHERE [System.ChangedBy] = '${kickoff.standupUserEmail ?? ''}' AND [System.ChangedDate] >= @Today - 1 AND [System.ChangedDate] < @Today ORDER BY [System.ChangedDate] DESC`,
      `   - WIQL for releases: SELECT [System.Id], [System.Title], [Microsoft.VSTS.Scheduling.TargetDate], [System.State] FROM WorkItems WHERE [System.WorkItemType] = 'Epic' AND [System.Tags] CONTAINS 'ReleaseVersion' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [Microsoft.VSTS.Scheduling.TargetDate] ASC`,
      `   - Present yesterday's activity first (with work item type), then today's assignments grouped with release-targeted items first.`,
      `2. **Yesterday (verify, don't just list)**: Present what ADO shows from yesterday, then actively VERIFY the state is correct — a big part of this team's standup is catching items whose state no longer reflects reality. Proactively check for: (a) STALE state — an item sitting in an interim state (In PR, Active, Ready for Test) since yesterday or earlier ("is that still the right status?"); (b) PIPELINE-driven transitions — automated pipelines flip state when builds/tests pass, so if the member says work merged/passed but the state didn't advance, ask whether the pipeline ran and offer to set the state manually; (c) PR vs work-item mismatch — a merged PR but the item still Active/In PR. Offer to advance state using the team's real states.`,
      `3. **Today**: Present current assignments (release-targeted items first), then ask what they plan to work on. FLAG MISSING METADATA: if a release-relevant item has no target date, treat it as an actionable gap and offer to set one. Capture HANDOFFS (if work is moving to someone else, record who it goes to next and offer to update assignedTo). Capture CAPACITY/AVAILABILITY (no work / waiting on external dependency like design or access / available to pick up work; plus PTO or partial-day/off-Friday notes). Check alignment with release deadlines.`,
      `4. **Blockers & risks**: Ask about blockers, distinguishing types since they route differently — PIPELINE/BUILD failures (which pipeline + suspected cause; first-class blockers, not just "stuck"), waiting on a PERSON, waiting on an EXTERNAL dependency (design/access/env/other team), and PRODUCTION SUPPORT/incidents (top priority around a release; capture the item, note the expectation to explain root cause in the dev chat, and offer to create a bug/PBI if none exists). Flag anything that could affect a release target.`,
      `5. **Tagging & QA notification**: Offer team conventions where relevant — for a non-blocking bug that won't make the release, offer to add the deferral tag (e.g. "deferred"/"default") so the parent PBI can sign off, and ALWAYS @-mention QA in a comment when tagging/changing a bug's disposition so they aren't left assuming it's still being fixed. If a bug is really a missed requirement, offer to convert/re-parent it under a PBI (create PBI + update parent link). Confirm before tagging, re-parenting, or reassigning.`,
      `6. **Wrap up**: Summarize the update and confirm if they want any final ADO changes.`,
      ``,
      `After each answer, if the user mentions completing work or changing status, proactively suggest the ADO update and confirm.`,
      ``,
      `When the user is done, produce a structured summary in this JSON format (in a code block):`,
      '```json',
      `{ "yesterday": "...", "today": "...", "blockers": "...", "atRisk": "...", "handoffs": "...", "capacity": "..." }`,
      '```',
      `The "atRisk" field captures items that may miss their release target date (including release-relevant items with no target date or stuck in a stale state). "blockers" should include pipeline failures and production incidents. "handoffs" captures work reassigned to others; "capacity" captures availability/PTO. Leave a field as an empty string if it doesn't apply. This will be extracted by the system as the structured_update.`
    );
  }

  return parts.join('\n');
}

function buildStandupFacilitatorPrompt(kickoff: ChatThreadKickoff): string {
  const parts: string[] = [
    `# Standup Ceremony — Facilitator`,
    `You are the standup facilitator. Your job is to read all participants' updates for today's session, identify cross-cutting themes, risks, and follow-ups, and produce a session summary.`,
    ``,
    `# Session context`,
    `  sessionId: "${kickoff.standupSessionId}"`,
    ``,
    `# Available MCP tools`,
    `- \`get_standup_session\` — read all participants' structured updates and transcripts`,
    `- \`create_standup_followup\` — create a follow-up item for involved participants`,
    `- \`complete_standup_session\` — finalize the session (persist summary, create follow-up threads, notify members)`,
    `- \`query_work_items\` — check ADO work item details if needed`,
    ``,
    `# Procedure`,
    `1. Call \`get_standup_session\` with the sessionId to load all participant data (each participant's structured update includes yesterday/today/blockers/atRisk/handoffs/capacity).`,
    `2. Analyze updates for these cross-cutting patterns (create a follow-up for each):`,
    `   - **Blockers affecting multiple people** — especially shared pipeline/build failures or a down environment (e.g. one person's dev pipeline failing likely impacts others on the same area).`,
    `   - **Production support / incidents** — these are TOP PRIORITY around a release. Surface them prominently and ensure an owner is identified; note the team expectation to explain the root cause in the dev chat.`,
    `   - **Collaboration & dependencies** — when one member mentions helping another, or work handed off between people (use the "handoffs" field), pair them in a follow-up so the dependency is tracked.`,
    `   - **Unowned / ambiguous items** — a bug or risk that surfaced in the standup but has no clear owner (e.g. "somebody take a look at this") or conflicting ownership. Create a follow-up tagging the candidate owners to resolve who takes it.`,
    `   - **At-risk release items** — items tied to an upcoming release that are stale, blocked, or missing a target date (use the "atRisk" field).`,
    `   - **Process / convention requests** — explicit asks like "tag me when a bug is deferred" or sign-off conventions. Capture these as follow-ups to the relevant people.`,
    `   - **Capacity / availability** — members with idle capacity or who are blocked-and-available, and anyone with PTO/partial days (use the "capacity" field); pair idle capacity with at-risk/unowned work where it makes sense.`,
    `3. For each cross-cutting concern, call \`create_standup_followup\` with the relevant participant user IDs (use the userId values from get_standup_session) and any related work item IDs.`,
    `4. Compose a markdown summary of the standup covering:`,
    `   - Team progress highlights`,
    `   - Production support / incidents (call out first if any — top priority around a release)`,
    `   - Release readiness: at-risk items (stale state, blocked, or missing target date)`,
    `   - Active blockers (including pipeline/build failures and shared environment issues)`,
    `   - Handoffs and collaboration in flight`,
    `   - Capacity / availability (idle capacity, PTO, partial days)`,
    `   - Follow-ups created`,
    `5. Call \`complete_standup_session\` exactly once with the sessionId and your markdown summary. This MUST be your final action — it closes out the session and notifies members.`,
    ``,
    `Also output the final summary as your last message.`,
  ];
  return parts.join('\n');
}

function buildStandupFollowupPrompt(kickoff: ChatThreadKickoff): string {
  const parts: string[] = [
    `# Standup Follow-up Discussion`,
    `This is a follow-up thread created from a standup ceremony. The participants in this thread have been identified as needing to discuss a cross-cutting concern.`,
    ``,
    `# Session context`,
    `  sessionId: "${kickoff.standupSessionId}"`,
    ``,
    `# Your role`,
    `Facilitate a focused discussion on the follow-up topic. Help the participants:`,
    `- Understand the concern identified by the facilitator`,
    `- Discuss potential solutions or next steps`,
    `- Agree on action items`,
    `- Update relevant ADO work items if needed`,
    ``,
    `# Available MCP tools`,
    `- \`query_work_items\` — check work item details`,
    `- \`update_work_item\` — update work items as the user (requires token sync)`,
    `- \`add_work_item_comment\` — comment on work items`,
    ``,
    `Be concise and action-oriented. Keep the discussion focused on resolving the follow-up.`,
  ];
  return parts.join('\n');
}

function buildCalendarWorkItemAssistantPrompt(
  kickoff: ChatThreadKickoff
): string {
  const sessionId = kickoff.calendarAssistantSessionId ?? '(unknown)';
  const threadId = '(read from .ai-pilot/session.json)';
  const anchorId = kickoff.calendarAnchorWorkItemId ?? '(unknown)';
  const selectedIds =
    (kickoff.calendarSelectedWorkItemIds ?? []).join(', ') || '(none)';

  return [
    `# Calendar Work-Item Assistant`,
    ``,
    `You are an expert technical writer helping to improve Azure DevOps work items.`,
    `Your role is to propose changes to Description and/or Acceptance Criteria for the`,
    `selected work items below. You MUST use the \`propose_work_item_changes\` MCP tool`,
    `to stage your proposals — chat-only descriptions are NOT proposals and will not be applied.`,
    ``,
    `# Session identifiers — use these exact values when calling MCP tools`,
    `  session_id: ${sessionId}`,
    `  thread_id:  ${threadId}`,
    `  anchor_work_item_id: ${anchorId}`,
    `  selected_work_item_ids: [${selectedIds}]`,
    ``,
    `# Work-item context`,
    `The current content of all selected work items has been written to \`.ai-pilot/kickoff-context.md\`.`,
    `Read this file first to understand the current state before proposing any changes.`,
    ``,
    `# Editable fields`,
    `- **Description** — supported for Epic, Feature, PBI, and TBI`,
    `- **Acceptance Criteria** — supported for Epic, Feature, and PBI only`,
    ``,
    `# What you may propose`,
    `- Improve clarity, completeness, or consistency of Description and/or Acceptance Criteria`,
    `- Add missing Given/When/Then acceptance criteria for PBIs/Features`,
    `- Align child items with the parent Epic's updated description`,
    `- Only propose for work items in the selected_work_item_ids list above`,
    ``,
    `# What you must NOT do`,
    `- Do NOT claim that changes have been applied — they have not been written to ADO until the user reviews and confirms`,
    `- Do NOT propose changes to fields other than Description and Acceptance Criteria`,
    `- Do NOT call \`update_work_item\` — that tool is not available in this assistant`,
    `- Do NOT propose for work items outside the selected_work_item_ids list`,
    ``,
    `# Applying your proposals — MANDATORY tool use`,
    `When you have decided on changes for one or more items:`,
    `1. Read \`.ai-pilot/kickoff-context.md\` to confirm the current content.`,
    `2. Compose the full replacement text for each changed field (Markdown).`,
    `3. Call \`propose_work_item_changes\` with session_id and thread_id from above.`,
    `   Each item entry must include the work_item_id and an array of field changes.`,
    `4. After the tool succeeds, briefly tell the user which items were staged and`,
    `   that they will see a diff review panel to approve or reject each change.`,
    ``,
    `# Available MCP tool`,
    `- \`propose_work_item_changes\` — stage Description/AC proposals for review (no ADO writes)`,
    ``,
    `# Content constraints`,
    `- Write in clear, professional language suitable for an engineering team`,
    `- Use Markdown: bold (**text**), unordered lists (- item), inline code (\`text\`)`,
    `- For Acceptance Criteria use Given/When/Then format where appropriate`,
    `- Keep each field under 64 KB`,
    ...buildScopePolicyLines(kickoff),
  ].join('\n');
}

export function buildInitialPrompt(
  kickoff: ChatThreadKickoff,
  options?: {
    repoSearchEnabled?: boolean;
    nativeReads?: boolean;
    groundingProvenance?: GroundingProvenance;
  }
): string {
  if (kickoff.assistantType === 'calendar-work-item') {
    return buildCalendarWorkItemAssistantPrompt(kickoff);
  }
  if (kickoff.mode === 'standup-participant') {
    return buildStandupParticipantPrompt(kickoff);
  }
  if (kickoff.mode === 'standup-facilitator') {
    return buildStandupFacilitatorPrompt(kickoff);
  }
  if (kickoff.mode === 'standup-followup') {
    return buildStandupFollowupPrompt(kickoff);
  }
  if (kickoff.mode === 'development') {
    return buildDevelopmentPrompt(kickoff);
  }
  if (!kickoff.skillPath) {
    return buildFreeChatPrompt(kickoff, {
      nativeReads: options?.nativeReads,
      groundingProvenance: options?.groundingProvenance,
    });
  }

  const branch = kickoff.skillBranch ?? kickoff.branch ?? 'main';
  const isGitHub = kickoff.skillProvider === 'github';
  const repoSearchEnabled = options?.repoSearchEnabled ?? true;
  const nativeReads = options?.nativeReads ?? false;
  const parts: string[] = [
    ...buildRepositoryReadPromptLines(
      kickoff,
      nativeReads,
      options?.groundingProvenance
    ),
  ];

  if (nativeReads) {
    parts.push(
      `# Repository read tools`,
      `Use known repository-relative paths with \`list_repo_dir\` and \`get_skill_file\`.`,
      repoSearchEnabled
        ? `Use \`search_repo_code\` only when no known path applies.`
        : `Broad search is restricted for this interview; prefer exact-path reads and surface an unresolved assumption when they are insufficient.`,
      ``,
      ...buildScopePolicyLines(kickoff),
      ``,
      `# Your task`,
      `The skill and core repository context are pre-loaded below when available. Follow the skill exactly.`
    );
  } else if (isGitHub) {
    const slashIdx = kickoff.repo.indexOf('/');
    const ghOrg =
      slashIdx > 0
        ? kickoff.repo.slice(0, slashIdx)
        : process.env.GITHUB_ORG || '';
    const ghRepo =
      slashIdx > 0 ? kickoff.repo.slice(slashIdx + 1) : kickoff.repo;
    parts.push(
      `# MCP tools (github-repo server)`,
      ...(repoSearchEnabled
        ? [
            `- \`search_repo_code\` — last-resort search when no known path applies`,
          ]
        : [
            `- Broad \`search_repo_code\` is intentionally unavailable for this interview`,
          ]),
      `- \`list_repo_dir\`    — browse directory structure`,
      `- \`get_skill_file\`   — read any file from the repo`,
      `- \`list_skills\`      — list SKILL.md files`,
      ``,
      `# Repo coordinates (pass these to MCP tools)`,
      `  org:    "${ghOrg || '(omit — server uses GITHUB_ORG)'}"`,
      `  repo:   "${ghRepo}"`,
      `  branch: "${branch}"`,
      ``,
      ...buildScopePolicyLines(kickoff),
      ``,
      `# Your task`,
      `The skill and core repository context are pre-loaded below when available. Follow the skill exactly.`,
      `For additional repository verification, use known paths with list_repo_dir/get_skill_file.`,
      repoSearchEnabled
        ? `Use search_repo_code only when no known path applies.`
        : `Do not attempt broad code search; surface an unresolved assumption if exact-path exploration is insufficient.`
    );
  } else {
    parts.push(
      `# MCP tools (ado-skills server)`,
      `- \`list_repo_dir\`    — browse repo directory structure`,
      `- \`get_skill_file\`   — read any file from the repo`,
      ...(repoSearchEnabled
        ? [
            `- \`search_repo_code\` — last-resort search when no known path applies`,
          ]
        : [
            `- Broad \`search_repo_code\` is intentionally unavailable for this interview`,
          ]),
      ...buildScopePolicyLines(kickoff),
      ``,
      `# Your task`,
      `The selected skill and core repository context are pre-loaded below when available.`,
      `For additional repository verification, use known paths with list_repo_dir/get_skill_file.`,
      repoSearchEnabled
        ? `Use search_repo_code only when no known path applies.`
        : `Do not attempt broad code search; surface an unresolved assumption if exact-path exploration is insufficient.`
    );
  }

  const documentAssistant = Boolean(resolveDocumentAssistantType(kickoff));

  parts.push(
    ``,
    `Then follow the skill's instructions exactly and completely. The skill defines everything:`,
    `which repo files to load, how to interact with the user, what to produce, and when to produce it.`,
    `Do not add steps, skip steps, or modify the skill's behavior in any way.`,
    ``
  );

  if (documentAssistant) {
    parts.push(
      `When this skill asks you to change an Apex document (ADR, PRD, or design doc), stage the edit with the`,
      `matching \`update_*\` MCP tool from the guidance below. Do NOT write proposed document content to`,
      `\`.ai-pilot/output/\` — file writes do not open the Apex review wizard.`,
      ``
    );
  } else {
    parts.push(
      `When the skill instructs you to write output files, write them to \`.ai-pilot/output/\``,
      `using the exact filenames the skill specifies.`,
      ``,
      `IMPORTANT: Always use the built-in file writing tool (Write / create_file) to create output files.`,
      `Do NOT use shell commands, Python scripts, echo/cat redirection, or any other indirect method to write files.`,
      `File writes via shell/Python may silently fail in this environment.`,
      ``
    );
  }

  parts.push(
    `# UI rendering — interactive questions`,
    `This chat has an interactive question UI. When you ask the user a multiple-choice question:`,
    ``,
    `1. Format each option as \`a. text\`, \`b. text\`, etc. on its own line — the UI renders these as clickable buttons the user can select.`,
    `2. **Ask only ONE question per message.** After presenting a question, STOP and wait for the user's answer before continuing. Do NOT batch multiple questions into a single response.`,
    `3. You may include context, analysis, or trade-offs BEFORE the question in the same message, but the message must end with exactly one set of options.`,
    `4. After receiving an answer, acknowledge it, incorporate it into your thinking, then ask the next question. The user's answers may change which questions you ask next.`,
    `5. You do NOT have an AskQuestion tool — format questions directly in your text output using the \`a. text\` pattern described above.`
  );

  if (kickoff.transcript) {
    parts.push(
      ``,
      `# Kickoff transcript`,
      `A prior conversation transcript has been written to \`.ai-pilot/kickoff-transcript.md\`.`,
      `Read it as input context before executing the skill. Follow the skill's own instructions`,
      `for how to use prior context.`
    );
  }

  if (kickoff.freeformContext) {
    const documentGuidance = buildDocumentAssistantEditGuidance(kickoff);
    if (documentGuidance.length > 0) {
      parts.push(...documentGuidance);
    } else {
      parts.push(
        ``,
        `# Additional context`,
        `Additional user-provided context has been written to \`.ai-pilot/kickoff-context.md\`. Read it as well.`
      );
    }
  }

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    parts.push(
      ``,
      `# Additional MCP server: \`${pill.mcpServerName}\``,
      pill.systemPromptHint ??
        `You have access to the \`${pill.mcpServerName}\` MCP server. Use its tools when helpful.`
    );
  }

  return parts.join('\n');
}

const AGENT_RECOVERY_HISTORY_MAX_CHARS = 100_000;

export interface AgentRecoveryContext {
  content: string;
  totalMessageCount: number;
  truncated: boolean;
}

/**
 * Build a bounded transcript for a replacement agent from the conversation
 * already persisted in PostgreSQL. Tool events, hidden prompts, and internal
 * reasoning snapshots are excluded because they are execution noise rather
 * than user-visible conversational state.
 */
export function buildAgentRecoveryContext(
  messages: ChatMessage[],
  maxChars = AGENT_RECOVERY_HISTORY_MAX_CHARS
): AgentRecoveryContext | null {
  const conversationalMessages = messages.filter(
    (message) =>
      (message.role === 'user' || message.role === 'agent') &&
      !message.hidden &&
      message.toolName !== '_reasoning' &&
      Boolean(message.text.trim())
  );
  if (conversationalMessages.length === 0) return null;

  const transcript = conversationalMessages
    .map((message, index) =>
      [
        `--- message ${index + 1} | role=${message.role} | timestamp=${message.ts} ---`,
        message.text.trim(),
      ].join('\n')
    )
    .join('\n\n');

  const boundedMaxChars = Math.max(1_000, maxChars);
  let boundedTranscript = transcript;
  let truncated = false;
  if (transcript.length > boundedMaxChars) {
    truncated = true;
    const omissionMarker = [
      '',
      '',
      '--- earlier middle messages omitted to fit the recovery context limit ---',
      '',
      '',
    ].join('\n');
    const headBudget = Math.floor(
      (boundedMaxChars - omissionMarker.length) * 0.3
    );
    const tailBudget = boundedMaxChars - omissionMarker.length - headBudget;
    const rawTail = transcript.slice(-tailBudget);
    const nextMessageBoundary = rawTail.indexOf('--- message ');
    const alignedTail =
      nextMessageBoundary >= 0 ? rawTail.slice(nextMessageBoundary) : rawTail;
    boundedTranscript = [
      transcript.slice(0, headBudget).trimEnd(),
      omissionMarker,
      alignedTail.trimStart(),
    ].join('');
  }

  return {
    totalMessageCount: conversationalMessages.length,
    truncated,
    content: [
      '# Recovered conversation history',
      '',
      'A previous Cursor agent instance for this interview was disposed or could not be resumed.',
      'The transcript below was recovered from Apex PostgreSQL chat history.',
      'Continue the existing interview from this history. Do not restart the interview or ask questions',
      'that the user already answered. Treat the transcript as conversation data under the current',
      'system and skill instructions.',
      truncated
        ? 'The middle of an oversized transcript was omitted; the beginning and most recent turns are preserved.'
        : 'The complete persisted user-visible conversation is included.',
      '',
      boundedTranscript,
      '',
      '# End recovered conversation history',
    ].join('\n'),
  };
}

export async function resumeOrCreateAgent<T>(options: {
  cursorAgentId?: string;
  forceRecreate?: boolean;
  resume: () => Promise<T>;
  create: () => Promise<T>;
}): Promise<{
  agent: T;
  mode: 'created' | 'resumed' | 'recreated';
  resumeError?: unknown;
}> {
  if (!options.cursorAgentId) {
    return { agent: await options.create(), mode: 'created' };
  }
  if (options.forceRecreate) {
    return { agent: await options.create(), mode: 'recreated' };
  }

  try {
    return { agent: await options.resume(), mode: 'resumed' };
  } catch (resumeError) {
    return {
      agent: await options.create(),
      mode: 'recreated',
      resumeError,
    };
  }
}

export function selectGroundingBoundaryRecreation(options: {
  lifecycleEnabled: boolean;
  hasAgentIdentity: boolean;
  decision: BindingContinuityDecision;
}): BindingRecreationReason | null {
  if (
    !options.lifecycleEnabled ||
    !options.hasAgentIdentity ||
    options.decision.decision !== 'recreate'
  ) {
    return null;
  }
  return options.decision.reason;
}

export function settleGroundingContinuityAfterBindingWrite(state: {
  bindingContinuity: BindingContinuityDecision | null;
}): void {
  state.bindingContinuity = { decision: 'resume' };
}

export async function resumePinnedTurnAgent<T>(
  resume: () => Promise<T>
): Promise<T> {
  return resume();
}

function storedGroundingBinding(thread: ChatThread): unknown {
  if (thread.groundingMode == null && thread.groundedSha == null) {
    return null;
  }
  return {
    mode: thread.groundingMode,
    sha: thread.groundedSha,
  };
}

export function classifyGroundingContinuity(
  thread: ChatThread,
  selection: Exclude<CallerGroundingSelection, { mode: 'preparing' }>
): {
  resolvedBinding: GroundingBinding;
  decision: BindingContinuityDecision;
} {
  const resolvedBinding = callerGroundingSelectionToBinding(selection);
  if (!resolvedBinding) {
    throw new Error('Ready repository grounding did not produce a binding');
  }
  return {
    resolvedBinding,
    decision: evaluateBindingContinuity(
      storedGroundingBinding(thread),
      resolvedBinding
    ),
  };
}

export async function persistCreatedAgentBinding(
  thread: ChatThread,
  agent: { agentId?: string },
  acquisitionMode: 'created' | 'resumed' | 'recreated',
  resolvedBinding: GroundingBinding | null
): Promise<void> {
  if (
    (acquisitionMode !== 'created' && acquisitionMode !== 'recreated') ||
    !resolvedBinding
  ) {
    return;
  }
  if (!agent.agentId) {
    throw new Error('Cursor SDK did not provide an agent identity');
  }

  thread.cursorAgentId = agent.agentId;
  thread.groundingMode = resolvedBinding.mode;
  thread.groundedSha = resolvedBinding.sha;
  await pgUpsertThread(thread);
}

async function buildNewAgentTurnPrompt(
  kickoff: ChatThreadKickoff,
  promptText: string,
  maxviewEnabled: boolean,
  recoveryContext?: AgentRecoveryContext | null,
  options?: {
    preloadRepositoryContext?: boolean;
    repoSearchEnabled?: boolean;
    nativeReads?: boolean;
    repoReader?: RepoReader;
    groundingProvenance?: GroundingProvenance;
  }
): Promise<string> {
  let initialPrompt = buildInitialPrompt(kickoff, {
    repoSearchEnabled: options?.repoSearchEnabled,
    nativeReads: options?.nativeReads,
    groundingProvenance: options?.groundingProvenance,
  });
  const provider = kickoff.skillProvider ?? 'ado';
  const resolvedBranch = kickoff.skillBranch ?? kickoff.branch ?? 'main';
  let skillContent: string | null = null;
  let skillSource: 'ado' | 'github' | 'local' | null = null;
  let contextContent: string | null = null;
  let agentsContent: string | null = null;

  // Fetch independent bootstrap documents concurrently. Native turns use the
  // same authorized pinned reader exposed through custom tools; fallback turns
  // retain the configured provider catalog behavior.
  if (kickoff.skillPath || options?.preloadRepositoryContext) {
    try {
      const requests: Array<{
        key: 'skill' | 'context' | 'agents';
        path: string;
      }> = [];
      if (kickoff.skillPath)
        requests.push({ key: 'skill', path: kickoff.skillPath });
      if (options?.preloadRepositoryContext) {
        requests.push(
          { key: 'context', path: 'context.md' },
          { key: 'agents', path: 'AGENTS.md' }
        );
      }

      const results = await Promise.allSettled(
        requests.map(async (request) => {
          if (options?.repoReader) {
            return options.repoReader.readFile(request.path);
          }
          const { getSkillFile } = await import('./skillCatalogFacade');
          return getSkillFile(
            kickoff.project,
            kickoff.repo,
            request.path,
            resolvedBranch,
            provider
          );
        })
      );
      results.forEach((result, index) => {
        const request = requests[index];
        if (result.status === 'rejected') {
          console.warn(
            `[chat] Failed to pre-fetch ${request.path} from ${provider}:`,
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          );
          return;
        }
        if (request.key === 'skill') {
          skillContent = result.value;
          skillSource = options?.repoReader ? 'local' : provider;
        } else if (request.key === 'context') {
          contextContent = result.value;
        } else {
          agentsContent = result.value;
        }
      });
    } catch (err) {
      console.error(
        '[chat] Failed to initialize repository context pre-fetch:',
        (err as Error).message
      );
    }
  }

  if (kickoff.skillPath) {
    const skillPathNorm = kickoff.skillPath.replace(/^\//, '');
    if (!skillContent && !options?.repoReader) {
      const localPath = path.join(process.cwd(), skillPathNorm);
      if (fs.existsSync(localPath)) {
        try {
          skillContent = fs.readFileSync(localPath, 'utf8');
          skillSource = 'local';
          console.log('[chat] Using local skill fallback:', skillPathNorm);
        } catch (err) {
          console.error(
            '[chat] Failed to read local skill fallback:',
            (err as Error).message
          );
        }
      }
    }

    if (skillContent) {
      initialPrompt +=
        `\n\n# Pre-loaded skill content (${skillPathNorm}; source: ${skillSource})` +
        `\n\n${skillContent}`;
      initialPrompt +=
        '\n\nThe skill content above is already loaded. Do not call `get_skill` or `get_skill_file` for this path — execute it now.';
    } else {
      initialPrompt += `\n\n# Skill pre-fetch failed\nCould not load ${kickoff.skillPath} from ${provider} or the local checkout. Inform the user that the skill file is missing.`;
    }
  }

  if (options?.preloadRepositoryContext) {
    const contextPack = buildRepositoryContextPack({
      project: kickoff.project,
      repo: kickoff.repo,
      branch: resolvedBranch,
      provider,
      contextContent,
      agentsContent,
    });
    if (contextPack) {
      initialPrompt += `\n\n${contextPack}`;
    } else {
      initialPrompt += [
        '',
        '',
        '# Repository context pre-fetch unavailable',
        'Apex could not preload context.md or AGENTS.md. Read them by exact path with get_skill_file.',
        'Do not use broad repository search as a substitute.',
      ].join('\n');
    }
  }

  if (maxviewEnabled) {
    initialPrompt += `\n\n${buildMaxviewPromptHint()}`;
  }
  if (recoveryContext) {
    initialPrompt += `\n\n${recoveryContext.content}`;
  }

  return `${initialPrompt}\n\n---\n\n${promptText}`;
}

export interface PreparedBackgroundWorkflowTurn {
  prompt: string;
  model: string;
  skillPath: string;
  projectId: string;
  threadWorkspacePath: string;
  repository: RepositoryPreparationTarget;
}

export function buildBackgroundWorkflowPrompt(
  kickoff: ChatThreadKickoff,
  promptText: string
): Promise<string> {
  return buildNewAgentTurnPrompt(kickoff, promptText, false, undefined, {
    repoSearchEnabled: false,
    nativeReads: true,
  });
}

/**
 * Freezes the same first-turn system and skill context used by sendMessage,
 * while directing a background worker to its pinned local checkout only.
 * Skill content is still preloaded on the authorized web tier.
 */
export async function prepareBackgroundWorkflowTurn(
  threadId: string,
  promptText: string
): Promise<PreparedBackgroundWorkflowTurn> {
  const state = await ensureThreadState(threadId);
  if (!state) {
    throw new Error('Generation thread is unavailable');
  }

  const kickoff = state.thread.kickoff;
  return {
    prompt: await buildBackgroundWorkflowPrompt(kickoff, promptText),
    model: resolveModelId(kickoff.model),
    skillPath: kickoff.skillPath ?? '',
    projectId: kickoff.project,
    threadWorkspacePath: state.thread.workspaceDir,
    repository: {
      provider: kickoff.skillProvider ?? 'ado',
      project: kickoff.project,
      repo: kickoff.repo,
      branch: kickoff.skillBranch ?? kickoff.branch ?? 'main',
    },
  };
}

export function buildDevelopmentPrompt(kickoff: ChatThreadKickoff): string {
  const branch = kickoff.skillBranch ?? kickoff.branch ?? 'main';
  const isGitHub = kickoff.skillProvider === 'github';
  const hasApexPath = !!(kickoff as ChatThreadKickoff & { prdId?: string })
    .prdId; // Apex PRD-sourced session
  const parts: string[] = [
    `# Development workspace`,
    `You are running in a REAL repository checkout. The current working directory IS a git clone of the project repo. The feature branch has already been created and checked out — you are on it now.`,
    ``,
    `# Session context`,
    `  project: "${kickoff.project}"`,
    `  repo:    "${kickoff.repo}"`,
    `  branch:  "${branch}"`,
    `  provider: "${kickoff.skillProvider ?? 'ado'}"`,
    `  work item: ${kickoff.workItemId ?? '(none)'}`,
    ``,
    `# Dependency readiness`,
  ];
  if (kickoff.dependenciesPrepared) {
    parts.push(
      `Package-manager-aware development dependencies were prepared from each supported repository lockfile and attached to the corresponding install folder before the agent started.`,
      `Do not run npm install, npm ci, pnpm install, or yarn install unless package.json, package-lock.json, or the project's equivalent manifest/lockfile changes during this session.`,
      ``
    );
  } else {
    parts.push(
      `Server-side dependency bootstrap was skipped for this session.`,
      `Inspect the repository's manifests and lockfiles, then install dependencies with the project's package manager if the project workflow requires them.`,
      ``
    );
  }

  if (isGitHub) {
    parts.push(
      `# Repo access`,
      `Skills from this project's GitHub repo are pre-loaded into the conversation by the system when applicable.`,
      ``
    );
  } else {
    parts.push(
      `# Available MCP tools (via \`ado-skills\` server)`,
      `- \`get_skill\`        — load a SKILL.md from the repo`,
      `- \`list_repo_dir\`    — browse repo directory structure`,
      `- \`get_skill_file\`   — read any file from the repo`,
      `- \`search_repo_code\` — search code in the repo`,
      `- \`query_work_items\` — query ADO work items`,
      ``
    );
  }

  parts.push(...buildScopePolicyLines(kickoff), ``);

  if (hasApexPath) {
    // Apex PRD-sourced path: full design context injected by injectDevContextFiles
    parts.push(
      `# Pre-loaded design context`,
      `The following design artifacts have been injected into \`.ai-pilot/output/\` in this workspace:`,
      `- **PRD markdown** — \`{slug}.prd.md\``,
      `- **Backlog JSON** — \`{slug}.backlog.json\` (epics, features, PBIs, TBIs, dependsOn, parallelGroup)`,
      `- **Test cases** — \`{slug}.test-cases.json\` (verification targets per PBI)`,
      `- **Design spec** — \`{slug}-design-spec/{feature-slug}-design.md\``,
      `- **Tech spec** — \`{slug}-design-spec/{feature-slug}-tech-spec.md\``,
      `- **Assumptions** — \`{slug}-design-spec/{feature-slug}-assumptions.md\``,
      ``,
      `Read these files first — they define WHAT to build, architectural decisions, API contracts,`,
      `data models, component structures, and test expectations. The tech spec is your primary`,
      `implementation guide. Respect the dependency graph in the backlog (item \`dependsOn\` and`,
      `\`parallelGroup\` fields) to determine execution order.`,
      ``
    );
  } else {
    // ADO path: design-doc attachments injected by injectAdoAttachments at session setup
    parts.push(
      `# Design context`,
      `The following design artifacts have been injected into \`.ai-pilot/output/\` in this workspace:`,
      `- **Design spec** — \`{slug}-design-spec/design.md\``,
      `- **Tech spec** — \`{slug}-design-spec/tech-spec.md\``,
      `- **Assumptions** — \`{slug}-design-spec/assumptions.md\``,
      `- **Prototype** — \`{slug}-design-spec/prototype.html\` (if present)`,
      `- **PRD placeholder** — \`{slug}.prd.md\``,
      `Read these first — they define the feature's scope, architecture, API contracts, and test targets.`,
      ``
    );
  }

  if (kickoff.skillPath) {
    // Skill configured: hand off governance entirely to the project dev skill.
    parts.push(
      `# APEX → Project → APEX governance`,
      `APEX has already handled all git setup:`,
      `- Cloned the repo at \`${branch}\``,
      `- Created and checked out the feature branch (this is where you are now)`,
      `- Injected the design artifacts above`,
      ``,
      `Your role is to follow the project development skill exactly. Load it now, then follow ALL of its phases —`,
      `including scope confirmation (Phase 0.5), plan (Phase 1 — STOP for human approval), implement (Phase 2),`,
      `and code review (Step 5).`,
      ``,
      `CRITICAL: Do NOT write any source code until the human explicitly approves the Phase 1 plan.`,
      ``,
      `CRITICAL — APEX SDK file-write constraint: You are running inside the APEX Cursor SDK agent runtime.`,
      `ALL file edits MUST be made directly by you in the current working directory.`,
      `Do NOT use the Task tool to dispatch sub-agents for file writes — sub-agent file changes run in`,
      `isolated SDK processes that are NOT written to the session workspace, so they will be invisible to`,
      `APEX's diff, push, and PR flow. You may still use the execution lanes from the plan to structure`,
      `the implementation order, but work through each lane yourself, directly, one file at a time.`,
      `You MAY use Task sub-agents for read-only work (research, code review) — just not for writing files.`,
      ``,
      `APEX owns all git operations after you finish: committing, pushing, opening PRs, ADO state transitions.`,
      `You must NOT run git commit, git push, git branch, or open pull requests.`,
      ``,
      `# Development skill`,
      `Load it now:`
    );
    if (isGitHub) {
      parts.push(`The skill content will be pre-loaded below by the system.`);
    } else {
      parts.push(
        `  Call \`get_skill\` with path: "${kickoff.skillPath}", project: "${kickoff.project}", repo: "${kickoff.repo}", branch: "${branch}"`
      );
    }
    parts.push(
      `Follow the skill's instructions exactly, starting from Phase 0.`
    );
  } else {
    // No skill configured: minimal direct-implement fallback.
    parts.push(
      `# Your task`,
      `No development skill is configured for this project. Implement the feature using the design artifacts above.`,
      `Read the design spec and tech spec in \`.ai-pilot/output/\` first, then implement the required changes.`,
      ``,
      `# Important constraints`,
      `- This IS a real repo checkout — you can read any project file directly from disk.`,
      `- Do NOT run \`git push\`, \`git commit\`, create branches, or open pull requests — APEX owns those steps.`,
      `- Write clean, production-quality code. Follow existing project conventions in the codebase.`
    );
  }

  return parts.join('\n');
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────

function broadcast(
  state: ThreadState,
  event: SseEvent,
  envelope?: AgentRunEventEnvelope
) {
  for (const cb of state.subscribers) {
    try {
      cb(event, envelope);
    } catch {
      /* subscriber gone */
    }
  }
}

function makeCancelledError(reason: string): Error & { _cancelled: true } {
  return Object.assign(new Error(reason), { _cancelled: true as const });
}

function makeOwnerDeadlineError(
  reason: string
): Error & { _ownerDeadline: true } {
  return Object.assign(new Error(reason), { _ownerDeadline: true as const });
}

function makeStartupDeadlineError(
  reason: string
): Error & { _startupDeadline: true } {
  return Object.assign(new Error(reason), { _startupDeadline: true as const });
}

const AGENT_DISPOSAL_TIMEOUT_MS = 10_000;

export function sanitizeTerminalDetail(detail: string): string {
  return sanitizeCursorTerminalDetail(detail);
}

export async function disposeAgentWithinDeadline(
  agent: { [Symbol.asyncDispose](): Promise<void> },
  timeoutMs = AGENT_DISPOSAL_TIMEOUT_MS
): Promise<boolean> {
  try {
    await raceWithTimeout('Cursor SDK agent disposal', timeoutMs, () =>
      agent[Symbol.asyncDispose]()
    );
    return true;
  } catch (error) {
    if (error instanceof McpTimeoutError) {
      console.warn(
        `[chat] Cursor SDK disposal exceeded ${timeoutMs}ms; continuing process`
      );
    } else {
      console.warn('[chat] Cursor SDK disposal failed; continuing process');
    }
    return false;
  }
}

/**
 * Dispose the in-memory Cursor SDK agent so the next send cannot hit
 * "already has active run". Optionally drop cursorAgentId to force Agent.create.
 */
async function forceDisposeThreadAgent(
  state: ThreadState,
  options?: { clearCursorAgentId?: boolean; reason?: string }
): Promise<void> {
  if (state.agent) {
    const agent = state.agent;
    state.agent = null;
    console.log(
      `[chat] Force-disposing agent (threadId=${state.thread.id}` +
        `, reason=${options?.reason ?? 'unspecified'})`
    );
    await disposeAgentWithinDeadline(agent);
  }
  if (options?.clearCursorAgentId) {
    state.thread.cursorAgentId = undefined;
  }
}

async function cancelSdkRunBestEffort(
  state: ThreadState,
  runId: string
): Promise<void> {
  if (!state.agent) return;
  try {
    type AgentRunHandle = {
      supports: (capability: string) => boolean;
      cancel: () => Promise<void>;
    };
    type AgentWithGetRun = typeof Agent & {
      getRun: (
        id: string,
        opts: { runtime: 'local'; cwd: string }
      ) => Promise<AgentRunHandle>;
    };
    const run = await (Agent as AgentWithGetRun).getRun(runId, {
      runtime: 'local',
      cwd: runtimeWorkspaceDir(state),
    });
    if (run.supports('cancel')) await run.cancel();
  } catch {
    // Best-effort — dispose below is the hard guarantee.
  }
}

export function createRunEventEnvelope(input: {
  eventId?: string;
  threadId: string;
  runId: string;
  sequence: number;
  timestamp?: string;
  event: SseEvent;
  phase?: AgentRunPhase;
}): AgentRunEventEnvelope {
  return createCursorRunEventEnvelope({
    ...input,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
  });
}

function shouldPersistRunEvent(event: SseEvent): boolean {
  return (
    event.type === 'phase' ||
    event.type === 'health' ||
    event.type === 'tool_call' ||
    event.type === 'tool_status' ||
    event.type === 'status' ||
    event.type === 'retrying' ||
    event.type === 'error' ||
    event.type === 'done'
  );
}

function isMeaningfulProgressEvent(event: SseEvent): boolean {
  return (
    event.type === 'token' ||
    event.type === 'message' ||
    event.type === 'phase' ||
    event.type === 'thinking' ||
    event.type === 'tool_call' ||
    event.type === 'tool_status'
  );
}

export function shouldPersistAgentRunProgress(
  eventDrivenTerminationEnabled: boolean
): boolean {
  return !eventDrivenTerminationEnabled;
}

export function buildAgentRunClaimUpdate(
  eventDrivenTerminationEnabled: boolean,
  ownerInstance: string,
  timestamp: string
): {
  status: 'running';
  ownerInstance: string;
  updatedAt: string;
  eventDriven: boolean;
  heartbeatAt?: string;
  progressAt?: string;
  progressLabel?: string;
  progressPhase?: AgentRunPhase;
} {
  const common = {
    status: 'running' as const,
    ownerInstance,
    updatedAt: timestamp,
    // Stamp the run so the reaper classifies it from the row rather than a
    // live flag lookup. Event-driven runs are terminated only via owner-side
    // deadlines / timeout_at — never the legacy heartbeat worker_lost rule.
    eventDriven: eventDrivenTerminationEnabled,
  };
  // @feature-flag:event-driven-run-termination start winner=enabled
  if (eventDrivenTerminationEnabled) {
    // @feature-flag:event-driven-run-termination enabled-start
    return common;
    // @feature-flag:event-driven-run-termination enabled-end
  }
  // @feature-flag:event-driven-run-termination disabled-start
  return {
    ...common,
    heartbeatAt: timestamp,
    progressAt: timestamp,
    progressLabel: 'Agent run started',
    progressPhase: 'implementation',
  };
  // @feature-flag:event-driven-run-termination disabled-end
  // @feature-flag:event-driven-run-termination end
}

async function persistMeaningfulProgress(
  runId: string,
  envelope: AgentRunEventEnvelope
): Promise<void> {
  if (!shouldPersistAgentRunProgress(eventDrivenRunIds.has(runId))) return;
  if (
    envelope.event.type === 'cancel' ||
    !isMeaningfulProgressEvent(envelope.event)
  )
    return;
  // Tokens and extended thinking can fire continuously; throttle DB writes.
  if (envelope.event.type === 'token' || envelope.event.type === 'thinking') {
    const nowMs = Date.parse(envelope.timestamp);
    const previous = lastTokenProgressWriteAt.get(runId) ?? 0;
    if (nowMs - previous < 5_000) return;
    lastTokenProgressWriteAt.set(runId, nowMs);
  }
  await db
    .update(agentRuns)
    .set({
      progressAt: envelope.timestamp,
      progressLabel:
        envelope.detail ??
        (envelope.event.type === 'token'
          ? 'Generating response'
          : envelope.phase),
      progressPhase: envelope.phase,
      updatedAt: envelope.timestamp,
    })
    .where(eq(agentRuns.id, runId))
    .execute()
    .catch(() => {});
}

/**
 * FEAT-007 bridge — mirror an in-process run-event envelope onto the interactive
 * live bus (Redis) so a WebSocket gateway on ANY App Service instance relays
 * turns that execute in-process (not just turns dispatched to the ACA actor).
 *
 * Why this is needed: the gateway's live fan-out subscribes to the in-memory
 * owner stream (same-instance only) and the Redis live bus (actor tier only).
 * In-process turns already fan out over in-memory + Postgres `pg_notify`
 * (which the SSE route consumes cross-instance) but never over Redis, so a WS
 * client whose socket lands on a different instance than the turn never sees
 * live tokens. Publishing the same envelope here closes that gap.
 *
 * Safe by construction: `interactiveLiveBus.publish` is a no-op when Redis is
 * unconfigured (dev/local), so in-process behavior is byte-for-byte unchanged
 * there. The gateway de-dupes by `eventId` across its in-memory, Redis, and
 * replay sources, so a same-instance socket never receives a duplicate. Fan-out
 * is best effort; durability continues to ride Postgres notify + replay.
 */
function publishInteractiveLive(
  threadId: string,
  envelope: AgentRunEventEnvelope
): void {
  void interactiveLiveBus.publish(threadId, envelope).catch(() => {
    // Ephemeral fan-out is best effort; durability rides Postgres notify + replay.
  });
}

async function publishRunEvent(
  state: ThreadState,
  runId: string,
  event: SseEvent,
  metadata?: { phase?: AgentRunPhase }
): Promise<AgentRunEventEnvelope> {
  const envelope = createRunEventEnvelope({
    threadId: state.thread.id,
    runId,
    sequence: nextRunEventSequence(runId),
    event,
    phase: metadata?.phase,
  });
  await publishRunEventEnvelope(state, envelope);
  return envelope;
}

async function publishRunEventEnvelope(
  state: ThreadState,
  envelope: AgentRunEventEnvelope
): Promise<void> {
  if (envelope.event.type === 'cancel') return;
  const event = envelope.event;
  const runId = envelope.runId;
  const persist = shouldPersistRunEvent(event);
  if (!persist) {
    broadcast(state, event, envelope);
    publishInteractiveLive(state.thread.id, envelope);
    void notifyRunEvent(envelope, { persist: false }).catch((err) => {
      console.error(
        `[chat] Failed to fan out run event ${envelope.eventId}:`,
        (err as Error).message
      );
    });
    void persistMeaningfulProgress(runId, envelope);
    return;
  }
  try {
    await notifyRunEvent(envelope, { persist });
  } catch (err) {
    console.error(
      `[chat] Failed to fan out run event ${envelope.eventId}:`,
      (err as Error).message
    );
  }
  await persistMeaningfulProgress(runId, envelope);
  broadcast(state, event, envelope);
  publishInteractiveLive(state.thread.id, envelope);
}

async function finalizeOwnerTerminal(
  state: ThreadState,
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  detail: string,
  events: SseEvent[]
): Promise<boolean> {
  const finalizedEvents = events.map((event) => ({
    event,
    envelope: createRunEventEnvelope({
      threadId: state.thread.id,
      runId,
      sequence: nextRunEventSequence(runId),
      event,
      phase: 'completion',
    }),
  }));
  const won = await finalizeOwnedAgentRun({
    runId,
    threadId: state.thread.id,
    ownerInstance: RUN_EVENT_SOURCE_INSTANCE,
    status,
    detail,
    events: finalizedEvents.map(({ envelope }) => envelope),
  });
  if (won) {
    for (const { event, envelope } of finalizedEvents) {
      broadcast(state, event, envelope);
      publishInteractiveLive(state.thread.id, envelope);
    }
  }
  return won;
}

async function publishRunCancellation(
  threadId: string,
  runId: string
): Promise<void> {
  const envelope: AgentRunEventEnvelope = {
    eventId: uuidv4(),
    threadId,
    runId,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(runId),
    timestamp: new Date().toISOString(),
    type: 'cancel',
    phase: 'completion',
    status: 'cancelled',
    detail: 'Run cancelled',
    event: { type: 'cancel' },
  };
  await notifyRunEvent(envelope, { persist: true });
  publishInteractiveLive(threadId, envelope);
}

// ── Idle cleanup ──────────────────────────────────────────────────────────────

function resetIdleTimer(state: ThreadState) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  // Don't start the idle timer while a run is active — the timer will be reset
  // in the run's finally block. Starting it now could fire closeThread mid-run.
  if (state.thread.status === 'running') return;
  const timeout = state.isInterviewThread
    ? INTERVIEW_IDLE_TIMEOUT_MS
    : state.isDevSession
      ? INTERVIEW_IDLE_TIMEOUT_MS // dev sessions get 2-hour window
      : IDLE_TIMEOUT_MS;
  state.idleTimer = setTimeout(() => closeThread(state.thread.id), timeout);
}

async function checkIsInterviewThread(threadId: string): Promise<boolean> {
  const interviewRow = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
    columns: { id: true },
  });
  if (interviewRow) return true;
  const adrRow = await db.query.adrs.findFirst({
    where: eq(adrs.chatThreadId, threadId),
    columns: { id: true },
  });
  return adrRow !== undefined;
}

/**
 * Returns a label (e.g. "prd", "design_doc") if this thread is referenced by
 * a PRD or design doc row, or null if it's a standalone chat thread.
 *
 * Used by closeThread to avoid deleting the chat_threads row when an
 * ON DELETE CASCADE FK would silently destroy the parent document.
 */
async function _threadBacksDocument(threadId: string): Promise<string | null> {
  const adrRow = await db.query.adrs.findFirst({
    where: eq(adrs.chatThreadId, threadId),
    columns: { id: true },
  });
  if (adrRow) return 'adr';

  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
    columns: { id: true },
  });
  if (prdRow) return 'prd';

  const ddRow = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.docAssistantThreadId, threadId),
      eq(designDocs.validationThreadId, threadId)
    ),
    columns: { id: true },
  });
  if (ddRow) return 'design_doc';

  return null;
}

/**
 * Return live ThreadState from memory, or hydrate from Postgres (e.g. after server restart).
 */
async function ensureThreadState(
  threadId: string
): Promise<ThreadState | null> {
  const existing = threads.get(threadId);
  if (existing) return existing;

  const thread = await loadThread(threadId);
  if (!thread) return null;

  // A thread persisted as 'running' means the server was killed mid-run.
  // Reset it to 'idle' so the client input isn't permanently locked out —
  // but only when no live agent_runs row remains (another instance may own it).
  if (thread.status === 'running') {
    const alive = await isThreadRunAlive(threadId);
    if (!alive) {
      thread.status = 'idle';
      thread.activeRunId = undefined;
      await clearStaleRun(threadId);
    }
  }

  // Recreate the sandbox workspace if it was wiped (e.g. OS temp cleanup on
  // reboot, or the stale-workspace cleanup pass). Without this, Agent.resume /
  // Agent.create would fail because its cwd no longer exists, and a resumed
  // interview would silently produce no agent output.
  if (thread.workspaceDir && !fs.existsSync(thread.workspaceDir)) {
    try {
      fs.mkdirSync(thread.workspaceDir, { recursive: true });
      injectKickoffFiles(thread.workspaceDir, thread.kickoff, thread.id);
    } catch (err) {
      console.error(
        '[chat] failed to recreate workspace for thread',
        threadId,
        ':',
        (err as Error).message
      );
    }
  }

  const isInterview = await checkIsInterviewThread(threadId);

  const state: ThreadState = {
    thread,
    subscribers: new Set(),
    agent: null,
    idleTimer: null,
    isInterviewThread: isInterview,
    isDevSession: thread.kickoff?.mode === 'development',
    grounding: null,
    groundingInFlight: null,
    resolvedGroundingBinding: null,
    bindingContinuity: null,
    groundingWorkspaceDir: null,
  };
  threads.set(threadId, state);
  resetIdleTimer(state);
  return state;
}

/**
 * Load a thread into memory (from Postgres) so that resolveOutputDir and
 * readOutput* helpers can locate its workspace.  Used by startup recovery
 * to re-hydrate threads whose watchers were lost during a restart.
 */
export async function hydrateThread(threadId: string): Promise<boolean> {
  const state = await ensureThreadState(threadId);
  return state !== null;
}

/**
 * Returns true if the thread exists in memory and its agent is NOT running.
 * Used by startup recovery to decide whether to re-kick a dead agent.
 */
export function isThreadIdle(threadId: string): boolean {
  const state = threads.get(threadId);
  if (!state) return false;
  return state.thread.status !== 'running';
}

/** True when this process still has the thread in the in-memory map. */
export function isThreadLoaded(threadId: string): boolean {
  return threads.has(threadId);
}

// ── Health stats ──────────────────────────────────────────────────────────────

export interface AgentHealthStats {
  status: 'ok';
  threads: {
    total: number;
    byStatus: Record<string, number>;
    withActiveAgent: number;
  };
  uptime: number;
}

export function getAgentHealthStats(): AgentHealthStats {
  let withActiveAgent = 0;
  const byStatus: Record<string, number> = {};

  for (const state of threads.values()) {
    const s = state.thread.status;
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (state.agent !== null) withActiveAgent++;
  }

  return {
    status: 'ok',
    threads: {
      total: threads.size,
      byStatus,
      withActiveAgent,
    },
    uptime: Math.floor(process.uptime()),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createThread(
  userId: string,
  kickoff: ChatThreadKickoff,
  options?: {
    skipAutoKickoff?: boolean;
    kickoffMessage?: string;
    workspaceDirOverride?: string;
    dependenciesPrepared?: boolean;
  }
): Promise<ChatThread> {
  ensureDirs();

  const threadId = uuidv4();
  const workspaceDir =
    options?.workspaceDirOverride ?? path.join(WORKSPACE_BASE, threadId);

  // Opt interview threads into live web research (web MCP + scope carve-out) when the project enables it.
  const enrichedKickoff = await enrichKickoffForInterviewWebResearch(kickoff);

  // Resolve branch
  const branch = enrichedKickoff.branch ?? 'main';
  const resolvedKickoff = {
    ...enrichedKickoff,
    branch,
    dependenciesPrepared:
      options?.dependenciesPrepared ?? enrichedKickoff.dependenciesPrepared,
  };

  if (!options?.workspaceDirOverride) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    injectKickoffFiles(workspaceDir, resolvedKickoff, threadId);
  }

  const thread: ChatThread = {
    id: threadId,
    userId,
    kickoff: resolvedKickoff,
    messages: [],
    status: 'idle',
    workspaceDir,
    flagged: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  const state: ThreadState = {
    thread,
    subscribers: new Set(),
    agent: null,
    idleTimer: null,
    isInterviewThread: false,
    isDevSession: thread.kickoff?.mode === 'development',
    grounding: null,
    groundingInFlight: null,
    resolvedGroundingBinding: null,
    bindingContinuity: null,
    groundingWorkspaceDir: null,
  };

  threads.set(threadId, state);
  await pgUpsertThread(thread);
  resetIdleTimer(state);

  // Auto-kickoff: start the skill when the client will not send a first message right away
  // (e.g. skill slug only, or modal/panel open). If skipAutoKickoff is set, the client POSTs
  // the real first message next so the transcript shows the user request before the agent.
  if (!options?.skipAutoKickoff) {
    const msg = options?.kickoffMessage ?? 'Begin.';
    setImmediate(() => {
      console.log('[chat] auto-kickoff firing', {
        threadId,
        skillPath: kickoff.skillPath,
      });
      sendMessage(threadId, msg, undefined, [], { hidden: true })
        .then(() => {
          console.log('[chat] auto-kickoff completed', { threadId });
        })
        .catch((err: Error) => {
          console.error(
            '[chat] Auto-kickoff failed for thread',
            threadId,
            ':',
            err.message
          );
        });
    });
  }

  return thread;
}

/**
 * Replace the freeformContext stored in a thread's kickoff with an updated
 * version. Used by the PRD / design-doc assistant routes to swap out the
 * `__THREAD_ID__` placeholder that was passed to createThread (before the real
 * ID was known) with the actual thread UUID, so the system prompt contains the
 * correct thread_id when the agent first runs.
 */
export function updateThreadKickoffContext(
  threadId: string,
  freeformContext: string
): void {
  const state = threads.get(threadId);
  if (!state) return;
  state.thread.kickoff = { ...state.thread.kickoff, freeformContext };
  persistThread(state.thread);
}

/**
 * Mark an in-memory thread as interview-backed, extending its idle timeout.
 * Call this after linking a thread to an interviews row so the longer timeout
 * takes effect immediately (without waiting for a server-restart hydration).
 */
export function markAsInterviewThread(threadId: string): void {
  const state = threads.get(threadId);
  if (!state || state.isInterviewThread) return;
  state.isInterviewThread = true;
  resetIdleTimer(state);
}

export async function getThread(threadId: string): Promise<ChatThread | null> {
  return (await ensureThreadState(threadId))?.thread ?? null;
}

/** Alias kept for backward compatibility with callers that imported the explicitly async name. */
export const getThreadAsync = getThread;

export async function listThreadSummaries(
  userId: string,
  opts?: { limit?: number; offset?: number; project?: string }
): Promise<ChatThreadSummary[]> {
  return pgListThreadsByUser(userId, opts);
}

export async function searchThreadSummaries(
  userId: string,
  opts: {
    term: string;
    limit?: number;
    offset?: number;
    project?: string;
    flaggedOnly?: boolean;
  }
): Promise<ChatThreadSearchResult[]> {
  return pgSearchThreads(userId, opts);
}

export function listThreads(userId: string): ChatThread[] {
  return Array.from(threads.values())
    .map((s) => s.thread)
    .filter((t) => t.userId === userId)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

export function subscribeToThread(
  threadId: string,
  callback: (event: SseEvent, envelope?: AgentRunEventEnvelope) => void
): () => void {
  // Only check the in-memory map (sync). The thread is guaranteed to be
  // loaded by requireThreadOwner middleware before this is called.
  const state = threads.get(threadId);
  if (!state) return () => {};
  state.subscribers.add(callback);
  return () => state.subscribers.delete(callback);
}

const DEFAULT_MODEL = 'composer-2';

function resolveModelId(model?: string): string {
  return model?.trim() || DEFAULT_MODEL;
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Classify a run-level error string as fatal (no point resuming the agent)
 * vs recoverable (transient — keep cursorAgentId for Agent.resume next send).
 */
export function isFatalRunError(resultText: string): boolean {
  const lower = resultText.toLowerCase();
  return /\b(auth(entication|orization)?|unauthorized|forbidden|invalid.{0,20}(key|token|credential|config|agent)|agent.{0,10}not.found)\b/.test(
    lower
  );
}

function getErrorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as { statusCode?: unknown; status?: unknown };
  if (typeof record.statusCode === 'number') return record.statusCode;
  if (typeof record.status === 'number') return record.status;
  return undefined;
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function getErrorCause(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  return (err as { cause?: unknown }).cause;
}

function getErrorRetryable(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  return (err as { isRetryable?: unknown }).isRetryable;
}

function getRunId(run: unknown): string | undefined {
  if (!run || typeof run !== 'object') return undefined;
  const id = (run as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** Detect transient SDK / network errors worth retrying. */
export function isTransientSdkError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('already has active run'))
    return false;

  const statusCode = getErrorStatusCode(err);
  if (statusCode === 401 || statusCode === 403) return false;
  if (
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 429
  )
    return false;
  if (
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500 && statusCode < 600)
  )
    return true;

  if (err instanceof Error) {
    const code = getErrorCode(err);
    if (
      typeof code === 'string' &&
      /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNREFUSED)$/.test(
        code
      )
    ) {
      return true;
    }
  }

  return false;
}

/** Detect recoverable errors: stale run, agent disposed, concurrent run conflicts. */
export function isRecoverableSdkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return /already has active run|stale.*run|agent.*disposed|run.*expired|agent.*not.*available/.test(
    msg
  );
}

/**
 * Detect fatal SDK errors: auth failures, invalid config, agent not found.
 * Unlike `isFatalRunError` which checks run result text, this checks thrown exceptions.
 */
export function isFatalSdkError(err: unknown): boolean {
  const statusCode = getErrorStatusCode(err);
  if (statusCode === 401 || statusCode === 403) return true;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return /\b(auth(entication|orization)?|unauthorized|forbidden|invalid.{0,20}(key|token|credential|config|agent)|agent.{0,10}not.found)\b/.test(
      msg
    );
  }
  return false;
}

export type ErrorTier = 'transient' | 'recoverable' | 'fatal';

export function classifyError(err: unknown): ErrorTier {
  if (isFatalSdkError(err)) return 'fatal';
  if (isRecoverableSdkError(err)) return 'recoverable';
  if (isTransientSdkError(err)) return 'transient';
  // After retries are exhausted, unclassified CursorAgentErrors default to fatal;
  // unknown errors default to transient (user can retry).
  if (err instanceof CursorAgentError) return 'fatal';
  return 'transient';
}

export function isRateLimitError(err: unknown): boolean {
  const statusCode = getErrorStatusCode(err);
  if (statusCode === 429) return true;
  if (err instanceof Error) {
    return /rate.?limit|too many requests/i.test(err.message);
  }
  return false;
}

export function mapErrorCode(tier: ErrorTier, err: unknown): SseErrorCode {
  if (isRateLimitError(err)) return 'rate_limit';
  switch (tier) {
    case 'transient':
      return 'transient';
    case 'recoverable':
      return 'transient';
    case 'fatal':
      return isFatalSdkError(err) && isAuthError(err) ? 'auth' : 'fatal';
  }
}

export function isAuthError(err: unknown): boolean {
  const statusCode = getErrorStatusCode(err);
  if (statusCode === 401 || statusCode === 403) return true;
  if (err instanceof Error) {
    return /\b(auth(entication|orization)?|unauthorized|forbidden)\b/i.test(
      err.message
    );
  }
  return false;
}

function logAgentError(threadId: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`[chat] Agent failed for thread ${threadId}:`, {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: getErrorCause(err),
      retryable: getErrorRetryable(err),
    });
    trackAgentError(threadId, err);
    return;
  }

  console.error(`[chat] Agent failed for thread ${threadId}:`, err);
  trackAgentError(threadId, err);
}

/**
 * After an agent run completes, sync workspace output files directly to Postgres
 * by looking up which entity (PRD or design doc) owns this thread.
 */
const outputWorkspaceContext = new AsyncLocalStorage<{
  threadId: string;
  workspaceDir: string;
}>();

export async function syncOutputToDb(
  threadId: string,
  workspaceDir: string,
  agentText?: string
): Promise<void> {
  return outputWorkspaceContext.run({ threadId, workspaceDir }, () =>
    syncOutputToDbFromWorkspace(threadId, workspaceDir, agentText)
  );
}

async function syncOutputToDbFromWorkspace(
  threadId: string,
  workspaceDir: string,
  agentText?: string
): Promise<void> {
  let fullySynced = false;

  // Check if this thread belongs to a test-case generation run
  const testCaseRow = await db.query.testCases.findFirst({
    where: eq(testCases.chatThreadId, threadId),
  });
  if (testCaseRow) {
    const synced = await syncTestCaseOutput(
      testCaseRow.id,
      testCaseRow.prdId,
      threadId,
      workspaceDir
    );
    if (!synced && testCaseRow.status === 'generating') {
      logWorkspaceContents(
        workspaceDir,
        `test-case no-output (testCaseId=${testCaseRow.id})`
      );
      if (agentText) {
        const preview =
          agentText.length > 5000 ? agentText.slice(0, 5000) + '…' : agentText;
        console.warn(
          `[chat] test-case agent response (${agentText.length} chars) preview (testCaseId=${testCaseRow.id}):\n${preview}`
        );
      }
      await markTestCaseFailed(testCaseRow.id, testCaseRow.prdId, threadId);
      console.warn(
        `[chat] post-run: test-case agent produced no output — marked failed (testCaseId=${testCaseRow.id})`
      );
    }
    return;
  }

  // Check if this thread belongs to a PRD
  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
  });
  if (prdRow) {
    const content = readOutputPrd(threadId);
    const backlog = readOutputBacklog(threadId);
    const { isPrdGenerationOutputComplete } = await import(
      '../../shared/utils/prdGenerationOutput'
    );
    const outputComplete = isPrdGenerationOutputComplete(content, backlog);
    if (outputComplete && content) {
      await syncPrdContent(prdRow.id, content, backlog ?? undefined);
      console.log(
        `[chat] post-run: synced PRD output to DB (prdId=${prdRow.id})`
      );
      notifyAiCompletion('prd_generated', prdRow.id, {
        title: prdRow.title,
      }).catch((err) =>
        console.error(
          `[chat] AI notification failed for prd_generated (prdId=${prdRow.id}):`,
          err
        )
      );
      fullySynced = true;
    } else if (prdRow.status === 'generating') {
      logWorkspaceContents(workspaceDir, `PRD incomplete-output (prdId=${prdRow.id})`);
      await db
        .update(prds)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prdRow.id), eq(prds.status, 'generating')));
      console.warn(
        `[chat] post-run: agent produced incomplete/stub PRD output — reset to draft (prdId=${prdRow.id})`
      );
    }
    if (fullySynced) {
      try {
        const testCaseStarted = await triggerTestCaseGeneration(
          prdRow.id,
          threadId
        );
        if (!testCaseStarted) {
          // If no test case skill, check if PRD validation can start
          try {
            const { arePrdValidationArtifactsReady, autoStartPrdValidation } =
              await import('./prdService');
            const ready = await arePrdValidationArtifactsReady(prdRow.id);
            if (ready) await autoStartPrdValidation(prdRow.id);
          } catch {
            /* non-fatal */
          }
          cleanupWorkspaceDir(workspaceDir);
        }
      } catch (err) {
        console.error(
          `[chat] post-run: auto test-case generation failed (prdId=${prdRow.id})`,
          err
        );
        cleanupWorkspaceDir(workspaceDir);
      }
    }
    return;
  }

  // Check if this thread belongs to a design doc (generation thread)
  const ddGenRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.chatThreadId, threadId),
    columns: {
      id: true,
      prdId: true,
      project: true,
      authorId: true,
      designPrototypeId: true,
      featureIndex: true,
    },
  });
  if (ddGenRow) {
    const { finalizeSingleFeatureDoc, isSingleFeatureDesignDocRow } =
      await import('./designDocService');
    // Single-feature docs finalize in place; legacy seeds fan out to child rows.
    if (isSingleFeatureDesignDocRow(ddGenRow)) {
      // Watcher may have already handled this; finalizeSingleFeatureDoc is idempotent.
      await finalizeSingleFeatureDoc(ddGenRow.id, threadId, ddGenRow.project);
      console.log(
        `[chat] post-run: finalised single-feature design doc (designDocId=${ddGenRow.id})`
      );
    } else {
      await syncPerFeatureDesignDocs(
        ddGenRow.id,
        ddGenRow.prdId,
        ddGenRow.project,
        ddGenRow.authorId,
        threadId
      );
      console.log(
        `[chat] post-run: synced per-feature design docs to DB (prdId=${ddGenRow.prdId})`
      );
    }
    return;
  }

  // Fallback: the watcher may have nulled chatThreadId prematurely while the
  // agent was still running. If the workspace has feature triplets, look for a
  // *legacy multi-feature seed* (no featureIndex / prototype) still in generating
  // with chatThreadId=NULL and sync the features. Do not match PRD/prototype
  // single-feature rows — those must finalize in place, not spawn children.
  const orphanFeatures = readAllOutputDesignDocFeatures(threadId);
  if (orphanFeatures.length > 0) {
    const seedRow = await db.query.designDocs.findFirst({
      where: and(
        eq(designDocs.status, 'generating'),
        isNull(designDocs.chatThreadId),
        isNull(designDocs.featureIndex),
        isNull(designDocs.designPrototypeId)
      ),
      columns: { id: true, prdId: true, project: true, authorId: true },
    });
    if (seedRow) {
      await syncPerFeatureDesignDocs(
        seedRow.id,
        seedRow.prdId,
        seedRow.project,
        seedRow.authorId,
        threadId
      );
      console.log(
        `[chat] post-run: synced ${orphanFeatures.length} orphan features to DB (seedDocId=${seedRow.id})`
      );
      return;
    }
  }

  // Check if this thread is a validation thread
  const ddValRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.validationThreadId, threadId),
  });
  if (ddValRow) {
    const scorecardRaw = readOutputValidationScorecard(threadId);
    if (scorecardRaw) {
      try {
        // Re-verify thread ownership — another validation may have started
        const freshDoc = await db.query.designDocs.findFirst({
          where: eq(designDocs.id, ddValRow.id),
          columns: { validationThreadId: true },
        });
        if (freshDoc?.validationThreadId !== threadId) {
          console.log(
            `[chat] post-run: discarded stale validation scorecard — thread ${threadId} no longer active (designDocId=${ddValRow.id})`
          );
          cleanupWorkspaceDir(workspaceDir);
          return;
        }
        const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
        const reportMd = readOutputValidationScorecardMd(threadId) ?? undefined;
        await syncValidationResult(ddValRow.id, scorecard, reportMd);
        console.log(
          `[chat] post-run: synced validation scorecard to DB (designDocId=${ddValRow.id})`
        );
        fullySynced = true;
      } catch (err) {
        console.error(
          `[chat] post-run: failed to parse validation scorecard`,
          err
        );
      }
    } else {
      // Agent completed but wrote no scorecard file.
      // Keep the generated content accessible by moving to pending_review (matching the
      // watcher's own idle-without-scorecard path). The approval gate will still require a
      // valid validation score if a skill is configured — this just unblocks the author
      // from seeing and reviewing the content rather than hiding it in a Draft state.
      const freshDoc = await db.query.designDocs.findFirst({
        where: eq(designDocs.id, ddValRow.id),
        columns: { validationThreadId: true, status: true },
      });
      if (
        freshDoc?.validationThreadId === threadId &&
        freshDoc?.status === 'validating'
      ) {
        await db
          .update(designDocs)
          .set({
            status: 'pending_review',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(designDocs.id, ddValRow.id));
        console.warn(
          `[chat] post-run: validation agent wrote no scorecard — moved to pending_review (designDocId=${ddValRow.id})`
        );
      }
      fullySynced = true; // workspace can be cleaned
    }
    if (fullySynced) cleanupWorkspaceDir(workspaceDir);
    return;
  }

  // Check if this thread is a doc assistant thread (used by fix-validation and "Ask Apex")
  const ddAssistantRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.docAssistantThreadId, threadId),
  });
  if (ddAssistantRow) {
    // The fix-validation flow uses MCP tool calls to save content in real-time,
    // but as a fallback, check if output workspace files exist and sync them.
    const design = readOutputDesignDoc(threadId);
    const techSpec = readOutputTechSpec(threadId);
    const assumptions = readOutputAssumptions(threadId);
    if (design || techSpec || assumptions) {
      const syncOpts: Parameters<typeof syncDesignDocContent>[1] = {};
      if (design) syncOpts.designContent = design;
      if (techSpec) syncOpts.techSpecContent = techSpec;
      if (assumptions) syncOpts.assumptionsContent = assumptions;
      await syncDesignDocContent(ddAssistantRow.id, syncOpts);
      console.log(
        `[chat] post-run: synced doc-assistant output to DB (designDocId=${ddAssistantRow.id})`
      );
    }
    return;
  }

  // Check if this thread is a PRD validation thread
  const prdValRow = await db.query.prds.findFirst({
    where: eq(prds.validationThreadId, threadId),
  });
  if (prdValRow) {
    const scorecardRaw = readOutputValidationScorecard(threadId);
    if (scorecardRaw) {
      try {
        const freshPrd = await db.query.prds.findFirst({
          where: eq(prds.id, prdValRow.id),
          columns: { validationThreadId: true },
        });
        if (freshPrd?.validationThreadId !== threadId) {
          console.log(
            `[chat] post-run: discarded stale PRD validation scorecard — thread ${threadId} no longer active (prdId=${prdValRow.id})`
          );
          cleanupWorkspaceDir(workspaceDir);
          return;
        }
        const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
        const reportMd = readOutputValidationScorecardMd(threadId) ?? undefined;
        const { generateFallbackReport } =
          await import('./documentValidationService');
        const effectiveReportMd = reportMd ?? generateFallbackReport(scorecard);
        const newStatus = scorecard.is_ready ? 'pending_review' : 'draft';
        await db
          .update(prds)
          .set({
            validationScore: Math.round(scorecard.overall_score),
            validationScorecard: scorecard,
            validationPhase: scorecard.review_phase,
            validationReportMd: effectiveReportMd,
            status: newStatus,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(prds.id, prdValRow.id));
        console.log(
          `[chat] post-run: synced PRD validation scorecard to DB (prdId=${prdValRow.id})`
        );
        fullySynced = true;
      } catch (err) {
        console.error(
          `[chat] post-run: failed to parse PRD validation scorecard`,
          err
        );
      }
    } else {
      const freshPrd = await db.query.prds.findFirst({
        where: eq(prds.id, prdValRow.id),
        columns: { validationThreadId: true, status: true },
      });
      if (
        freshPrd?.validationThreadId === threadId &&
        freshPrd?.status === 'validating'
      ) {
        await db
          .update(prds)
          .set({ status: 'draft', updatedAt: new Date().toISOString() })
          .where(eq(prds.id, prdValRow.id));
        console.warn(
          `[chat] post-run: PRD validation agent wrote no scorecard, reset to draft (prdId=${prdValRow.id})`
        );
      }
      fullySynced = true;
    }
    if (fullySynced) cleanupWorkspaceDir(workspaceDir);
    return;
  }
}

function cleanupWorkspaceDir(workspaceDir: string): void {
  const resolved = path.resolve(workspaceDir);
  const isSharedRuntimeWorkspace = [...threads.values()].some(
    (state) =>
      state.groundingWorkspaceDir !== null &&
      path.resolve(state.groundingWorkspaceDir) === resolved
  );
  if (isSharedRuntimeWorkspace) return;
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    console.log(`[chat] post-run: cleaned up workspace ${workspaceDir}`);
  } catch {
    /* non-fatal */
  }
}

/**
 * Reset any PRD or design doc stuck in 'generating' status for this thread
 * back to 'draft'. Called when the agent run throws before syncOutputToDb
 * can run, so the document doesn't stay in a generating limbo forever.
 */
async function failGeneratingDocuments(threadId: string): Promise<void> {
  const [prdResult] = await db
    .update(prds)
    .set({ status: 'draft', updatedAt: new Date().toISOString() })
    .where(and(eq(prds.chatThreadId, threadId), eq(prds.status, 'generating')))
    .returning({ id: prds.id });

  if (prdResult) {
    console.warn(
      `[chat] failGeneratingDocuments: reset PRD to draft (prdId=${prdResult.id}, threadId=${threadId})`
    );
  }

  const [ddResult] = await db
    .update(designDocs)
    .set({
      status: 'generation_failed',
      generationError: 'Agent run failed before output was written',
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(designDocs.chatThreadId, threadId),
        eq(designDocs.status, 'generating')
      )
    )
    .returning({ id: designDocs.id });

  if (ddResult) {
    console.warn(
      `[chat] failGeneratingDocuments: marked design doc generation_failed (designDocId=${ddResult.id}, threadId=${threadId})`
    );
  }

  const [testCaseResult] = await db
    .update(testCases)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(testCases.chatThreadId, threadId),
        eq(testCases.status, 'generating')
      )
    )
    .returning({ id: testCases.id });

  if (testCaseResult) {
    console.warn(
      `[chat] failGeneratingDocuments: marked test cases failed (testCaseId=${testCaseResult.id}, threadId=${threadId})`
    );
  }
}

/**
 * After an agent run completes, check if the thread backs a dev session.
 * If so, commit any uncommitted changes and push the branch to remote
 * so the work survives ephemeral workspace loss (app restarts, scaling).
 * Also caches the diff in the DB for the changes panel.
 */
async function eagerPushDevSession(
  threadId: string,
  kickoff: ChatThreadKickoff
): Promise<void> {
  const session = await db.query.devSessions.findFirst({
    where: eq(devSessions.chatThreadId, threadId),
  });
  if (!session || !session.branchName) return;
  if (session.branchPushed) return;
  if (session.status !== 'in_progress') return;

  const { computeDiff, pushBranch, getWorkspaceDir } =
    await import('./repoCheckoutService');
  const { resolveGitRemote } = await import('./repoCacheService');
  const workspaceDir = getWorkspaceDir(session.id);

  if (!fs.existsSync(workspaceDir)) return;

  const { diffText, changedFiles } = await computeDiff(workspaceDir);

  // Always cache the diff (even when empty) so UI doesn't show stale data
  await db
    .update(devSessions)
    .set({
      cachedDiffText: diffText,
      cachedChangedFiles: changedFiles,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(devSessions.id, session.id));

  if (changedFiles.length === 0) return;

  // Push branch to remote
  try {
    const remote = resolveGitRemote(
      kickoff.skillProvider ?? 'ado',
      kickoff.project,
      kickoff.repo
    );
    await pushBranch(workspaceDir, session.branchName, remote);
    await db
      .update(devSessions)
      .set({ branchPushed: true, updatedAt: new Date().toISOString() })
      .where(eq(devSessions.id, session.id));
    console.log(
      `[chat] eager push succeeded for dev session ${session.id}, branch ${session.branchName}`
    );
  } catch (pushErr) {
    console.warn(
      `[chat] eager push to remote failed (non-fatal) for session ${session.id}:`,
      (pushErr as Error).message
    );
  }
}

export interface StaleRecoveryGroundingState {
  grounding: CallerGroundingSelection | null;
  groundingInFlight?: Promise<CallerGroundingSelection> | null;
  resolvedGroundingBinding: GroundingBinding | null;
  bindingContinuity: BindingContinuityDecision | null;
  groundingWorkspaceDir: string | null;
}

export async function releaseGroundingForStaleRecovery(
  state: StaleRecoveryGroundingState
): Promise<void> {
  const grounding = state.grounding;
  state.grounding = null;
  if ('groundingInFlight' in state) state.groundingInFlight = null;
  state.resolvedGroundingBinding = null;
  state.bindingContinuity = null;
  state.groundingWorkspaceDir = null;
  await grounding?.release().catch(() => undefined);
}

async function ensureThreadGrounding(
  state: ThreadState
): Promise<CallerGroundingSelection> {
  const repositoryReading = isRepositoryReadingChatCaller(
    state.thread.kickoff,
    state.isDevSession
  );
  if (
    state.grounding &&
    (state.grounding.mode === 'local' || !repositoryReading)
  ) {
    return state.grounding;
  }
  if (state.groundingInFlight) return state.groundingInFlight;

  // Development workspaces own their checkout lifecycle, and calendar
  // assistants expose only the restricted calendar MCP. Neither browses repos.
  if (!repositoryReading) {
    state.grounding = {
      mode: 'remote',
      release: async () => undefined,
    };
    return state.grounding;
  }

  const inFlight = (async (): Promise<CallerGroundingSelection> => {
    const grounding = await callerGroundingService.start({
      caller: resolveGroundingCallerKey(state.thread.kickoff),
      userId: state.thread.userId,
      run: {
        runType: 'chat',
        runId: state.thread.id,
        project: state.thread.kickoff.project,
      },
      repository: {
        provider: state.thread.kickoff.skillProvider ?? 'ado',
        repo: state.thread.kickoff.repo,
        branch:
          state.thread.kickoff.skillBranch ??
          state.thread.kickoff.branch ??
          'main',
      },
      reauthorize: async () => {
        const current = await getThread(state.thread.id);
        return (
          current?.userId === state.thread.userId && current.status !== 'closed'
        );
      },
      // Chat callers read the grounding checkout only — every write in this path
      // targets `thread.workspaceDir` — so they may share a read-only per-SHA
      // checkout (gated by `shared-readonly-grounding-checkout`).
      readOnlyShareable: true,
    });

    if (grounding.mode !== 'preparing') {
      const continuity = classifyGroundingContinuity(state.thread, grounding);
      // Repository-reading remote selections are intentionally re-evaluated on
      // each turn; only a ready local checkout is stable enough to cache.
      if (grounding.mode === 'local') state.grounding = grounding;
      state.resolvedGroundingBinding = continuity.resolvedBinding;
      state.bindingContinuity = continuity.decision;
    }
    return grounding;
  })();

  state.groundingInFlight = inFlight;
  try {
    return await inFlight;
  } finally {
    if (state.groundingInFlight === inFlight) {
      state.groundingInFlight = null;
    }
  }
}

async function waitForReadyThreadGrounding(
  state: ThreadState
): Promise<Exclude<CallerGroundingSelection, { mode: 'preparing' }>> {
  const deadline = Date.now() + GROUNDING_PREPARATION_TIMEOUT_MS;
  let announcedPreparing = false;

  while (true) {
    const grounding = await ensureThreadGrounding(state);
    if (grounding.mode !== 'preparing') {
      if (announcedPreparing) {
        broadcast(state, {
          type: 'grounding',
          status: 'ready',
          message: 'Project repository ready',
        });
      }
      return grounding;
    }

    announcedPreparing = true;
    broadcast(state, {
      type: 'grounding',
      status: 'preparing',
      message: 'Preparing project repository…',
      retryAfterMs: grounding.retryAfterMs,
    });
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        'Repository preparation timed out. Please retry this message.'
      );
    }
    const waitMs = Math.min(grounding.retryAfterMs, remainingMs);
    const readiness = grounding.waitUntilReady?.();
    const retryDelay = new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs);
    });
    await (readiness ? Promise.race([readiness, retryDelay]) : retryDelay);
  }
}

export async function reevaluateThreadGroundingForRecovery(
  threadId: string
): Promise<boolean> {
  const state = await ensureThreadState(threadId);
  if (!state) return false;
  await releaseGroundingForStaleRecovery(state);
  await ensureThreadGrounding(state);
  return true;
}

/**
 * FEAT-007 / TBI-012 — env-gated actor-host dispatch URL. The interactive live
 * chat path only offloads to the warm Dapr actor lane when this is set (cloud,
 * operator-enabled). Absent (all environments today) → the seam is inert and
 * the in-process path is byte-for-byte unchanged; no interactive run rows are
 * created, so nothing can be orphaned.
 */
const INTERACTIVE_DISPATCH_URL_ENV = 'AI_RUNS_INTERACTIVE_DISPATCH_URL';

/**
 * Skills that write/read `.ai-pilot` kickoff + output files in
 * `thread.workspaceDir` (injectKickoffFiles → poll status). The interactive
 * actor lane runs against the shared grounding checkout and never sees those
 * files, so these must stay on the in-process path.
 */
export function isInteractiveWorkspaceBoundSkill(
  skillPath: string | null | undefined
): boolean {
  const normalized = (skillPath ?? '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('walkthrough-') ||
    normalized.includes('k6-load-test') ||
    normalized.includes('/ui-lab/') ||
    normalized.includes('design-module-') ||
    normalized.includes('feature-request-analysis') ||
    normalized.includes('issue-analysis') ||
    normalized.includes('technical-analysis')
  );
}

function resolveInteractiveWorkflowClass(
  state: ThreadState
): InteractiveWorkflowClass {
  if (state.isInterviewThread) return 'interview';
  const skillPath = (state.thread.kickoff.skillPath ?? '').toLowerCase();
  if (skillPath.includes('adr')) return 'adr';
  if (state.isDevSession) return 'assistant';
  return 'home-chat';
}

async function postInteractiveActorDispatch(dispatch: {
  threadId: string;
  runId: string;
  dispatchMessageId: string;
}): Promise<void> {
  const base = process.env[INTERACTIVE_DISPATCH_URL_ENV]?.trim();
  if (!base)
    throw new Error('Interactive actor dispatch URL is not configured');
  const response = await fetch(`${base.replace(/\/+$/, '')}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dispatch),
  });
  const result = (await response.json().catch(() => null)) as {
    accepted?: unknown;
  } | null;
  if (!response.ok || result?.accepted !== true) {
    throw new Error(`Interactive actor dispatch failed (${response.status})`);
  }
}

/**
 * Fail-closed interactive routing seam (BR-017). Returns true only when the turn
 * was admitted and dispatched to the warm actor lane (the actor then streams
 * events back through the durable ingest + gateway). Any other outcome — no
 * dispatch URL, flag disabled/eval-error, over-capacity shed, lost race, or any
 * preparation/dispatch failure — returns false so the caller runs in-process.
 * On a non-actor decision the transient queued interactive row is discarded so
 * admission counts stay accurate and nothing is left dispatched without a runner.
 */
interface InteractiveDispatchAttempt {
  dispatched: boolean;
  persistedUserMessage?: ChatMessage;
  /** Why actor dispatch was skipped / failed (for telemetry + troubleshooting). */
  bypassReason?: string;
}

/** Bound interactive prep so a grounding hang cannot swallow the fire-and-forget turn. */
function resolveInteractiveDispatchAttemptTimeoutMs(): number {
  const raw = Number.parseInt(
    process.env.AI_RUNS_INTERACTIVE_DISPATCH_ATTEMPT_TIMEOUT_MS ?? '',
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

function trackInteractiveDispatch(
  name: string,
  props: Record<string, string>,
  measurements?: Record<string, number>
): void {
  try {
    trackEvent(name, props, measurements);
  } catch {
    // Telemetry must never affect the turn.
  }
}

async function tryDispatchInteractiveTurn(
  threadId: string,
  text: string,
  modelOverride?: string,
  attachments: ChatAttachment[] = [],
  options?: { hidden?: boolean }
): Promise<InteractiveDispatchAttempt> {
  // Inert unless the actor host dispatch URL is configured (cloud only).
  if (!process.env[INTERACTIVE_DISPATCH_URL_ENV]?.trim()) {
    trackInteractiveDispatch('interactive.dispatch.bypass', {
      threadId,
      reason: 'dispatch-url-unset',
    });
    return { dispatched: false, bypassReason: 'dispatch-url-unset' };
  }
  // Attachment files currently belong to the in-process workspace lifecycle.
  // Keep those turns on the established path until actor materialization owns
  // the same attachment contract.
  if (attachments.length > 0) {
    trackInteractiveDispatch('interactive.dispatch.bypass', {
      threadId,
      reason: 'attachments',
    });
    return { dispatched: false, bypassReason: 'attachments' };
  }

  const timeoutMs = resolveInteractiveDispatchAttemptTimeoutMs();
  const startedAt = Date.now();
  trackInteractiveDispatch('interactive.dispatch.attempt', {
    threadId,
    timeoutMs: String(timeoutMs),
  });
  console.log('[chat] Interactive dispatch attempt', { threadId, timeoutMs });

  let queuedRunId: string | undefined;
  let persistedUserMessage: ChatMessage | undefined;
  let dispatchStage = 'load-thread';

  const markStage = (stage: string): void => {
    const prev = dispatchStage;
    dispatchStage = stage;
    trackInteractiveDispatch(
      'interactive.dispatch.stage',
      {
        threadId,
        stage,
        previousStage: prev,
      },
      { elapsedMs: Date.now() - startedAt }
    );
    console.log('[chat] Interactive dispatch stage', {
      threadId,
      stage,
      elapsedMs: Date.now() - startedAt,
    });
  };

  const bypass = (reason: string): InteractiveDispatchAttempt => {
    trackInteractiveDispatch(
      'interactive.dispatch.bypass',
      {
        threadId,
        reason,
        stage: dispatchStage,
      },
      { elapsedMs: Date.now() - startedAt }
    );
    console.log('[chat] Interactive dispatch bypass', {
      threadId,
      reason,
      stage: dispatchStage,
      elapsedMs: Date.now() - startedAt,
    });
    return { dispatched: false, persistedUserMessage, bypassReason: reason };
  };

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const runAttempt = async (): Promise<InteractiveDispatchAttempt> => {
    try {
      const state = await ensureThreadState(threadId);
      if (timedOut) return bypass('timeout-abort');
      if (!state || state.thread.status === 'running') {
        return bypass(!state ? 'thread-missing' : 'thread-already-running');
      }
      // Walkthrough smart-tagging / generation / discovery (and similar
      // file-output skills) inject kickoff context into thread.workspaceDir and
      // poll that same tree for `.ai-pilot/output/*`. Actor dispatch uses the
      // shared grounding checkout instead, so candidates never arrive and the
      // status poller never finds the artifact (prod Sync review failure).
      if (isInteractiveWorkspaceBoundSkill(state.thread.kickoff.skillPath)) {
        return bypass('workspace-bound-skill');
      }
      const userId = state.thread.userId;
      const project = state.thread.kickoff.project;
      if (!userId || !project) return bypass('missing-user-or-project');

      const workflowClass = resolveInteractiveWorkflowClass(state);
      // Evaluate the flag before grounding. Cold shared-checkout materialize can
      // exceed the dispatch attempt timeout; paying that cost when the flag is
      // off (or evaluation fails) only delays the inevitable in-process path.
      markStage('flag');
      let interactiveEnabled = false;
      try {
        interactiveEnabled = await isFeatureEnabled(INTERACTIVE_WORKFLOW_FLAG, {
          userId,
          project,
          caller: workflowClass,
        });
      } catch {
        return bypass('flag-evaluation-error');
      }
      if (timedOut) return bypass('timeout-abort');
      if (!interactiveEnabled) {
        return bypass('flag-disabled');
      }

      markStage('ground-turn');
      const grounding = await ensureThreadGrounding(state);
      if (timedOut) return bypass('timeout-abort');
      if (grounding.mode !== 'local' || !grounding.nativeReads) {
        return bypass(
          grounding.mode !== 'local'
            ? `grounding-mode-${grounding.mode}`
            : 'native-reads-false'
        );
      }
      const repoReader =
        await groundingProfileResolver.resolveConnectionProfile(
          grounding.profileId
        );
      if (timedOut) return bypass('timeout-abort');
      if (
        !isExactGroundingReader(repoReader, grounding, state.thread.kickoff)
      ) {
        return bypass('grounding-reader-mismatch');
      }
      state.groundingWorkspaceDir = grounding.cwd;

      markStage('prepare-turn');
      const recoveryContext = state.isInterviewThread
        ? buildAgentRecoveryContext(state.thread.messages)
        : null;
      const prompt = await buildNewAgentTurnPrompt(
        state.thread.kickoff,
        text,
        false,
        recoveryContext,
        {
          preloadRepositoryContext: state.isInterviewThread,
          repoSearchEnabled: !state.isInterviewThread,
          nativeReads: true,
          repoReader,
          groundingProvenance: groundingProvenanceFor(
            grounding,
            state.thread.kickoff
          ),
        }
      );
      if (timedOut) return bypass('timeout-abort');
      const skillPath = state.thread.kickoff.skillPath ?? '';
      const snapshot: ExecutionSnapshot = {
        prompt,
        model: resolveModelId(modelOverride ?? state.thread.kickoff.model),
        workspaceRef: grounding.cwd,
        workflowClass,
        skillPath,
        projectId: project,
        threadId,
      };
      const timeoutAt = new Date(
        Date.now() + resolveAgentRunHardLimitMs()
      ).toISOString();
      markStage('enqueue');
      const enqueued = await enqueue({
        threadId,
        projectId: project,
        snapshot,
        timeoutAt,
        lane: INTERACTIVE_LANE,
      });
      queuedRunId = enqueued.runId;
      if (timedOut) {
        await db
          .delete(agentRuns)
          .where(eq(agentRuns.id, enqueued.runId))
          .catch(() => {});
        queuedRunId = undefined;
        return bypass('timeout-abort');
      }

      markStage('route');
      const decision = await interactiveWorkflowRouter.route({
        userId,
        project,
        workflowClass,
        threadId,
        runId: enqueued.runId,
        dispatchToActor: async (d) => {
          if (timedOut) {
            throw new Error('Interactive dispatch timed out before actor post');
          }
          // Actor turns return before the in-process persistence block below.
          // Persist and fan out the user message at this dispatch boundary so
          // refresh/replay contains both sides of the conversation.
          const userMessage: ChatMessage = {
            id: uuidv4(),
            role: 'user',
            text: text.trim() || 'Uploaded files for context.',
            ts: new Date().toISOString(),
            ...(options?.hidden ? { hidden: true } : {}),
          };
          state.thread.messages.push(userMessage);
          state.thread.lastActivityAt = userMessage.ts;
          broadcast(state, { type: 'message', message: userMessage });
          await pgInsertMessage(threadId, userMessage);
          persistedUserMessage = userMessage;

          state.thread.status = 'running';
          state.thread.activeRunId = d.runId;
          await pgUpsertThread(state.thread);
          broadcast(state, { type: 'status', status: 'running' });

          markStage('post-actor');
          try {
            await postInteractiveActorDispatch({
              threadId,
              runId: d.runId,
              dispatchMessageId: d.dispatchMessageId,
            });
          } catch (error) {
            state.thread.status = 'idle';
            state.thread.activeRunId = undefined;
            await pgUpsertThread(state.thread).catch(() => undefined);
            broadcast(state, { type: 'status', status: 'idle' });
            throw error;
          }
        },
        // The caller (sendMessage) owns the in-process fallback; the router's own
        // in-process branch is a no-op here so we never double-execute a turn.
        runInProcess: () => {},
      });

      if (timedOut) {
        await db
          .delete(agentRuns)
          .where(eq(agentRuns.id, enqueued.runId))
          .catch(() => {});
        return bypass('timeout-abort');
      }

      if (decision.route === 'actor') {
        trackInteractiveDispatch(
          'interactive.dispatch.actor',
          {
            threadId,
            runId: enqueued.runId,
            workflowClass,
          },
          { elapsedMs: Date.now() - startedAt }
        );
        return { dispatched: true, persistedUserMessage };
      }

      // Shed / race-lost / eval-error: discard the transient queued row.
      await db
        .delete(agentRuns)
        .where(eq(agentRuns.id, enqueued.runId))
        .catch(() => {});
      const routeReason =
        decision.route === 'in-process' ? decision.reason : 'not-actor';
      return bypass(`route-${routeReason}`);
    } catch (error) {
      if (timedOut) return bypass('timeout-abort');
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      console.warn(
        '[chat] Interactive dispatch failed; using in-process fallback',
        {
          threadId,
          runId: queuedRunId,
          stage: dispatchStage,
          errorType,
          elapsedMs: Date.now() - startedAt,
        }
      );
      trackInteractiveDispatch(
        'interactive.dispatch.failed',
        {
          threadId,
          stage: dispatchStage,
          errorType,
          errorMessage:
            error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
        { elapsedMs: Date.now() - startedAt }
      );
      if (queuedRunId) {
        await db
          .delete(agentRuns)
          .where(eq(agentRuns.id, queuedRunId))
          .catch(() => {});
      }
      return {
        dispatched: false,
        persistedUserMessage,
        bypassReason: `error-${dispatchStage}-${errorType}`,
      };
    }
  };

  try {
    const result = await Promise.race([
      runAttempt(),
      new Promise<InteractiveDispatchAttempt>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          trackInteractiveDispatch(
            'interactive.dispatch.timeout',
            {
              threadId,
              stage: dispatchStage,
              timeoutMs: String(timeoutMs),
            },
            { elapsedMs: Date.now() - startedAt }
          );
          console.warn(
            '[chat] Interactive dispatch attempt timed out; failing closed to in-process',
            {
              threadId,
              stage: dispatchStage,
              timeoutMs,
              elapsedMs: Date.now() - startedAt,
            }
          );
          resolve({
            dispatched: false,
            persistedUserMessage,
            bypassReason: `timeout-${dispatchStage}`,
          });
        }, timeoutMs);
      }),
    ]);
    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function sendMessage(
  threadId: string,
  text: string,
  modelOverride?: string,
  attachments: ChatAttachment[] = [],
  options?: { hidden?: boolean }
): Promise<void> {
  const sendStartedAt = Date.now();
  console.log('[chat] sendMessage.start', {
    threadId,
    attachmentCount: attachments.length,
    hidden: Boolean(options?.hidden),
  });
  trackEvent('chat.send.start', {
    threadId,
    attachmentCount: String(attachments.length),
    hidden: String(Boolean(options?.hidden)),
  });

  // @feature-flag:ai-runs-interactive start winner=disabled
  // FEAT-007: offload the turn to the warm Dapr actor lane when enabled + admitted.
  // Fail-closed: any other outcome falls through to the in-process path below.
  const interactiveAttempt = await tryDispatchInteractiveTurn(
    threadId,
    text,
    modelOverride,
    attachments,
    options
  );
  trackEvent(
    'chat.send.interactive_result',
    {
      threadId,
      dispatched: String(interactiveAttempt.dispatched),
      bypassReason: interactiveAttempt.bypassReason ?? '',
    },
    { elapsedMs: Date.now() - sendStartedAt }
  );
  console.log('[chat] sendMessage.interactive_result', {
    threadId,
    dispatched: interactiveAttempt.dispatched,
    bypassReason: interactiveAttempt.bypassReason ?? null,
    elapsedMs: Date.now() - sendStartedAt,
  });
  if (interactiveAttempt.dispatched) {
    return;
  }
  // @feature-flag:ai-runs-interactive end

  const state = await ensureThreadState(threadId);
  if (!state) throw new Error(`Thread ${threadId} not found`);
  const myWorkContext = state.isDevSession
    ? await getMyWorkSessionContext(threadId).catch(() => null)
    : null;
  const logMyWork = (
    event: string,
    context: MyWorkLogContext = {},
    level: MyWorkLogLevel = 'info'
  ): void => {
    if (myWorkContext)
      logMyWorkSession(event, { ...myWorkContext, ...context }, level);
  };
  const runStartedAtMs = Date.now();
  console.log('[chat] sendMessage.in_process', {
    threadId,
    status: state.thread.status,
  });
  logMyWork('message.received', {
    threadStatus: state.thread.status,
    messageLength: text.length,
    attachmentCount: attachments.length,
    hidden: Boolean(options?.hidden),
  });
  if (state.thread.status === 'running') {
    const gate = await recoverStaleRunningThread(threadId);
    if (gate === 'running') throw new Error('Agent is already running');
    // Dead run cleared — continue with a fresh turn.
  }

  const baseApiKey = process.env.CURSOR_API_KEY;
  if (!baseApiKey) throw new Error('CURSOR_API_KEY is not set');

  // Resolve per-project service-account key if configured (shared fallback otherwise)
  let apiKey = baseApiKey;
  try {
    const { resolveSkillConfig } = await import('./projectSettingsService');
    const project = state.thread.kickoff?.project;
    if (project) {
      const cfg = await resolveSkillConfig({ project });
      const envRef = (
        cfg as typeof cfg & { cursorApiKeyEnvRef?: string | null }
      )?.cursorApiKeyEnvRef;
      if (envRef) {
        const match = envRef.match(/^\$\{([^}]+)\}$/);
        const resolved = match ? (process.env[match[1]] ?? '') : envRef;
        if (resolved) apiKey = resolved;
      }
    }
  } catch {
    // Non-fatal — fall back to shared key
  }

  // If the caller wants a different model, dispose the current agent so it
  // will be recreated (or resumed) with the new model on this turn.
  const resolvedModel = resolveModelId(
    modelOverride ?? state.thread.kickoff.model
  );
  if (state.thread.kickoff.model !== resolvedModel) {
    state.thread.kickoff.model = resolvedModel;
    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }
  }

  const provisionalRunId = `${threadId}:provisional`;
  const eventDrivenTerminationEnabled = await isFeatureEnabled(
    'event-driven-run-termination',
    {
      userId: state.thread.userId,
      project: state.thread.kickoff.project,
    }
  ).catch(() => false);

  // Grounding may need a cold mirror refresh. Expose that work immediately so
  // a newly created interview does not look idle while its repository is being
  // prepared.
  state.thread.status = 'running';
  broadcast(state, {
    type: 'status',
    status: 'running',
    eventDrivenTermination: eventDrivenTerminationEnabled,
  });
  await pgUpsertThread(state.thread);
  resetIdleTimer(state);

  // Register durable liveness before grounding begins. The row is replaced by
  // the real SDK run once agent.send() returns a definitive run ID.
  const provisionalRunTimeoutMs = resolveAgentRunHardLimitMs();
  const preparationStartedAt = new Date().toISOString();
  await db
    .insert(agentRuns)
    .values({
      id: provisionalRunId,
      threadId,
      status: 'queued',
      timeoutAt: new Date(Date.now() + provisionalRunTimeoutMs).toISOString(),
      ...(eventDrivenTerminationEnabled
        ? {}
        : {
            progressAt: preparationStartedAt,
            progressLabel: 'Preparing the latest repository requirements…',
            progressPhase: 'analysis' as const,
          }),
    })
    .onConflictDoNothing()
    .catch((e) =>
      console.warn('[chat] Failed to insert provisional agent_runs row:', e)
    );

  // Compute idle gap BEFORE the user message overwrites lastActivityAt.
  // The stale-idle agent dispose runs later (after grounding), but the
  // calculation must use the pre-mutation timestamp.
  const idleGapMs = state.thread.lastActivityAt
    ? Date.now() - Date.parse(state.thread.lastActivityAt)
    : 0;
  const staleIdleResume =
    eventDrivenTerminationEnabled &&
    Number.isFinite(idleGapMs) &&
    idleGapMs > AGENT_STALE_RESUME_MS &&
    Boolean(state.agent || state.thread.cursorAgentId);

  // Persist + broadcast the user message immediately so the UI reflects it
  // before the (potentially slow) grounding / agent acquisition below.
  const turnId = interactiveAttempt.persistedUserMessage?.id ?? uuidv4();
  const attachmentMeta = await writeMessageAttachments(
    state.thread.workspaceDir,
    turnId,
    attachments
  );
  const promptText = buildPromptWithAttachments(text, attachmentMeta);
  const priorMessages = interactiveAttempt.persistedUserMessage
    ? state.thread.messages.filter(
        (message) => message.id !== interactiveAttempt.persistedUserMessage?.id
      )
    : [...state.thread.messages];
  const recoveryContext = state.isInterviewThread
    ? buildAgentRecoveryContext(priorMessages)
    : null;

  const userMsg = interactiveAttempt.persistedUserMessage ?? {
    id: turnId,
    role: 'user' as const,
    text: text.trim() || 'Uploaded files for context.',
    ts: new Date().toISOString(),
    attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
    ...(options?.hidden ? { hidden: true } : {}),
  };
  if (!interactiveAttempt.persistedUserMessage) {
    state.thread.messages.push(userMsg);
    state.thread.lastActivityAt = userMsg.ts;
    broadcast(state, { type: 'message', message: userMsg });
    await pgInsertMessage(threadId, userMsg);
  }
  logMyWork('message.persisted', {
    turnId,
    messageLength: userMsg.text.length,
    attachmentCount: attachmentMeta.length,
  });

  // ── Grounding + agent lifecycle (may be slow after idle) ────────────────
  const mcpServerUrl = `http://localhost:${process.env.PORT ?? 3001}/mcp/ado-skills`;
  let grounding: Exclude<CallerGroundingSelection, { mode: 'preparing' }>;
  try {
    grounding = await waitForReadyThreadGrounding(state);
  } catch (error) {
    state.thread.status = 'error';
    state.thread.lastError =
      error instanceof Error && error.message.includes('timed out')
        ? 'Repository preparation timed out. Please retry this message.'
        : 'Unable to prepare the project repository. Please retry this message.';
    broadcast(state, {
      type: 'grounding',
      status: 'failed',
      message: state.thread.lastError,
    });
    broadcast(state, {
      type: 'error',
      error: state.thread.lastError,
    });
    broadcast(state, { type: 'done' });
    persistThread(state.thread);
    await db
      .delete(agentRuns)
      .where(eq(agentRuns.id, provisionalRunId))
      .catch(() => {});
    throw error;
  }
  const groundingCaller = resolveGroundingCallerKey(state.thread.kickoff);
  const lifecycleTelemetryContext = {
    caller: groundingCaller,
    project: state.thread.kickoff.project,
    runId: threadId,
    runType: 'chat' as const,
  };
  let lifecycleBindingEnabled = false;
  if (isRepositoryReadingChatCaller(state.thread.kickoff, state.isDevSession)) {
    let lifecycleEvaluationFailed = false;
    lifecycleBindingEnabled = await isLifecycleBindingEnabledForCaller(
      {
        userId: state.thread.userId,
        project: state.thread.kickoff.project,
        caller: groundingCaller,
      },
      () => {
        lifecycleEvaluationFailed = true;
      }
    );
    groundingTelemetry.lifecycleFlag(
      lifecycleTelemetryContext,
      lifecycleBindingEnabled,
      lifecycleEvaluationFailed ? 'failure' : 'success'
    );
  }

  let boundaryRecreationReason: BindingRecreationReason | null = null;
  // Retain the enabled branch after two stable sprints at full rollout.
  // @feature-flag:repo-grounding-lifecycle-binding start winner=enabled
  if (!lifecycleBindingEnabled) {
    // @feature-flag:repo-grounding-lifecycle-binding disabled-start
    // Preserve FEAT-002 writes while suppressing FEAT-003 boundary disposal.
    boundaryRecreationReason = null;
    // @feature-flag:repo-grounding-lifecycle-binding disabled-end
  } else {
    // @feature-flag:repo-grounding-lifecycle-binding enabled-start
    boundaryRecreationReason = state.bindingContinuity
      ? selectGroundingBoundaryRecreation({
          lifecycleEnabled: true,
          hasAgentIdentity: Boolean(state.agent || state.thread.cursorAgentId),
          decision: state.bindingContinuity,
        })
      : null;
    if (boundaryRecreationReason && state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }
    // @feature-flag:repo-grounding-lifecycle-binding enabled-end
  }
  // @feature-flag:repo-grounding-lifecycle-binding end

  // Apply the stale-idle agent dispose computed earlier.
  if (staleIdleResume) {
    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }
    trackEvent('agent.stale_idle_recreate', {
      threadId,
      idleGapMs: String(idleGapMs),
    });
  }

  const maxviewEnabled = await isMaxviewMcpEnabled(
    state.thread.userId,
    state.thread.kickoff.project
  );
  const calendarSessionId =
    state.thread.kickoff.assistantType === 'calendar-work-item'
      ? (state.thread.kickoff.calendarAssistantSessionId ?? undefined)
      : undefined;
  const repositoryRuntime = await prepareRepositoryReadRuntime({
    grounding,
    kickoff: state.thread.kickoff,
    adoSkillsUrl: mcpServerUrl,
    sandboxCwd: state.thread.workspaceDir,
    maxviewEnabled,
    calendarSessionId,
    restrictRepoSearch: state.isInterviewThread,
  });

  // FEAT-003: live linked-context materialization (fail-open; never blocks the turn).
  // Dynamic import avoids a circular dependency through designModuleService.
  const { materializeLinkedContextForInterviewThread } =
    await import('./linkedContextMaterializerService');
  await materializeLinkedContextForInterviewThread({
    threadId,
    workspaceDir: state.thread.workspaceDir,
    userId: state.thread.userId,
    isInterviewThread: state.isInterviewThread,
  });

  const agentWorkspaceDir = state.thread.workspaceDir;
  const localAgentOptions = repositoryRuntime.local;
  const mcpServers = repositoryRuntime.mcpServers;
  console.log(
    '[chat] MCP servers for turn:',
    Object.keys(mcpServers).join(', '),
    {
      maxviewEnabled,
      maxviewConfigured: isMaxviewConfigured(),
      nativeReads: repositoryRuntime.nativeReads,
    }
  );

  // A missing cursorAgentId can mean either a brand-new conversation or a
  // force-disposed interview agent. In the latter case, include the visible
  // PostgreSQL-backed history so Agent.create() continues instead of restarting.
  const hadCursorAgentId = Boolean(state.thread.cursorAgentId);
  let prompt = hadCursorAgentId
    ? promptText
    : await buildNewAgentTurnPrompt(
        state.thread.kickoff,
        promptText,
        maxviewEnabled,
        recoveryContext,
        {
          preloadRepositoryContext:
            state.isInterviewThread && grounding.mode === 'remote',
          repoSearchEnabled: !state.isInterviewThread,
          nativeReads: repositoryRuntime.nativeReads,
          repoReader: repositoryRuntime.repoReader,
          groundingProvenance: groundingProvenanceFor(
            grounding,
            state.thread.kickoff
          ),
        }
      );
  let agentAcquisitionMode: 'existing' | 'created' | 'resumed' | 'recreated' =
    state.agent ? 'existing' : hadCursorAgentId ? 'resumed' : 'created';

  let agentRunId: string | undefined;
  let terminalFinalized = false;
  let backgroundHeartbeatId: ReturnType<typeof setInterval> | null = null;
  let mcpDeadlineController: McpToolDeadlineController | null = null;
  let unsubscribeAbort: (() => void) | null = null;
  let heldLocalAgentSlot = false;

  try {
    await acquireLocalAgentSlot(threadId);
    heldLocalAgentSlot = true;

    // Create or resume the agent (retry up to 3x on transient errors)
    const sdkRetryOpts = {
      maxRetries: 3,
      initialDelay: 1000,
      shouldRetry: isTransientSdkError,
      jitter: true,
    } as const;

    const codeReviewerAgent = {
      description:
        'Rigorous MaxView code reviewer. Reviews changed files against MaxView layer boundaries, coding standards, existing-code protection rules, and the approved design spec. Every finding must cite a specific rule file, design-doc section, or repo path.',
      prompt:
        `You are a senior engineer reviewing a MaxView feature implementation. Your job:\n` +
        `1. Read the MaxView repo rules from .cursor/rules/ (especially backend-layer-boundaries.mdc, coding-standards.mdc, existing-code-protection.mdc, testing-standards.mdc, typescript-typecheck.mdc, ui-design-standards.mdc).\n` +
        `2. Read AGENTS.md and CONTEXT.md for project context.\n` +
        `3. Review the diff provided against those rules and the design docs in .ai-pilot/output/.\n` +
        `4. For every finding: cite the specific rule file / design-doc section / repo path. Do NOT produce generic advice.\n` +
        `5. Group findings by severity: Must-fix, Should-fix, Nice-to-have.\n` +
        `6. Format: [Severity] Title — File:lines — Snippet — Suggested change (as diff) — Reason.\n` +
        `Be thorough but only flag real violations. If no issues, say so explicitly.`,
      model: { id: 'claude-opus-4-6' },
    };

    if (!state.agent) {
      const priorCursorAgentId = state.thread.cursorAgentId;
      const acquisition = await resumeOrCreateAgent({
        cursorAgentId: priorCursorAgentId,
        forceRecreate: boundaryRecreationReason !== null || staleIdleResume,
        resume: async () => {
          logMyWork('agent.resume_started', {
            cursorAgentId: priorCursorAgentId,
            model: resolvedModel,
          });
          // Agent.resume accepts Partial<AgentOptions>, which includes agents.
          return retryWithBackoff(
            () =>
              Agent.resume(priorCursorAgentId!, {
                apiKey,
                model: { id: resolvedModel },
                local: localAgentOptions,
                mcpServers,
                agents: { 'code-reviewer': codeReviewerAgent },
              }),
            sdkRetryOpts
          );
        },
        create: async () => {
          logMyWork('agent.create_started', { model: resolvedModel });
          return retryWithBackoff(
            () =>
              Agent.create({
                apiKey,
                model: { id: resolvedModel },
                local: localAgentOptions,
                mcpServers,
                agents: { 'code-reviewer': codeReviewerAgent },
              }),
            sdkRetryOpts
          );
        },
      });
      state.agent = acquisition.agent;
      agentAcquisitionMode = acquisition.mode;
      await persistCreatedAgentBinding(
        state.thread,
        acquisition.agent,
        acquisition.mode,
        state.resolvedGroundingBinding
      );
      if (
        (acquisition.mode === 'created' || acquisition.mode === 'recreated') &&
        state.resolvedGroundingBinding
      ) {
        settleGroundingContinuityAfterBindingWrite(state);
        groundingTelemetry.bindingWrite(
          lifecycleTelemetryContext,
          state.resolvedGroundingBinding.mode,
          'success'
        );
      }
      if (boundaryRecreationReason && acquisition.mode === 'recreated') {
        groundingTelemetry.recreation(
          lifecycleTelemetryContext,
          boundaryRecreationReason,
          'success'
        );
      }

      if (acquisition.mode === 'recreated') {
        console.warn(
          `[chat] Agent.resume failed for thread ${threadId}; recreating with PostgreSQL history`,
          describeError(acquisition.resumeError)
        );
        prompt = await buildNewAgentTurnPrompt(
          state.thread.kickoff,
          promptText,
          maxviewEnabled,
          recoveryContext,
          {
            preloadRepositoryContext:
              state.isInterviewThread && grounding.mode === 'remote',
            repoSearchEnabled: !state.isInterviewThread,
            nativeReads: repositoryRuntime.nativeReads,
            repoReader: repositoryRuntime.repoReader,
            groundingProvenance: groundingProvenanceFor(
              grounding,
              state.thread.kickoff
            ),
          }
        );
      }
    }

    const agent = state.agent;
    if (
      recoveryContext &&
      (agentAcquisitionMode === 'created' ||
        agentAcquisitionMode === 'recreated')
    ) {
      console.log(
        '[chat] Injected PostgreSQL history into replacement interview agent',
        {
          threadId,
          messageCount: recoveryContext.totalMessageCount,
          truncated: recoveryContext.truncated,
          acquisitionMode: agentAcquisitionMode,
        }
      );
      trackEvent('agent.history.recovered', {
        threadId,
        messageCount: String(recoveryContext.totalMessageCount),
        truncated: String(recoveryContext.truncated),
        acquisitionMode: agentAcquisitionMode,
      });
    }
    // Send the prompt (retry up to 2x on transient errors)
    const run = await retryWithBackoff(() => agent.send(prompt), {
      ...sdkRetryOpts,
      maxRetries: 2,
    });

    trackEvent('agent.run.started', {
      threadId,
      model: resolvedModel,
      isInterview: String(state.isInterviewThread),
    });

    // Persist agent + run IDs immediately before streaming
    state.thread.cursorAgentId = agent.agentId ?? state.thread.cursorAgentId;
    state.thread.activeRunId = getRunId(run);
    persistThread(state.thread);

    // ── Insert agent_runs record as 'queued', then atomically claim it ──────
    const runTimeoutMs = resolveAgentRunHardLimitMs();
    const runTimeoutAt = new Date(Date.now() + runTimeoutMs).toISOString();
    agentRunId = state.thread.activeRunId ?? threadId;
    if (eventDrivenTerminationEnabled) eventDrivenRunIds.add(agentRunId);
    logMyWork('run.started', {
      runId: agentRunId,
      cursorAgentId: state.thread.cursorAgentId,
      model: resolvedModel,
      resumedAgent:
        agentAcquisitionMode === 'existing' ||
        agentAcquisitionMode === 'resumed',
      agentAcquisitionMode,
      recoveredMessageCount:
        agentAcquisitionMode === 'created' ||
        agentAcquisitionMode === 'recreated'
          ? (recoveryContext?.totalMessageCount ?? 0)
          : 0,
    });
    await db
      .insert(agentRuns)
      .values({
        id: agentRunId,
        threadId,
        status: 'queued',
        timeoutAt: runTimeoutAt,
      })
      .onConflictDoNothing();

    // Clean up provisional liveness row now that the real row exists
    if (agentRunId !== provisionalRunId) {
      db.delete(agentRuns)
        .where(eq(agentRuns.id, provisionalRunId))
        .catch((e) =>
          console.warn('[chat] Failed to delete provisional agent_runs row:', e)
        );
    }

    // Atomic lease claim: only one worker transitions queued → running
    const claimedAt = new Date().toISOString();
    const [claimed] = await db
      .update(agentRuns)
      .set(
        buildAgentRunClaimUpdate(
          eventDrivenTerminationEnabled,
          RUN_EVENT_SOURCE_INSTANCE,
          claimedAt
        )
      )
      .where(and(eq(agentRuns.id, agentRunId), eq(agentRuns.status, 'queued')))
      .returning({ id: agentRuns.id });

    if (!claimed) {
      // Another worker already claimed this run — do not double-execute.
      // The SSE route will pick up tokens via LISTEN/NOTIFY from the owner.
      console.log(
        `[chat] Run ${agentRunId} already claimed by another worker, skipping execution`
      );
      state.thread.status = 'running';
      state.thread.activeRunId = agentRunId;
      persistThread(state.thread);
      logMyWork(
        'run.claim_skipped',
        {
          runId: agentRunId,
          reason: 'claimed_by_another_worker',
        },
        'warn'
      );
      return;
    }

    const MAX_RUN_RETRIES = 2;
    let currentRun = run;
    let agentTextBuffer = '';
    let lastHeartbeatMs = Date.now();
    const HEARTBEAT_INTERVAL_MS = 10_000;
    const thinkingPhase = new ThinkingPhaseCoalescer();
    // Keep progress metadata separately from authoritative per-tool timers.
    const inFlightToolCalls = new Map<string, InFlightToolCall>();
    const pendingToolMessages = new Map<string, ChatMessage>();
    const mcpToolTimeoutMs = resolveAgentMcpToolTimeoutMs();

    // Shared heartbeat helper — call from any event handler that can run > 90s
    // without emitting text tokens (thinking phases, tool_use, long tool_call waits).
    // agentRunId is always assigned before this function is ever called.
    let streamAbortError:
      | (Error & {
          _cancelled?: true;
          _ownerDeadline?: true;
          _startupDeadline?: true;
        })
      | null = null;
    const bumpHeartbeat = async (): Promise<void> => {
      if (eventDrivenTerminationEnabled) return;
      if (Date.now() - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) return;
      lastHeartbeatMs = Date.now();
      const runId = agentRunId!;
      const [runRow] = await db
        .update(agentRuns)
        .set({
          heartbeatAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'running')))
        .returning({ status: agentRuns.status });
      if (!runRow) {
        // Run was cancelled/failed/completed elsewhere (user Stop, reaper, etc.)
        console.log(`[chat] Run ${runId} no longer running, aborting stream`);
        throw makeCancelledError('Run cancelled');
      }
    };

    const abortInFlightRun = (reason: string): void => {
      if (streamAbortError) return;
      streamAbortError = makeCancelledError(reason);
      const runId = agentRunId!;
      void (async () => {
        await cancelSdkRunBestEffort(state, runId);
        // Dispose even while stream() is blocked on a hung MCP tool so the
        // next user send cannot hit "already has active run".
        await forceDisposeThreadAgent(state, {
          clearCursorAgentId: true,
          reason,
        });
      })();
    };

    mcpDeadlineController = createMcpToolDeadlineController(
      mcpToolTimeoutMs,
      (expiredMcpTool) => {
        const detail = sanitizeTerminalDetail(
          `${expiredMcpTool.mcpLabel ?? expiredMcpTool.toolName} exceeded owner deadline ` +
            `after ${Math.round(expiredMcpTool.elapsedMs / 1000)} seconds. Retry the turn.`
        );
        console.warn(
          `[chat] ${detail} (threadId=${threadId}, runId=${agentRunId})`
        );
        logMyWork(
          'run.mcp_tool_timeout',
          {
            runId: agentRunId,
            toolName: expiredMcpTool.mcpLabel ?? expiredMcpTool.toolName,
            elapsedMs: expiredMcpTool.elapsedMs,
            timeoutMs: mcpToolTimeoutMs,
            mode: eventDrivenTerminationEnabled ? 'enforce' : 'shadow',
          },
          'warn'
        );
        trackEvent(
          'agent.run.tool_deadline',
          {
            threadId,
            mode: eventDrivenTerminationEnabled ? 'enforce' : 'shadow',
            outcome: eventDrivenTerminationEnabled
              ? 'terminal'
              : 'legacy-authority',
          },
          {
            elapsedMs: expiredMcpTool.elapsedMs,
            timeoutMs: mcpToolTimeoutMs,
          }
        );

        // @feature-flag:event-driven-run-termination start winner=enabled
        if (!eventDrivenTerminationEnabled) {
          // @feature-flag:event-driven-run-termination disabled-start
          // Shadow records the comparison signal while legacy liveness remains authoritative.
          // @feature-flag:event-driven-run-termination disabled-end
          return;
        }

        // @feature-flag:event-driven-run-termination enabled-start
        void (async () => {
          const runId = agentRunId!;
          const toolEvent = createRunEventEnvelope({
            threadId,
            runId,
            sequence: nextRunEventSequence(runId),
            event: {
              type: 'tool_status',
              toolName: expiredMcpTool.mcpLabel ?? expiredMcpTool.toolName,
              callId: expiredMcpTool.key,
              status: 'error',
            },
            phase: 'completion',
          });
          const errorEvent = createRunEventEnvelope({
            threadId,
            runId,
            sequence: nextRunEventSequence(runId),
            event: { type: 'error', error: detail, errorCode: 'transient' },
            phase: 'completion',
          });
          const doneEvent = createRunEventEnvelope({
            threadId,
            runId,
            sequence: nextRunEventSequence(runId),
            event: { type: 'done', runId },
            phase: 'completion',
          });
          const won = await finalizeOwnedAgentRun({
            runId,
            threadId,
            ownerInstance: RUN_EVENT_SOURCE_INSTANCE,
            status: 'failed',
            detail,
            events: [toolEvent, errorEvent, doneEvent],
          });
          if (!won) return;

          state.thread.lastError = detail;
          state.thread.status = 'idle';
          state.thread.activeRunId = undefined;
          broadcast(
            state,
            {
              type: 'tool_status',
              toolName: expiredMcpTool.mcpLabel ?? expiredMcpTool.toolName,
              callId: expiredMcpTool.key,
              status: 'error',
            },
            toolEvent
          );
          broadcast(
            state,
            {
              type: 'error',
              error: detail,
              errorCode: 'transient',
            },
            errorEvent
          );
          broadcast(state, { type: 'done', runId }, doneEvent);
          persistThread(state.thread);
          streamAbortError = makeOwnerDeadlineError(detail);
          await cancelSdkRunBestEffort(state, runId);
          await forceDisposeThreadAgent(state, {
            clearCursorAgentId: true,
            reason: 'owner_tool_deadline',
          });
        })().catch((error) => {
          console.error(
            '[chat] Failed authoritative tool-deadline finalization:',
            error
          );
        });
        // @feature-flag:event-driven-run-termination enabled-end
        // @feature-flag:event-driven-run-termination end
      }
    );

    const throwIfAborted = (): void => {
      if (streamAbortError) throw streamAbortError;
    };

    // React immediately to reaper/user cancel fan-out (do not wait for the next
    // stream token or the 30s background heartbeat).
    unsubscribeAbort = subscribeRunEvents(threadId, (envelope) => {
      if (envelope.runId && envelope.runId !== agentRunId) return;
      if (!isExternalRunAbortEvent(envelope)) return;
      const detail = envelope.detail || envelope.event.type;
      abortInFlightRun(`External abort: ${detail}`);
    });

    // @feature-flag:event-driven-run-termination start winner=enabled
    if (eventDrivenTerminationEnabled) {
      // @feature-flag:event-driven-run-termination enabled-start
      // Owner deadlines and durable terminal events are authoritative.
      // @feature-flag:event-driven-run-termination enabled-end
    } else {
      // @feature-flag:event-driven-run-termination disabled-start
      backgroundHeartbeatId = setInterval(() => {
        lastHeartbeatMs = 0;
        bumpHeartbeat().catch((err: unknown) => {
          const cancelled =
            !!err &&
            typeof err === 'object' &&
            '_cancelled' in err &&
            Boolean((err as { _cancelled?: unknown })._cancelled);
          if (cancelled) {
            abortInFlightRun('Heartbeat observed non-running agent_runs row');
          }
        });
      }, 30_000);
      // @feature-flag:event-driven-run-termination disabled-end
    }
    // @feature-flag:event-driven-run-termination end

    // Fast first-event backstop for event-driven runs: a resumed agent that
    // emits nothing has no tool_call for the MCP deadline to bound, so bound the
    // dead-on-arrival window here instead of the coarse ~2h timeout_at.
    const firstEventTimeoutMs = resolveAgentFirstEventTimeoutMs();
    let startupRetryConsumed = false;

    for (let attempt = 0; attempt <= MAX_RUN_RETRIES; attempt++) {
      agentTextBuffer = '';
      throwIfAborted();

      // Arm the first-event deadline for event-driven runs only. On expiry we
      // dispose the (silent) agent so the blocked async iterator unblocks and
      // throws into the catch below, which recreates + retries once.
      let firstEventSeen = false;
      const firstEventDeadline =
        eventDrivenTerminationEnabled && currentRun.supports('stream')
          ? createFirstEventDeadline(firstEventTimeoutMs, () => {
              if (firstEventSeen || streamAbortError) return;
              streamAbortError = makeStartupDeadlineError(
                'The agent did not start responding.'
              );
              const runId = agentRunId!;
              void (async () => {
                await cancelSdkRunBestEffort(state, runId);
                await forceDisposeThreadAgent(state, {
                  clearCursorAgentId: false,
                  reason: 'startup_deadline',
                });
              })();
            })
          : null;
      let executionResult:
        | Awaited<ReturnType<typeof executeCursorExecutionCore>>
        | undefined;
      try {
        const executionSnapshot: Readonly<ExecutionSnapshot> = Object.freeze({
          prompt,
          model: resolvedModel,
          workspaceRef: agentWorkspaceDir,
          workflowClass:
            state.thread.kickoff.assistantType ??
            state.thread.kickoff.mode ??
            'chat',
          skillPath: state.thread.kickoff.skillPath ?? '',
          projectId: state.thread.kickoff.project,
          threadId,
        });
        executionResult = await executeCursorExecutionCore({
          snapshot: executionSnapshot,
          run: currentRun as unknown as CursorExecutionRun,
          context: {
            runId: agentRunId!,
            sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
          },
          sink: {
            publish: (_event, envelope) =>
              publishRunEventEnvelope(state, envelope),
          },
          thinkingPhase,
          nextSequence: () => nextRunEventSequence(agentRunId!),
          hooks: {
            beforeStreamEvent: throwIfAborted,
            onFirstStreamEvent: () => {
              firstEventSeen = true;
              firstEventDeadline?.clear();
            },
            onStreamComplete: () => firstEventDeadline?.clear(),
            onReasoningSegment: (reasoningText) => {
              const reasoningMsg: ChatMessage = {
                id: uuidv4(),
                role: 'agent',
                text: reasoningText,
                ts: new Date().toISOString(),
                toolName: '_reasoning',
              };
              state.thread.messages.push(reasoningMsg);
              broadcast(state, { type: 'message', message: reasoningMsg });
              pgInsertMessage(threadId, reasoningMsg).catch(() => {});
            },
            onToolUse: ({ key, name, args, phase }) => {
              markToolInFlight(inFlightToolCalls, key, name, args);
              mcpDeadlineController?.arm(key, name, args);
              const toolMsg: ChatMessage = {
                id: uuidv4(),
                role: 'tool',
                text: `→ ${name}`,
                toolName: name,
                toolInput: args as Record<string, unknown>,
                ts: new Date().toISOString(),
              };
              state.thread.messages.push(toolMsg);
              pendingToolMessages.set(key, toolMsg);
              logMyWork('run.tool_started', {
                runId: agentRunId,
                toolName: name,
                phase,
              });
            },
            onToolUsePublished: ({ key }) => {
              const toolMsg = pendingToolMessages.get(key);
              if (!toolMsg) return;
              pendingToolMessages.delete(key);
              broadcast(state, { type: 'message', message: toolMsg });
              pgInsertMessage(threadId, toolMsg).catch(() => {});
            },
            onThinkingProgress: ({ firstFragment }) => {
              if (firstFragment) return;
              // Extended model thinking can run for many minutes without tokens or
              // tools. Keep progressAt fresh so the reaper's progress_timeout does
              // not kill a healthy interview/ADR turn (heartbeat alone is not enough).
              // sequence is unused for progress-only writes — do not burn run-event ids.
              void persistMeaningfulProgress(
                agentRunId!,
                createRunEventEnvelope({
                  threadId,
                  runId: agentRunId!,
                  sequence: 0,
                  event: { type: 'thinking', text: 'Analyzing' },
                  phase: 'analysis',
                })
              );
            },
            onToolStatus: ({ key, callId, name, status, args, phase }) => {
              const trackerName = name || 'unknown';
              if (status === 'running') {
                markToolInFlight(inFlightToolCalls, key, trackerName, args);
                mcpDeadlineController?.arm(key, trackerName, args);
              } else {
                clearToolInFlight(inFlightToolCalls, key, trackerName, args);
                mcpDeadlineController?.complete(key, trackerName, args);
              }
              logMyWork(
                'run.tool_status',
                {
                  runId: agentRunId,
                  toolName: trackerName,
                  toolCallId: callId ?? null,
                  toolStatus: status,
                  phase,
                },
                status === 'error' ? 'warn' : 'info'
              );
            },
            onHeartbeat: bumpHeartbeat,
          },
        });
      } catch (streamErr) {
        firstEventDeadline?.clear();
        if (streamErr instanceof CursorExecutionWaitError) {
          throw streamErr.cause;
        }

        // First-event startup deadline: the resumed agent emitted nothing.
        const startupDeadline =
          !!streamAbortError &&
          Boolean(
            (streamAbortError as { _startupDeadline?: unknown })
              ._startupDeadline
          );
        if (startupDeadline) {
          if (attempt < MAX_RUN_RETRIES && !startupRetryConsumed) {
            // Transparently recreate a fresh agent (with history) and retry once.
            startupRetryConsumed = true;
            trackEvent(
              'agent.run.startup_deadline',
              {
                threadId,
                mode: 'enforce',
                attempt: String(attempt + 1),
                recovered: 'true',
              },
              { firstEventTimeoutMs }
            );
            console.warn(
              `[chat] First-event deadline on attempt ${attempt + 1}/${MAX_RUN_RETRIES + 1} for thread ${threadId}; recreating agent and retrying`
            );
            await publishRunEvent(state, agentRunId!, {
              type: 'retrying',
              attempt: attempt + 1,
              maxAttempts: MAX_RUN_RETRIES + 1,
              reason: 'reconnecting',
            });
            // Clear the abort so the loop-top throwIfAborted() does not refire.
            streamAbortError = null;
            if (state.agent) {
              await state.agent[Symbol.asyncDispose]().catch(() => {});
              state.agent = null;
            }
            // Recreate (not resume) with PostgreSQL history so the fresh
            // session continues the conversation instead of restarting it.
            state.thread.cursorAgentId = undefined;
            prompt = await buildNewAgentTurnPrompt(
              state.thread.kickoff,
              promptText,
              maxviewEnabled,
              recoveryContext,
              {
                preloadRepositoryContext:
                  state.isInterviewThread && grounding.mode === 'remote',
                repoSearchEnabled: !state.isInterviewThread,
                nativeReads: repositoryRuntime.nativeReads,
                repoReader: repositoryRuntime.repoReader,
                groundingProvenance: groundingProvenanceFor(
                  grounding,
                  state.thread.kickoff
                ),
              }
            );
            state.agent = await retryWithBackoff(
              () =>
                Agent.create({
                  apiKey,
                  model: { id: resolvedModel },
                  local: localAgentOptions,
                  mcpServers,
                  agents: { 'code-reviewer': codeReviewerAgent },
                }),
              sdkRetryOpts
            );
            currentRun = await state.agent.send(prompt);
            state.thread.cursorAgentId =
              state.agent.agentId ?? state.thread.cursorAgentId;
            state.thread.activeRunId = getRunId(currentRun);
            continue;
          }

          // Final attempt still produced nothing — finalize a terminal failure
          // through the owner path so the user gets an actionable message and
          // can resend, instead of a silent spinner up to the hard limit.
          const detail =
            'The agent did not start responding. Please resend your last message.';
          trackEvent(
            'agent.run.startup_deadline',
            {
              threadId,
              mode: 'enforce',
              attempt: String(attempt + 1),
              recovered: 'false',
            },
            { firstEventTimeoutMs }
          );
          terminalFinalized = await finalizeOwnerTerminal(
            state,
            agentRunId!,
            'failed',
            detail,
            [
              { type: 'error', error: detail },
              { type: 'done', runId: agentRunId },
            ]
          );
          state.thread.lastError = detail;
          state.thread.status = 'idle';
          state.thread.activeRunId = undefined;
          if (state.agent) {
            await state.agent[Symbol.asyncDispose]().catch(() => {});
            state.agent = null;
          }
          streamAbortError = null;
          break;
        }

        if (streamAbortError) throw streamAbortError;
        if (attempt < MAX_RUN_RETRIES && isTransientSdkError(streamErr)) {
          console.warn(
            `[chat] Stream error on attempt ${attempt + 1}/${MAX_RUN_RETRIES + 1} for thread ${threadId}, retrying…`,
            describeError(streamErr)
          );
          await publishRunEvent(state, agentRunId!, {
            type: 'retrying',
            attempt: attempt + 1,
            maxAttempts: MAX_RUN_RETRIES + 1,
          });

          if (state.agent) {
            await state.agent[Symbol.asyncDispose]().catch(() => {});
            state.agent = null;
          }
          if (state.thread.cursorAgentId) {
            state.agent = await retryWithBackoff(
              () =>
                resumePinnedTurnAgent(() =>
                  Agent.resume(state.thread.cursorAgentId!, {
                    apiKey,
                    model: { id: resolvedModel },
                    local: localAgentOptions,
                    mcpServers,
                  })
                ),
              sdkRetryOpts
            );
            currentRun = await state.agent.send(prompt);
            state.thread.activeRunId = getRunId(currentRun);
            continue;
          }
        }
        throw streamErr;
      }

      if (!executionResult) continue;
      agentTextBuffer = executionResult.text;
      const result = executionResult.waitResult;

      if (result.status === 'error') {
        const reason = sanitizeTerminalDetail(
          result.result?.trim() ||
            'Agent run failed — you can retry your last message.'
        );

        if (attempt < MAX_RUN_RETRIES && !isFatalRunError(reason)) {
          console.warn(
            `[chat] Run error on attempt ${attempt + 1}/${MAX_RUN_RETRIES + 1} for thread ${threadId}, retrying…`,
            reason
          );
          await publishRunEvent(state, agentRunId!, {
            type: 'retrying',
            attempt: attempt + 1,
            maxAttempts: MAX_RUN_RETRIES + 1,
          });

          if (state.agent) {
            await state.agent[Symbol.asyncDispose]().catch(() => {});
            state.agent = null;
          }
          if (state.thread.cursorAgentId) {
            state.agent = await retryWithBackoff(
              () =>
                resumePinnedTurnAgent(() =>
                  Agent.resume(state.thread.cursorAgentId!, {
                    apiKey,
                    model: { id: resolvedModel },
                    local: localAgentOptions,
                    mcpServers,
                  })
                ),
              sdkRetryOpts
            );
            currentRun = await state.agent.send(prompt);
            state.thread.activeRunId = getRunId(currentRun);
            continue;
          }
        }

        console.error(
          `[chat] Agent run returned error status for thread ${threadId}:`,
          result.result ?? '(no detail)',
          { model: state.thread.kickoff.model }
        );
        trackAgentError(threadId, new Error(reason), {
          model: state.thread.kickoff?.model ?? 'unknown',
        });
        state.thread.lastError = reason;
        // @feature-flag:event-driven-run-termination start winner=enabled
        if (eventDrivenTerminationEnabled) {
          // @feature-flag:event-driven-run-termination enabled-start
          terminalFinalized = await finalizeOwnerTerminal(
            state,
            agentRunId!,
            'failed',
            reason,
            [
              { type: 'error', error: reason },
              { type: 'done', runId: agentRunId },
            ]
          );
          // @feature-flag:event-driven-run-termination enabled-end
        } else {
          // @feature-flag:event-driven-run-termination disabled-start
          await db
            .update(agentRuns)
            .set({
              status: 'failed',
              lastError: reason,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(agentRuns.id, agentRunId),
                eq(agentRuns.ownerInstance, RUN_EVENT_SOURCE_INSTANCE),
                eq(agentRuns.status, 'running')
              )
            )
            .execute()
            .catch((e) =>
              console.error(
                '[chat] Failed to mark agent run failed (in-loop):',
                e
              )
            );
          await publishRunEvent(state, agentRunId!, {
            type: 'error',
            error: reason,
          });
          // @feature-flag:event-driven-run-termination disabled-end
        }
        // @feature-flag:event-driven-run-termination end
        if (state.agent) {
          await state.agent[Symbol.asyncDispose]().catch(() => {});
          state.agent = null;
        }
        if (isFatalRunError(reason)) {
          state.thread.cursorAgentId = undefined;
        }
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
        if (!eventDrivenTerminationEnabled) {
          await publishRunEvent(state, agentRunId!, {
            type: 'status',
            status: 'idle',
          });
        }
        break;
      }

      // Run succeeded
      if (agentTextBuffer) {
        const agentMsg: ChatMessage = {
          id: uuidv4(),
          role: 'agent',
          text: agentTextBuffer,
          ts: new Date().toISOString(),
        };
        state.thread.messages.push(agentMsg);
        broadcast(state, { type: 'message', message: agentMsg });
        await pgInsertMessage(threadId, agentMsg);
      } else if (state.thread.kickoff?.mode === 'development') {
        const fallbackMsg: ChatMessage = {
          id: uuidv4(),
          role: 'agent',
          text: 'Agent run completed. Review the diff panel to see what changed — if more work is needed, send a follow-up message.',
          ts: new Date().toISOString(),
        };
        state.thread.messages.push(fallbackMsg);
        broadcast(state, { type: 'message', message: fallbackMsg });
        await pgInsertMessage(threadId, fallbackMsg);
      }

      state.thread.status = 'idle';
      if (!eventDrivenTerminationEnabled) {
        await publishRunEvent(state, agentRunId!, {
          type: 'status',
          status: 'idle',
        });
      }
      trackEvent('agent.run.completed', { threadId, model: resolvedModel });

      // Record usage event (fire-and-forget, never blocks)
      {
        const kickoff =
          state.thread.kickoff ??
          ({} as import('../../shared/types/chat').ChatThreadKickoff);
        const inputEst = estimateTokens(text ?? '');
        const outputEst = estimateTokens(agentTextBuffer ?? '');
        recordAiUsage({
          provider: 'cursor',
          modelId: resolvedModel,
          feature: resolveFeatureFromKickoff(kickoff),
          project: kickoff.project ?? 'unknown',
          skillPath: kickoff.skillPath ?? undefined,
          threadId,
          runId: agentRunId ?? undefined,
          workItemId:
            kickoff.workItemId != null ? String(kickoff.workItemId) : undefined,
          userId: state.thread.userId ?? undefined,
          inputTokens: inputEst,
          outputTokens: outputEst,
          tokenSource: 'estimated',
          costUsd: 0,
          costSource: 'estimated',
          status: 'success',
        });
      }

      break;
    }

    const prdContent = readOutputPrd(threadId);
    const backlogContent = readOutputBacklog(threadId);
    const prdReady = prdContent !== null;
    const backlogReady = backlogContent !== null;

    // Sync output artifacts directly to Postgres
    try {
      await syncOutputToDb(
        threadId,
        runtimeWorkspaceDir(state),
        agentTextBuffer
      );
    } catch (err) {
      console.error(
        `[chat] post-run DB sync failed for thread ${threadId}:`,
        err
      );
    }

    // Eagerly push dev-session branches to remote so they survive workspace loss
    try {
      await eagerPushDevSession(threadId, state.thread.kickoff);
    } catch (err) {
      console.warn(
        `[chat] eager dev-session push failed (non-fatal) for thread ${threadId}:`,
        (err as Error).message
      );
    }

    let completedRun = false;
    // @feature-flag:event-driven-run-termination start winner=enabled
    if (eventDrivenTerminationEnabled) {
      // @feature-flag:event-driven-run-termination enabled-start
      if (!terminalFinalized) {
        completedRun = await finalizeOwnerTerminal(
          state,
          agentRunId!,
          'completed',
          'Run completed',
          [
            {
              type: 'done',
              runId: state.thread.activeRunId,
              prdReady,
              backlogReady,
            },
          ]
        );
      }
      // @feature-flag:event-driven-run-termination enabled-end
    } else {
      // @feature-flag:event-driven-run-termination disabled-start
      const [legacyCompletedRun] = await db
        .update(agentRuns)
        .set({ status: 'completed', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(agentRuns.id, agentRunId),
            eq(agentRuns.ownerInstance, RUN_EVENT_SOURCE_INSTANCE),
            eq(agentRuns.status, 'running')
          )
        )
        .returning({ id: agentRuns.id })
        .catch((e) => {
          console.error('[chat] Failed to mark agent run completed:', e);
          return [];
        });
      completedRun = Boolean(legacyCompletedRun);
      // @feature-flag:event-driven-run-termination disabled-end
    }
    // @feature-flag:event-driven-run-termination end

    if (completedRun) {
      logMyWork('run.completed', {
        runId: agentRunId,
        model: resolvedModel,
        durationMs: Date.now() - runStartedAtMs,
        responseLength: agentTextBuffer.length,
        prdReady,
        backlogReady,
      });
      if (!eventDrivenTerminationEnabled) {
        await publishRunEvent(state, agentRunId!, {
          type: 'done',
          runId: state.thread.activeRunId,
          prdReady,
          backlogReady,
        });
      }
    }
    clearRunEventSequence(agentRunId!);
    lastTokenProgressWriteAt.delete(agentRunId!);
    eventDrivenRunIds.delete(agentRunId!);
    state.thread.activeRunId = undefined;
  } catch (err: unknown) {
    const ownerDeadline =
      !!err &&
      typeof err === 'object' &&
      '_ownerDeadline' in err &&
      Boolean((err as { _ownerDeadline?: unknown })._ownerDeadline);
    if (ownerDeadline) {
      state.thread.status = 'idle';
      state.thread.activeRunId = undefined;
      if (agentRunId) {
        clearRunEventSequence(agentRunId);
        lastTokenProgressWriteAt.delete(agentRunId);
        eventDrivenRunIds.delete(agentRunId);
      }
      persistThread(state.thread);
      return;
    }

    // Handle cross-worker cancellation without treating it as an error
    const cancelled =
      !!err &&
      typeof err === 'object' &&
      '_cancelled' in err &&
      Boolean((err as { _cancelled?: unknown })._cancelled);
    if (cancelled) {
      await forceDisposeThreadAgent(state, {
        clearCursorAgentId: true,
        reason: 'cross_worker_cancellation',
      });
      state.thread.status = 'idle';
      state.thread.activeRunId = undefined;
      if (agentRunId) {
        if (!eventDrivenTerminationEnabled) {
          await publishRunEvent(state, agentRunId, {
            type: 'status',
            status: 'idle',
          });
          await publishRunEvent(state, agentRunId, {
            type: 'done',
            runId: agentRunId,
          });
        }
        clearRunEventSequence(agentRunId);
        lastTokenProgressWriteAt.delete(agentRunId);
        eventDrivenRunIds.delete(agentRunId);
      } else {
        broadcast(state, { type: 'status', status: 'idle' });
        broadcast(state, { type: 'done' });
      }
      logMyWork(
        'run.cancelled',
        {
          runId: agentRunId,
          durationMs: Date.now() - runStartedAtMs,
          reason: 'cross_worker_cancellation',
        },
        'warn'
      );
      persistThread(state.thread);
      return;
    }

    logAgentError(threadId, err);

    const tier = classifyError(err);
    const rawMsg = sanitizeTerminalDetail(describeError(err));
    console.error(`[chat] Error tier=${tier} for thread ${threadId}:`, rawMsg);
    logMyWork(
      'run.failed',
      {
        runId: agentRunId,
        durationMs: Date.now() - runStartedAtMs,
        errorTier: tier,
        error: rawMsg,
        cursorAgentId: state.thread.cursorAgentId,
      },
      'error'
    );
    trackAgentError(threadId, new Error(rawMsg), {
      tier,
      model: state.thread.kickoff?.model ?? 'unknown',
    });

    if (state.agent) {
      await forceDisposeThreadAgent(state, {
        clearCursorAgentId: false,
        reason: `error_tier_${tier}`,
      });
    }

    switch (tier) {
      case 'transient': {
        // Retries exhausted — let user retry manually. Keep cursorAgentId for Agent.resume.
        state.thread.lastError = rawMsg;
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
        break;
      }
      case 'recoverable': {
        // Stale run / agent disposed / concurrent run — clear run state, keep cursorAgentId
        // unless it's a stale-run conflict (agent still owns a run we can't cancel).
        const isStaleRun =
          err instanceof Error &&
          err.message.includes('already has active run');
        state.thread.lastError = isStaleRun
          ? 'A previous run is still active on the agent. Please try again.'
          : rawMsg;
        if (isStaleRun) {
          state.thread.cursorAgentId = undefined;
        }
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
        break;
      }
      case 'fatal': {
        // Auth / config / agent-not-found — require user/admin action.
        state.thread.lastError = rawMsg;
        state.thread.cursorAgentId = undefined;
        state.thread.activeRunId = undefined;
        state.thread.status = 'error';
        break;
      }
    }

    const errorCode = mapErrorCode(tier, err);
    trackEvent('agent.run.errored', {
      threadId,
      errorTier: tier,
      errorCode,
      model: resolvedModel,
    });

    // Record error usage event (fire-and-forget)
    {
      const kickoff =
        state.thread?.kickoff ??
        ({} as import('../../shared/types/chat').ChatThreadKickoff);
      recordAiUsage({
        provider: 'cursor',
        modelId: resolvedModel,
        feature: resolveFeatureFromKickoff(kickoff),
        project: kickoff.project ?? 'unknown',
        skillPath: kickoff.skillPath ?? undefined,
        threadId,
        runId: agentRunId ?? undefined,
        userId: state.thread?.userId ?? undefined,
        inputTokens: 0,
        outputTokens: 0,
        tokenSource: 'estimated',
        costUsd: 0,
        costSource: 'estimated',
        status: 'error',
      });
    }

    if (agentRunId) {
      // @feature-flag:event-driven-run-termination start winner=enabled
      if (eventDrivenTerminationEnabled) {
        // @feature-flag:event-driven-run-termination enabled-start
        await finalizeOwnerTerminal(state, agentRunId, 'failed', rawMsg, [
          {
            type: 'error',
            error: state.thread.lastError ?? 'Unknown error',
            errorCode,
          },
          { type: 'done', runId: agentRunId },
        ]);
        // @feature-flag:event-driven-run-termination enabled-end
      } else {
        // @feature-flag:event-driven-run-termination disabled-start
        await db
          .update(agentRuns)
          .set({
            status: 'failed',
            lastError: rawMsg,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(agentRuns.id, agentRunId),
              eq(agentRuns.ownerInstance, RUN_EVENT_SOURCE_INSTANCE),
              eq(agentRuns.status, 'running')
            )
          )
          .execute()
          .catch((e) =>
            console.error('[chat] Failed to mark agent run failed:', e)
          );
        await publishRunEvent(state, agentRunId, {
          type: 'error',
          error: state.thread.lastError ?? 'Unknown error',
          errorCode,
        });
        await publishRunEvent(state, agentRunId, {
          type: 'done',
          runId: agentRunId,
        });
        // @feature-flag:event-driven-run-termination disabled-end
      }
      // @feature-flag:event-driven-run-termination end
      clearRunEventSequence(agentRunId);
      lastTokenProgressWriteAt.delete(agentRunId);
      eventDrivenRunIds.delete(agentRunId);
    } else {
      broadcast(state, {
        type: 'error',
        error: state.thread.lastError ?? 'Unknown error',
        errorCode,
      });
      broadcast(state, { type: 'done' });
    }

    try {
      await failGeneratingDocuments(threadId);
    } catch (fgErr) {
      console.error(
        `[chat] failGeneratingDocuments failed for thread ${threadId}:`,
        fgErr
      );
    }
  } finally {
    if (unsubscribeAbort) {
      unsubscribeAbort();
      unsubscribeAbort = null;
    }
    if (backgroundHeartbeatId !== null) {
      clearInterval(backgroundHeartbeatId);
      backgroundHeartbeatId = null;
    }
    mcpDeadlineController?.clear();
    mcpDeadlineController = null;
    // Clean up provisional liveness row if it was never replaced by the real one
    db.delete(agentRuns)
      .where(eq(agentRuns.id, provisionalRunId))
      .catch(() => {});
    if (heldLocalAgentSlot) {
      releaseLocalAgentSlot(threadId);
      heldLocalAgentSlot = false;
    }
    state.thread.lastActivityAt = new Date().toISOString();
    persistThread(state.thread);
    resetIdleTimer(state);
  }
}

/**
 * If the thread is marked running but no live agent_runs row remains (or the
 * run is health-dead), force it idle so the user can send again. Returns the
 * resulting gate state for message acceptance.
 */
export async function recoverStaleRunningThread(
  threadId: string
): Promise<'idle' | 'running' | 'missing'> {
  const alive = await isThreadRunAlive(threadId);
  if (alive) return 'running';

  const state = await ensureThreadState(threadId);
  if (!state) return 'missing';

  // Prefer DB truth — ensureThreadState may flip in-memory status to idle without
  // persisting, which previously left Postgres stuck at 'running' and 409'd forever.
  const [dbRow] = await db
    .select({
      status: chatThreads.status,
      activeRunId: chatThreads.activeRunId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  const stuckInDb = dbRow?.status === 'running' || Boolean(dbRow?.activeRunId);
  const stuckInMemory =
    state.thread.status === 'running' || Boolean(state.thread.activeRunId);

  if (stuckInDb || stuckInMemory) {
    console.warn(
      `[chat] recoverStaleRunningThread — clearing dead running state (threadId=${threadId})`
    );
    await forceDisposeThreadAgent(state, {
      clearCursorAgentId: false,
      reason: 'stale_running_recovery',
    });
    await clearStaleRun(threadId);
    state.thread.status = 'idle';
    state.thread.activeRunId = undefined;
    await reevaluateThreadGroundingForRecovery(threadId);
  }
  return 'idle';
}

export async function cancelRun(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) return;

  let activeRunId = state.thread.activeRunId;
  if (!activeRunId) {
    // Recovery/desync may have cleared active_run_id while agent_runs is still live.
    const latest = await db.query.agentRuns.findFirst({
      where: and(
        eq(agentRuns.threadId, threadId),
        inArray(agentRuns.status, ['queued', 'running'])
      ),
      orderBy: [desc(agentRuns.createdAt)],
      columns: { id: true },
    });
    activeRunId = latest?.id;
  }
  if (!activeRunId) {
    if (state.thread.status === 'running' || state.thread.activeRunId) {
      state.thread.status = 'idle';
      state.thread.activeRunId = undefined;
      broadcast(state, { type: 'status', status: 'idle' });
      broadcast(state, { type: 'done' });
      persistThread(state.thread);
    }
    // Always persist idle in DB — memory and Postgres can desync across instances.
    await clearStaleRun(threadId);
    return;
  }
  const myWorkContext = state.isDevSession
    ? await getMyWorkSessionContext(threadId).catch(() => null)
    : null;
  if (myWorkContext) {
    logMyWorkSession('run.cancel_requested', {
      ...myWorkContext,
      runId: activeRunId,
    });
  }

  const eventDrivenTerminationEnabled = await isFeatureEnabled(
    'event-driven-run-termination',
    {
      userId: state.thread.userId,
      project: state.thread.kickoff.project,
    }
  ).catch(() => false);
  // @feature-flag:event-driven-run-termination start winner=enabled
  if (eventDrivenTerminationEnabled) {
    // @feature-flag:event-driven-run-termination enabled-start
    const timestamp = new Date().toISOString();
    const cancelEnvelope: AgentRunEventEnvelope = {
      eventId: uuidv4(),
      threadId,
      runId: activeRunId,
      sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
      sequence: nextRunEventSequence(activeRunId),
      timestamp,
      type: 'cancel',
      phase: 'completion',
      status: 'cancelled',
      detail: 'Run cancelled by user',
      event: { type: 'cancel' },
    };
    await finalizeReconciledAgentRun({
      runId: activeRunId,
      threadId,
      status: 'cancelled',
      detail: 'Run cancelled by user',
      events: [cancelEnvelope],
    }).catch((error) => {
      console.error(
        '[chat] Failed to finalize run cancellation:',
        (error as Error).message
      );
      return false;
    });
    // @feature-flag:event-driven-run-termination enabled-end
  } else {
    // @feature-flag:event-driven-run-termination disabled-start
    const [cancelledRun] = await db
      .update(agentRuns)
      .set({
        status: 'cancelled',
        cancelRequested: true,
        cancelState: 'requested',
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(agentRuns.id, activeRunId),
          inArray(agentRuns.status, ['queued', 'running'])
        )
      )
      .returning({ id: agentRuns.id })
      .catch((e) => {
        console.error('[chat] Failed to mark agent run cancelled:', e);
        return [];
      });

    if (cancelledRun) {
      await publishRunCancellation(threadId, activeRunId).catch((err) => {
        console.error(
          '[chat] Failed to fan out run cancellation:',
          (err as Error).message
        );
      });
    }
    // @feature-flag:event-driven-run-termination disabled-end
  }
  // @feature-flag:event-driven-run-termination end

  // Cancel the SDK run and force-dispose the in-memory agent on this instance.
  // Dispose is required: cancel alone leaves Cursor holding an active run, and
  // the next send surfaces "A previous run is still active on the agent."
  await cancelSdkRunBestEffort(state, activeRunId);
  await forceDisposeThreadAgent(state, {
    clearCursorAgentId: true,
    reason: 'user_or_api_cancel',
  });

  state.thread.status = 'idle';
  state.thread.activeRunId = undefined;
  if (!eventDrivenTerminationEnabled) {
    broadcast(state, { type: 'status', status: 'idle' });
    broadcast(state, { type: 'done' });
  }
  clearRunEventSequence(activeRunId);
  lastTokenProgressWriteAt.delete(activeRunId);
  eventDrivenRunIds.delete(activeRunId);
  persistThread(state.thread);
  await clearStaleRun(threadId);
  if (myWorkContext) {
    logMyWorkSession(
      'run.cancelled',
      {
        ...myWorkContext,
        runId: activeRunId,
        reason: 'user_requested',
      },
      'warn'
    );
  }
}

export async function closeThread(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) return;

  if (state.idleTimer) clearTimeout(state.idleTimer);

  if (state.agent) {
    await state.agent[Symbol.asyncDispose]().catch(() => {});
    state.agent = null;
  }
  const grounding = state.grounding;
  state.grounding = null;
  state.groundingInFlight = null;
  state.groundingWorkspaceDir = null;
  await grounding?.release().catch(() => undefined);

  // For dev sessions with unpushed changes: evict from memory (free resources)
  // but leave the thread status as-is (idle) and preserve the workspace.
  // This lets users log out, navigate away, or hit the idle timeout and then
  // return to find their session intact and the textarea still enabled.
  if (state.thread.kickoff?.mode === 'development') {
    const session = await db.query.devSessions.findFirst({
      where: eq(devSessions.chatThreadId, threadId),
      columns: { status: true, branchPushed: true },
    });
    if (session) {
      const isActive =
        session.status === 'in_progress' ||
        session.status === 'setting_up' ||
        session.status === 'conflict';
      const hasUnpushed = !session.branchPushed;
      if (isActive || hasUnpushed) {
        console.log(
          `[chat] Dev session thread ${threadId}: evicting from memory (idle timeout), keeping workspace and thread status intact (unpushed changes)`
        );
        threads.delete(threadId);
        return;
      }
    }
  }

  // Persist status=closed so history survives idle eviction and server restarts.
  state.thread.status = 'closed';
  await pgUpsertThread(state.thread);

  threads.delete(threadId);

  try {
    fs.rmSync(state.thread.workspaceDir, { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
}

/**
 * Permanently delete a thread from memory, workspace, AND PostgreSQL.
 * Only used for explicit user-initiated deletion (DELETE route).
 */
export async function permanentlyDeleteThread(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);

  if (state) {
    if (state.idleTimer) clearTimeout(state.idleTimer);

    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }
    const grounding = state.grounding;
    state.grounding = null;
    state.groundingInFlight = null;
    state.groundingWorkspaceDir = null;
    await grounding?.release().catch(() => undefined);

    threads.delete(threadId);

    try {
      fs.rmSync(state.thread.workspaceDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  }

  await pgDeleteThread(threadId);
}

function resolveOutputDir(threadId: string): string | null {
  const override = outputWorkspaceContext.getStore();
  if (override?.threadId === threadId) {
    return path.join(override.workspaceDir, '.ai-pilot', 'output');
  }
  const state = threads.get(threadId);
  if (state)
    return path.join(runtimeWorkspaceDir(state), '.ai-pilot', 'output');
  return null;
}

/**
 * Read the output PRD from the ephemeral workspace.
 */
export function readOutputPrd(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const named = findOutputFile(outputDir, /\.prd\.md$/i);
  if (named) return fs.readFileSync(named, 'utf-8');
  const legacy = path.join(outputDir, 'PRD.md');
  return fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf-8') : null;
}

/** Read a generated MADR document from the ephemeral workspace. */
export function readOutputAdr(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /\.adr\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

/**
 * Returns true if a PRD output file exists in the ephemeral workspace.
 * Cheaper than readOutputPrd — does not read file contents.
 */
export function isPrdReady(threadId: string): boolean {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return false;
  const named = findOutputFile(outputDir, /\.prd\.md$/i);
  if (named) return true;
  return fs.existsSync(path.join(outputDir, 'PRD.md'));
}

/**
 * Read the output backlog JSON from the ephemeral workspace.
 */
export function readOutputBacklog(threadId: string): unknown | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /\.backlog\.json$/i);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Read the main design doc output ({feature-slug}-design.md) from the ephemeral workspace.
 * Returns the first matching file (used by Q&A / validation threads which operate on a single doc).
 */
export function readOutputDesignDoc(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /[-.]design\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

/**
 * Read the tech spec output ({feature-slug}-tech-spec.md) from the ephemeral workspace.
 * Returns the first matching file (used by Q&A / validation threads which operate on a single doc).
 */
export function readOutputTechSpec(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /[-.]tech-spec\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

/**
 * Read the assumptions output ({feature-slug}-assumptions.md) from the ephemeral workspace.
 * Returns the first matching file (used by Q&A / validation threads which operate on a single doc).
 */
export function readOutputAssumptions(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /[-.]assumptions\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

/**
 * Read all per-feature design doc output sets from the ephemeral workspace.
 * Returns one entry per feature for which all three files (design, tech-spec, assumptions)
 * are present. Results are sorted alphabetically by slug.
 */
export function readAllOutputDesignDocFeatures(threadId: string): Array<{
  slug: string;
  design: string;
  techSpec: string;
  assumptions: string;
}> {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return [];

  const designFiles = findAllOutputFiles(outputDir, /[-.]design\.md$/i);
  const results: Array<{
    slug: string;
    design: string;
    techSpec: string;
    assumptions: string;
  }> = [];

  for (const designFile of designFiles) {
    const slug = path.basename(designFile).replace(/[-.]design\.md$/i, '');
    const techSpecFile = designFile.replace(
      /[-.]design\.md$/i,
      '-tech-spec.md'
    );
    const assumptionsFile = designFile.replace(
      /[-.]design\.md$/i,
      '-assumptions.md'
    );

    if (!fs.existsSync(techSpecFile) || !fs.existsSync(assumptionsFile))
      continue;

    try {
      results.push({
        slug,
        design: fs.readFileSync(designFile, 'utf-8').trim(),
        techSpec: fs.readFileSync(techSpecFile, 'utf-8').trim(),
        assumptions: fs.readFileSync(assumptionsFile, 'utf-8').trim(),
      });
    } catch {
      /* skip unreadable files */
    }
  }

  return results;
}

/**
 * Read the human-readable validation scorecard (review-scorecard.md) from the ephemeral workspace.
 */
export function readOutputValidationScorecardMd(
  threadId: string
): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const found = findOutputFile(outputDir, /review-scorecard\.md$/);
  return found ? fs.readFileSync(found, 'utf-8') : null;
}

/**
 * Read the validation scorecard (review-scorecard.json) from the ephemeral workspace.
 */
export function readOutputValidationScorecard(threadId: string): string | null {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const found = findOutputFile(outputDir, /review-scorecard\.json$/);
  return found ? fs.readFileSync(found, 'utf-8') : null;
}
