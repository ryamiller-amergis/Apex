import fs from 'node:fs';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { interviews } from '../db/schema';
import type {
  StartTechnicalPhaseResponse,
  TechnicalPhaseSeedContext,
  TechnicalPhaseState,
} from '../../shared/types/interview';
import { createThread, sendMessage } from './chatAgentService';
import { loadFullThread } from './chatThreadRepository';
import {
  amendRequirementsSummary,
  editPhaseSummary,
  getPhaseSummary,
} from './phaseLifecycleService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';

const DEFAULT_TECHNICAL_PHASE_SKILL =
  '.cursor/skills/technical-phase/SKILL.md';

type InterviewRow = typeof interviews.$inferSelect;

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

async function loadInterviewById(interviewId: string): Promise<InterviewRow> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
  });
  if (!row) throw httpError(404, 'Interview not found');
  return row;
}

function unavailableReason(row: InterviewRow): string | null {
  if (row.phaseFlow !== 'technical_only' && row.phaseFlow !== 'both_sequential') {
    return 'The Technical phase is not configured for this interview.';
  }
  if (
    row.phaseFlow === 'both_sequential'
    && row.requirementsPhaseStatus !== 'approved'
  ) {
    return 'Requirements must be approved before Technical can start.';
  }
  return null;
}

async function loadSeedContext(row: InterviewRow): Promise<TechnicalPhaseSeedContext> {
  const originalThread = await loadFullThread(row.chatThreadId);
  const originalPrompt = originalThread?.messages.find(
    (message) => message.role === 'user' && !message.hidden && message.text.trim(),
  )?.text.trim()
    || originalThread?.kickoff.transcript?.trim();
  if (!originalPrompt) {
    throw httpError(409, 'The original interview prompt is unavailable.');
  }

  if (row.phaseFlow === 'technical_only') {
    return {
      originalPrompt,
      requirementsSummary: null,
      requirementsApprovedAt: null,
    };
  }

  const requirements = await getPhaseSummary(row.id, 'requirements');
  if (!requirements || requirements.status !== 'approved') {
    throw httpError(409, 'Requirements must be approved before Technical can start.');
  }
  return {
    originalPrompt,
    requirementsSummary: requirements.content,
    requirementsApprovedAt: requirements.approvedAt,
  };
}

function buildSeedMarkdown(row: InterviewRow, seed: TechnicalPhaseSeedContext): string {
  return [
    `# Technical Phase Kickoff — ${row.title}`,
    '',
    `Interview ID: ${row.id}`,
    `Interview slug: ${slugify(row.title)}`,
    '',
    '## Original interview prompt',
    '',
    seed.originalPrompt,
    '',
    '## Approved Requirements Phase Summary',
    '',
    seed.requirementsSummary ?? 'No Requirements phase is configured for this interview.',
  ].join('\n');
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'interview';
}

async function stateForRow(
  row: InterviewRow,
  includeSeed: boolean,
): Promise<TechnicalPhaseState> {
  const reason = unavailableReason(row);
  if (reason) {
    return {
      status: 'unavailable',
      canStart: false,
      technicalPhaseChatThreadId: row.technicalPhaseChatThreadId ?? null,
      seedContext: null,
      unavailableReason: reason,
    };
  }

  const status = row.technicalPhaseStatus === 'approved'
    ? 'complete'
    : row.technicalPhaseChatThreadId
      ? 'in_progress'
      : 'ready';
  return {
    status,
    canStart: status === 'ready',
    technicalPhaseChatThreadId: row.technicalPhaseChatThreadId ?? null,
    seedContext: includeSeed ? await loadSeedContext(row) : null,
  };
}

export async function getTechnicalPhaseState(
  interviewId: string,
): Promise<TechnicalPhaseState> {
  return stateForRow(await loadInterviewById(interviewId), true);
}

