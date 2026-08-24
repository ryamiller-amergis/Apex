import { Agent } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk/dist/cjs/agent.js';
import type {
  LocalAgentOptions,
  McpServerConfig,
} from '@cursor/sdk/dist/cjs/options.js';
import { v4 as uuidv4 } from 'uuid';
import { retryWithBackoff } from '../utils/retry';
import { listSkillConfigs } from './projectSettingsService';
import { recordAiUsage, estimateTokens } from './aiUsageService';
import {
  callerGroundingService,
  type CallerGroundingSelection,
} from './callerGroundingService';
import type { RepoReader } from '../../shared/types/repoReader';
import { groundingProfileResolver } from './groundingProfileResolver';
import { createNativeReadTools } from './nativeReadToolAdapter';

const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const GROUNDING_PREPARATION_TIMEOUT_MS = 2 * 60 * 1000;
const MODEL_ID = 'composer-2.5';

const SYSTEM_PROMPT_BASE = `You are **Ask Apex** — a senior product owner who lives and breathes the Apex platform. You combine deep product knowledge with genuine enthusiasm for how Apex transforms the way teams build software. Think of yourself as the person who conceived many of these features, shepherded them through design and delivery, and now delights in helping people get the most out of the product.

# Your Persona
- Speak as a knowledgeable, approachable senior product owner — not a chatbot reading docs
- Be conversational, specific, and proactive: don't just answer the question, help the user see the bigger picture
- When relevant, highlight how Apex streamlines workflows, replaces fragmented manual processes, and enhances consistency
- Share product-owner perspective: prioritization trade-offs, why features were designed a certain way, adoption benefits, ROI arguments
- Be honest about limitations — if something isn't built yet, say so and mention it could be a great feature request

# What You Can Discuss
- **Product features & workflows** — explain any Apex capability, walk users through how to accomplish tasks, compare features
- **Why Apex vs. manual/fragmented approaches** — articulate how AI-guided interviews replace ad-hoc meetings, how auto-generated PRDs save days of writing, how centralized notifications eliminate email chains, etc.
- **How AI integration enhances decision-making** — validation scoring, feature request analysis, standup facilitation with real ADO data, PRD assistant that bulk-addresses feedback
- **User experience benefits** — centralized platform, consistent UI, real-time notifications, role-based access, mobile responsiveness
- **Product vision & roadmap thinking** — discuss where the product is heading, what problems are being solved next, how features build on each other
- **Adoption & ROI** — help users make the case for Apex adoption within their teams
- **Feature trade-offs** — explain design decisions, why certain approaches were chosen, what constraints shaped the product
- **Recent changes** — what shipped, what improved, what bugs were fixed (reference the changelog)

# Primary Knowledge Sources
Your baseline context below includes \`context.md\` (comprehensive product guide) and \`AGENTS.md\` (agent quick-reference with feature map). These are your primary references — start every answer from this knowledge.

# How to answer questions
1. Start with the baseline documentation provided below — \`context.md\` and \`AGENTS.md\` cover most product questions comprehensively.
2. When a question goes beyond what the baseline covers, USE YOUR TOOLS to look up the answer:
   - Browse \`src/client/components/\` for UI features
   - Browse \`src/server/services/\` and \`src/server/routes/\` for backend logic
   - Browse \`.agents/skills/\`, legacy \`.cursor/skills/\`, and \`design-docs/\` for feature documentation
   - Read \`public/CHANGELOG.json\` for recent changes
   - Search code to find where specific features or concepts are implemented
3. If you still can't find the answer after searching, say so honestly and suggest the user submit a feature request — the Feature Request system will even auto-analyze it with AI!

# Topic Boundary
You are **exclusively** an Apex product assistant. Only answer questions that relate to the AI-Pilot (Apex) platform — its features, workflows, configuration, troubleshooting, architecture, roadmap, or general software concepts needed to understand Apex (e.g. "what is RBAC?" is fine because Apex uses RBAC).

**Politely decline off-topic questions** such as sports scores, stock prices, weather, housing markets, cooking recipes, general trivia, or anything unrelated to Apex. When declining, respond with something like:
"I'm here to help with Apex! If you have questions about features, workflows, or how to get the most out of the platform, I'd love to help."

Do NOT answer off-topic questions even if the user insists — always redirect back to Apex.

# Constraints
- You are a READ-ONLY assistant. Do NOT create, write, or modify any files.
- Only use tools to READ repo content. Do not use any write/edit tools.`;

