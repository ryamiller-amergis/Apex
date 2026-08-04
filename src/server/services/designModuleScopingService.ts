import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, designModules } from '../db/schema';
import {
  cancelRun as cancelChatRun,
  createThread as createChatThread,
  isThreadIdle,
  sendMessage,
  updateThreadKickoffContext,
} from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import type {
  DesignModuleScopingConfidence,
  DesignModuleScopingRequest,
  DesignModuleScopingResult,
  DesignModuleScopingResultResponse,
  DesignModuleScopingStartResponse,
} from '../../shared/types/designModuleScoping';
import { DesignModuleScopingError } from '../../shared/types/designModuleScoping';

export const DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH =
  '.cursor/skills/design-module-scoping/SKILL.md';
const OUTPUT_RELATIVE_PATH = ['.ai-pilot', 'output', 'module-scoping.json'];
const CONFIDENCE_VALUES = new Set<DesignModuleScopingConfidence>([
  'high',
  'medium',
  'low',
]);

const cancelledThreads = new Set<string>();

/**
 * Threads whose kickoff/refine sendMessage is still in flight.
 * createThread leaves status as `idle` until sendMessage flips it to
 * `running`, and the client polls immediately — without this guard that
 * window is mis-reported as "completed without a proposal".
 */
const scopingInFlight = new Set<string>();

function trackScopingSend(
  threadId: string,
  send: Promise<unknown>
): void {
  scopingInFlight.add(threadId);
  void send.finally(() => {
    scopingInFlight.delete(threadId);
  });
}
/**
 * Skill content is loaded by chatAgentService during thread bootstrap via the
 * standard prefetch chain (pinned SHA checkout → GH/ADO MCP → Apex cwd
 * fallback). This service only passes the skillPath on the thread kickoff and
 * includes module metadata in freeformContext — it does not embed the skill
 * body itself.
 */

function buildModuleContext(
  projectId: string,
  input: DesignModuleScopingRequest,
  repoMeta: { repo: string; branch: string; skillProvider: string }
): string {
  const lines = [
    `Project: ${projectId}`,
    `Connected repo: ${repoMeta.repo}`,
    `Branch: ${repoMeta.branch}`,
    `Provider: ${repoMeta.skillProvider}`,
    `Module name: ${input.name.trim()}`,
    `Description: ${(input.description ?? '').trim() || '(none)'}`,
  ];
  if (input.moduleSlug?.trim()) {
    lines.push(`Module slug: ${input.moduleSlug.trim()}`);
  }
  if (input.searchHints?.trim()) {
    lines.push('', 'Search hints (what to look for in the connected repo):');
    lines.push(input.searchHints.trim());
  }
  if (input.currentGlobs?.length) {
    lines.push('', 'Current globs:');
    for (const glob of input.currentGlobs) {
      lines.push(`- ${glob}`);
    }
  }
  if (input.instruction?.trim()) {
    lines.push('', `Refine instruction: ${input.instruction.trim()}`);
  }
  lines.push(
    '',
    'Explore the connected repository with MCP tools (search_repo_code, list_repo_dir, get_skill_file).',
    'Do NOT invent paths — verify against the connected repo.',
    'Write proposed source globs to .ai-pilot/output/module-scoping.json using the Write tool.'
  );
  return lines.join('\n');
}

function buildFreeformContext(
  projectId: string,
  input: DesignModuleScopingRequest,
  repoMeta: { repo: string; branch: string; skillProvider: string },
): string {
  return [
    '# Module to scope',
    buildModuleContext(projectId, input, repoMeta),
  ].join('\n');
}

const SCOPING_KICKOFF_MESSAGE =
  'Execute the Design Module Scoping skill. The module context is in `.ai-pilot/kickoff-context.md`. Use MCP tools to search/list the connected project repository and branch listed there, then write `.ai-pilot/output/module-scoping.json` with the Write tool. Do not ask questions.';

async function persistThreadOnModule(
  moduleSlug: string | undefined,
  threadId: string
): Promise<void> {
  const slug = moduleSlug?.trim();
  if (!slug) return;
  const existing = await db.query.designModules.findFirst({
    where: eq(designModules.slug, slug),
    columns: { id: true },
  });
  if (!existing) return;
  await db
    .update(designModules)
    .set({
      scopingThreadId: threadId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designModules.slug, slug));
}

