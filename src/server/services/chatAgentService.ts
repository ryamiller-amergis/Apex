import { Agent, CursorAgentError } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk/dist/cjs/agent.js';
import type { McpServerConfig } from '@cursor/sdk/dist/cjs/options.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type {
  ChatAttachment,
  ChatAttachmentMeta,
  ChatThread,
  ChatMessage,
  ChatThreadKickoff,
  SseEvent,
  SseErrorCode,
} from '../../shared/types/chat';
import { isAzureWwwroot, resolveDataRoot } from '../utils/dataDir';
import {
  upsertThread as pgUpsertThread,
  insertMessage as pgInsertMessage,
  listThreadsByUser as pgListThreadsByUser,
  loadFullThread as pgLoadFullThread,
  deleteThread as pgDeleteThread,
} from './chatThreadRepository';
import { db } from '../db/drizzle';
import { and, eq, isNull, or } from 'drizzle-orm';
import { interviews, prds, designDocs, testCases } from '../db/schema';
import { syncPrdContent } from './prdService';
import { notifyAiCompletion } from './aiCompletionNotifier';
import { syncDesignDocContent, syncValidationResult, syncPerFeatureDesignDocs } from './designDocService';
import { markTestCaseFailed, syncTestCaseOutput, triggerTestCaseGeneration } from './testCaseService';
import type { ValidationScorecard } from '../../shared/types/interview';
import type { ChatThreadSummary } from '../../shared/types/chat';
import { retryWithBackoff } from '../utils/retry';
import { trackAgentError, trackEvent } from './telemetry';

// ── Configuration ─────────────────────────────────────────────────────────────

const DATA_ROOT = resolveDataRoot();
const WORKSPACE_BASE = process.env.AI_PILOT_WORKSPACE_DIR
  ? path.resolve(process.env.AI_PILOT_WORKSPACE_DIR)
  : isAzureWwwroot()
    ? path.join(DATA_ROOT, 'workspaces')
    : path.join(os.tmpdir(), 'ai-pilot-workspaces');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const INTERVIEW_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// ── In-memory state ───────────────────────────────────────────────────────────

interface ThreadState {
  thread: ChatThread;
  /** SSE subscriber callbacks for this thread */
  subscribers: Set<(event: SseEvent) => void>;
  /** Live Cursor SDK agent — null between turns */
  agent: SDKAgent | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Cached flag — true when the thread backs an interview row (gets longer idle timeout) */
  isInterviewThread: boolean;
}

const threads = new Map<string, ThreadState>();

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
        results.push(...findAllOutputFiles(path.join(dir, entry.name), pattern));
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
    console.error('[chat] pg upsertThread failed:', err.message),
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
      console.warn(`[chat] ${context}: workspace does not exist (${workspaceDir})`);
      return;
    }
    const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
    if (!fs.existsSync(outputDir)) {
      console.warn(`[chat] ${context}: output dir does not exist (${outputDir})`);
      const topLevel = fs.readdirSync(workspaceDir, { recursive: true }) as string[];
      console.warn(`[chat] ${context}: workspace files: ${topLevel.slice(0, 30).join(', ')}`);
      return;
    }
    const outputFiles = fs.readdirSync(outputDir, { recursive: true }) as string[];
    console.warn(`[chat] ${context}: output dir files (${outputFiles.length}): ${outputFiles.slice(0, 30).join(', ')}`);
  } catch {
    console.warn(`[chat] ${context}: failed to list workspace contents`);
  }
}

function cleanupStaleWorkspaces() {
  if (!fs.existsSync(WORKSPACE_BASE)) return;
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const dir of fs.readdirSync(WORKSPACE_BASE)) {
    const sessionFile = path.join(WORKSPACE_BASE, dir, '.ai-pilot', 'session.json');
    if (fs.existsSync(sessionFile)) {
      const stat = fs.statSync(sessionFile);
      if (stat.mtimeMs < twoHoursAgo) {
        fs.rmSync(path.join(WORKSPACE_BASE, dir), { recursive: true, force: true });
      }
    }
  }
}

function injectKickoffFiles(workspaceDir: string, kickoff: ChatThreadKickoff, threadId: string): void {
  const aiPilotDir = path.join(workspaceDir, '.ai-pilot');
  fs.mkdirSync(aiPilotDir, { recursive: true });
  fs.mkdirSync(path.join(aiPilotDir, 'output'), { recursive: true });

  if (kickoff.transcript) {
    fs.writeFileSync(
      path.join(aiPilotDir, 'kickoff-transcript.md'),
      kickoff.transcript,
      'utf-8',
    );
  }

  if (kickoff.freeformContext) {
    fs.writeFileSync(
      path.join(aiPilotDir, 'kickoff-context.md'),
      kickoff.freeformContext,
      'utf-8',
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
      2,
    ),
    'utf-8',
  );
}

function sanitizeAttachmentName(name: string, index: number): string {
  const fallback = `attachment-${index + 1}.txt`;
  const baseName = path.basename(name || fallback);
  const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return sanitized || fallback;
}

