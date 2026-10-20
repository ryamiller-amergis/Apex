/**
 * The read path that answers "what happened, and what happens next" for a Playbook run.
 *
 * Every fact here comes from the four Apex-owned tables. The engine's own store is a disposable
 * execution cache (BR-001), and exit criterion E4 proves the point by dropping every engine table
 * mid-run and asking this module the same question again.
 *
 * That is why this file imports nothing from `src/server/services/playbookEngine/` and names no
 * engine table. The `no-restricted-imports` boundary from TBI-008 makes the first half of that
 * enforceable rather than aspirational; the second half is asserted by a test.
 *
 * It is a service rather than a helper beside a route because two callers need it — the status view
 * in TBI-025 and E4's own test in TBI-028 — and a helper next to one of them gets copied for the
 * other, after which the two drift.
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookRuns } from '../db/schema';
import { CURSOR_AGENT_STEP_TYPE, suspendReasonForStepType } from './playbookSteps/registry';
import { listPendingGateRows } from './playbookGateService';
import type {
  PlaybookRunDetail,
  PlaybookRunListResult,
  PlaybookRunSummary,
  PlaybookStepActivity,
  PlaybookStepRun,
  PlaybookSuspensionDetail,
} from '../../shared/types/playbook';

/** Step states that mean the step has not finished. */
const OPEN_STEP_STATUSES = new Set(['pending', 'running', 'suspended']);

/** Shape of the nested rows the relational query returns. */
type RunRow = typeof playbookRuns.$inferSelect & {
  initiator?: {
    displayName: string | null;
    email: string | null;
  } | null;
  definitionVersion: {
    id: string;
    versionNumber: number;
    definitionId: string;
    definition: { name: string };
  };
  steps?: Array<Record<string, unknown>>;
};

