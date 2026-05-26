import { Agent, CursorAgentError } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk/dist/cjs/agent.js';
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
import { and, eq, isNull } from 'drizzle-orm';
import { interviews, prds, designDocs } from '../db/schema';
import { syncPrdContent } from './prdService';
import { syncDesignDocContent, syncValidationResult, syncPerFeatureDesignDocs } from './designDocService';
import type { ValidationScorecard } from '../../shared/types/interview';
import type { ChatThreadSummary } from '../../shared/types/chat';

const DATA_ROOT = resolveDataRoot();
const WORKSPACE_BASE = process.env.AI_PILOT_WORKSPACE_DIR
  ? path.resolve(process.env.AI_PILOT_WORKSPACE_DIR)
  : isAzureWwwroot()
    ? path.join(DATA_ROOT, 'workspaces')
    : path.join(os.tmpdir(), 'ai-pilot-workspaces');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// ── In-memory state ───────────────────────────────────────────────────────────

interface ThreadState {
  thread: ChatThread;
  /** SSE subscriber callbacks for this thread */
  subscribers: Set<(event: SseEvent) => void>;
  /** Live Cursor SDK agent — null between turns */
  agent: SDKAgent | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
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

  if (kickoff.freeformContext) {
    parts.push(
      ``,
      `# Design doc context`,
      `The design doc content for this session has been written to \`.ai-pilot/kickoff-context.md\`.`,
      `Read this file IMMEDIATELY before responding to any user message — it contains the full design doc (Design, Tech Spec, and Assumptions sections) that you are assisting with.`,
      `The file also contains the \`doc_id\` and \`thread_id\` values you must pass when calling \`update_design_doc\`.`,
      ``,
      `# Applying edits`,
      `You have an \`update_design_doc\` MCP tool available. Use it when the user asks you to apply, save, or write changes to the document.`,
      `- Call it once per section that needs updating.`,
      `- Pass the \`doc_id\` and \`thread_id\` from \`.ai-pilot/kickoff-context.md\`.`,
      `- After a successful save, confirm to the user that the changes have been applied.`,
    );
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
  state.idleTimer = setTimeout(() => closeThread(state.thread.id), IDLE_TIMEOUT_MS);
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
  }