function writeMessageAttachments(
  workspaceDir: string,
  turnId: string,
  attachments: ChatAttachment[],
): ChatAttachmentMeta[] {
  if (attachments.length === 0) return [];

  const attachmentsDir = path.join(workspaceDir, '.ai-pilot', 'attachments', turnId);
  fs.mkdirSync(attachmentsDir, { recursive: true });

  return attachments.map((attachment, index) => {
    const fileName = `${String(index + 1).padStart(2, '0')}-${sanitizeAttachmentName(attachment.name, index)}`;
    const absolutePath = path.join(attachmentsDir, fileName);
    if (attachment.encoding === 'base64') {
      fs.writeFileSync(absolutePath, Buffer.from(attachment.content, 'base64'));
    } else {
      fs.writeFileSync(absolutePath, attachment.content, 'utf-8');
    }

    return {
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      path: path.posix.join('.ai-pilot', 'attachments', turnId, fileName),
    };
  });
}

function buildPromptWithAttachments(text: string, attachments: ChatAttachmentMeta[]): string {
  if (attachments.length === 0) return text;

  const messageText = text.trim() || 'Please use the uploaded files as additional context.';
  const attachmentLines = attachments.map((attachment) => {
    const isImage = attachment.type.startsWith('image/');
    const hint = isImage ? ' [IMAGE -- use the Read tool to view this file]' : '';
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

/**
 * Build the mcpServers map for the Cursor SDK agent.
 * Always includes ado-skills; conditionally adds any MCP pill selected for this thread.
 * Supports both HTTP and stdio transport (matching the SDK's McpServerConfig union type).
 */
function buildMcpServers(kickoff: ChatThreadKickoff, adoSkillsUrl: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {
    'ado-skills': { url: adoSkillsUrl },
  };

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

  return servers;
}

function buildFreeChatPrompt(kickoff: ChatThreadKickoff): string {
  const branch = kickoff.branch ?? 'main';
  const parts: string[] = [
    `# Sandbox workspace`,
    `You are running in an isolated sandbox. The current working directory contains only a \`.ai-pilot/\` scratch folder.`,
    `It is NOT a clone of the project repo. Project files live in the ADO repo and must be fetched via MCP — never search the local filesystem for them.`,
    ``,
    `# Session context`,
    `  project: "${kickoff.project}"`,
    `  repo:    "${kickoff.repo}"`,
    `  branch:  "${branch}"`,
    ``,
    `# Available MCP tools (via \`ado-skills\` server)`,
    `- \`get_skill\`       — load a SKILL.md from the repo`,
    `- \`list_repo_dir\`   — browse repo directory structure`,
    `- \`get_skill_file\`  — read any file from the repo`,
    `- \`search_repo_code\`— search code in the repo`,
    ``,
    `# Free-chat mode`,
    `You are in open-ended assistant mode. Help the user with whatever they need: questions, code analysis, design discussions, writing, etc.`,
    ``,
    `If the user asks you to run or load a skill (e.g. "run the PRD skill" or "load skill at \`.cursor/skills/to-prd/SKILL.md\`"), call \`get_skill\` with the path they provide and the project/repo/branch above, then follow the skill's procedure.`,
    ``,
    `If the user sends a message like "Run skill: <name> (<path>)", call \`get_skill\` with that path and proceed.`,
  ];

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    parts.push(
      ``,
      `# Additional MCP server: \`${pill.mcpServerName}\``,
      pill.systemPromptHint ?? `You have access to the \`${pill.mcpServerName}\` MCP server. Use its tools to help the user.`,
    );
  }

  if (kickoff.freeformContext) {
    if (kickoff.assistantType === 'prd') {
      // Extract prd_id and thread_id from the freeform context so the agent
      // has them directly in the system prompt — no file-read required.
      const prdIdMatch = kickoff.freeformContext.match(/^prd_id:\s*(\S+)/m);
      const threadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
      const prdId = prdIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      const threadId = threadIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      parts.push(
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
        `Only call \`update_prd\` for the artifact(s) that actually own the changed field — often a single call is correct.`,
        ``,
        `- \`resolve_prd_comment\` — call this after addressing a review comment to mark it resolved.`,
        `  Pass the \`comment_id\` from the Review Comments section in \`.ai-pilot/kickoff-context.md\`.`,
        ``,
        `# Addressing review comments`,
        `When the user asks you to address comments: read the Review Comments section, revise the relevant content,`,
        `call \`update_prd\`, then call \`resolve_prd_comment\` for each comment addressed.`,
        `Confirm what was changed and which comments were resolved.`,
      );
    } else {
      const docIdMatch = kickoff.freeformContext.match(/^doc_id:\s*(\S+)/m);
      const docThreadIdMatch = kickoff.freeformContext.match(/^thread_id:\s*(\S+)/m);
      const docId = docIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      const docThreadId = docThreadIdMatch?.[1] ?? '(unknown — read from .ai-pilot/kickoff-context.md)';
      parts.push(
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
      );
    }
  }

  if (kickoff.transcript) {
    parts.push(
      ``,
      `# Kickoff transcript`,
      `A prior conversation transcript has been written to \`.ai-pilot/kickoff-transcript.md\`. Read it as additional context.`,
    );
  }

  return parts.join('\n');
}

function buildInitialPrompt(kickoff: ChatThreadKickoff): string {
  if (!kickoff.skillPath) {
    return buildFreeChatPrompt(kickoff);
  }

  const branch = kickoff.branch ?? 'main';
  const parts: string[] = [
    `# Sandbox`,
    `You are running in an isolated sandbox workspace. The current working directory contains ONLY a \`.ai-pilot/\` scratch folder for kickoff inputs and final outputs.`,
    `Repo files (CONTEXT.md, AGENTS.md, sibling skills, schemas, ADRs, etc.) are NOT on the local filesystem — they live in the ADO repo and must be fetched via the \`ado-skills\` MCP server. Do not search the local filesystem for them.`,
    ``,
    `# MCP tools (ado-skills server)`,
    `- \`get_skill\`        — load a SKILL.md from the repo`,
    `- \`list_repo_dir\`    — browse repo directory structure`,
    `- \`get_skill_file\`   — read any file from the repo`,
    `- \`search_repo_code\` — search code in the repo`,
    ``,
    `# Your task`,
    `Call \`get_skill\` with the following parameters to load the skill:`,
    `  project: "${kickoff.project}"`,
    `  repo:    "${kickoff.repo}"`,
    `  path:    "${kickoff.skillPath}"`,
    `  branch:  "${branch}"`,
    ``,
    `Then follow the skill's instructions exactly and completely. The skill defines everything:`,
    `which repo files to load, how to interact with the user, what to produce, and when to produce it.`,
    `Do not add steps, skip steps, or modify the skill's behavior in any way.`,
    ``,
    `When the skill instructs you to write output files, write them to \`.ai-pilot/output/\``,
    `using the exact filenames the skill specifies.`,
    ``,
    `# UI rendering note`,
    `When the skill asks the user questions with multiple-choice options, format each option`,
    `as \`a. text\`, \`b. text\`, etc. on its own line — the chat UI renders these as clickable`,
    `buttons. This is a rendering hint only; it does not change when, whether, or how many`,
    `questions the skill asks.`,
  ];

  if (kickoff.transcript) {
    parts.push(
      ``,
      `# Kickoff transcript`,
      `A prior conversation transcript has been written to \`.ai-pilot/kickoff-transcript.md\`.`,
      `Read it as input context before executing the skill. Follow the skill's own instructions`,
      `for how to use prior context.`,
    );
  }

  if (kickoff.freeformContext) {
    parts.push(
      ``,
      `# Additional context`,
      `Additional user-provided context has been written to \`.ai-pilot/kickoff-context.md\`. Read it as well.`,
    );
  }

  if (kickoff.mcpPill) {
    const pill = kickoff.mcpPill;
    parts.push(
      ``,
      `# Additional MCP server: \`${pill.mcpServerName}\``,
      pill.systemPromptHint ?? `You have access to the \`${pill.mcpServerName}\` MCP server. Use its tools when helpful.`,
    );
  }

  return parts.join('\n');
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────

function broadcast(state: ThreadState, event: SseEvent) {
  for (const cb of state.subscribers) {
    try { cb(event); } catch { /* subscriber gone */ }
  }
}

// ── Idle cleanup ──────────────────────────────────────────────────────────────

function resetIdleTimer(state: ThreadState) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  const timeout = state.isInterviewThread ? INTERVIEW_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
  state.idleTimer = setTimeout(() => closeThread(state.thread.id), timeout);
}

async function checkIsInterviewThread(threadId: string): Promise<boolean> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
    columns: { id: true },
  });
  return row !== undefined;
}

