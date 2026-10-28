/**
 * Draft, edit, approve and read a build-intake brief (FEAT-006).
 *
 * The eight-section brief stays in `interview_briefs`; requirement rows, risk decisions and the
 * classification live on revision 1 of the build run. ID counters, the task estimate and the
 * migration flag ride in the `detail` of the latest `intake.brief_drafted` / `intake.brief_edited`
 * event, which carries IDs and numbers only, never brief text.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  BuildBriefAnalysis,
  BuildBriefAnalysisResponse,
  BuildClassificationResult,
  BuildIdCounters,
  BuildRequirement,
  BuildRequirementInput,
  BuildRiskDecision,
} from '../../shared/types/build';
import { BUILD_REQUIREMENT_KINDS } from '../../shared/types/build';
import type { InterviewBriefRecord, InterviewBriefSections } from '../../shared/types/interview';
import { db } from '../db/drizzle';
import { appUsers, buildEvents, buildRevisions, buildRuns, interviews } from '../db/schema';
import { appendBuildEvent } from './buildEventsService';
import { canActOnBuildIntakeInterview, isBuildIntakeInterview } from './buildIntakeAccess';
import { redactJson } from './buildRedactionService';
import { analyzeBuildBrief, BuildBriefAnalysisError, classifyBuild } from './buildRiskClassifier';
import {
  approveInterviewBrief,
  getInterviewBrief,
  InterviewBriefError,
  parseInterviewBriefSections,
  saveInterviewBrief,
} from './interviewBriefService';
import type { ApproveInterviewBriefResult } from './interviewBriefService';
import { BuildIntakeDraftError, draftBuildIntakeBrief } from './interviewOrchestratorService';
import type { BuildIntakeBriefDraft } from './interviewOrchestratorService';

export const BUILD_BRIEF_FORBIDDEN_MESSAGE =
  'Only the requester, a Project Admin or a Platform Admin can change or approve this brief.';
export const BUILD_BRIEF_NO_AC_MESSAGE = 'Add at least one acceptance criterion before you approve.';
export const BUILD_BRIEF_DRAFT_FAILED_MESSAGE =
  'The brief could not be drafted. Try again, or keep chatting and draft it later.';
export const BUILD_BRIEF_APPROVE_FAILED_MESSAGE = 'The brief was not approved. Nothing changed. Try again.';
export const BUILD_BRIEF_NO_RUN_MESSAGE = 'This build request is not linked to a build. Nothing changed.';
export const BUILD_BRIEF_NOT_DRAFTED_MESSAGE = 'The brief has not been drafted yet.';

const BUILD_DRAFT_TIMEOUT_MS = 60_000;
const DRAFT_EVENT = 'intake.brief_drafted';
const DRAFT_FAILED_EVENT = 'intake.brief_draft_failed';
const EDIT_EVENT = 'intake.brief_edited';
const APPROVED_EVENT = 'intake.brief_approved';
const REQUIREMENT_LINE_RE = /^(AC|DOD|BR|NFR)-([1-9]\d*): (.*)$/;
const PREFIX_KIND: Record<string, BuildRequirement['kind']> = { AC: 'ac', DOD: 'dod', BR: 'br', NFR: 'nfr' };
const EMPTY_COUNTERS: BuildIdCounters = { AC: 0, DOD: 0, BR: 0, NFR: 0, RD: 0 };

export class BuildBriefError extends Error {
  readonly statusCode: number;
  readonly draftFailed: boolean;

  constructor(message: string, statusCode: number, options?: { draftFailed?: boolean }) {
    super(message);
    this.name = 'BuildBriefError';
    this.statusCode = statusCode;
    this.draftFailed = options?.draftFailed ?? false;
  }
}

export interface BuildIntakeInterview {
  id: string;
  project: string | null;
  authorId: string;
  playbookProfileKey: string | null;
}

interface AnalysisState {
  counters: BuildIdCounters;
  estimatedTasks: number | null;
  needsMigration: boolean;
  reasons: string[];
}

interface RevisionRow {
  id: string;
  briefVersion: number | null;
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
}

export type ApproveBuildBriefResult = ApproveInterviewBriefResult & { classification: BuildClassificationResult };

// ── Loading ───────────────────────────────────────────────────────────────────

export async function loadBuildIntakeInterview(interviewId: string): Promise<BuildIntakeInterview | null> {
  const [row] = await db
    .select({
      id: interviews.id,
      project: interviews.project,
      authorId: interviews.authorId,
      playbookProfileKey: interviews.playbookProfileKey,
    })
    .from(interviews)
    .where(eq(interviews.id, interviewId))
    .limit(1);
  return row ?? null;
}

async function requireBuildIntake(interviewId: string): Promise<BuildIntakeInterview> {
  const interview = await loadBuildIntakeInterview(interviewId);
  if (!interview || !isBuildIntakeInterview(interview)) {
    throw new BuildBriefError('Interview not found', 404);
  }
  return interview;
}

async function requireActor(actorId: string, interview: BuildIntakeInterview): Promise<void> {
  if (!(await canActOnBuildIntakeInterview(actorId, interview))) {
    throw new BuildBriefError(BUILD_BRIEF_FORBIDDEN_MESSAGE, 403);
  }
}

async function requireBuildRunId(interviewId: string): Promise<string> {
  const [row] = await db
    .select({ id: buildRuns.id })
    .from(buildRuns)
    .where(eq(buildRuns.interviewId, interviewId))
    .limit(1);
  if (!row) throw new BuildBriefError(BUILD_BRIEF_NO_RUN_MESSAGE, 409);
  return row.id;
}

async function loadRevisionOne(buildRunId: string): Promise<RevisionRow | null> {
  const [row] = await db
    .select({
      id: buildRevisions.id,
      briefVersion: buildRevisions.briefVersion,
      requirements: buildRevisions.requirements,
      riskDecisions: buildRevisions.riskDecisions,
    })
    .from(buildRevisions)
    .where(and(eq(buildRevisions.buildRunId, buildRunId), eq(buildRevisions.revisionNumber, 1)))
    .limit(1);
  return row ?? null;
}

function readState(detail: Record<string, unknown> | null | undefined): AnalysisState {
  const counters = { ...EMPTY_COUNTERS, ...((detail?.counters as Partial<BuildIdCounters> | undefined) ?? {}) };
  const estimate = detail?.estimatedTasks;
  return {
    counters,
    estimatedTasks: typeof estimate === 'number' ? estimate : null,
    needsMigration: detail?.needsMigration === true,
    reasons: Array.isArray(detail?.reasons) ? (detail?.reasons as string[]) : [],
  };
}

async function latestEvent(
  buildRunId: string,
  eventTypes: string[],
): Promise<{ eventType: string; detail: Record<string, unknown> | null } | null> {
  const [row] = await db
    .select({ eventType: buildEvents.eventType, detail: buildEvents.detail })
    .from(buildEvents)
    .where(and(eq(buildEvents.buildRunId, buildRunId), inArray(buildEvents.eventType, eventTypes)))
    .orderBy(desc(buildEvents.ordinal))
    .limit(1);
  return row ?? null;
}

async function loadState(buildRunId: string): Promise<AnalysisState> {
  const event = await latestEvent(buildRunId, [DRAFT_EVENT, EDIT_EVENT]);
  return readState(event?.detail);
}

async function displayNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ oid: appUsers.oid, displayName: appUsers.displayName })
    .from(appUsers)
    .where(inArray(appUsers.oid, unique));
  return new Map(rows.map((row) => [row.oid, row.displayName ?? row.oid]));
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** AC, DoD and NFR rows go into `acceptanceCriteria`, BR rows into `businessRules`, one `ID: text` per line. */
export function renderBriefSections(
  sections: InterviewBriefSections,
  requirements: readonly BuildRequirement[],
): InterviewBriefSections {
  const line = (row: BuildRequirement) => `${row.id}: ${row.text}`;
  const live = requirements.filter((row) => !row.retired);
  return {
    ...sections,
    acceptanceCriteria: live.filter((row) => row.kind !== 'br').map(line).join('\n'),
    businessRules: live.filter((row) => row.kind === 'br').map(line).join('\n'),
  };
}