  const state: ThreadState = {
    thread,
    subscribers: new Set(),
    agent: null,
    idleTimer: null,
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


// ── Public API ────────────────────────────────────────────────────────────────

export async function createThread(
  userId: string,
  kickoff: ChatThreadKickoff,
  options?: { skipAutoKickoff?: boolean },
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
  };

  threads.set(threadId, state);
  persistThread(thread);
  resetIdleTimer(state);

  // Auto-kickoff: start the skill when the client will not send a first message right away
  // (e.g. skill slug only, or modal/panel open). If skipAutoKickoff is set, the client POSTs
  // the real first message next so the transcript shows the user request before the agent.
  if (!options?.skipAutoKickoff) {
    setImmediate(() => {
      // #region agent log
      try{const fs2=require('fs');fs2.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'chatAgentService.ts:createThread:auto-kickoff-firing',message:'auto-kickoff setImmediate fired',data:{threadId,skillPath:kickoff.skillPath},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
      // #endregion
      sendMessage(threadId, 'Begin.').then(() => {
        // #region agent log
        try{const fs2=require('fs');fs2.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'chatAgentService.ts:createThread:auto-kickoff-success',message:'auto-kickoff sendMessage completed successfully',data:{threadId},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
        // #endregion
      }).catch((err: Error) => {
        // #region agent log
        try{const fs2=require('fs');fs2.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'chatAgentService.ts:createThread:auto-kickoff-error',message:'auto-kickoff sendMessage FAILED',data:{threadId,error:err.message,name:err.name},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
        // #endregion
        console.error('[chat] Auto-kickoff failed for thread', threadId, ':', err.message);
      });
    });
  }

  return thread;
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

function logAgentError(threadId: string, err: unknown): void {
  if (err instanceof Error) {
    console.error(`[chat] Agent failed for thread ${threadId}:`, {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: (err as any).cause,
      retryable: (err as any).isRetryable,
    });
    return;
  }

  console.error(`[chat] Agent failed for thread ${threadId}:`, err);
}

/**
 * After an agent run completes, sync workspace output files directly to Postgres
 * by looking up which entity (PRD or design doc) owns this thread.
 */
async function syncOutputToDb(threadId: string, workspaceDir: string): Promise<void> {
  let fullySynced = false;

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
      fullySynced = content !== null && backlog !== null;
    }
    if (fullySynced) cleanupWorkspaceDir(workspaceDir);
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

export async function sendMessage(
  threadId: string,
  text: string,
  modelOverride?: string,
  attachments: ChatAttachment[] = [],
): Promise<void> {
  const state = await ensureThreadState(threadId);
  if (!state) throw new Error(`Thread ${threadId} not found`);
  // #region agent log
  try{const fs2=require('fs');fs2.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'chatAgentService.ts:sendMessage:start',message:'sendMessage called',data:{threadId,currentStatus:state.thread.status,textPrefix:text.slice(0,30)},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
  // #endregion
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
    // Create or resume the agent
    if (!state.agent) {
      if (state.thread.cursorAgentId) {
        state.agent = await Agent.resume(state.thread.cursorAgentId, {
          apiKey,
          model: { id: resolvedModel },
          local: { cwd: state.thread.workspaceDir },
          mcpServers: {
            'ado-skills': { url: mcpServerUrl },
          },
        });
      } else {
        state.agent = await Agent.create({
          apiKey,
          model: { id: resolvedModel },
          local: { cwd: state.thread.workspaceDir },
          mcpServers: {
            'ado-skills': { url: mcpServerUrl },
          },
        });
      }
    }

    const agent = state.agent;
    const run = await agent.send(prompt);

    // Persist agent + run IDs immediately before streaming
    state.thread.cursorAgentId = agent.agentId ?? state.thread.cursorAgentId;
    state.thread.activeRunId = (run as any).id;
    persistThread(state.thread);

    // Stream tokens and tool calls
    let agentTextBuffer = '';

    if (run.supports('stream')) {
      for await (const event of run.stream()) {
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
              // #region agent log
              try{const fs2=require('fs');fs2.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'chatAgentService.ts:tool_call',message:'agent tool call',data:{threadId,toolName:block.name,inputKeys:Object.keys(block.input||{})},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
              // #endregion
            }
          }
        }
      }
    }

    const result = await run.wait();

    if (result.status === 'error') {
      const reason = result.result?.trim() || 'Agent run failed — you can retry your last message.';
      console.error(`[chat] Agent run returned error status for thread ${threadId}:`, result.result ?? '(no detail)', { model: state.thread.kickoff.model });
      // #region agent log
      try{const fs2=require('fs');fs2.appendFileSync('debug-d6e0f6.log',JSON.stringify({sessionId:'d6e0f6',location:'chatAgentService.ts:run-error',message:'agent run returned error status',data:{threadId,model:state.thread.kickoff.model,result:result.result??null,skillPath:state.thread.kickoff.skillPath},timestamp:Date.now(),hypothesisId:'H-A'})+'\n');}catch(_){}
      // #endregion
      state.thread.lastError = reason;
      broadcast(state, { type: 'error', error: reason });
      // Dispose the agent and clear the stored agent ID so the next send
      // creates a fresh agent rather than resuming a broken one.
      if (state.agent) {
        await state.agent[Symbol.asyncDispose]().catch(() => {});
        state.agent = null;
      }
      state.thread.cursorAgentId = undefined;
      state.thread.activeRunId = undefined;
      state.thread.status = 'idle';
      broadcast(state, { type: 'status', status: 'idle' });
    } else {
      // Commit the accumulated agent message
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

    // The SDK throws "Agent <id> already has active run" when the agent has a
    // stale live run — typically after a server restart mid-turn. Dispose the
    // agent and clear the stored agent ID so the next send creates a fresh one.
    const isStaleRun =
      err instanceof Error && err.message.includes('already has active run');

    if (err instanceof CursorAgentError || isStaleRun) {
      state.thread.lastError = isStaleRun
        ? 'A previous run is still active on the agent. Please try again.'
        : describeError(err);
      if (state.agent) {
        await state.agent[Symbol.asyncDispose]().catch(() => {});
        state.agent = null;
      }
      if (isStaleRun) {
        // Clear the agent ID so the next send starts a fresh agent rather than
        // resuming the one that still owns the active run.
        state.thread.cursorAgentId = undefined;
        state.thread.activeRunId = undefined;
        state.thread.status = 'idle';
      } else {
        state.thread.status = 'error';
      }
    } else {
      state.thread.status = 'error';
      state.thread.lastError = describeError(err);
    }
    broadcast(state, { type: 'error', error: state.thread.lastError ?? 'Unknown error' });
    broadcast(state, { type: 'done' });
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

  // Only delete from Postgres if the thread is not backing an interview.
  // Interview threads use ON DELETE CASCADE, so deleting the chat_thread row
  // would silently wipe the interview record. Leave the DB row intact; the
  // in-memory state and workspace have already been cleaned up above.
  db.query.interviews
    .findFirst({ where: eq(interviews.chatThreadId, threadId) })
    .then((linked) => {
      if (linked) return; // interview-backed thread — keep the DB row
      pgDeleteThread(threadId).catch((err: Error) =>
        console.error('[chat] pg deleteThread failed:', err.message),
      );
    })
    .catch((err: Error) =>
      console.error('[chat] interview lookup before deleteThread failed:', err.message),
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