/**
 * Returns a label (e.g. "prd", "design_doc") if this thread is referenced by
 * a PRD or design doc row, or null if it's a standalone chat thread.
 *
 * Used by closeThread to avoid deleting the chat_threads row when an
 * ON DELETE CASCADE FK would silently destroy the parent document.
 */
async function threadBacksDocument(threadId: string): Promise<string | null> {
  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
    columns: { id: true },
  });
  if (prdRow) return 'prd';

  const ddRow = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.qaChatThreadId, threadId),
      eq(designDocs.docAssistantThreadId, threadId),
      eq(designDocs.validationThreadId, threadId),
    ),
    columns: { id: true },
  });
  if (ddRow) return 'design_doc';

  return null;
}

/**
 * Return live ThreadState from memory, or hydrate from Postgres (e.g. after server restart).
 */
async function ensureThreadState(threadId: string): Promise<ThreadState | null> {
  const existing = threads.get(threadId);
  if (existing) return existing;

  const thread = await loadThread(threadId);
  if (!thread) return null;

  // A thread persisted as 'running' means the server was killed mid-run.
  // Reset it to 'idle' so the client input isn't permanently locked out.
  if (thread.status === 'running') {
    thread.status = 'idle';
    thread.activeRunId = undefined;
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
        (err as Error).message,
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
  options?: { skipAutoKickoff?: boolean; kickoffMessage?: string },
): Promise<ChatThread> {
  ensureDirs();

  const threadId = uuidv4();
  const workspaceDir = path.join(WORKSPACE_BASE, threadId);

  // Resolve branch
  const branch = kickoff.branch ?? 'main';
  const resolvedKickoff = { ...kickoff, branch };

  // Create a minimal workspace — skills are fetched via MCP (ADO API), not from disk.
  fs.mkdirSync(workspaceDir, { recursive: true });
  injectKickoffFiles(workspaceDir, resolvedKickoff, threadId);

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
      console.log('[chat] auto-kickoff firing', { threadId, skillPath: kickoff.skillPath });
      sendMessage(threadId, msg, undefined, [], { hidden: true }).then(() => {
        console.log('[chat] auto-kickoff completed', { threadId });
      }).catch((err: Error) => {
        console.error('[chat] Auto-kickoff failed for thread', threadId, ':', err.message);
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
export function updateThreadKickoffContext(threadId: string, freeformContext: string): void {
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
  opts?: { limit?: number; offset?: number },
): Promise<ChatThreadSummary[]> {
  return pgListThreadsByUser(userId, opts);
}

export function listThreads(userId: string): ChatThread[] {
  return Array.from(threads.values())
    .map((s) => s.thread)
    .filter((t) => t.userId === userId)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

export function subscribeToThread(
  threadId: string,
  callback: (event: SseEvent) => void,
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
  return /\b(auth(entication|orization)?|unauthorized|forbidden|invalid.{0,20}(key|token|credential|config|agent)|agent.{0,10}not.found)\b/.test(lower);
}

/** Detect transient SDK / network errors worth retrying. */
export function isTransientSdkError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('already has active run')) return false;

  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 401 || statusCode === 403) return false;
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 429) return false;
  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) return true;

  if (err instanceof Error) {
    const code = (err as any).code;
    if (typeof code === 'string' && /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|ECONNREFUSED)$/.test(code)) {
      return true;
    }
  }

  return false;
}