/** Reads rows back from server-rendered sections. Only used to repair a stale revision. */
export function requirementsFromSections(sections: InterviewBriefSections): BuildRequirement[] {
  const rows: BuildRequirement[] = [];
  for (const text of [sections.acceptanceCriteria, sections.businessRules]) {
    for (const raw of text.split('\n')) {
      const match = REQUIREMENT_LINE_RE.exec(raw.trim());
      if (match) rows.push({ id: `${match[1]}-${match[2]}`, kind: PREFIX_KIND[match[1]], text: match[3], retired: false });
    }
  }
  return rows;
}

function stateDetail(analysis: BuildBriefAnalysis, state: Omit<AnalysisState, 'counters' | 'reasons'>, briefId: string, briefVersion: number) {
  return {
    briefId,
    briefVersion,
    counters: analysis.counters,
    estimatedTasks: state.estimatedTasks,
    needsMigration: state.needsMigration,
    reasons: analysis.classification.reasons,
  };
}

async function upsertRevisionOne(
  buildRunId: string,
  briefVersion: number,
  analysis: Pick<BuildBriefAnalysis, 'requirements' | 'riskDecisions' | 'classification'>,
): Promise<string> {
  const now = new Date().toISOString();
  const values = {
    briefVersion,
    requirements: analysis.requirements,
    riskDecisions: analysis.riskDecisions,
    classification: analysis.classification.value,
    updatedAt: now,
  };
  const [row] = await db
    .insert(buildRevisions)
    .values({ buildRunId, revisionNumber: 1, ...values })
    .onConflictDoUpdate({ target: [buildRevisions.buildRunId, buildRevisions.revisionNumber], set: values })
    .returning({ id: buildRevisions.id });
  return row.id;
}