/**
 * Only resume for refine turns. A fresh "Suggest" always starts a new thread so
 * a failed re-run cannot wipe a prior successful proposal mid-poll.
 */
async function resolveResumeThreadId(
  input: DesignModuleScopingRequest
): Promise<string | null> {
  if (!input.instruction?.trim()) return null;
  if (input.threadId?.trim()) return input.threadId.trim();
  const slug = input.moduleSlug?.trim();
  if (!slug) return null;
  const row = await db.query.designModules.findFirst({
    where: eq(designModules.slug, slug),
    columns: { scopingThreadId: true },
  });
  return row?.scopingThreadId ?? null;
}

export async function startScoping(
  projectId: string,
  input: DesignModuleScopingRequest,
  userId: string
): Promise<DesignModuleScopingStartResponse> {
  if (!input?.name?.trim()) {
    throw new DesignModuleScopingError(
      'name is required',
      'DESIGN_MODULE_SCOPING_VALIDATION'
    );
  }
  if (!projectId?.trim()) {
    throw new DesignModuleScopingError(
      'project is required',
      'DESIGN_MODULE_SCOPING_VALIDATION'
    );
  }

  const skillConfig = await resolveSkillConfig({ project: projectId });
  if (!skillConfig?.skillRepo) {
    throw new DesignModuleScopingError(
      'This project has no connected repository configured for design-module scoping.',
      'NO_REPO_CONNECTED'
    );
  }

  const repoMeta = {
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
    skillProvider: skillConfig.skillProvider ?? 'ado',
  };
  const skillPath =
    skillConfig.designModuleScopingSkillPath?.trim() ||
    DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH;

  const resumeThreadId = await resolveResumeThreadId(input);

  if (resumeThreadId) {
    await loadThreadForUser(resumeThreadId, userId);
    cancelledThreads.delete(resumeThreadId);

    const freeformContext = buildFreeformContext(
      projectId,
      input,
      repoMeta,
    );
    updateThreadKickoffContext(resumeThreadId, freeformContext);

    const row = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, resumeThreadId),
      columns: { workspaceDir: true },
    });
    if (row?.workspaceDir) {
      const outputPath = path.join(row.workspaceDir, ...OUTPUT_RELATIVE_PATH);
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {
        // Best-effort; stale output is still validated on poll.
      }
      try {
        const kickoffPath = path.join(
          row.workspaceDir,
          '.ai-pilot',
          'kickoff-context.md'
        );
        fs.mkdirSync(path.dirname(kickoffPath), { recursive: true });
        fs.writeFileSync(kickoffPath, freeformContext, 'utf-8');
      } catch {
        // Best-effort; in-memory kickoff update still applies on next turn.
      }
    }

    const message = [
      'Refine the Design Module source scope. The updated module context is in `.ai-pilot/kickoff-context.md`.',
      '',
      buildModuleContext(projectId, input, repoMeta),
      '',
      'Rewrite `.ai-pilot/output/module-scoping.json` with the updated proposal using the Write tool. Do not ask questions.',
    ].join('\n');

    trackScopingSend(
      resumeThreadId,
      sendMessage(resumeThreadId, message).catch((err: Error) => {
        console.error(
          `[designModuleScoping] sendMessage failed for ${resumeThreadId}:`,
          err.message
        );
      })
    );

    await persistThreadOnModule(input.moduleSlug, resumeThreadId);
    return { threadId: resumeThreadId };
  }

  const model =
    skillConfig.designModuleScopingModel ??
    skillConfig.designModuleModel ??
    skillConfig.designDocModel ??
    skillConfig.defaultModel ??
    (await getDefaultModel());
  const freeformContext = buildFreeformContext(
    projectId,
    input,
    repoMeta,
  );

  const thread = await createChatThread(
    userId,
    {
      project: projectId,
      repo: skillConfig.skillRepo,
      branch: skillConfig.skillBranch ?? 'main',
      skillProvider: skillConfig.skillProvider ?? 'ado',
      skillPath,
      freeformContext,
      model,
    },
    {
      skipAutoKickoff: true,
    }
  );

  cancelledThreads.delete(thread.id);
  trackScopingSend(
    thread.id,
    sendMessage(thread.id, SCOPING_KICKOFF_MESSAGE, undefined, [], {
      hidden: true,
    }).catch((err: Error) => {
      console.error(
        `[designModuleScoping] kickoff sendMessage failed for ${thread.id}:`,
        err.message
      );
    })
  );

  await persistThreadOnModule(input.moduleSlug, thread.id);
  return { threadId: thread.id };
}

function resolveOutputPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...OUTPUT_RELATIVE_PATH);
}

function readOutput(workspaceDir: string): string | null {
  const outputPath = resolveOutputPath(workspaceDir);
  if (!fs.existsSync(outputPath)) return null;
  try {
    return fs.readFileSync(outputPath, 'utf-8');
  } catch {
    return null;
  }
}

export function parseScopingResult(raw: string): DesignModuleScopingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DesignModuleScopingError(
      'Scoping output is not valid JSON.',
      'INVALID_OUTPUT'
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DesignModuleScopingError(
      'Scoping output is not an object.',
      'INVALID_OUTPUT'
    );
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.globs) || record.globs.length === 0) {
    throw new DesignModuleScopingError(
      'Scoping output is missing globs.',
      'MISSING_GLOBS'
    );
  }

  const globs = record.globs.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new DesignModuleScopingError(
        `Scoping glob at index ${index} is invalid.`,
        'INVALID_GLOB'
      );
    }
    const item = entry as Record<string, unknown>;
    const pattern = typeof item.pattern === 'string' ? item.pattern.trim() : '';
    const rationale =
      typeof item.rationale === 'string' ? item.rationale.trim() : '';
    const confidence = item.confidence as DesignModuleScopingConfidence;
    if (!pattern) {
      throw new DesignModuleScopingError(
        `Scoping glob at index ${index} is missing pattern.`,
        'INVALID_GLOB'
      );
    }
    if (pattern.includes('..') || path.isAbsolute(pattern)) {
      throw new DesignModuleScopingError(
        `Scoping glob "${pattern}" must stay within the repository.`,
        'INVALID_GLOB'
      );
    }
    if (!CONFIDENCE_VALUES.has(confidence)) {
      throw new DesignModuleScopingError(
        `Scoping glob at index ${index} has invalid confidence.`,
        'INVALID_GLOB'
      );
    }
    if (!rationale) {
      throw new DesignModuleScopingError(
        `Scoping glob at index ${index} is missing rationale.`,
        'INVALID_GLOB'
      );
    }
    return { pattern, confidence, rationale };
  });

  return {
    globs,
    notes: typeof record.notes === 'string' ? record.notes : undefined,
  };
}

async function loadThreadForUser(
  threadId: string,
  userId: string
): Promise<{ userId: string; workspaceDir: string | null; status: string }> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { userId: true, workspaceDir: true, status: true },
  });
  if (!row || row.userId !== userId) {
    throw new DesignModuleScopingError(
      'Design module scoping thread not found.',
      'THREAD_NOT_FOUND'
    );
  }
  return row;
}

export async function getScopingResult(
  threadId: string,
  userId: string
): Promise<DesignModuleScopingResultResponse> {
  const row = await loadThreadForUser(threadId, userId);

  if (cancelledThreads.has(threadId)) {
    return { status: 'cancelled' };
  }

  if (!row.workspaceDir) {
    return { status: 'pending' };
  }

  const raw = readOutput(row.workspaceDir);
  if (!raw) {
    // Kickoff is fire-and-forget; status stays idle until sendMessage starts.
    // Treat that gap (and the whole in-flight run) as pending, not failure.
    if (scopingInFlight.has(threadId) || !isThreadIdle(threadId)) {
      return { status: 'pending' };
    }
    return {
      status: 'failed',
      error: 'Agent completed without producing a scoping proposal.',
    };
  }

  try {
    const result = parseScopingResult(raw);
    return { status: 'ready', result };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to parse scoping output.';
    return { status: 'failed', error: message };
  }
}

export async function cancelScoping(
  threadId: string,
  userId: string
): Promise<DesignModuleScopingResultResponse> {
  await loadThreadForUser(threadId, userId);
  await cancelChatRun(threadId);
  scopingInFlight.delete(threadId);
  cancelledThreads.add(threadId);
  return { status: 'cancelled' };
}