/** Detect recoverable errors: stale run, agent disposed, concurrent run conflicts. */
export function isRecoverableSdkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return /already has active run|stale.*run|agent.*disposed|run.*expired|agent.*not.*available/.test(msg);
}

/**
 * Detect fatal SDK errors: auth failures, invalid config, agent not found.
 * Unlike `isFatalRunError` which checks run result text, this checks thrown exceptions.
 */
export function isFatalSdkError(err: unknown): boolean {
  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 401 || statusCode === 403) return true;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return /\b(auth(entication|orization)?|unauthorized|forbidden|invalid.{0,20}(key|token|credential|config|agent)|agent.{0,10}not.found)\b/.test(msg);
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
  const statusCode = (err as any)?.statusCode || (err as any)?.status;
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
  const statusCode = (err as any)?.statusCode || (err as any)?.status;
  if (statusCode === 401 || statusCode === 403) return true;
  if (err instanceof Error) {
    return /\b(auth(entication|orization)?|unauthorized|forbidden)\b/i.test(err.message);
  }
  return false;
}

function logAgentError(threadId: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`[chat] Agent failed for thread ${threadId}:`, {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: (err as any).cause,
      retryable: (err as any).isRetryable,
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
async function syncOutputToDb(threadId: string, workspaceDir: string): Promise<void> {
  let fullySynced = false;

  // Check if this thread belongs to a test-case generation run
  const testCaseRow = await db.query.testCases.findFirst({
    where: eq(testCases.chatThreadId, threadId),
  });
  if (testCaseRow) {
    const synced = await syncTestCaseOutput(testCaseRow.id, testCaseRow.prdId, threadId);
    if (!synced && testCaseRow.status === 'generating') {
      logWorkspaceContents(workspaceDir, `test-case no-output (testCaseId=${testCaseRow.id})`);
      await markTestCaseFailed(testCaseRow.id, testCaseRow.prdId, threadId);
      console.warn(`[chat] post-run: test-case agent produced no output — marked failed (testCaseId=${testCaseRow.id})`);
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
    if (content) {
      await syncPrdContent(prdRow.id, content, backlog ?? undefined);
      console.log(`[chat] post-run: synced PRD output to DB (prdId=${prdRow.id})`);
      notifyAiCompletion('prd_generated', prdRow.id, { title: prdRow.title }).catch(err =>
        console.error(`[chat] AI notification failed for prd_generated (prdId=${prdRow.id}):`, err),
      );
      fullySynced = content !== null && backlog !== null;
    } else if (prdRow.status === 'generating') {
      logWorkspaceContents(workspaceDir, `PRD no-output (prdId=${prdRow.id})`);
      await db.update(prds)
        .set({ status: 'draft', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prdRow.id), eq(prds.status, 'generating')));
      console.warn(`[chat] post-run: agent produced no PRD output — reset to draft (prdId=${prdRow.id})`);
    }
    if (fullySynced) {
      try {
        const testCaseStarted = await triggerTestCaseGeneration(prdRow.id, threadId);
        if (!testCaseStarted) {
          // If no test case skill, check if PRD validation can start
          try {
            const { arePrdValidationArtifactsReady, autoStartPrdValidation } = await import('./prdService');
            const ready = await arePrdValidationArtifactsReady(prdRow.id);
            if (ready) await autoStartPrdValidation(prdRow.id);
          } catch { /* non-fatal */ }
          cleanupWorkspaceDir(workspaceDir);
        }
      } catch (err) {
        console.error(`[chat] post-run: auto test-case generation failed (prdId=${prdRow.id})`, err);
        cleanupWorkspaceDir(workspaceDir);
      }
    }
    return;
  }

  // Check if this thread belongs to a design doc (generation thread)
  const ddGenRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.chatThreadId, threadId),
  });
  if (ddGenRow) {
    await syncPerFeatureDesignDocs(ddGenRow.id, ddGenRow.prdId, ddGenRow.project, ddGenRow.authorId, threadId);
    console.log(`[chat] post-run: synced per-feature design docs to DB (prdId=${ddGenRow.prdId})`);
    return;
  }

  // Fallback: the watcher may have nulled chatThreadId prematurely while the
  // agent was still running. If the workspace has feature triplets, look for
  // the seed doc in generating status (chatThreadId=NULL) and sync the features.
  const orphanFeatures = readAllOutputDesignDocFeatures(threadId);
  if (orphanFeatures.length > 0) {
    const seedRow = await db.query.designDocs.findFirst({
      where: and(eq(designDocs.status, 'generating'), isNull(designDocs.chatThreadId)),
      columns: { id: true, prdId: true, project: true, authorId: true },
    });
    if (seedRow) {
      await syncPerFeatureDesignDocs(seedRow.id, seedRow.prdId, seedRow.project, seedRow.authorId, threadId);
      console.log(`[chat] post-run: synced ${orphanFeatures.length} orphan features to DB (seedDocId=${seedRow.id})`);
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
          console.log(`[chat] post-run: discarded stale validation scorecard — thread ${threadId} no longer active (designDocId=${ddValRow.id})`);
          cleanupWorkspaceDir(workspaceDir);
          return;
        }
        const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
        const reportMd = readOutputValidationScorecardMd(threadId) ?? undefined;
        await syncValidationResult(ddValRow.id, scorecard, reportMd);
        console.log(`[chat] post-run: synced validation scorecard to DB (designDocId=${ddValRow.id})`);
        fullySynced = true;
      } catch (err) {
        console.error(`[chat] post-run: failed to parse validation scorecard`, err);
      }
    } else {
      // Agent completed (success path) but wrote no scorecard file.
      // Reset the doc from 'validating' → 'draft' so the user can re-run.
      // The WHERE status='validating' guard prevents overwriting an already-scored doc.
      const freshDoc = await db.query.designDocs.findFirst({
        where: eq(designDocs.id, ddValRow.id),
        columns: { validationThreadId: true, status: true },
      });
      if (freshDoc?.validationThreadId === threadId && freshDoc?.status === 'validating') {
        await db.update(designDocs)
          .set({ status: 'draft', updatedAt: new Date().toISOString() })
          .where(eq(designDocs.id, ddValRow.id));
        console.warn(`[chat] post-run: validation agent wrote no scorecard, reset to draft (designDocId=${ddValRow.id})`);
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
      console.log(`[chat] post-run: synced doc-assistant output to DB (designDocId=${ddAssistantRow.id})`);
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
          console.log(`[chat] post-run: discarded stale PRD validation scorecard — thread ${threadId} no longer active (prdId=${prdValRow.id})`);
          cleanupWorkspaceDir(workspaceDir);
          return;
        }
        const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
        const reportMd = readOutputValidationScorecardMd(threadId) ?? undefined;
        const { generateFallbackReport } = await import('./documentValidationService');
        const effectiveReportMd = reportMd ?? generateFallbackReport(scorecard);
        const newStatus = scorecard.is_ready ? 'pending_review' : 'draft';
        await db.update(prds)
          .set({
            validationScore: Math.round(scorecard.overall_score),
            validationScorecard: scorecard,
            validationPhase: scorecard.review_phase,
            validationReportMd: effectiveReportMd,
            status: newStatus,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(prds.id, prdValRow.id));
        console.log(`[chat] post-run: synced PRD validation scorecard to DB (prdId=${prdValRow.id})`);
        fullySynced = true;
      } catch (err) {
        console.error(`[chat] post-run: failed to parse PRD validation scorecard`, err);
      }
    } else {
      const freshPrd = await db.query.prds.findFirst({
        where: eq(prds.id, prdValRow.id),
        columns: { validationThreadId: true, status: true },
      });
      if (freshPrd?.validationThreadId === threadId && freshPrd?.status === 'validating') {
        await db.update(prds)
          .set({ status: 'draft', updatedAt: new Date().toISOString() })
          .where(eq(prds.id, prdValRow.id));
        console.warn(`[chat] post-run: PRD validation agent wrote no scorecard, reset to draft (prdId=${prdValRow.id})`);
      }
      fullySynced = true;
    }
    if (fullySynced) cleanupWorkspaceDir(workspaceDir);
    return;
  }

  // Check if this thread is a Q&A thread
  const ddQaRow = await db.query.designDocs.findFirst({
    where: eq(designDocs.qaChatThreadId, threadId),
  });
  if (ddQaRow) {
    // Try multi-feature output first — the agent may have written per-feature triplets
    const features = readAllOutputDesignDocFeatures(threadId);
    if (features.length > 1) {
      await syncPerFeatureDesignDocs(ddQaRow.id, ddQaRow.prdId, ddQaRow.project, ddQaRow.authorId, threadId);
      console.log(`[chat] post-run: synced ${features.length} per-feature design docs from Q&A (prdId=${ddQaRow.prdId})`);
      fullySynced = true;
    } else {
      // Single-feature fallback — write to the seed row directly
      const design = readOutputDesignDoc(threadId);
      const techSpec = readOutputTechSpec(threadId);
      const assumptions = readOutputAssumptions(threadId);
      if (design || techSpec || assumptions) {
        const syncOpts: Parameters<typeof syncDesignDocContent>[1] = {};
        if (design) syncOpts.designContent = design;
        if (techSpec) syncOpts.techSpecContent = techSpec;
        if (assumptions) syncOpts.assumptionsContent = assumptions;
        await syncDesignDocContent(ddQaRow.id, syncOpts);
        console.log(`[chat] post-run: synced Q&A design doc output to DB (designDocId=${ddQaRow.id})`);
        fullySynced = design !== null && techSpec !== null && assumptions !== null;
      }
    }
    if (fullySynced) cleanupWorkspaceDir(workspaceDir);
    return;
  }
}