function toSummary(run: RunRow): PlaybookRunSummary {
  return {
    runId: run.id,
    project: run.project,
    definitionId: run.definitionVersion.definitionId,
    definitionName: run.definitionVersion.definition.name,
    definitionVersionId: run.definitionVersion.id,
    versionNumber: run.definitionVersion.versionNumber,
    status: run.status,
    initiatorUserId: run.initiatorUserId,
    initiatorDisplayName:
      run.initiator?.displayName?.trim() ||
      run.initiator?.email?.trim() ||
      run.initiatorUserId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

interface AgentProgressRow {
  progressAt?: string | null;
  progressLabel?: string | null;
  progressPhase?: string | null;
}

interface DeliberationTurnProgressRow {
  specialist: string;
  status: string;
}

interface DeliberationProgressRow {
  phase: string;
  updatedAt: string;
  turns?: DeliberationTurnProgressRow[];
}

type StepRow = Record<string, unknown> & {
  stepId: string;
  stepType: string;
  status: string;
  agentRun?: AgentProgressRow | null;
  deliberationSession?: DeliberationProgressRow | null;
};

const STEP_ACTOR_LABELS: Record<string, string> = {
  operations: 'Operations specialist',
  recruiting: 'Recruiting specialist',
  client: 'Client experience specialist',
  compliance: 'Compliance specialist',
  data: 'Data specialist',
  product: 'Product specialist',
  market: 'Market specialist',
  chair: 'Board chair',
};

function cursorActivity(row: StepRow): PlaybookStepActivity | null {
  const progress = row.agentRun;
  if (!progress) return null;
  const actor = STEP_ACTOR_LABELS[row.stepId] ?? 'AI specialist';
  const phase = progress.progressPhase;
  const action =
    phase === 'queued'
      ? 'waiting for an available worker'
      : phase === 'dispatched' || phase === 'setup'
        ? 'starting'
        : phase === 'planning' || phase === 'analysis'
          ? 'reviewing the charter and evidence'
          : phase === 'testing' || phase === 'typecheck'
            ? 'checking its recommendation'
            : phase === 'completion'
              ? 'finishing its report'
              : 'preparing its recommendation';
  const label = progress.progressLabel?.trim() ?? '';
  const detail = /queued|waiting/i.test(label)
    ? 'Waiting for an available AI worker.'
    : /prepar|analy|review|search|research|generat/i.test(label)
      ? label
      : undefined;
  return {
    summary: `${actor} is ${action}.`,
    ...(detail ? { detail } : {}),
    updatedAt: progress.progressAt ?? null,
  };
}

function deliberationActivity(row: StepRow): PlaybookStepActivity | null {
  const session = row.deliberationSession;
  if (!session) return null;
  const turns = session.turns ?? [];
  const completed = turns.filter((turn) => turn.status === 'completed').length;
  const active = turns.find((turn) => turn.status === 'running');
  const summary =
    session.phase === 'agenda'
      ? 'The moderator is selecting the decisions that need discussion.'
      : session.phase === 'response'
        ? `Board specialists are comparing recommendations (${completed} of ${turns.length} turns complete).`
        : session.phase === 'rebuttal'
          ? `Board specialists are resolving disagreements (${completed} of ${turns.length} turns complete).`
          : session.phase === 'synthesis'
            ? 'The moderator is preparing the board recommendation.'
            : 'The board discussion is finishing.';
  const specialist = active
    ? (STEP_ACTOR_LABELS[active.specialist] ??
      `${active.specialist.charAt(0).toUpperCase()}${active.specialist.slice(1)} specialist`)
    : null;
  return {
    summary,
    ...(specialist
      ? { detail: `${specialist} is responding to the current board question.` }
      : {}),
    updatedAt: session.updatedAt,
  };
}

function toStepRun(source: Record<string, unknown>): PlaybookStepRun {
  const row = source as StepRow;
  const { agentRun: _agentRun, deliberationSession: _session, ...step } = row;
  const open = OPEN_STEP_STATUSES.has(row.status);
  const activity = open
    ? row.stepType === 'board-deliberation'
      ? deliberationActivity(row)
      : row.stepType === CURSOR_AGENT_STEP_TYPE
        ? cursorActivity(row)
        : null
    : null;
  return {
    ...(step as unknown as PlaybookStepRun),
    ...(activity ? { activity } : {}),
  };
}

/**
 * The step a run is currently on.
 *
 * A suspended step wins outright — that is the thing a person is looking for. Otherwise it is the
 * first step that has not reached a terminal state. A run whose steps have all finished is on no
 * step at all, which is a real answer rather than a missing one.
 */
function currentStep(steps: PlaybookStepRun[]): PlaybookStepRun | null {
  const latest = steps[steps.length - 1];
  return (
    steps.find((s) => s.status === 'suspended') ??
    steps.find((s) => OPEN_STEP_STATUSES.has(s.status)) ??
    (latest?.status === 'failed_retryable' ? latest : null) ??
    null
  );
}

function suspensionOf(
  steps: PlaybookStepRun[]
): PlaybookSuspensionDetail | null {
  const parked = steps.find((s) => s.status === 'suspended');
  if (!parked) return null;
  return {
    stepId: parked.stepId,
    // Asked of the registry rather than decided here: whether a wait ends with a person or a
    // machine is a property the step type declares, and duplicating it would let the two drift.
    reason: suspendReasonForStepType(parked.stepType),
    deadline: parked.expiresAt,
    actionId: parked.stepType === 'interview' ? parked.resumeToken : null,
  };
}

/**
 * Runs in a project, most recent first, capped at `limit`.
 *
 * The total is counted rather than inferred from the page, because a status view that shows twenty
 * runs and reports twenty, when there are three hundred, is worse than one that shows twenty and
 * says so.
 */
export async function listRuns(
  project: string,
  limit: number,
  assignedToUserId?: string
): Promise<PlaybookRunListResult> {
  const assigned = assignedToUserId
    ? await listPendingGateRows({
        project,
        userId: assignedToUserId,
        limit: 10_000,
      })
    : null;
  if (assigned && assigned.total === 0) return { runs: [], total: 0 };
  const runIds = assigned
    ? [...new Set(assigned.rows.map((row) => row.runId))]
    : [];
  const where = assigned
    ? and(eq(playbookRuns.project, project), inArray(playbookRuns.id, runIds))
    : eq(playbookRuns.project, project);
  const rows = await db.query.playbookRuns.findMany({
    where,
    orderBy: [desc(playbookRuns.startedAt)],
    limit,
    with: {
      initiator: {
        columns: { displayName: true, email: true },
      },
      definitionVersion: {
        columns: { id: true, versionNumber: true, definitionId: true },
        with: { definition: { columns: { name: true } } },
      },
    },
  });

  const [totals] = await db
    .select({ total: count() })
    .from(playbookRuns)
    .where(where);

  return {
    runs: (rows as unknown as RunRow[]).map(toSummary),
    total: totals?.total ?? 0,
  };
}

/**
 * One run with its ordered steps, its pinned version, and what it is waiting on.
 *
 * Scoped by project in the query rather than filtered afterwards, so a caller cannot read across
 * projects even if the route guard above it were misconfigured. Returns null when the run does not
 * exist or belongs elsewhere — the two are deliberately indistinguishable to the caller.
 */
export async function getRun(
  project: string,
  runId: string
): Promise<PlaybookRunDetail | null> {
  const row = await db.query.playbookRuns.findFirst({
    // One relational query rather than three and a manual join, per .cursor/rules/postgresql-db.mdc.
    where: and(eq(playbookRuns.id, runId), eq(playbookRuns.project, project)),
    with: {
      initiator: {
        columns: { displayName: true, email: true },
      },
      definitionVersion: {
        columns: { id: true, versionNumber: true, definitionId: true },
        with: { definition: { columns: { name: true } } },
      },
      steps: {
        with: {
          agentRun: {
            columns: {
              progressAt: true,
              progressLabel: true,
              progressPhase: true,
            },
          },
          deliberationSession: {
            columns: {
              phase: true,
              updatedAt: true,
            },
            with: {
              turns: {
                columns: {
                  specialist: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!row) return null;

  const run = row as unknown as RunRow;
  // Ordered here rather than in the query so the relational load stays a single round trip.
  const steps = (run.steps ?? [])
    .map(toStepRun)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    ...toSummary(run),
    steps,
    currentStepId: currentStep(steps)?.stepId ?? null,
    suspension: suspensionOf(steps),
  };
}
