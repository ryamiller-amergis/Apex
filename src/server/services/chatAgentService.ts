import { Agent, CursorAgentError } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk/dist/cjs/agent.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type {
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
    `# Sandbox notice`,
    `You are running in an isolated sandbox workspace. The current working directory contains ONLY a \`.ai-pilot/\` scratch folder for kickoff inputs and final outputs.`,
    `It is NOT a clone of the project repo. Project files such as \`CONTEXT.md\`, \`AGENTS.md\`, ADRs, glossaries, sibling skills, etc. will NOT be on the local filesystem. Do not search the filesystem for them and do not report them as "missing" — they live in the ADO repo and must be fetched via MCP.`,
    ``,
    `# Step 1 — Load the skill`,
    `Call the \`get_skill\` tool on the \`ado-skills\` MCP server with:`,
    `  project: "${kickoff.project}"`,
    `  repo: "${kickoff.repo}"`,
    `  path: "${kickoff.skillPath}"`,
    `  branch: "${branch}"`,
    ``,
    `# Step 2 — Fetch every repo file the skill references`,
    `If the skill instructs you to read files like \`CONTEXT.md\`, \`AGENTS.md\`, ADRs, glossaries, examples, a docs sidebar, or a handbook index, follow this sub-procedure:`,
    ``,
    `  2a. DISCOVER before fetching. Use the \`list_repo_dir\` tool to browse the repo and confirm a path exists before calling \`get_skill_file\`. Start at the repo root (\`/\`) to see top-level structure, then drill into sub-folders as needed:`,
    `        list_repo_dir  project="${kickoff.project}"  repo="${kickoff.repo}"  branch="${branch}"  path="/"`,
    `      Then check sub-folders like \`/docs\`, \`/.cursor\`, etc. as the root listing suggests.`,
    ``,
    `  2b. FETCH files that actually exist using \`get_skill_file\`. Only attempt paths that appeared in the \`list_repo_dir\` results.`,
    ``,
    `  2c. GIVE UP PROMPTLY if a referenced file does not appear in the directory listing after at most 2-3 browsing attempts. Do NOT keep guessing new paths in a loop. Instead, note what was not found and continue the skill with the context you have. Tell the user briefly which files were unavailable.`,
    ``,
    `  2d. NEVER search the local filesystem (the sandbox cwd) for these files — they do not exist there.`,
    ``,
    `  2e. BEFORE the first interview question, gather implementation context from code. Use \`search_repo_code\` with 2-4 targeted queries derived from the user's kickoff topic (domain terms, feature names, service names, key entities).`,
    `      Example:`,
    `        search_repo_code  project="${kickoff.project}"  repo="${kickoff.repo}"  branch="${branch}"  query="timecard approval callout pto"  limit=8`,
    ``,
    `  2f. For each relevant hit from \`search_repo_code\`, read the file via \`get_skill_file\` and summarize concrete findings (existing modules, route handlers, services, and constraints) before you start the interview. Do not ask architecture questions that are already answered by discovered code.`,
    ``,
    `# Step 3 — Run the full interview before producing any artifact`,
    `Execute the skill's procedure in order. If the skill defines an interview, "grill", clarification, rubric, or Q&A phase, follow these rules WITHOUT EXCEPTION:`,
    ``,
    `  a. Ask the questions one at a time (or in small numbered batches per the skill's format). After posting questions, STOP and wait for the user's reply. Do not generate any document or summary.`,
    `  b. After each user reply, continue with the NEXT unanswered interview questions. A single user reply does NOT complete the interview. Keep asking until every question in the skill's defined interview list has been covered.`,
    `  c. When ALL questions have been asked and answered, end your message with EXACTLY this sentence on its own line:`,
    `       > Interview complete — reply **"create prd"** when you are ready for me to generate the document.`,
    `  d. ONLY write the output file after the user explicitly says "create prd", "yes", "proceed", "generate", "go ahead", or a clearly equivalent signal. If the user asks a follow-up question or requests a change instead, answer it and keep waiting.`,
    ``,
    `⛔ HARD RULE: Do NOT write \`.ai-pilot/output/PRD.md\` (or any other output file) at any point during the interview. Writing it early will be treated as a critical failure.`,
    ``,
    `# Question format — MANDATORY for EVERY interview question, no exceptions`,
    `The chat UI renders lettered options as interactive buttons that the user clicks to answer. This ONLY works if you follow the exact format below. Failing to use this format means the user cannot answer interactively.`,
    ``,
    `⛔ EVERY question you ask during the interview — including yes/no questions, binary choices, and open-ended clarifications — MUST be formatted as a lettered list. There are no exceptions. If a question seems binary (yes/no), turn it into a 3-4 option list anyway.`,
    ``,
    `Required format (copy this structure exactly):`,
    ``,
    `  **Question N:** [question text — one clear sentence]`,
    ``,
    `  a. [first option]`,
    `  b. [second option]`,
    `  c. [third option — can be "Some of both / hybrid"]`,
    `  d. Other — I'll describe in the text box below`,
    ``,
    `  > *Recommendation: [letter] — [one sentence reason why]*`,
    ``,
    `Rules (all mandatory):`,
    `- ALWAYS use exactly the \`a. text\` format — one option per line, letter + period + space + text.`,
    `- ALWAYS include at least 3 options. For a yes/no question, add a third option like "c. It depends — I'll clarify below".`,
    `- ALWAYS end with a "d. Other / free-form" option so the user can type a custom answer.`,
    `- Put the recommendation AFTER the options, not before, not inline.`,
    `- NEVER write choices in prose sentences like "Choose A or B", "**[A]**", "Option 1 vs Option 2", or embed the options in a paragraph. Each option must be its own line starting with \`a.\`, \`b.\`, \`c.\`, or \`d.\`.`,
    `- NEVER ask an open-ended question without lettered options. Even "please describe X" must be wrapped: offer 2-3 likely answers as options plus "d. Other — I'll describe below".`,
  ];

  if (kickoff.transcript) {
    parts.push(
      ``,
      `A prior conversation transcript has been written to \`.ai-pilot/kickoff-transcript.md\` in this workspace. Read it for input context before starting the skill flow — but treat it as background, not as a substitute for the skill's interview phase. The transcript does NOT count as having answered the interview questions.`,
    );
  }

  if (kickoff.freeformContext) {
    parts.push(
      ``,
      `Additional user-provided context has been written to \`.ai-pilot/kickoff-context.md\`. Read it as well.`,
    );
  }

  parts.push(
    ``,
    `# Step 4 — Final artifact (only after explicit user approval)`,
    `After the user says "create prd" (or equivalent), write the output to \`.ai-pilot/output/PRD.md\` (or whatever filename the skill specifies under \`.ai-pilot/output/\`) and tell the user it is ready for review.`,
  );

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