function cleanupWorkspaceDir(workspaceDir: string): void {
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    console.log(`[chat] post-run: cleaned up workspace ${workspaceDir}`);
  } catch { /* non-fatal */ }
}

/**
 * Reset any PRD or design doc stuck in 'generating' status for this thread
 * back to 'draft'. Called when the agent run throws before syncOutputToDb
 * can run, so the document doesn't stay in a generating limbo forever.
 */
async function failGeneratingDocuments(threadId: string): Promise<void> {
  const [prdResult] = await db.update(prds)
    .set({ status: 'draft', updatedAt: new Date().toISOString() })
    .where(and(eq(prds.chatThreadId, threadId), eq(prds.status, 'generating')))
    .returning({ id: prds.id });

  if (prdResult) {
    console.warn(`[chat] failGeneratingDocuments: reset PRD to draft (prdId=${prdResult.id}, threadId=${threadId})`);
  }

  const [ddResult] = await db.update(designDocs)
    .set({ status: 'draft', updatedAt: new Date().toISOString() })
    .where(and(eq(designDocs.chatThreadId, threadId), eq(designDocs.status, 'generating')))
    .returning({ id: designDocs.id });

  if (ddResult) {
    console.warn(`[chat] failGeneratingDocuments: reset design doc to draft (designDocId=${ddResult.id}, threadId=${threadId})`);
  }

  const [testCaseResult] = await db.update(testCases)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(and(eq(testCases.chatThreadId, threadId), eq(testCases.status, 'generating')))
    .returning({ id: testCases.id });

  if (testCaseResult) {
    console.warn(`[chat] failGeneratingDocuments: marked test cases failed (testCaseId=${testCaseResult.id}, threadId=${threadId})`);
  }
}

