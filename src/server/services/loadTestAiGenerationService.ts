import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads } from '../db/schema';
import { createThread as createChatThread, cancelRun as cancelChatRun, isThreadIdle } from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import type {
  LoadTestAiGenerateRequest,
  LoadTestAiGenerateResult,
  LoadTestAiGenerateResultResponse,
  LoadTestAiGenerateStartResponse,
} from '../../shared/types/loadTestAi';
import { LoadTestAiGenerationError } from '../../shared/types/loadTestAi';

export const DEFAULT_K6_GENERATION_SKILL_PATH = '.cursor/skills/k6-load-test-generation/SKILL.md';
const OUTPUT_RELATIVE_PATH = ['.ai-pilot', 'output', 'k6-generation.json'];

// In-memory record of cancelled generation threads. Repo source (transient chat workspace)
// is never persisted beyond generation, so a lightweight in-memory marker is sufficient —
// on process restart a cancelled-but-unread thread simply falls back to pending/failed.
const cancelledThreads = new Set<string>();

// ── Plaintext secret heuristic ──────────────────────────────────────────────────
// Reject scripts that contain obviously real (not placeholder) bearer tokens, API
// keys, or private key material. This is intentionally conservative — env/secret-ref
// placeholders like `${__ENV.AUTH_TOKEN}` never match.

const SECRET_PATTERNS: RegExp[] = [
  /Authorization\s*[:=]\s*['"`]?\s*Bearer\s+[A-Za-z0-9\-_.]{12,}/i,
  /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9\-_]{16,}['"]/i,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/,
];

export function containsPlaintextSecret(script: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(script));
}

/** Throws when the generated script fails the plaintext-secret heuristic. */
export function validateForApply(result: Pick<LoadTestAiGenerateResult, 'script'>): void {
  if (containsPlaintextSecret(result.script)) {
    throw new LoadTestAiGenerationError(
      'Generated script appears to contain a plaintext secret (bearer token, API key, or private key). Use env/secret-ref placeholders instead.',
      'PLAINTEXT_SECRET_DETECTED',
    );
  }
}

// ── Kickoff context ──────────────────────────────────────────────────────────────

function buildFreeformContext(projectId: string, input: LoadTestAiGenerateRequest): string {
  const lines = [
    `Project: ${projectId}`,
    '',
    'Flow hints:',
    input.flowHints.trim(),
  ];
  if (input.loadProfileCaps) {
    lines.push('', `Load profile caps: ${JSON.stringify(input.loadProfileCaps)}`);
  }
  return lines.join('\n');
}

// ── startGeneration ──────────────────────────────────────────────────────────────

export async function startGeneration(
  projectId: string,
  input: LoadTestAiGenerateRequest,
  userId: string,
): Promise<LoadTestAiGenerateStartResponse> {
  if (!input?.flowHints?.trim()) {
    throw new LoadTestAiGenerationError('flowHints is required', 'LOAD_TEST_AI_VALIDATION');
  }

  const skillConfig = await resolveSkillConfig({ project: projectId });
  if (!skillConfig?.skillRepo) {
    throw new LoadTestAiGenerationError(
      'This project has no connected repository configured for load-test generation.',
      'NO_REPO_CONNECTED',
    );
  }

  const skillPath = skillConfig.loadTestGenerationSkillPath ?? DEFAULT_K6_GENERATION_SKILL_PATH;
  const globalModel = await getDefaultModel();
  const model = skillConfig.loadTestGenerationModel ?? skillConfig.developmentModel ?? globalModel;

  const freeformContext = buildFreeformContext(projectId, input);

  const thread = await createChatThread(userId, {
    project: projectId,
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
    skillProvider: skillConfig.skillProvider ?? 'ado',
    skillPath,
    freeformContext,
    model,
  });

  cancelledThreads.delete(thread.id);
  return { threadId: thread.id };
}

// ── getGenerationResult ──────────────────────────────────────────────────────────

function resolveOutputPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...OUTPUT_RELATIVE_PATH);
}

function readOutput(workspaceDir: string): string | null {
  const outputPath = resolveOutputPath(workspaceDir);
  if (!fs.existsSync(outputPath)) return null;
  try {
    return fs.readFileSync(outputPath, 'utf-8') as unknown as string;
  } catch {
    return null;
  }
}

function parseResult(raw: string): LoadTestAiGenerateResult {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LoadTestAiGenerationError('Generated output is not valid JSON.', 'INVALID_OUTPUT');
  }
  if (!parsed || typeof parsed.script !== 'string' || !parsed.script.trim()) {
    throw new LoadTestAiGenerationError('Generated output is missing a script.', 'MISSING_SCRIPT');
  }
  if (!Array.isArray(parsed.suggested_thresholds)) {
    throw new LoadTestAiGenerationError('Generated output is missing suggested_thresholds.', 'MISSING_THRESHOLDS');
  }
  return {
    script: parsed.script,
    suggested_thresholds: parsed.suggested_thresholds,
    notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
  };
}

async function loadThreadForUser(
  threadId: string,
  userId: string,
): Promise<{ userId: string; workspaceDir: string | null; status: string }> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { userId: true, workspaceDir: true, status: true },
  });
  if (!row || row.userId !== userId) {
    throw new LoadTestAiGenerationError('Load test generation thread not found.', 'THREAD_NOT_FOUND');
  }
  return row;
}

export async function getGenerationResult(
  threadId: string,
  userId: string,
): Promise<LoadTestAiGenerateResultResponse> {
  const row = await loadThreadForUser(threadId, userId);

  if (cancelledThreads.has(threadId)) {
    return { status: 'cancelled' };
  }

  if (!row.workspaceDir) {
    return { status: 'pending' };
  }

  const raw = readOutput(row.workspaceDir);
  if (!raw) {
    if (isThreadIdle(threadId)) {
      return { status: 'failed', error: 'Agent completed without generating a script.' };
    }
    return { status: 'pending' };
  }

  try {
    const result = parseResult(raw);
    validateForApply(result);
    return { status: 'ready', result };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to parse generation output.';
    return { status: 'failed', error: message };
  }
}

// ── cancelGeneration ─────────────────────────────────────────────────────────────

export async function cancelGeneration(
  threadId: string,
  userId: string,
): Promise<LoadTestAiGenerateResultResponse> {
  await loadThreadForUser(threadId, userId);
  await cancelChatRun(threadId);
  cancelledThreads.add(threadId);
  return { status: 'cancelled' };
}