function logDraftFailure(interviewId: string, reason: string, startedAt: number): void {
  console.info('[build-brief]', JSON.stringify({
    event: 'build_brief_draft_failed',
    interviewId,
    reason,
    durationMs: Date.now() - startedAt,
  }));
}

function toInputRows(value: unknown): BuildRequirementInput[] {
  if (!Array.isArray(value)) throw new BuildBriefError('requirements must be an array.', 400);
  return value.map((row, index) => {
    const record = row as Record<string, unknown> | null;
    const id = record?.id;
    const kind = record?.kind;
    const text = record?.text;
    if (
      !record
      || (id !== null && typeof id !== 'string')
      || !BUILD_REQUIREMENT_KINDS.includes(kind as BuildRequirement['kind'])
      || typeof text !== 'string'
    ) {
      throw new BuildBriefError(`Requirement ${index + 1} is not valid.`, 400);
    }
    return { id: id as string | null, kind: kind as BuildRequirement['kind'], text };
  });
}

// ── Draft ─────────────────────────────────────────────────────────────────────

export async function draftBuildBrief(input: {
  interviewId: string;
  actorId: string;
  /** `auto` never overwrites an existing brief and returns null instead. */
  mode: 'manual' | 'auto';
}): Promise<InterviewBriefRecord | null> {
  const interview = await requireBuildIntake(input.interviewId);
  await requireActor(input.actorId, interview);
  const buildRunId = await requireBuildRunId(interview.id);

  const existing = await getInterviewBrief(interview.id);
  if (existing?.status === 'approved') throw new BuildBriefError('An approved brief is frozen.', 409);
  if (existing && input.mode === 'auto') return null;

  const startedAt = Date.now();
  const fail = async (reason: string): Promise<never> => {
    logDraftFailure(interview.id, reason, startedAt);
    await appendBuildEvent({
      buildRunId,
      eventType: DRAFT_FAILED_EVENT,
      severity: 'warn',
      message: 'The brief could not be drafted',
      actorUserId: input.actorId,
      detail: { reason },
    }).catch(() => undefined);
    throw new BuildBriefError(BUILD_BRIEF_DRAFT_FAILED_MESSAGE, 502, { draftFailed: true });
  };

  let draft: BuildIntakeBriefDraft;
  try {
    draft = redactJson(await draftBuildIntakeBrief({ interviewId: interview.id, timeoutMs: BUILD_DRAFT_TIMEOUT_MS }));
  } catch (error) {
    return fail(error instanceof BuildIntakeDraftError ? error.reason : 'agent_error');
  }

  const revision = await loadRevisionOne(buildRunId);
  const state = await loadState(buildRunId);
  let analysis: BuildBriefAnalysis;
  try {
    analysis = analyzeBuildBrief({
      requirements: draft.requirements.map((row) => ({ id: null, kind: row.kind, text: row.text })),
      riskCandidates: draft.riskCandidates,
      estimatedTasks: draft.estimatedTasks,
      needsMigration: draft.needsMigration,
      previous: revision ? { requirements: revision.requirements, riskDecisions: revision.riskDecisions, counters: state.counters } : null,
    });
  } catch (error) {
    if (error instanceof BuildBriefAnalysisError) return fail('invalid_analysis');
    throw error;
  }

  const { riskCandidates, estimatedTasks, needsMigration } = draft;
  const sections = renderBriefSections({
    problemAndOutcome: draft.problemAndOutcome,
    users: draft.users,
    scope: draft.scope,
    businessRules: draft.businessRules,
    scenarios: draft.scenarios,
    acceptanceCriteria: draft.acceptanceCriteria,
    assumptions: draft.assumptions,
    unresolvedItems: draft.unresolvedItems,
  }, analysis.requirements);
  const brief = await saveInterviewBrief({ interviewId: interview.id, sections, savedBy: input.actorId });
  const revisionId = await upsertRevisionOne(buildRunId, brief.version, analysis);

  const raised = analysis.riskDecisions.filter((decision, index) => (
    decision.rating === 'high' && riskCandidates[index]?.rating !== 'high'
  )).length;
  console.info('[build-brief]', JSON.stringify({
    event: 'build_brief_drafted',
    interviewId: interview.id,
    durationMs: Date.now() - startedAt,
    riskRaised: raised,
  }));

  await appendBuildEvent({
    buildRunId,
    buildRevisionId: revisionId,
    eventType: DRAFT_EVENT,
    message: 'Brief drafted',
    actorUserId: input.actorId,
    dedupeKey: `brief_drafted:${brief.id}:${brief.version}`,
    detail: stateDetail(analysis, { estimatedTasks, needsMigration }, brief.id, brief.version),
  });
  return brief;
}

