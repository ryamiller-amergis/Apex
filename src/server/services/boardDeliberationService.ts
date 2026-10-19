import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BoardDeliberationStepConfig } from '../../shared/types/playbook';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import { db } from '../db/drizzle';
import {
  playbookDeliberationSessions,
  playbookDeliberationTurns,
  playbookRuns,
  playbookStepRuns,
} from '../db/schema';
import { createThread } from './chatAgentService';
import { enqueue } from './agentRunLifecycleService';
import { getDefaultModel } from './appSettingsService';
import { getSkillConfig } from './projectSettingsService';
import { cursorAgentCompletionOutput } from './playbookSteps/cursorAgentCompletion';
import { failStepRun, resumeStepRun } from './playbookSteps/stepRuns';
import { CURSOR_AGENT_STEP_TYPE } from './playbookSteps/registry';

const MODERATOR_SKILL = '.cursor/skills/ats-board-moderator/SKILL.md';
const ROLE_SKILLS: Readonly<Record<string, string>> = {
  operations: '.cursor/skills/ats-board-operations/SKILL.md',
  recruiting: '.cursor/skills/ats-board-recruiting/SKILL.md',
  client: '.cursor/skills/ats-board-client/SKILL.md',
  compliance: '.cursor/skills/ats-board-compliance/SKILL.md',
  data: '.cursor/skills/ats-board-data/SKILL.md',
  product: '.cursor/skills/ats-board-product/SKILL.md',
  market: '.cursor/skills/ats-board-market/SKILL.md',
};
export const ATS_BOARD_ROLES = Object.keys(ROLE_SKILLS);
export const BOARD_DELIBERATION_MAX_TOPICS = 5;
export const BOARD_DELIBERATION_MAX_ROUNDS = 2;
export const BOARD_DELIBERATION_DEFAULT_INQUIRY_BUDGET = 16;
const AGENT_TIMEOUT_MS = 55 * 60 * 1000;
const DISPATCH_LEASE_MS = 5 * 60 * 1000;
const MAX_CONTEXT_CHARS = 40_000;

class DeliberationOutputDeferredError extends Error {
  constructor() {
    super('Deliberation output is not readable yet.');
    this.name = 'DeliberationOutputDeferredError';
  }
}

const agendaTopicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  participants: z
    .array(
      z.enum([
        'operations',
        'recruiting',
        'client',
        'compliance',
        'data',
        'product',
        'market',
      ])
    )
    .min(2),
  evidenceNeeded: z.array(z.string()),
});

const agendaSchema = z
  .object({
    role: z.literal('moderator'),
    topics: z.array(agendaTopicSchema).max(BOARD_DELIBERATION_MAX_TOPICS),
    noMaterialDisagreement: z.boolean(),
  })
  .superRefine((agenda, context) => {
    const topicIds = new Set<string>();
    agenda.topics.forEach((topic, topicIndex) => {
      if (topicIds.has(topic.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['topics', topicIndex, 'id'],
          message: `Duplicate deliberation topic id "${topic.id}".`,
        });
      }
      topicIds.add(topic.id);

      const participants = new Set<string>();
      topic.participants.forEach((participant, participantIndex) => {
        if (participants.has(participant)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['topics', topicIndex, 'participants', participantIndex],
            message: `Duplicate participant "${participant}" in topic "${topic.id}".`,
          });
        }
        participants.add(participant);
      });
    });
  });

const responseSchema = z.object({
  role: z.enum([
    'operations',
    'recruiting',
    'client',
    'compliance',
    'data',
    'product',
    'market',
  ]),
  topicId: z.string().min(1),
  position: z.string().min(1),
  evidence: z.array(z.string()),
  challenges: z.array(z.string()),
  revisions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  newEvidence: z.boolean(),
});

const synthesisTopicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  participants: z.array(z.string()),
  outcome: z.string(),
  status: z.enum(['resolved', 'unresolved', 'leadership_required']),
  evidenceQuality: z.enum(['strong', 'moderate', 'weak']),
});

const synthesisSchema = z.object({
  role: z.literal('moderator'),
  topics: z.array(synthesisTopicSchema).max(BOARD_DELIBERATION_MAX_TOPICS),
  unresolved: z.array(z.string()),
  evidenceQuality: z.enum(['strong', 'moderate', 'weak']),
});

