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
 * Platform skill lives in the Apex checkout. Remote skill repos often do not
 * have it yet (GitHub pre-fetch 404s and the agent exits without writing
 * output). Embed the local skill text so scoping works before the skill is
 * published to the connected repo.
 */
export function loadLocalScopingSkill(
  repositoryRoot = process.cwd()
): string {
  const skillPath = path.join(
    repositoryRoot,
    DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH
  );
  if (!fs.existsSync(skillPath)) {
    throw new DesignModuleScopingError(
      `Design module scoping skill is missing at ${DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH}.`,
      'SKILL_MISSING'
    );
  }
  return fs.readFileSync(skillPath, 'utf-8');
}

function buildModuleContext(
  projectId: string,
  input: DesignModuleScopingRequest
): string {
  const lines = [
    `Project: ${projectId}`,
    `Module name: ${input.name.trim()}`,
    `Description: ${(input.description ?? '').trim() || '(none)'}`,
  ];
  if (input.moduleSlug?.trim()) {
    lines.push(`Module slug: ${input.moduleSlug.trim()}`);
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
    'Write proposed source globs to .ai-pilot/output/module-scoping.json using the Write tool.'
  );
  return lines.join('\n');
}

function buildFreeformContext(
  projectId: string,
  input: DesignModuleScopingRequest
): string {
  return [
    '# Design Module Scoping skill — follow exactly',
    loadLocalScopingSkill(),
    '',
    '# Module to scope',
    buildModuleContext(projectId, input),
  ].join('\n');
}

const SCOPING_KICKOFF_MESSAGE =
  'Execute the Design Module Scoping skill embedded in `.ai-pilot/kickoff-context.md`. Explore the repository with MCP tools as needed, then write `.ai-pilot/output/module-scoping.json` with the Write tool. Do not ask questions.';

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

async function resolveResumeThreadId(
  input: DesignModuleScopingRequest
): Promise<string | null> {
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

  const resumeThreadId = await resolveResumeThreadId(input);

  if (resumeThreadId) {
    await loadThreadForUser(resumeThreadId, userId);
    cancelledThreads.delete(resumeThreadId);

    // Refresh kickoff context with the local skill + latest module inputs.
    updateThreadKickoffContext(
      resumeThreadId,
      buildFreeformContext(projectId, input)
    );

    // Clear prior output so polling waits for the latest pass.
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
      // Also rewrite kickoff-context.md on disk when the workspace still exists.
      try {
        const kickoffPath = path.join(
          row.workspaceDir,
          '.ai-pilot',
          'kickoff-context.md'
        );
        fs.mkdirSync(path.dirname(kickoffPath), { recursive: true });
        fs.writeFileSync(
          kickoffPath,
          buildFreeformContext(projectId, input),
          'utf-8'
        );
      } catch {
        // Best-effort; in-memory kickoff update still applies on next turn prompt.
      }
    }

    const message = [
      input.instruction?.trim()
        ? 'Refine the Design Module source scope using the skill in kickoff-context.md.'
        : 'Propose Design Module source globs for this module using the skill in kickoff-context.md.',
      '',
      buildModuleContext(projectId, input),
      '',
      'Rewrite `.ai-pilot/output/module-scoping.json` with the updated proposal using the Write tool. Do not ask questions.',
    ].join('\n');

    void sendMessage(resumeThreadId, message).catch((err: Error) => {
      console.error(
        `[designModuleScoping] sendMessage failed for ${resumeThreadId}:`,
        err.message
      );
    });

    await persistThreadOnModule(input.moduleSlug, resumeThreadId);
    return { threadId: resumeThreadId };
  }

  const model =
    skillConfig.designDocModel ??
    skillConfig.defaultModel ??
    (await getDefaultModel());
  const freeformContext = buildFreeformContext(projectId, input);

  // skillPath keeps the skill-oriented system prompt. The skill body is also
  // embedded in freeformContext, and chatAgentService falls back to the local
  // Apex checkout when the connected repo does not have the skill yet (404).
  const thread = await createChatThread(
    userId,
    {
      project: projectId,
      repo: skillConfig.skillRepo,
      branch: skillConfig.skillBranch ?? 'main',
      skillProvider: skillConfig.skillProvider ?? 'ado',
      skillPath: DEFAULT_DESIGN_MODULE_SCOPING_SKILL_PATH,
      freeformContext,
      model,
    },
    {
      skipAutoKickoff: true,
    }
  );

  cancelledThreads.delete(thread.id);
  void sendMessage(thread.id, SCOPING_KICKOFF_MESSAGE, undefined, [], {
    hidden: true,
  }).catch((err: Error) => {
    console.error(
      `[designModuleScoping] kickoff sendMessage failed for ${thread.id}:`,
      err.message
    );
  });

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
    if (isThreadIdle(threadId)) {
      return {
        status: 'failed',
        error: 'Agent completed without producing a scoping proposal.',
      };
    }
    return { status: 'pending' };
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
  cancelledThreads.add(threadId);
  return { status: 'cancelled' };
}