export async function sendMessage(
  threadId: string,
  text: string,
  modelOverride?: string,
  attachments: ChatAttachment[] = [],
  options?: { hidden?: boolean },
): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) throw new Error(`Thread ${threadId} not found`);
  console.log('[chat] sendMessage', { threadId, status: state.thread.status });
  if (state.thread.status === 'running') throw new Error('Agent is already running');

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) throw new Error('CURSOR_API_KEY is not set');

  // If the caller wants a different model, dispose the current agent so it
  // will be recreated (or resumed) with the new model on this turn.
  const resolvedModel = resolveModelId(modelOverride ?? state.thread.kickoff.model);
  if (state.thread.kickoff.model !== resolvedModel) {
    state.thread.kickoff.model = resolvedModel;
    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
    }
  }

  const mcpServerUrl = `http://localhost:${process.env.PORT ?? 3001}/mcp/ado-skills`;
  const mcpServers = buildMcpServers(state.thread.kickoff, mcpServerUrl);

  const turnId = uuidv4();
  const attachmentMeta = writeMessageAttachments(state.thread.workspaceDir, turnId, attachments);
  const promptText = buildPromptWithAttachments(text, attachmentMeta);

  // Record the user message
  const userMsg: ChatMessage = {
    id: turnId,
    role: 'user',
    text: text.trim() || 'Uploaded files for context.',
    ts: new Date().toISOString(),
    attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
    ...(options?.hidden ? { hidden: true } : {}),
  };
  state.thread.messages.push(userMsg);
  state.thread.lastActivityAt = userMsg.ts;
  broadcast(state, { type: 'message', message: userMsg });
  pgInsertMessage(threadId, userMsg).catch((err: Error) =>
    console.error('[chat] pg insertMessage (user) failed:', err.message),
  );

  // Update status
  state.thread.status = 'running';
  broadcast(state, { type: 'status', status: 'running' });
  persistThread(state.thread);
  resetIdleTimer(state);

  // Build initial prompt on first turn
  const isFirstTurn = !state.thread.cursorAgentId;
  const prompt = isFirstTurn
    ? `${buildInitialPrompt(state.thread.kickoff)}\n\n---\n\n${promptText}`
    : promptText;

  try {
    // Create or resume the agent (retry up to 3x on transient errors)
    const sdkRetryOpts = { maxRetries: 3, initialDelay: 1000, shouldRetry: isTransientSdkError, jitter: true } as const;

    if (!state.agent) {
      if (state.thread.cursorAgentId) {
        state.agent = await retryWithBackoff(
          () => Agent.resume(state.thread.cursorAgentId!, {
            apiKey,
            model: { id: resolvedModel },
            local: { cwd: state.thread.workspaceDir },
            mcpServers,
          }),
          sdkRetryOpts,
        );
      } else {
        state.agent = await retryWithBackoff(
          () => Agent.create({
            apiKey,
            model: { id: resolvedModel },
            local: { cwd: state.thread.workspaceDir },
            mcpServers,
          }),
          sdkRetryOpts,
        );
      }
    }

    const agent = state.agent;
    // Send the prompt (retry up to 2x on transient errors)
    const run = await retryWithBackoff(
      () => agent.send(prompt),
      { ...sdkRetryOpts, maxRetries: 2 },
    );

    trackEvent('agent.run.started', {
      threadId,
      model: resolvedModel,
      isInterview: String(state.isInterviewThread),
    });

    // Persist agent + run IDs immediately before streaming
    state.thread.cursorAgentId = agent.agentId ?? state.thread.cursorAgentId;
    state.thread.activeRunId = (run as any).id;
    persistThread(state.thread);

    const MAX_RUN_RETRIES = 2;
    let currentRun = run;
    let agentTextBuffer = '';

    for (let attempt = 0; attempt <= MAX_RUN_RETRIES; attempt++) {
      agentTextBuffer = '';

      // Stream tokens and tool calls — wrapped in try/catch for stream-level failures
      if (currentRun.supports('stream')) {
        try {
          for await (const event of currentRun.stream()) {
            if (event.type === 'assistant') {
              for (const block of event.message.content) {
                if (block.type === 'text') {
                  agentTextBuffer += block.text;
                  broadcast(state, { type: 'token', text: block.text });
                }
                if (block.type === 'tool_use') {
                  broadcast(state, {
                    type: 'tool_call',
                    toolName: block.name,
                    input: block.input,
                  });
                }
              }
            }
          }
        } catch (streamErr) {
          if (attempt < MAX_RUN_RETRIES && isTransientSdkError(streamErr)) {
            console.warn(`[chat] Stream error on attempt ${attempt + 1}/${MAX_RUN_RETRIES + 1} for thread ${threadId}, retrying…`, describeError(streamErr));
            broadcast(state, { type: 'retrying', attempt: attempt + 1, maxAttempts: MAX_RUN_RETRIES + 1 });

            if (state.agent) {
              await state.agent[Symbol.asyncDispose]().catch(() => {});
              state.agent = null;
            }
            if (state.thread.cursorAgentId) {
              state.agent = await retryWithBackoff(
                () => Agent.resume(state.thread.cursorAgentId!, {
                  apiKey,
                  model: { id: resolvedModel },
                  local: { cwd: state.thread.workspaceDir },
                  mcpServers: { 'ado-skills': { url: mcpServerUrl } },
                }),
                sdkRetryOpts,
              );
              currentRun = await state.agent.send(prompt);
              state.thread.activeRunId = (currentRun as any).id;
              continue;
            }
          }
          throw streamErr;
        }
      }

      const result = await currentRun.wait();

      if (result.status === 'error') {
        const reason = result.result?.trim() || 'Agent run failed — you can retry your last message.';

        if (attempt < MAX_RUN_RETRIES && !isFatalRunError(reason)) {
          console.warn(`[chat] Run error on attempt ${attempt + 1}/${MAX_RUN_RETRIES + 1} for thread ${threadId}, retrying…`, reason);
          broadcast(state, { type: 'retrying', attempt: attempt + 1, maxAttempts: MAX_RUN_RETRIES + 1 });

          if (state.agent) {
            await state.agent[Symbol.asyncDispose]().catch(() => {});
            state.agent = null;
          }
          if (state.thread.cursorAgentId) {
            state.agent = await retryWithBackoff(
              () => Agent.resume(state.thread.cursorAgentId!, {
                apiKey,
                model: { id: resolvedModel },
                local: { cwd: state.thread.workspaceDir },
                mcpServers: { 'ado-skills': { url: mcpServerUrl } },
              }),
              sdkRetryOpts,
            );
            currentRun = await state.agent.send(prompt);
            state.thread.activeRunId = (currentRun as any).id;
            continue;
          }
        }

        console.error(`[chat] Agent run returned error status for thread ${threadId}:`, result.result ?? '(no detail)', { model: state.thread.kickoff.model });
        trackAgentError(threadId, new Error(reason), { model: state.thread.kickoff?.model ?? 'unknown' });
        state.thread.lastError = reason;
        broadcast(state, { type: 'error', error: reason });
        if (state.agent) {
          await state.agent[Symbol.asyncDispose]().catch(() => {});
          state.agent = null;
        }
        if (isFatalRunError(reason)) {
          state.thread.cursorAgentId = undefined;
        }
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
        broadcast(state, { type: 'status', status: 'idle' });
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
        pgInsertMessage(threadId, agentMsg).catch((err: Error) =>
          console.error('[chat] pg insertMessage (agent) failed:', err.message),
        );
      }

      state.thread.status = 'idle';
      broadcast(state, { type: 'status', status: 'idle' });
      trackEvent('agent.run.completed', { threadId, model: resolvedModel });
      break;
    }

    const prdContent = readOutputPrd(threadId);
    const backlogContent = readOutputBacklog(threadId);
    const prdReady = prdContent !== null;
    const backlogReady = backlogContent !== null;

    // Sync output artifacts directly to Postgres
    try {
      await syncOutputToDb(threadId, state.thread.workspaceDir);
    } catch (err) {
      console.error(`[chat] post-run DB sync failed for thread ${threadId}:`, err);
    }

    broadcast(state, { type: 'done', runId: state.thread.activeRunId, prdReady, backlogReady });
    state.thread.activeRunId = undefined;
  } catch (err: any) {
    logAgentError(threadId, err);

    const tier = classifyError(err);
    const rawMsg = describeError(err);
    console.error(`[chat] Error tier=${tier} for thread ${threadId}:`, rawMsg);
    trackAgentError(threadId, err, { tier, model: state.thread.kickoff?.model ?? 'unknown' });

    if (state.agent) {
      await state.agent[Symbol.asyncDispose]().catch(() => {});
      state.agent = null;
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
        const isStaleRun = err instanceof Error && err.message.includes('already has active run');
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
    trackEvent('agent.run.errored', { threadId, errorTier: tier, errorCode, model: resolvedModel });
    broadcast(state, { type: 'error', error: state.thread.lastError ?? 'Unknown error', errorCode });
    broadcast(state, { type: 'done' });

    try {
      await failGeneratingDocuments(threadId);
    } catch (fgErr) {
      console.error(`[chat] failGeneratingDocuments failed for thread ${threadId}:`, fgErr);
    }
  } finally {
    state.thread.lastActivityAt = new Date().toISOString();
    persistThread(state.thread);
    resetIdleTimer(state);
  }
}