function buildRepositoryReadGuidance(
  nativeReads: boolean,
  repoInfo?: RepoInfo | null,
  repoReader?: RepoReader,
  storage: 'bare mirror' | 'Azure Files checkout' = 'Azure Files checkout',
): string {
  return nativeReads
    ? [
        '# Sandbox workspace and native repository reads',
        'The current working directory remains the Apex agent sandbox; it is NOT the repository checkout.',
        ...(repoInfo && repoReader
          ? [
              'Repository grounding provenance:',
              `  storage: "${storage}"`,
              `  repository: "${repoReader.identity.repo}"`,
              `  branch: "${repoInfo.branch}"`,
              `  pinned SHA: "${repoReader.identity.sha}"`,
            ]
          : []),
        'Read the authorized SHA-pinned checkout only through these local checkout-backed read-only tools:',
        '- `get_skill_file` — read a repository-relative file',
        '- `list_repo_dir` — list a repository-relative directory',
        '- `search_repo_code` — search the pinned checkout',
        'Never use the GitHub or ADO provider MCP servers for repository reads.',
      ].join('\n')
    : [
        '# Sandbox workspace and provider repository reads',
        'The current working directory is an isolated sandbox, not the project checkout.',
        'Repository files must be fetched via the `github-repo` MCP server.',
        '- `get_skill_file` — read any file from the repository',
        '- `list_repo_dir` — browse repository directories',
        '- `search_repo_code` — search repository code',
        '- `list_skills` — list available skills',
      ].join('\n');
}

function fallbackSystemPrompt(
  nativeReads: boolean,
  repoInfo?: RepoInfo | null,
  repoReader?: RepoReader,
  storage?: 'bare mirror' | 'Azure Files checkout',
): string {
  return `${SYSTEM_PROMPT_BASE}

${buildRepositoryReadGuidance(nativeReads, repoInfo, repoReader, storage)}

Note: I was unable to load the latest documentation from the repository. I'll do my best to answer using my tools and general knowledge of the application.`;
}

const CONTEXT_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
interface RepoInfo {
  org: string;
  repo: string;
  branch: string;
}
const contextPromptCache = new Map<
  string,
  { prompt: string; fetchedAt: number }
>();

async function resolveRepoInfo(): Promise<RepoInfo | null> {
  try {
    const configs = await listSkillConfigs();
    const ghConfig = configs.find(
      (c) => c.skillProvider === 'github' && c.isDefault
    );
    if (!ghConfig) return null;

    const repoStr = ghConfig.skillRepo;
    const slashIdx = repoStr.indexOf('/');
    if (slashIdx < 0) return null;

    return {
      org: repoStr.slice(0, slashIdx),
      repo: repoStr.slice(slashIdx + 1),
      branch: ghConfig.skillBranch || 'main',
    };
  } catch {
    return null;
  }
}