export async function startTechnicalPhase(
  interviewId: string,
  actingUserId: string,
): Promise<StartTechnicalPhaseResponse> {
  const row = await loadInterviewById(interviewId);
  if (row.technicalOwnerId !== actingUserId) {
    throw httpError(403, 'Only the assigned Technical owner can start this phase.');
  }
  const reason = unavailableReason(row);
  if (reason) throw httpError(409, reason);
  if (row.technicalPhaseChatThreadId) {
    throw httpError(409, 'The Technical phase has already been started.');
  }

  const seed = await loadSeedContext(row);
  const skillConfig = await resolveSkillConfig({
    project: row.project,
    settingsId: row.skillSettingsId ?? undefined,
  });
  const model =
    skillConfig?.technicalPhaseModel
    ?? skillConfig?.defaultModel
    ?? await getDefaultModel();
  const seededMarkdown = buildSeedMarkdown(row, seed);
  const thread = await createThread(
    actingUserId,
    {
      project: row.project,
      repo: row.repo,
      branch: skillConfig?.skillBranch ?? 'main',
      skillProvider: skillConfig?.skillProvider,
      skillPath:
        skillConfig?.technicalPhaseSkillPath ?? DEFAULT_TECHNICAL_PHASE_SKILL,
      model,
      agentModule: 'technicalPhase',
      effort: skillConfig?.technicalPhaseEffort ?? undefined,
      skillSettingsId: row.skillSettingsId ?? skillConfig?.id ?? null,
      freeformContext: seededMarkdown,
      transcript: seededMarkdown,
    },
    { skipAutoKickoff: true },
  );

  const updated = await db
    .update(interviews)
    .set({
      technicalPhaseChatThreadId: thread.id,
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(interviews.id, interviewId),
      eq(interviews.technicalOwnerId, actingUserId),
      isNull(interviews.technicalPhaseChatThreadId),
    ))
    .returning({ id: interviews.id });
  if (updated.length === 0) {
    throw httpError(409, 'The Technical phase was started by another request.');
  }
  void sendMessage(
    thread.id,
    'Begin the Technical phase.',
    undefined,
    [],
    { hidden: true },
  )
    .then(() => syncTechnicalPhaseArtifacts(thread.id, actingUserId))
    .catch((error: unknown) => {
    console.error(
      `[technicalPhase] Auto-kickoff failed for thread ${thread.id}:`,
      error instanceof Error ? error.message : error,
    );
    });

  return {
    interviewId,
    technicalPhaseChatThreadId: thread.id,
    state: {
      status: 'in_progress',
      canStart: false,
      technicalPhaseChatThreadId: thread.id,
      seedContext: seed,
    },
  };
}

/**
 * Start the Technical phase on behalf of its assigned owner, driven by the
 * Requirements approval instead of a user click. Returns the current state when
 * the phase is still locked, unowned, or already started.
 */
export async function handoffToTechnicalPhase(
  interviewId: string,
): Promise<TechnicalPhaseState | null> {
  const row = await loadInterviewById(interviewId);
  if (unavailableReason(row)) return null;
  if (row.technicalPhaseChatThreadId) return stateForRow(row, true);
  if (!row.technicalOwnerId) return null;

  try {
    const { state } = await startTechnicalPhase(interviewId, row.technicalOwnerId);
    return state;
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    // Another approval won the race; report whatever it started.
    return stateForRow(await loadInterviewById(interviewId), true);
  }
}

export interface TechnicalPhaseArtifactSyncResult {
  amendedRequirements: boolean;
  syncedTechnicalSummary: boolean;
}

async function applyClaimedFile(
  filePath: string,
  apply: (content: string) => Promise<unknown>,
): Promise<boolean> {
  const claimedPath = `${filePath}.processing`;
  try {
    fs.renameSync(filePath, claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    await apply(fs.readFileSync(claimedPath, 'utf8'));
  } catch (error) {
    try {
      fs.renameSync(claimedPath, filePath);
    } catch {
      // Preserve the lifecycle error; the claimed file remains for diagnosis.
    }
    throw error;
  }
  try {
    fs.unlinkSync(claimedPath);
  } catch (error) {
    console.error(
      `[technicalPhase] Applied artifact but could not remove ${claimedPath}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return true;
}

export async function syncTechnicalPhaseArtifacts(
  threadId: string,
  actingUserId: string,
): Promise<TechnicalPhaseArtifactSyncResult> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.technicalPhaseChatThreadId, threadId),
  });
  if (!row) return { amendedRequirements: false, syncedTechnicalSummary: false };
  if (row.technicalOwnerId !== actingUserId) {
    throw httpError(403, 'Only the assigned Technical owner can sync phase artifacts.');
  }

  const thread = await loadFullThread(threadId);
  if (!thread?.workspaceDir) {
    return { amendedRequirements: false, syncedTechnicalSummary: false };
  }
  const outputDir = path.join(thread.workspaceDir, '.ai-pilot', 'output');
  if (!fs.existsSync(outputDir)) {
    return { amendedRequirements: false, syncedTechnicalSummary: false };
  }

  const amendmentPath = path.join(outputDir, 'requirements-amendment.md');
  const summaryName = fs.readdirSync(outputDir).find(
    (name) => /\.technical-phase-summary\.md$/i.test(name),
  );
  const amendedRequirements = await applyClaimedFile(
    amendmentPath,
    (content) => amendRequirementsSummary(row.id, actingUserId, content),
  );
  const syncedTechnicalSummary = summaryName
    ? await applyClaimedFile(
      path.join(outputDir, summaryName),
      (content) => editPhaseSummary(row.id, 'technical', actingUserId, content),
    )
    : false;

  return { amendedRequirements, syncedTechnicalSummary };
}

/**
 * Import a Technical summary that became available after the dispatch request
 * returned. This covers process restarts and delayed artifact writes before the
 * summary read model is served.
 */
export async function syncAvailableTechnicalPhaseSummary(
  interviewId: string,
): Promise<boolean> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
  });
  if (
    !row?.technicalOwnerId
    || !row.technicalPhaseChatThreadId
    || row.technicalSummary?.trim()
  ) {
    return false;
  }

  const result = await syncTechnicalPhaseArtifacts(
    row.technicalPhaseChatThreadId,
    row.technicalOwnerId,
  );
  return result.syncedTechnicalSummary;
}