/** Called after a requester confirms the intake summary. Never throws; failures are recorded as events. */
export async function autoDraftBuildBrief(interviewId: string): Promise<void> {
  try {
    const interview = await loadBuildIntakeInterview(interviewId);
    if (!interview || !isBuildIntakeInterview(interview)) return;
    await draftBuildBrief({ interviewId, actorId: interview.authorId, mode: 'auto' });
  } catch (error) {
    if (error instanceof BuildBriefError) return;
    console.error('[build-brief] automatic draft failed:', error instanceof Error ? error.name : 'UnknownError');
  }
}

/** Same as `autoDraftBuildBrief`, for the interview whose main chat thread is `chatThreadId`. Never throws. */
export async function autoDraftBuildBriefForThread(chatThreadId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ id: interviews.id })
      .from(interviews)
      .where(eq(interviews.chatThreadId, chatThreadId))
      .limit(1);
    if (row) await autoDraftBuildBrief(row.id);
  } catch (error) {
    console.error('[build-brief] automatic draft lookup failed:', error instanceof Error ? error.name : 'UnknownError');
  }
}

// ── Edit ──────────────────────────────────────────────────────────────────────

export async function saveBuildBrief(input: {
  interviewId: string;
  actorId: string;
  sections: unknown;
  requirements: unknown;
}): Promise<InterviewBriefRecord> {
  const interview = await requireBuildIntake(input.interviewId);
  await requireActor(input.actorId, interview);
  const buildRunId = await requireBuildRunId(interview.id);

  const rows = redactJson(toInputRows(input.requirements));
  const sections = redactJson(parseInterviewBriefSections(input.sections));
  const revision = await loadRevisionOne(buildRunId);
  if (!revision) throw new BuildBriefError(BUILD_BRIEF_NOT_DRAFTED_MESSAGE, 409);
  const state = await loadState(buildRunId);

  let analysis: BuildBriefAnalysis;
  try {
    analysis = analyzeBuildBrief({
      requirements: rows,
      estimatedTasks: state.estimatedTasks,
      needsMigration: state.needsMigration,
      previous: { requirements: revision.requirements, riskDecisions: revision.riskDecisions, counters: state.counters },
    });
  } catch (error) {
    if (error instanceof BuildBriefAnalysisError) throw new BuildBriefError(error.problems.join('; '), 400);
    throw error;
  }

  const brief = await saveInterviewBrief({
    interviewId: interview.id,
    sections: renderBriefSections(sections, analysis.requirements),
    savedBy: input.actorId,
  });
  const revisionId = await upsertRevisionOne(buildRunId, brief.version, analysis);

  const before = new Map(revision.requirements.map((row) => [row.id, row.text]));
  const after = new Set(analysis.requirements.map((row) => row.id));
  await appendBuildEvent({
    buildRunId,
    buildRevisionId: revisionId,
    eventType: EDIT_EVENT,
    message: 'Brief edited',
    actorUserId: input.actorId,
    dedupeKey: `brief_edited:${brief.id}:${brief.version}`,
    detail: {
      ...stateDetail(analysis, state, brief.id, brief.version),
      changedIds: analysis.requirements.filter((row) => before.has(row.id) && before.get(row.id) !== row.text).map((row) => row.id),
      addedIds: analysis.requirements.filter((row) => !before.has(row.id)).map((row) => row.id),
      removedIds: [...before.keys()].filter((id) => !after.has(id)),
    },
  });
  return brief;
}