type Agenda = z.infer<typeof agendaSchema>;
type DeliberationPhase = 'agenda' | 'response' | 'rebuttal' | 'synthesis';
type DeliberationSession = typeof playbookDeliberationSessions.$inferSelect;
type DeliberationTurn = typeof playbookDeliberationTurns.$inferSelect;

function clip(value: string): string {
  return value.length <= MAX_CONTEXT_CHARS
    ? value
    : `${value.slice(0, MAX_CONTEXT_CHARS)}\n[Context clipped]`;
}

function parseJson(value: unknown): unknown {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string')
    throw new Error('Agent output did not contain JSON.');
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fenced?.[1] ?? value).trim();
  return JSON.parse(source);
}

function parseReportRole(report: string): string | null {
  try {
    const parsed = parseJson(report);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return typeof (parsed as Record<string, unknown>).role === 'string'
      ? String((parsed as Record<string, unknown>).role)
      : null;
  } catch {
    return null;
  }
}

export function assertAtsBoardReportRoles(
  reports: Record<string, string>
): void {
  for (const role of ATS_BOARD_ROLES) {
    const report = reports[role];
    if (!report?.trim())
      throw new Error(`ATS board ${role} report is missing.`);
    const reportedRole = parseReportRole(report);
    if (reportedRole !== role) {
      throw new Error(
        `ATS board ${role} step returned role "${reportedRole ?? 'unknown'}"; expected "${role}".`
      );
    }
  }
}

function reportsText(reports: Record<string, string>): string {
  return ATS_BOARD_ROLES.map(
    (role) => `${role.toUpperCase()}:\n${reports[role]}`
  ).join('\n\n');
}

export function parseBoardDeliberationAgenda(value: unknown): Agenda {
  return agendaSchema.parse(value);
}

async function outputObject(
  turn: DeliberationTurn,
  completedAt: string,
  threadId?: string | null
): Promise<unknown> {
  if (!turn.agentRunId) throw new Error('Deliberation turn has no agent run.');
  const output = await cursorAgentCompletionOutput({
    stepType: CURSOR_AGENT_STEP_TYPE,
    agentRunId: turn.agentRunId,
    completedAt,
    threadId: threadId ?? turn.threadId,
  });
  if (!output) throw new DeliberationOutputDeferredError();
  return parseJson(output.scorecard ?? output.reportMd);
}

function nextSequence(turns: DeliberationTurn[]): number {
  return (
    turns.reduce((highest, turn) => Math.max(highest, turn.sequence), 0) + 1
  );
}

export function selectBoardDeliberationEntries<T>(
  entries: T[],
  inquiryBudget: number,
  inquiryCount: number
): T[] {
  const available = Math.max(0, inquiryBudget - inquiryCount - 1);
  return entries.slice(0, available);
}

export function shouldRunBoardRebuttal(
  results: Array<Record<string, unknown> | null>,
  maxRounds: number
): boolean {
  if (maxRounds <= 1) return false;
  return results.some((result) => {
    const parsed = responseSchema.safeParse(result);
    return (
      parsed.success &&
      (parsed.data.challenges.length > 0 || parsed.data.newEvidence)
    );
  });
}

