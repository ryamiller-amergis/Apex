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

function isAzureWwwroot(): boolean {
  const home = process.env.HOME;
  const cwd = process.cwd();
  return (
    cwd.startsWith('/home/site/wwwroot') ||
    Boolean(home && cwd.startsWith(path.join(home, 'site', 'wwwroot')))
  );
}

function resolveDataRoot(): string {
  if (process.env.AI_PILOT_DATA_DIR) {
    return path.resolve(process.env.AI_PILOT_DATA_DIR);
  }

  // Azure App Service deploys app code to /home/site/wwwroot, which can be
  // read-only. /home/data is the writable file-storage location.
  if (isAzureWwwroot()) {
    return path.join('/home', 'data', 'ai-pilot');
  }

  return path.join(process.cwd(), 'data');
}

const DATA_ROOT = resolveDataRoot();
const WORKSPACE_BASE = process.env.AI_PILOT_WORKSPACE_DIR
  ? path.resolve(process.env.AI_PILOT_WORKSPACE_DIR)
  : isAzureWwwroot()
    ? path.join(DATA_ROOT, 'workspaces')
    : path.join(os.tmpdir(), 'ai-pilot-workspaces');
const THREADS_DIR = path.join(DATA_ROOT, 'chat-threads');
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
  if (!fs.existsSync(dir)) return null;
  try {
    const names = fs.readdirSync(dir);
    const match = names.find((n) => pattern.test(n));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

// ── Persistence helpers ───────────────────────────────────────────────────────

function ensureDirs() {
  fs.mkdirSync(WORKSPACE_BASE, { recursive: true });
  fs.mkdirSync(THREADS_DIR, { recursive: true });
  cleanupStaleWorkspaces();
}

function persistThread(thread: ChatThread) {
  ensureDirs();
  const file = path.join(THREADS_DIR, `${thread.id}.json`);
  fs.writeFileSync(file, JSON.stringify(thread, null, 2), 'utf-8');
}

function loadThread(threadId: string): ChatThread | null {
  const file = path.join(THREADS_DIR, `${threadId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ChatThread;
  } catch {
    return null;
  }
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
  return [
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
  ].join('\n');
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
 * Return live ThreadState from memory, or hydrate from disk (e.g. after server restart).
 * `getThread` used to return `loadThread()` without registering in `threads`, so POST
 * /messages passed the route check then `sendMessage` threw "Thread not found".
 */
function ensureThreadState(threadId: string): ThreadState | null {
  const existing = threads.get(threadId);
  if (existing) return existing;

  const thread = loadThread(threadId);
  if (!thread) return null;

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
      sendMessage(threadId, 'Begin.').catch((err: Error) => {
        console.error('[chat] Auto-kickoff failed for thread', threadId, ':', err.message);
      });
    });
  }

  return thread;
}

export function getThread(threadId: string): ChatThread | null {
  return ensureThreadState(threadId)?.thread ?? null;
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
  const state = ensureThreadState(threadId);
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

export async function sendMessage(
  threadId: string,
  text: string,
  modelOverride?: string,
  attachments: ChatAttachment[] = [],
): Promise<void> {
  const state = ensureThreadState(threadId);
  if (!state) throw new Error(`Thread ${threadId} not found`);
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
            }
          }
        }
      }
    }

    const result = await run.wait();

    if (result.status === 'error') {
      const reason = result.result?.trim() || 'Agent run failed — you can retry your last message.';
      state.thread.lastError = reason;
      broadcast(state, { type: 'error', error: reason });
      // Dispose the agent so the next send creates a fresh one instead of
      // reusing a run that already ended in an error state.
      if (state.agent) {
        await state.agent[Symbol.asyncDispose]().catch(() => {});
        state.agent = null;
      }
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
      }

      state.thread.status = 'idle';
      broadcast(state, { type: 'status', status: 'idle' });
    }

    const outputDir = path.join(state.thread.workspaceDir, '.ai-pilot', 'output');
    const prdFile = findOutputFile(outputDir, /\.prd\.md$/i) ?? (fs.existsSync(path.join(outputDir, 'PRD.md')) ? path.join(outputDir, 'PRD.md') : null);
    const backlogFile = findOutputFile(outputDir, /\.backlog\.json$/i);
    const prdReady = prdFile !== null;
    const backlogReady = backlogFile !== null;

    // Persist output to the durable threads dir so previews survive restarts/workspace cleanup
    if (prdFile) {
      try {
        fs.copyFileSync(prdFile, path.join(THREADS_DIR, `${threadId}.prd.md`));
      } catch { /* non-fatal */ }
    }
    if (backlogFile) {
      try {
        fs.copyFileSync(backlogFile, path.join(THREADS_DIR, `${threadId}.backlog.json`));
      } catch { /* non-fatal */ }
    }

    broadcast(state, { type: 'done', runId: state.thread.activeRunId, prdReady, backlogReady });
    state.thread.activeRunId = undefined;
  } catch (err: any) {
    logAgentError(threadId, err);
    if (err instanceof CursorAgentError) {
      state.thread.status = 'error';
      state.thread.lastError = describeError(err);
      // Startup failure — dispose and clear so next send creates a fresh agent
      if (state.agent) {
        await state.agent[Symbol.asyncDispose]().catch(() => {});
        state.agent = null;
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
  const state = ensureThreadState(threadId);
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
  const state = ensureThreadState(threadId);
  if (!state) return;

  if (state.idleTimer) clearTimeout(state.idleTimer);

  if (state.agent) {
    await state.agent[Symbol.asyncDispose]().catch(() => {});
    state.agent = null;
  }

  state.thread.status = 'closed';
  broadcast(state, { type: 'status', status: 'closed' });
  persistThread(state.thread);
  threads.delete(threadId);

  // Remove workspace directory
  try {
    fs.rmSync(state.thread.workspaceDir, { recursive: true, force: true });
  } catch {
    // Non-fatal
  }
}

function resolveOutputDir(threadId: string): string | null {
  const state = threads.get(threadId);
  if (state) return path.join(state.thread.workspaceDir, '.ai-pilot', 'output');
  const thread = loadThread(threadId);
  return thread ? path.join(thread.workspaceDir, '.ai-pilot', 'output') : null;
}

/**
 * Read the output PRD. Checks the durable threads dir first (survives restarts),
 * then falls back to the ephemeral workspace.
 */
export function readOutputPrd(threadId: string): string | null {
  // 1. Durable copy next to the thread JSON
  const durablePrd = path.join(THREADS_DIR, `${threadId}.prd.md`);
  if (fs.existsSync(durablePrd)) return fs.readFileSync(durablePrd, 'utf-8');

  // 2. Ephemeral workspace (still exists in the current session)
  const outputDir = resolveOutputDir(threadId);
  if (!outputDir) return null;
  const named = findOutputFile(outputDir, /\.prd\.md$/i);
  if (named) return fs.readFileSync(named, 'utf-8');
  const legacy = path.join(outputDir, 'PRD.md');
  return fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf-8') : null;
}

/**
 * Read the output backlog JSON. Checks the durable threads dir first,
 * then falls back to the ephemeral workspace.
 */
export function readOutputBacklog(threadId: string): unknown | null {
  // 1. Durable copy next to the thread JSON
  const durableBacklog = path.join(THREADS_DIR, `${threadId}.backlog.json`);
  if (fs.existsSync(durableBacklog)) {
    try {
      return JSON.parse(fs.readFileSync(durableBacklog, 'utf-8'));
    } catch { /* fall through */ }
  }

  // 2. Ephemeral workspace
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
 * Overwrite the output PRD on disk with edited content.
 * Writes to both the durable threads dir and the workspace (if it exists).
 */
export function writeOutputPrd(threadId: string, content: string): void {
  // Always update the durable copy
  ensureDirs();
  fs.writeFileSync(path.join(THREADS_DIR, `${threadId}.prd.md`), content, 'utf-8');

  // Also keep the workspace copy in sync if it still exists
  const outputDir = resolveOutputDir(threadId);
  if (outputDir && fs.existsSync(outputDir)) {
    const named = findOutputFile(outputDir, /\.prd\.md$/i);
    fs.writeFileSync(named ?? path.join(outputDir, 'PRD.md'), content, 'utf-8');
  }
}