// ── Public API ────────────────────────────────────────────────────────────────

export async function createThread(userId: string, kickoff: ChatThreadKickoff): Promise<ChatThread> {
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

  // Auto-kickoff: start the skill immediately so the user doesn't have to type a first message.
  // Fire-and-forget — the HTTP response returns with the threadId while the agent spins up.
  setImmediate(() => {
    sendMessage(threadId, 'Begin.').catch((err: Error) => {
      console.error('[chat] Auto-kickoff failed for thread', threadId, ':', err.message);
    });
  });

  return thread;
}

export function getThread(threadId: string): ChatThread | null {
  return threads.get(threadId)?.thread ?? loadThread(threadId);
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

export async function sendMessage(threadId: string, text: string, modelOverride?: string): Promise<void> {
  const state = threads.get(threadId);
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

  // Record the user message
  const userMsg: ChatMessage = {
    id: uuidv4(),
    role: 'user',
    text,
    ts: new Date().toISOString(),
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
    ? `${buildInitialPrompt(state.thread.kickoff)}\n\n---\n\n${text}`
    : text;

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
      state.thread.status = 'error';
      state.thread.lastError = `Run ${state.thread.activeRunId} failed`;
      broadcast(state, { type: 'error', error: state.thread.lastError });
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

    broadcast(state, { type: 'done', runId: state.thread.activeRunId });
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
  const state = threads.get(threadId);
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
  const state = threads.get(threadId);
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

/**
 * Read the output PRD (if the agent wrote it) from the workspace.
 * Returns null if not yet written.
 */
export function readOutputPrd(threadId: string): string | null {
  const state = threads.get(threadId);
  if (!state) {
    const thread = loadThread(threadId);
    if (!thread) return null;
    const prdPath = path.join(thread.workspaceDir, '.ai-pilot', 'output', 'PRD.md');
    return fs.existsSync(prdPath) ? fs.readFileSync(prdPath, 'utf-8') : null;
  }
  const prdPath = path.join(state.thread.workspaceDir, '.ai-pilot', 'output', 'PRD.md');
  return fs.existsSync(prdPath) ? fs.readFileSync(prdPath, 'utf-8') : null;
}

/**
 * Overwrite the output PRD on disk with edited content.
 * Creates the output directory if it doesn't exist yet.
 */
export function writeOutputPrd(threadId: string, content: string): void {
  const state = threads.get(threadId);
  const workspaceDir = state
    ? state.thread.workspaceDir
    : (() => {
        const thread = loadThread(threadId);
        if (!thread) throw new Error(`Thread ${threadId} not found`);
        return thread.workspaceDir;
      })();

  const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(path.join(outputDir, 'PRD.md'), content, 'utf-8');
}