// ── Approve ───────────────────────────────────────────────────────────────────

export async function approveBuildBrief(input: {
  interviewId: string;
  actorId: string;
}): Promise<ApproveBuildBriefResult> {
  const interview = await requireBuildIntake(input.interviewId);
  await requireActor(input.actorId, interview);
  const buildRunId = await requireBuildRunId(interview.id);

  const brief = await getInterviewBrief(interview.id);
  if (!brief) throw new BuildBriefError(BUILD_BRIEF_NOT_DRAFTED_MESSAGE, 404);

  const state = await loadState(buildRunId);
  let revision = await loadRevisionOne(buildRunId);
  if (brief.status === 'draft') {
    if (!revision || revision.briefVersion !== brief.version) {
      const requirements = requirementsFromSections(brief.sections);
      const riskDecisions = revision?.riskDecisions ?? [];
      const classification = classifyBuild(riskDecisions, state.estimatedTasks, state.needsMigration);
      const id = await upsertRevisionOne(buildRunId, brief.version, { requirements, riskDecisions, classification });
      revision = { id, briefVersion: brief.version, requirements, riskDecisions };
    }
    if (!revision.requirements.some((row) => row.kind === 'ac' && !row.retired)) {
      throw new BuildBriefError(BUILD_BRIEF_NO_AC_MESSAGE, 400);
    }
  }
  if (!revision) throw new BuildBriefError(BUILD_BRIEF_NOT_DRAFTED_MESSAGE, 409);

  const riskDecisions = revision.riskDecisions;
  const requirements = revision.requirements;
  const classification = classifyBuild(riskDecisions, state.estimatedTasks, state.needsMigration);

  let result: ApproveInterviewBriefResult;
  try {
    result = await approveInterviewBrief({
      interviewId: interview.id,
      approvedBy: input.actorId,
      beforeResume: async (approved) => {
        const revisionId = await upsertRevisionOne(buildRunId, approved.version, { requirements, riskDecisions, classification });
        const approver = approved.approvedBy ?? input.actorId;
        await appendBuildEvent({
          buildRunId,
          buildRevisionId: revisionId,
          eventType: APPROVED_EVENT,
          message: 'Brief approved',
          actorUserId: approver,
          dedupeKey: `brief_approved:${approved.id}:${approved.version}`,
          detail: {
            briefId: approved.id,
            briefVersion: approved.version,
            classification: classification.value,
            onBehalfOf: approver === interview.authorId ? null : interview.authorId,
          },
        });
      },
    });
  } catch (error) {
    if (error instanceof InterviewBriefError && error.statusCode < 500) throw error;
    throw new BuildBriefError(BUILD_BRIEF_APPROVE_FAILED_MESSAGE, 500);
  }
  return { ...result, classification };
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getBuildBriefAnalysis(input: {
  interviewId: string;
  viewerId: string;
}): Promise<BuildBriefAnalysisResponse> {
  const interview = await requireBuildIntake(input.interviewId);
  const [run] = await db
    .select({ id: buildRuns.id })
    .from(buildRuns)
    .where(eq(buildRuns.interviewId, interview.id))
    .limit(1);
  if (!run) throw new BuildBriefError(BUILD_BRIEF_NOT_DRAFTED_MESSAGE, 404);

  const brief = await getInterviewBrief(interview.id);
  const revision = await loadRevisionOne(run.id);
  if (!brief || !revision) {
    const last = await latestEvent(run.id, [DRAFT_EVENT, DRAFT_FAILED_EVENT]);
    throw new BuildBriefError(BUILD_BRIEF_NOT_DRAFTED_MESSAGE, 404, { draftFailed: last?.eventType === DRAFT_FAILED_EVENT });
  }

  const state = await loadState(run.id);
  const mayEdit = await canActOnBuildIntakeInterview(input.viewerId, interview);
  const names = await displayNames([interview.authorId, brief.approvedBy ?? '']);
  const requesterName = names.get(interview.authorId) ?? interview.authorId;
  const redacted = redactJson({ requirements: revision.requirements, riskDecisions: revision.riskDecisions });

  return {
    interviewId: interview.id,
    buildRunId: run.id,
    revisionNumber: 1,
    briefVersion: brief.version,
    briefStatus: brief.status === 'approved' ? 'approved' : 'draft',
    requirements: redacted.requirements,
    riskDecisions: redacted.riskDecisions,
    classification: classifyBuild(revision.riskDecisions, state.estimatedTasks, state.needsMigration),
    requester: { id: interview.authorId, displayName: requesterName },
    approval: brief.approvedBy && brief.approvedAt
      ? {
        approvedBy: { id: brief.approvedBy, displayName: names.get(brief.approvedBy) ?? brief.approvedBy },
        approvedAt: brief.approvedAt,
      }
      : null,
    viewer: {
      mayEdit,
      actingFor: mayEdit && input.viewerId !== interview.authorId ? requesterName : null,
    },
  };
}

/** Brief record with every text section redacted, for the build-intake GET route. */
export async function getRedactedBuildBrief(interviewId: string): Promise<InterviewBriefRecord | null> {
  const brief = await getInterviewBrief(interviewId);
  return brief ? { ...brief, sections: redactJson(brief.sections) } : null;
}