async function fetchRepoContext(
  repoInfo: RepoInfo | null,
  runtime: AskApexRepositoryRuntime
): Promise<string> {
  if (!repoInfo) {
    return fallbackSystemPrompt(
      runtime.nativeReads,
      repoInfo,
      runtime.repoReader,
      runtime.storage,
    );
  }

  const sourceKey =
    runtime.nativeReads && runtime.repoReader
      ? `local:${runtime.repoReader.identity.provider}:${runtime.repoReader.identity.project}:${runtime.repoReader.identity.repo}@${runtime.repoReader.identity.sha}`
      : `remote:${repoInfo.org}/${repoInfo.repo}@${repoInfo.branch}`;
  const cached = contextPromptCache.get(sourceKey);
  if (cached && Date.now() - cached.fetchedAt < CONTEXT_CACHE_TTL_MS) {
    return cached.prompt;
  }

  const remoteCatalog = runtime.nativeReads
    ? null
    : await import('./skillCatalogGitHub');
  const sections: string[] = [
    SYSTEM_PROMPT_BASE,
    '',
    buildRepositoryReadGuidance(
      runtime.nativeReads,
      repoInfo,
      runtime.repoReader,
      runtime.storage,
    ),
    '',
  ];

  if (!runtime.nativeReads) {
    // Inject repo coordinates so the agent knows what to pass to provider MCP tools.
    sections.push(
      `# Repo coordinates (use with MCP tools)`,
      `  org:    "${repoInfo.org}"`,
      `  repo:   "${repoInfo.repo}"`,
      `  branch: "${repoInfo.branch}"`
    );
  }

  const filesToFetch = [
    { path: 'context.md', label: 'Product Context Guide' },
    { path: 'AGENTS.md', label: 'Agent Quick Reference' },
    { path: 'README.md', label: 'Application Overview (README)' },
    { path: 'public/CHANGELOG.json', label: 'Recent Changes (Changelog)' },
    {
      path: 'design-docs/feature-requests.md',
      label: 'Feature Requests & Roadmap',
    },
  ];

  for (const file of filesToFetch) {
    try {
      const content = runtime.repoReader
        ? await runtime.repoReader.readFile(file.path)
        : await remoteCatalog!.getSkillFile(
            repoInfo.repo,
            file.path,
            repoInfo.branch,
            repoInfo.org
          );
      if (content) {
        sections.push(`## ${file.label}\n\n${content}`);
      }
    } catch {
      // Best-effort — skip files that can't be fetched
    }
  }

  const prompt =
    sections.length > 6
      ? sections.join('\n\n')
      : fallbackSystemPrompt(
          runtime.nativeReads,
          repoInfo,
          runtime.repoReader,
          runtime.storage,
        );
  contextPromptCache.set(sourceKey, {
    prompt,
    fetchedAt: Date.now(),
  });
  return prompt;
}

/**
 * Build the MCP servers map for the Ask Apex agent.
 * Provides read-only GitHub repo browsing tools.
 */
function buildAskApexMcpServers(
  grounding: CallerGroundingSelection,
  options?: {
    nativeReads?: boolean;
    omitGroundingProfile?: boolean;
  }
): Record<string, McpServerConfig> {
  const port = process.env.PORT ?? '3001';
  const profilePath =
    grounding.mode === 'local' && !options?.omitGroundingProfile
      ? `/grounding/${grounding.profileId}`
      : '';
  const browseQuery = options?.nativeReads ? '?enableRepoBrowse=false' : '';
  return {
    'github-repo': {
      url: `http://localhost:${port}/mcp/github-repo${profilePath}${browseQuery}`,
    },
  };
}

interface AskApexRepositoryRuntime {
  nativeReads: boolean;
  local: LocalAgentOptions;
  mcpServers: Record<string, McpServerConfig>;
  repoReader?: RepoReader;
  storage?: 'bare mirror' | 'Azure Files checkout';
}

function isExactAskApexReader(
  reader: RepoReader,
  grounding: Extract<CallerGroundingSelection, { mode: 'local' }>,
  repoInfo: RepoInfo | null
): boolean {
  return Boolean(
    repoInfo &&
    reader.identity.provider === 'github' &&
    reader.identity.project === 'Apex' &&
    reader.identity.repo === repoInfo.repo &&
    reader.identity.sha === grounding.resolvedSha
  );
}

async function prepareAskApexRepositoryRuntime(
  grounding: CallerGroundingSelection,
  repoInfo: RepoInfo | null
): Promise<AskApexRepositoryRuntime> {
  const requestedNative = grounding.mode === 'local' && grounding.nativeReads;
  let repoReader: RepoReader | undefined;

  if (requestedNative && grounding.mode === 'local') {
    try {
      const resolved = await groundingProfileResolver.resolveConnectionProfile(
        grounding.profileId
      );
      if (isExactAskApexReader(resolved, grounding, repoInfo)) {
        repoReader = resolved;
      }
    } catch {
      repoReader = undefined;
    }
  }

  const nativeReads = Boolean(repoReader);
  return {
    nativeReads,
    local: {
      cwd: process.cwd(),
      ...(repoReader ? { customTools: createNativeReadTools(repoReader) } : {}),
    },
    mcpServers: buildAskApexMcpServers(grounding, {
      nativeReads,
      omitGroundingProfile: requestedNative,
    }),
    repoReader,
    storage:
      grounding.mode === 'local' && !grounding.workingTree
        ? 'bare mirror'
        : 'Azure Files checkout',
  };
}