function turnPrompt(
  session: DeliberationSession,
  turn: DeliberationTurn,
  turns: DeliberationTurn[]
): string {
  const reports = reportsText(session.sourceReports);
  if (turn.phase === 'agenda') {
    return clip(
      [
        'Build the bounded ATS board discussion agenda.',
        `Choose no more than ${session.maxTopics} material disagreements.`,
        'Return only the agenda JSON defined by your skill.',
        `Charter:\n${session.charter}`,
        `Independent reports:\n${reports}`,
      ].join('\n\n')
    );
  }

  const agenda = agendaSchema.parse(session.agenda);
  const topic = agenda.topics.find((item) => item.id === turn.topicId);
  if (!topic)
    throw new Error(
      `Deliberation topic ${turn.topicId ?? 'unknown'} was not found.`
    );
  const prior = turns
    .filter((item) => item.topicId === topic.id && item.result)
    .map(
      (item) =>
        `${item.specialist} ${item.phase}:\n${JSON.stringify(item.result)}`
    )
    .join('\n\n');

  if (turn.phase === 'response' || turn.phase === 'rebuttal') {
    return clip(
      [
        'DELIBERATION_ASSIGNMENT',
        `You are the ${turn.specialist} ATS board member.`,
        `Topic ${topic.id}: ${topic.title}`,
        `Question: ${topic.question}`,
        `Evidence needed: ${topic.evidenceNeeded.join('; ') || 'none named'}`,
        turn.phase === 'rebuttal'
          ? 'Review the peer responses below. Revise when evidence supports a challenge; otherwise preserve and explain the disagreement.'
          : 'Respond to this material disagreement using your opening position and the other opening reports.',
        'Return only the active-deliberation JSON defined by your skill.',
        `Charter:\n${session.charter}`,
        `Opening reports:\n${reports}`,
        `Prior discussion:\n${prior || 'none'}`,
      ].join('\n\n')
    );
  }

  return clip(
    [
      'Synthesize the bounded ATS board discussion.',
      'Return only the synthesis JSON defined by your skill.',
      'Do not erase dissent or convert one-source claims into decided facts.',
      `Agenda:\n${JSON.stringify(session.agenda)}`,
      `Discussion:\n${
        turns
          .filter((item) => item.result)
          .map(
            (item) =>
              `${item.specialist} ${item.phase}: ${JSON.stringify(item.result)}`
          )
          .join('\n\n') || 'none'
      }`,
      `Charter:\n${session.charter}`,
      `Independent reports:\n${reports}`,
    ].join('\n\n')
  );
}

function skillForTurn(turn: DeliberationTurn): string {
  if (turn.phase === 'agenda' || turn.phase === 'synthesis')
    return MODERATOR_SKILL;
  const skill = ROLE_SKILLS[turn.specialist];
  if (!skill)
    throw new Error(`Unknown ATS board specialist "${turn.specialist}".`);
  return skill;
}

async function enqueueTurn(input: {
  session: DeliberationSession;
  turn: DeliberationTurn;
  turns: DeliberationTurn[];
  project: string;
  userId: string;
}): Promise<string | null> {
  if (input.session.inquiryCount >= input.session.inquiryBudget) {
    throw new Error('ATS board deliberation inquiry budget is exhausted.');
  }
  const now = new Date().toISOString();
  const [claimed] = await db
    .update(playbookDeliberationTurns)
    .set({
      status: 'running',
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(playbookDeliberationTurns.id, input.turn.id),
        eq(playbookDeliberationTurns.status, 'pending')
      )
    )
    .returning();
  if (!claimed) return null;

  try {
    const skillConfig = await getSkillConfig(input.project);
    const model =
      skillConfig?.defaultModel?.trim() || (await getDefaultModel());
    const prompt = turnPrompt(input.session, claimed, input.turns);
    const thread = await createThread(
      input.userId,
      {
        project: input.project,
        repo: skillConfig?.skillRepo ?? input.project,
        branch: skillConfig?.skillBranch ?? 'main',
        skillProvider: skillConfig?.skillProvider,
        skillPath: skillForTurn(claimed),
        freeformContext: prompt,
        model,
        playbookMcpProfile: 'repository-read-only',
      },
      { skipAutoKickoff: true }
    );
    const timeoutAt = new Date(Date.now() + AGENT_TIMEOUT_MS).toISOString();
    const snapshot: ExecutionSnapshot = {
      prompt,
      model,
      workspaceRef: thread.workspaceDir,
      workflowClass: 'playbook-step',
      skillPath: skillForTurn(claimed),
      projectId: input.project,
      threadId: thread.id,
    };
    const { runId } = await enqueue({
      threadId: thread.id,
      projectId: input.project,
      snapshot,
      timeoutAt,
      lane: 'background',
    });
    await db.transaction(async (tx) => {
      const attached = await tx
        .update(playbookDeliberationTurns)
        .set({
          agentRunId: runId,
          threadId: thread.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(playbookDeliberationTurns.id, claimed.id),
            eq(playbookDeliberationTurns.status, 'running'),
            sql`${playbookDeliberationTurns.agentRunId} IS NULL`
          )
        )
        .returning({ id: playbookDeliberationTurns.id });
      if (attached.length === 0) {
        throw new Error(
          `Deliberation turn ${claimed.id} changed while dispatching.`
        );
      }
      await tx
        .update(playbookDeliberationSessions)
        .set({
          inquiryCount: sql<number>`${playbookDeliberationSessions.inquiryCount} + 1`,
          updatedAt: now,
        })
        .where(eq(playbookDeliberationSessions.id, input.session.id));
    });
    return runId;
  } catch (error) {
    await db
      .update(playbookDeliberationTurns)
      .set({
        status: 'pending',
        startedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(playbookDeliberationTurns.id, claimed.id),
          eq(playbookDeliberationTurns.status, 'running'),
          sql`${playbookDeliberationTurns.agentRunId} IS NULL`
        )
      );
    throw error;
  }
}