export async function cancelRun(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state || !state.agent) return;

  const activeRunId = state.thread.activeRunId;
  if (!activeRunId) return;

  try {
    const run = await (Agent as any).getRun(activeRunId, { runtime: 'local', cwd: state.thread.workspaceDir });
    if (run.supports('cancel')) await run.cancel();
  } catch {
    // Best-effort cancel
  }

  state.thread.status = 'idle';
  state.thread.activeRunId = undefined;
  broadcast(state, { type: 'status', status: 'idle' });
  broadcast(state, { type: 'done' });
  persistThread(state.thread);
}

export async function closeThread(threadId: string): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) return;

  if (state.idleTimer) clearTimeout(state.idleTimer);

  if (state.agent) {
    await state.agent[Symbol.asyncDispose]().catch(() => {});
    state.agent = null;
  }

  threads.delete(threadId);

  // Clean up workspace directory
  try {
    fs.rmSync(state.thread.workspaceDir, { recursive: true, force: true });
  } catch { /* non-fatal */ }

  // Never delete the chat_threads row when another table references it via
  // ON DELETE CASCADE — doing so silently wipes the parent document.
  //   - interviews.chat_thread_id  → CASCADE (deletes the interview)
  //   - prds.chat_thread_id        → CASCADE (deletes the PRD)
  // Design-doc thread columns don't have CASCADE FKs today, but deleting the
  // row would orphan the workspace reference and break recovery/sync. Guard
  // them the same way so document data is never lost.
  if (state.isInterviewThread) return;

  const backsDocument = await threadBacksDocument(threadId);
  if (backsDocument) {
    console.log(`[chat] closeThread: skipping pg delete — thread ${threadId} backs a ${backsDocument}`);
    return;
  }

  pgDeleteThread(threadId).catch((err: Error) =>
    console.error('[chat] pg deleteThread failed:', err.message),
  );
}