async function buildSystemPrompt(
  repoInfo: RepoInfo | null,
  runtime: AskApexRepositoryRuntime
): Promise<string> {
  try {
    return await fetchRepoContext(repoInfo, runtime);
  } catch (err) {
    console.error(
      '[ask-apex] Failed to build context-aware prompt:',
      (err as Error).message
    );
    return fallbackSystemPrompt(
      runtime.nativeReads,
      repoInfo,
      runtime.repoReader,
      runtime.storage,
    );
  }
}

export interface AskApexMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

export type AskApexSessionStatus = 'idle' | 'preparing' | 'streaming' | 'error';

export interface AskApexSseEvent {
  type: 'token' | 'message' | 'status' | 'error' | 'done';
  text?: string;
  message?: AskApexMessage;
  status?: AskApexSessionStatus;
  error?: string;
}

interface SessionState {
  id: string;
  userId: string;
  agent: SDKAgent | null;
  messages: AskApexMessage[];
  status: AskApexSessionStatus;
  subscribers: Set<(event: AskApexSseEvent) => void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  grounding: CallerGroundingSelection | null;
  repoInfo: RepoInfo | null;
}

const sessions = new Map<string, SessionState>();

function broadcast(session: SessionState, event: AskApexSseEvent): void {
  for (const cb of session.subscribers) {
    try {
      cb(event);
    } catch {
      /* subscriber error */
    }
  }
}

function resetIdleTimer(session: SessionState): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(
    () => destroySession(session.id),
    SESSION_IDLE_TIMEOUT_MS
  );
}

function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status === 'streaming') {
    resetIdleTimer(session);
    return;
  }
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.agent) {
    try {
      session.agent[Symbol.asyncDispose]().catch(() => {});
    } catch {
      /* ignore */
    }
  }
  sessions.delete(sessionId);
  void session.grounding?.release().catch(() => undefined);
}

export function createSession(userId: string): string {
  const sessionId = uuidv4();

  const session: SessionState = {
    id: sessionId,
    userId,
    agent: null,
    messages: [],
    status: 'idle',
    subscribers: new Set(),
    idleTimer: null,
    grounding: null,
    repoInfo: null,
  };

  sessions.set(sessionId, session);
  resetIdleTimer(session);
  return sessionId;
}

export function getSession(
  sessionId: string,
  userId: string
): SessionState | null {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return null;
  return session;
}

export function subscribeToSession(
  sessionId: string,
  userId: string,
  callback: (event: AskApexSseEvent) => void
): (() => void) | null {
  const session = getSession(sessionId, userId);
  if (!session) return null;
  session.subscribers.add(callback);
  return () => {
    session.subscribers.delete(callback);
  };
}

export function getSessionMessages(
  sessionId: string,
  userId: string
): AskApexMessage[] | null {
  const session = getSession(sessionId, userId);
  if (!session) return null;
  return session.messages;
}

async function ensureSessionGrounding(
  session: SessionState
): Promise<CallerGroundingSelection> {
  if (session.grounding) return session.grounding;

  const repoInfo = await resolveRepoInfo();
  session.repoInfo = repoInfo;
  if (!repoInfo) {
    session.grounding = {
      mode: 'remote',
      release: async () => undefined,
    };
    return session.grounding;
  }

  const grounding = await callerGroundingService.start({
    caller: 'ask-apex',
    userId: session.userId,
    run: {
      runType: 'service',
      runId: session.id,
      project: 'Apex',
    },
    repository: {
      provider: 'github',
      repo: repoInfo.repo,
      branch: repoInfo.branch,
    },
    reauthorize: async () => getSession(session.id, session.userId) !== null,
    readOnlyShareable: true,
  });
  if (grounding.mode !== 'preparing') {
    session.grounding = grounding;
  }
  return grounding;
}

async function waitForSessionGrounding(session: SessionState): Promise<{
  grounding: Exclude<CallerGroundingSelection, { mode: 'preparing' }>;
  prepared: boolean;
}> {
  const deadline = Date.now() + GROUNDING_PREPARATION_TIMEOUT_MS;
  let prepared = false;
  while (true) {
    const grounding = await ensureSessionGrounding(session);
    if (grounding.mode !== 'preparing') return { grounding, prepared };

    prepared = true;
    session.status = 'preparing';
    broadcast(session, { type: 'status', status: 'preparing' });
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

function isTransientSdkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('rate') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('503')
  );
}