async function sessionTurns(sessionId: string): Promise<DeliberationTurn[]> {
  return db.query.playbookDeliberationTurns.findMany({
    where: eq(playbookDeliberationTurns.sessionId, sessionId),
    orderBy: [asc(playbookDeliberationTurns.sequence)],
  });
}

async function createTurns(
  session: DeliberationSession,
  phase: DeliberationPhase,
  entries: Array<{ topicId?: string; specialist: string }>,
  currentTurns: DeliberationTurn[]
): Promise<number> {
  const selected = selectBoardDeliberationEntries(
    entries,
    session.inquiryBudget,
    session.inquiryCount
  );
  if (selected.length === 0) return 0;
  const first = nextSequence(currentTurns);
  await db
    .insert(playbookDeliberationTurns)
    .values(
      selected.map((entry, index) => ({
        sessionId: session.id,
        sequence: first + index,
        phase,
        topicId: entry.topicId,
        specialist: entry.specialist,
        status: 'pending' as const,
      }))
    )
    .onConflictDoNothing();
  return selected.length;
}

async function ensureSynthesisTurn(
  session: DeliberationSession,
  turns: DeliberationTurn[]
): Promise<void> {
  if (turns.some((turn) => turn.phase === 'synthesis')) return;
  await db
    .insert(playbookDeliberationTurns)
    .values({
      sessionId: session.id,
      sequence: nextSequence(turns),
      phase: 'synthesis',
      specialist: 'moderator',
      status: 'pending',
    })
    .onConflictDoNothing();
  await db
    .update(playbookDeliberationSessions)
    .set({
      phase: 'synthesis',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(playbookDeliberationSessions.id, session.id));
}

async function prepareFollowingTurns(
  session: DeliberationSession,
  turns: DeliberationTurn[]
): Promise<void> {
  const agendaTurn = turns.find((turn) => turn.phase === 'agenda');
  if (!agendaTurn?.result) return;
  const agenda = agendaSchema.parse(agendaTurn.result);
  const responses = turns.filter((turn) => turn.phase === 'response');
  const rebuttals = turns.filter((turn) => turn.phase === 'rebuttal');

  if (agenda.noMaterialDisagreement || agenda.topics.length === 0) {
    await ensureSynthesisTurn(session, turns);
    return;
  }
  if (responses.length === 0) {
    await createTurns(
      session,
      'response',
      agenda.topics.flatMap((topic) =>
        topic.participants.map((specialist) => ({
          topicId: topic.id,
          specialist,
        }))
      ),
      turns
    );
    await db
      .update(playbookDeliberationSessions)
      .set({
        phase: 'response',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(playbookDeliberationSessions.id, session.id));
    return;
  }
  if (
    responses.some(
      (turn) => turn.status === 'pending' || turn.status === 'running'
    )
  )
    return;

  const needsRebuttal = shouldRunBoardRebuttal(
    responses.map((turn) => turn.result),
    session.maxRounds
  );
  if (needsRebuttal && rebuttals.length === 0) {
    const created = await createTurns(
      session,
      'rebuttal',
      responses.map((turn) => ({
        topicId: turn.topicId ?? undefined,
        specialist: turn.specialist,
      })),
      turns
    );
    if (created === 0) {
      await ensureSynthesisTurn(session, turns);
      return;
    }
    await db
      .update(playbookDeliberationSessions)
      .set({
        phase: 'rebuttal',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(playbookDeliberationSessions.id, session.id));
    return;
  }
  if (
    rebuttals.some(
      (turn) => turn.status === 'pending' || turn.status === 'running'
    )
  )
    return;
  await ensureSynthesisTurn(session, turns);
}

export async function recoverInterruptedBoardDispatches(
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - DISPATCH_LEASE_MS).toISOString();
  const stranded = await db
    .select({
      turnId: playbookDeliberationTurns.id,
      sessionId: playbookDeliberationSessions.id,
      stepRunId: playbookStepRuns.id,
      project: playbookRuns.project,
      userId: playbookRuns.initiatorUserId,
    })
    .from(playbookDeliberationTurns)
    .innerJoin(
      playbookDeliberationSessions,
      eq(playbookDeliberationTurns.sessionId, playbookDeliberationSessions.id)
    )
    .innerJoin(
      playbookStepRuns,
      eq(playbookDeliberationSessions.stepRunId, playbookStepRuns.id)
    )
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(
      and(
        eq(playbookDeliberationTurns.status, 'running'),
        isNull(playbookDeliberationTurns.agentRunId),
        lte(playbookDeliberationTurns.startedAt, cutoff),
        eq(playbookDeliberationSessions.status, 'running'),
        eq(playbookStepRuns.status, 'suspended'),
        eq(playbookRuns.status, 'suspended')
      )
    );

  let recovered = 0;
  for (const row of stranded) {
    const reset = await db
      .update(playbookDeliberationTurns)
      .set({
        status: 'pending',
        startedAt: null,
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(playbookDeliberationTurns.id, row.turnId),
          eq(playbookDeliberationTurns.status, 'running'),
          isNull(playbookDeliberationTurns.agentRunId)
        )
      )
      .returning({ id: playbookDeliberationTurns.id });
    if (reset.length === 0) continue;

    const session = await db.query.playbookDeliberationSessions.findFirst({
      where: eq(playbookDeliberationSessions.id, row.sessionId),
    });
    if (!session) continue;
    const turns = await sessionTurns(row.sessionId);
    const turn = turns.find((item) => item.id === row.turnId);
    if (!turn) continue;

    try {
      const agentRunId = await enqueueTurn({
        session,
        turn,
        turns,
        project: row.project,
        userId: row.userId,
      });
      if (!agentRunId) continue;
      await db
        .update(playbookStepRuns)
        .set({ agentRunId, updatedAt: now.toISOString() })
        .where(
          and(
            eq(playbookStepRuns.id, row.stepRunId),
            eq(playbookStepRuns.status, 'suspended')
          )
        );
      recovered += 1;
    } catch (error) {
      console.error(
        `[playbook] failed to recover deliberation dispatch ${row.turnId}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return recovered;
}

export async function startBoardDeliberation(input: {
  stepRunId: string;
  config: BoardDeliberationStepConfig;
  project: string;
  userId: string;
}): Promise<{ sessionId: string; agentRunId: string }> {
  assertAtsBoardReportRoles(input.config.reports);
  const existing = await db.query.playbookDeliberationSessions.findFirst({
    where: eq(playbookDeliberationSessions.stepRunId, input.stepRunId),
  });
  let session = existing;
  if (!session) {
    [session] = await db
      .insert(playbookDeliberationSessions)
      .values({
        stepRunId: input.stepRunId,
        charter: input.config.charter,
        sourceReports: input.config.reports,
        maxTopics: input.config.maxTopics ?? BOARD_DELIBERATION_MAX_TOPICS,
        maxRounds: input.config.maxRounds ?? BOARD_DELIBERATION_MAX_ROUNDS,
        inquiryBudget:
          input.config.inquiryBudget ??
          BOARD_DELIBERATION_DEFAULT_INQUIRY_BUDGET,
      })
      .returning();
    await db.insert(playbookDeliberationTurns).values({
      sessionId: session.id,
      sequence: 1,
      phase: 'agenda',
      specialist: 'moderator',
    });
  } else if (session.status === 'failed') {
    await db
      .update(playbookDeliberationSessions)
      .set({
        status: 'running',
        inquiryCount: sql<number>`GREATEST(${playbookDeliberationSessions.inquiryCount} - 1, 0)`,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(playbookDeliberationSessions.id, session.id));
    await db
      .update(playbookDeliberationTurns)
      .set({
        status: 'pending',
        agentRunId: null,
        threadId: null,
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(playbookDeliberationTurns.sessionId, session.id),
          eq(playbookDeliberationTurns.status, 'failed')
        )
      );
    const retried = await db.query.playbookDeliberationSessions.findFirst({
      where: eq(playbookDeliberationSessions.id, session.id),
    });
    if (!retried)
      throw new Error(`Deliberation session ${session.id} disappeared.`);
    session = retried;
  }
  const turns = await sessionTurns(session.id);
  const turn = turns.find((item) => item.status === 'pending');
  if (!turn)
    throw new Error('ATS board deliberation has no pending turn to resume.');
  const agentRunId = await enqueueTurn({
    session,
    turn,
    turns,
    project: input.project,
    userId: input.userId,
  });
  if (!agentRunId) {
    const active = (await sessionTurns(session.id)).find(
      (item) => item.status === 'running' && item.agentRunId
    );
    if (!active?.agentRunId) {
      throw new Error(
        'ATS board deliberation turn dispatch is already in progress.'
      );
    }
    return { sessionId: session.id, agentRunId: active.agentRunId };
  }
  return { sessionId: session.id, agentRunId };
}

export async function handleBoardDeliberationTerminal(input: {
  agentRunId: string;
  status: 'completed' | 'failed' | 'cancelled';
  completedAt: string;
  threadId?: string | null;
  project: string;
  userId: string;
}): Promise<{
  handled: boolean;
  completed: boolean;
  stepRunId?: string;
  deferred?: boolean;
}> {
  const turn = await db.query.playbookDeliberationTurns.findFirst({
    where: eq(playbookDeliberationTurns.agentRunId, input.agentRunId),
    with: { session: true },
  });
  if (!turn?.session) return { handled: false, completed: false };
  const session = turn.session;
  const [execution] = await db
    .select({
      stepStatus: playbookStepRuns.status,
      runStatus: playbookRuns.status,
    })
    .from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(eq(playbookStepRuns.id, session.stepRunId))
    .limit(1);
  if (
    session.status !== 'running' ||
    execution?.stepStatus !== 'suspended' ||
    execution.runStatus !== 'suspended'
  ) {
    return {
      handled: true,
      completed: session.status === 'completed',
      stepRunId: session.stepRunId,
    };
  }
  if (turn.status !== 'running') {
    return {
      handled: true,
      completed: false,
      stepRunId: session.stepRunId,
    };
  }
  if (input.status !== 'completed') {
    const reason = `Deliberation ${turn.phase} run ended as ${input.status}.`;
    await db.transaction(async (tx) => {
      await tx
        .update(playbookDeliberationTurns)
        .set({
          status: 'failed',
          error: reason,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        })
        .where(eq(playbookDeliberationTurns.id, turn.id));
      await tx
        .update(playbookDeliberationSessions)
        .set({
          status: 'failed',
          updatedAt: input.completedAt,
        })
        .where(eq(playbookDeliberationSessions.id, session.id));
    });
    await failStepRun({
      stepRunId: session.stepRunId,
      retryable: true,
      reason,
    });
    return { handled: true, completed: false, stepRunId: session.stepRunId };
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = await outputObject(turn, input.completedAt, input.threadId);
    if (turn.phase === 'agenda') parsed = agendaSchema.parse(raw);
    else if (turn.phase === 'synthesis') parsed = synthesisSchema.parse(raw);
    else {
      const response = responseSchema.parse(raw);
      if (
        response.role !== turn.specialist ||
        response.topicId !== turn.topicId
      ) {
        throw new Error(
          `Deliberation response identity mismatch for ${turn.specialist}/${turn.topicId}.`
        );
      }
      parsed = response;
    }
  } catch (error) {
    if (error instanceof DeliberationOutputDeferredError) {
      return {
        handled: true,
        completed: false,
        stepRunId: session.stepRunId,
        deferred: true,
      };
    }
    const reason =
      error instanceof Error ? error.message : 'Invalid deliberation output.';
    await db
      .update(playbookDeliberationTurns)
      .set({
        status: 'failed',
        error: reason,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      })
      .where(eq(playbookDeliberationTurns.id, turn.id));
    await db
      .update(playbookDeliberationSessions)
      .set({
        status: 'failed',
        updatedAt: input.completedAt,
      })
      .where(eq(playbookDeliberationSessions.id, session.id));
    await failStepRun({
      stepRunId: session.stepRunId,
      retryable: true,
      reason,
    });
    return { handled: true, completed: false, stepRunId: session.stepRunId };
  }

  const completed = await db
    .update(playbookDeliberationTurns)
    .set({
      status: 'completed',
      result: parsed,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
    })
    .where(
      and(
        eq(playbookDeliberationTurns.id, turn.id),
        eq(playbookDeliberationTurns.status, 'running')
      )
    )
    .returning({ id: playbookDeliberationTurns.id });
  if (completed.length === 0) {
    const latest = await db.query.playbookDeliberationSessions.findFirst({
      where: eq(playbookDeliberationSessions.id, session.id),
    });
    return {
      handled: true,
      completed: latest?.status === 'completed',
      stepRunId: session.stepRunId,
    };
  }

  if (turn.phase === 'agenda') {
    await db
      .update(playbookDeliberationSessions)
      .set({
        agenda: parsed,
        updatedAt: input.completedAt,
      })
      .where(eq(playbookDeliberationSessions.id, session.id));
  }
  if (turn.phase === 'synthesis') {
    const synthesis = synthesisSchema.parse(parsed);
    const reportMd = `\`\`\`json\n${JSON.stringify(synthesis, null, 2)}\n\`\`\``;
    await db
      .update(playbookDeliberationSessions)
      .set({
        status: 'completed',
        phase: 'completed',
        summary: synthesis,
        updatedAt: input.completedAt,
      })
      .where(eq(playbookDeliberationSessions.id, session.id));
    await resumeStepRun({
      stepRunId: session.stepRunId,
      output: {
        sessionId: session.id,
        completedAt: input.completedAt,
        topics: synthesis.topics.map((topic) => ({
          id: topic.id,
          title: topic.title,
          participants: topic.participants,
          outcome: topic.outcome,
          status: topic.status,
        })),
        unresolved: synthesis.unresolved,
        evidenceQuality: synthesis.evidenceQuality,
        reportMd,
      },
    });
    return { handled: true, completed: true, stepRunId: session.stepRunId };
  }

  const refreshed = await db.query.playbookDeliberationSessions.findFirst({
    where: eq(playbookDeliberationSessions.id, session.id),
  });
  if (!refreshed)
    throw new Error(`Deliberation session ${session.id} disappeared.`);
  let turns = await sessionTurns(session.id);
  await prepareFollowingTurns(refreshed, turns);
  turns = await sessionTurns(session.id);
  const next = turns.find((item) => item.status === 'pending');
  if (!next)
    throw new Error(
      'ATS board deliberation could not determine its next turn.'
    );
  const nextRunId = await enqueueTurn({
    session: { ...refreshed, inquiryCount: refreshed.inquiryCount },
    turn: next,
    turns,
    project: input.project,
    userId: input.userId,
  });
  if (!nextRunId) {
    return { handled: true, completed: false, stepRunId: session.stepRunId };
  }
  await db
    .update(playbookStepRuns)
    .set({
      agentRunId: nextRunId,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(playbookStepRuns.id, session.stepRunId),
        eq(playbookStepRuns.status, 'suspended')
      )
    );
  return { handled: true, completed: false, stepRunId: session.stepRunId };
}

export async function listBoardDeliberationAudit(stepRunId: string): Promise<{
  charter: string | null;
  turns: Array<{
    sequence: number;
    phase: string;
    topicId: string | null;
    specialist: string;
    status: string;
    result: Record<string, unknown> | null;
    completedAt: string | null;
  }>;
}> {
  const session = await db.query.playbookDeliberationSessions.findFirst({
    where: eq(playbookDeliberationSessions.stepRunId, stepRunId),
  });
  if (!session) return { charter: null, turns: [] };
  const turns = await sessionTurns(session.id);
  return {
    charter: session.charter,
    turns: turns.map((turn) => ({
      sequence: turn.sequence,
      phase: turn.phase,
      topicId: turn.topicId,
      specialist: turn.specialist,
      status: turn.status,
      result: turn.result,
      completedAt: turn.completedAt,
    })),
  };
}