function resolveOutputDir(threadId: string): string | null {
  const state = threads.get(threadId);
  if (state) return path.join(state.thread.workspaceDir, '.ai-pilot', 'output');
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
export function readAllOutputDesignDocFeatures(
  threadId: string,
): Array<{ slug: string; design: string; techSpec: string; assumptions: string }> {
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return [];

  const designFiles = findAllOutputFiles(outputDir, /[-.]design\.md$/i);
  const results: Array<{ slug: string; design: string; techSpec: string; assumptions: string }> = [];

  for (const designFile of designFiles) {
    const slug = path.basename(designFile).replace(/[-.]design\.md$/i, '');
    const techSpecFile = designFile.replace(/[-.]design\.md$/i, '-tech-spec.md');
    const assumptionsFile = designFile.replace(/[-.]design\.md$/i, '-assumptions.md');

    if (!fs.existsSync(techSpecFile) || !fs.existsSync(assumptionsFile)) continue;

    try {
      results.push({
        slug,
        design: fs.readFileSync(designFile, 'utf-8').trim(),
        techSpec: fs.readFileSync(techSpecFile, 'utf-8').trim(),
        assumptions: fs.readFileSync(assumptionsFile, 'utf-8').trim(),
      });
    } catch { /* skip unreadable files */ }
  }

  return results;
}

/**
 * Read the human-readable validation scorecard (review-scorecard.md) from the ephemeral workspace.
 */
export function readOutputValidationScorecardMd(threadId: string): string | null {
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