export async function sendMessage(
  sessionId: string,
  userId: string,
  text: string
): Promise<void> {
  const session = getSession(sessionId, userId);
  if (!session) throw new Error('Session not found');
  if (session.status === 'streaming') throw new Error('Already streaming');

  const userMsg: AskApexMessage = {
    id: uuidv4(),
    role: 'user',
    text: text.trim(),
    ts: new Date().toISOString(),
  };
  session.messages.push(userMsg);
  broadcast(session, { type: 'message', message: userMsg });

  session.status = 'streaming';
  broadcast(session, { type: 'status', status: 'streaming' });
  resetIdleTimer(session);

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    session.status = 'error';
    broadcast(session, { type: 'error', error: 'CURSOR_API_KEY is not set' });
    return;
  }

  try {
    const sdkRetryOpts = {
      maxRetries: 3,
      initialDelay: 1000,
      shouldRetry: isTransientSdkError,
      jitter: true,
    } as const;
    const isFirstTurn = !session.agent;
    const groundingResult = isFirstTurn
      ? await waitForSessionGrounding(session)
      : null;
    const grounding = groundingResult?.grounding ?? session.grounding;
    if (!grounding) throw new Error('Repository grounding is unavailable');
    if (groundingResult?.prepared) {
      session.status = 'streaming';
      broadcast(session, { type: 'status', status: 'streaming' });
    }
    const repositoryRuntime = isFirstTurn
      ? await prepareAskApexRepositoryRuntime(grounding, session.repoInfo)
      : null;

    const prompt = isFirstTurn
      ? `${await buildSystemPrompt(session.repoInfo, repositoryRuntime!)}\n\n---\n\nUser: ${text.trim()}`
      : text.trim();

    if (!session.agent) {
      session.agent = await retryWithBackoff(
        () =>
          Agent.create({
            apiKey,
            model: { id: MODEL_ID },
            local: repositoryRuntime!.local,
            mcpServers: repositoryRuntime!.mcpServers,
          }),
        sdkRetryOpts
      );
    }

    const run = await retryWithBackoff(() => session.agent!.send(prompt), {
      ...sdkRetryOpts,
      maxRetries: 2,
    });

    let agentTextBuffer = '';

    if (run.supports('stream')) {
      for await (const event of run.stream()) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              agentTextBuffer += block.text;
              broadcast(session, { type: 'token', text: block.text });
            }
          }
        }
      }
    }

    const assistantMsg: AskApexMessage = {
      id: uuidv4(),
      role: 'assistant',
      text:
        agentTextBuffer.trim() ||
        "I wasn't able to generate a response. Please try again.",
      ts: new Date().toISOString(),
    };
    session.messages.push(assistantMsg);
    broadcast(session, { type: 'message', message: assistantMsg });

    session.status = 'idle';
    broadcast(session, { type: 'status', status: 'idle' });
    broadcast(session, { type: 'done' });

    // Record usage (fire-and-forget)
    recordAiUsage({
      provider: 'cursor',
      modelId: MODEL_ID,
      feature: 'home-chat',
      project: 'Apex',
      threadId: sessionId,
      userId,
      inputTokens: estimateTokens(text),
      outputTokens: estimateTokens(agentTextBuffer),
      tokenSource: 'estimated',
      costUsd: 0,
      costSource: 'estimated',
      status: 'success',
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error(
      `[ask-apex] sendMessage error for session ${sessionId}:`,
      errorMessage
    );

    const errorMsg: AskApexMessage = {
      id: uuidv4(),
      role: 'assistant',
      text: `Sorry, I encountered an error. Please try again. (${errorMessage})`,
      ts: new Date().toISOString(),
    };
    session.messages.push(errorMsg);
    broadcast(session, { type: 'message', message: errorMsg });

    session.status = 'idle';
    broadcast(session, { type: 'status', status: 'idle' });
    broadcast(session, { type: 'done' });
  } finally {
    resetIdleTimer(session);
  }
}

export function closeSession(sessionId: string, userId: string): boolean {
  const session = getSession(sessionId, userId);
  if (!session) return false;
  destroySession(sessionId);
  return true;
}
