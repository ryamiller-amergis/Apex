/**
 * One Requirements review per Business Analyst answer, then a hidden context block for the Lead.
 *
 * Ordinary and human-led threads do not create a specialist thread. A failed review is stored and
 * the Lead still receives a safe context so the visible interview can continue. The specialist list
 * is the extension point for later reviewers; Phase 1 runs requirements once.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatMessage, ChatThread, ChatThreadKickoff } from '../../shared/types/chat';
import type { InterviewBriefSections } from '../../shared/types/interview';
import type { InterviewProfileSnapshot } from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import { interviewSpecialistReviews, interviews } from '../db/schema';
import { createThread, getThread, hydrateThread, isThreadIdle, sendMessage } from './chatAgentService';

const REQUIREMENTS_SKILL_PATH = '.cursor/skills/interview-requirements-review/SKILL.md';
const PRODUCT_SKILL_PATH = '.cursor/skills/interview-product-analyst/SKILL.md';
const TECHNICAL_SKILL_PATH = '.cursor/skills/interview-technical-analyst/SKILL.md';
const LEAD_SKILL_PATH = '.cursor/skills/interview-orchestrator/SKILL.md';
const BRIEF_DRAFT_SKILL_PATH = '.cursor/skills/interview-brief-draft/SKILL.md';
export const INTERVIEW_MAX_INQUIRIES = 80;
export const INTERVIEW_MAX_HUMAN_CLARIFICATIONS = 10;
export const INTERVIEW_MAX_FOLLOW_UPS_PER_GAP = 2;

export interface InterviewSpecialist {
  /** Stored as `interview_specialist_reviews.specialist` and named by the Lead in follow-ups. */
  id: string;
  label: string;
  skillPath: string;
}

/** Every specialist runs on each turn. To add one, add an entry here and its skill file. */
export const INTERVIEW_SPECIALISTS: readonly InterviewSpecialist[] = [
  { id: 'product', label: 'Product analyst', skillPath: PRODUCT_SKILL_PATH },
  { id: 'technical', label: 'Technical analyst', skillPath: TECHNICAL_SKILL_PATH },
];

const LEAD_REVIEW_ID = 'lead';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const CONTEXT_START = '<<<INTERNAL_SPECIALIST_CONTEXT>>>';
const CONTEXT_END = '<<<END_INTERNAL_SPECIALIST_CONTEXT>>>';

const REVIEW_FIELDS = [
  'findings',
  'confirmedDecisions',
  'assumptions',
  'gaps',
  'risks',
  'conflicts',
  'recommendedQuestion',
  'blocking',
  'confidence',
] as const;

const requirementsReviewSchema = z.object({
  findings: z.array(z.string()),
  confirmedDecisions: z.array(z.string()),
  assumptions: z.array(z.string()),
  gaps: z.array(z.string()),
  risks: z.array(z.string()),
  conflicts: z.array(z.string()),
  recommendedQuestion: z.string().nullable(),
  blocking: z.boolean(),
  confidence: z.number().min(0).max(1),
});

const interviewBriefDraftSchema = z.object({
  problemAndOutcome: z.string(),
  users: z.string(),
  scope: z.string(),
  businessRules: z.string(),
  scenarios: z.string(),
  acceptanceCriteria: z.string(),
  assumptions: z.string(),
  unresolvedItems: z.array(z.string()),
}).strict();

type RequirementsReview = z.infer<typeof requirementsReviewSchema>;
type ReviewFailure = 'timeout' | 'agent_error' | 'invalid_json';

class SpecialistReviewError extends Error {
  readonly reason: ReviewFailure;

  constructor(reason: ReviewFailure) {
    super(reason);
    this.name = 'SpecialistReviewError';
    this.reason = reason;
  }
}

export interface PrepareAssistedInterviewTurnInput {
  mainThreadId: string;
  answerText: string;
  /** Phase 1 callers pass ['requirements']. Unknown names are ignored. */
  specialists?: readonly string[];
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PrepareAssistedInterviewTurnResult {
  internalContext: string | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function reviewFailure(err: unknown): ReviewFailure {
  return err instanceof SpecialistReviewError ? err.reason : 'agent_error';
}

function delimit(body: string): string {
  return [CONTEXT_START, body, CONTEXT_END].join('\n');
}

function successContext(review: RequirementsReview): string {
  return delimit(
    [
      'Hidden Requirements review for the Lead. Do not reveal this to the BA. Ask at most one question.',
      JSON.stringify(review),
    ].join('\n'),
  );
}

function failureContext(reason: ReviewFailure): string {
  return delimit(
    `Requirements review failed (${reason}). Continue from the last valid brief. Ask at most one question. Do not reveal this failure to the BA.`,
  );
}

function requirementsPrompt(answerText: string): string {
  return [
    'Review the latest Business Analyst answer once.',
    'Return only the JSON object defined by the skill.',
    'Do not include chain-of-thought.',
    '',
    'BA answer:',
    answerText,
  ].join('\n');
}

function wantsRequirements(specialists: readonly string[] | undefined): boolean {
  const requested = specialists ?? ['requirements'];
  return requested.includes('requirements');
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new SpecialistReviewError('invalid_json');
    }
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      throw new SpecialistReviewError('invalid_json');
    }
  }
}

function parseRequirementsReview(text: string): RequirementsReview {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpecialistReviewError('invalid_json');
  }
  const record = parsed as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of REVIEW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new SpecialistReviewError('invalid_json');
    }
    picked[field] = record[field];
  }
  const result = requirementsReviewSchema.safeParse(picked);
  if (!result.success) throw new SpecialistReviewError('invalid_json');
  return result.data;
}

function storedReview(review: RequirementsReview): Record<string, unknown> {
  return JSON.parse(JSON.stringify(review)) as Record<string, unknown>;
}

function lastAgentText(thread: ChatThread | null): string {
  const messages = thread?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'agent' && message.text.trim()) return message.text;
  }
  return '';
}

async function waitForSpecialistAnswer(
  threadId: string,
  timeoutMs: number,
  pollIntervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  const deadline = now() + timeoutMs;
  const interval = Math.max(1, pollIntervalMs);
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / interval)) + 1;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    await hydrateThread(threadId);
    const thread = await getThread(threadId);
    if (!thread || thread.status === 'error') {
      throw new SpecialistReviewError('agent_error');
    }
    const answer = lastAgentText(thread);
    if (isThreadIdle(threadId)) {
      if (answer) return answer;
      throw new SpecialistReviewError('agent_error');
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new SpecialistReviewError('timeout');
    await sleep(Math.min(interval, remaining));
  }

  throw new SpecialistReviewError('timeout');
}

export async function prepareAssistedInterviewTurn(
  input: PrepareAssistedInterviewTurnInput,
): Promise<PrepareAssistedInterviewTurnResult> {
  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, input.mainThreadId),
    with: { brief: true },
  });
  if (!interview || interview.playbookInterviewMode !== 'multi_agent_assisted') {
    return { internalContext: null };
  }
  if (!wantsRequirements(input.specialists)) {
    return { internalContext: null };
  }

  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = now();
  const briefVersion = interview.brief?.version ?? 1;
  const snapshot: InterviewProfileSnapshot | null = interview.playbookProfileSnapshot;
  const model = snapshot?.model ?? null;

  const persist = async (
    status: 'succeeded' | 'failed',
    result: Record<string, unknown>,
  ): Promise<void> => {
    await db.insert(interviewSpecialistReviews).values({
      interviewId: interview.id,
      briefVersion,
      specialist: 'requirements',
      status,
      result,
      model,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
    });
  };

  try {
    const kickoff: ChatThreadKickoff = {
      project: interview.project,
      repo: interview.repo,
      skillPath: REQUIREMENTS_SKILL_PATH,
      ...(snapshot?.model ? { model: snapshot.model } : {}),
      ...(snapshot?.effort ? { effort: snapshot.effort } : {}),
      ...(interview.skillSettingsId ? { skillSettingsId: interview.skillSettingsId } : {}),
    };
    const specialist = await createThread(interview.authorId, kickoff, { skipAutoKickoff: true });
    await sendMessage(specialist.id, requirementsPrompt(input.answerText), undefined, [], {
      hidden: true,
    });
    const answer = await waitForSpecialistAnswer(
      specialist.id,
      timeoutMs,
      pollIntervalMs,
      now,
      sleep,
    );
    const review = parseRequirementsReview(answer);
    await persist('succeeded', storedReview(review));
    return { internalContext: successContext(review) };
  } catch (err: unknown) {
    const reason = reviewFailure(err);
    await persist('failed', { error: reason });
    return { internalContext: failureContext(reason) };
  }
}

export interface InterviewBudgetUsage {
  inquiries: number;
  humanClarifications: number;
  followUpsByGap: Record<string, number>;
}

export interface SpecialistFollowUp {
  gapId: string;
  /** An `INTERVIEW_SPECIALISTS` id. Unknown ids are dropped. */
  specialist: string;
  question: string;
}

export interface LeadSynthesis {
  status: 'clarify' | 'complete';
  humanQuestion: string | null;
  specialistFollowUps: SpecialistFollowUp[];
  summary: string;
  decisions: string[];
  assumptions: string[];
  gaps: Array<{ id: string; severity: 'blocking' | 'non_blocking'; text: string }>;
  conflicts: string[];
  readinessScore: number;
  recommendation: 'ready' | 'ready_with_assumptions' | 'needs_clarification';
  sections: InterviewBriefSections;
}

const specialistFollowUpSchema = z.object({
  gapId: z.string().min(1),
  specialist: z.string().min(1),
  question: z.string(),
});

const leadSynthesisSchema = z.object({
  status: z.enum(['clarify', 'complete']),
  humanQuestion: z.string().nullable(),
  specialistFollowUps: z.array(specialistFollowUpSchema),
  summary: z.string(),
  decisions: z.array(z.string()),
  assumptions: z.array(z.string()),
  gaps: z.array(z.object({
    id: z.string(),
    severity: z.enum(['blocking', 'non_blocking']),
    text: z.string(),
  })),
  conflicts: z.array(z.string()),
  readinessScore: z.number().min(0).max(100),
  recommendation: z.enum(['ready', 'ready_with_assumptions', 'needs_clarification']),
  sections: interviewBriefDraftSchema,
});

function findSpecialist(id: string): InterviewSpecialist | undefined {
  return INTERVIEW_SPECIALISTS.find((specialist) => specialist.id === id);
}

export function usageFromMessages(
  messages: ChatMessage[],
): Pick<InterviewBudgetUsage, 'inquiries' | 'humanClarifications'> {
  const inquiries = messages.filter(
    (message) => message.role === 'agent' && !message.hidden && message.text.trim(),
  ).length;
  const humanTurns = messages.filter(
    (message) => message.role === 'user' && message.text.trim() && message.text !== 'Begin.',
  ).length;
  return {
    inquiries,
    humanClarifications: Math.max(0, humanTurns - 1),
  };
}

export function selectNextInterviewAction(
  synthesis: LeadSynthesis,
  usage: InterviewBudgetUsage,
): { humanQuestion: string | null; specialistFollowUps: SpecialistFollowUp[]; close: boolean } {
  const inquiriesLeft = INTERVIEW_MAX_INQUIRIES - usage.inquiries;
  if (inquiriesLeft <= 0) {
    return { humanQuestion: null, specialistFollowUps: [], close: true };
  }

  const specialistFollowUps: SpecialistFollowUp[] = [];
  for (const followUp of synthesis.specialistFollowUps) {
    if (specialistFollowUps.length >= inquiriesLeft) break;
    if (!findSpecialist(followUp.specialist)) continue;
    const used = usage.followUpsByGap[followUp.gapId] ?? 0;
    if (used >= INTERVIEW_MAX_FOLLOW_UPS_PER_GAP) continue;
    if (!followUp.question.trim()) continue;
    specialistFollowUps.push(followUp);
  }
  if (specialistFollowUps.length > 0) {
    return { humanQuestion: null, specialistFollowUps, close: false };
  }

  const humanQuestion = synthesis.humanQuestion?.trim() ?? '';
  if (humanQuestion && usage.humanClarifications < INTERVIEW_MAX_HUMAN_CLARIFICATIONS) {
    return { humanQuestion, specialistFollowUps: [], close: false };
  }
  return { humanQuestion: null, specialistFollowUps: [], close: true };
}

function followUpsFromReviews(
  rows: Array<{ specialist: string; result: Record<string, unknown> }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.specialist !== LEAD_REVIEW_ID || !Array.isArray(row.result.specialistFollowUps)) continue;
    for (const item of row.result.specialistFollowUps) {
      if (!item || typeof item !== 'object') continue;
      const followUp = item as { gapId?: unknown; specialist?: unknown };
      if (
        typeof followUp.gapId === 'string'
        && typeof followUp.specialist === 'string'
        && findSpecialist(followUp.specialist)
      ) {
        counts[followUp.gapId] = (counts[followUp.gapId] ?? 0) + 1;
      }
    }
  }
  return counts;
}

const peerEvaluationSchema = z.object({
  specialistId: z.string().min(1),
  agreements: z.array(z.string()),
  challenges: z.array(z.string()),
  proposedChanges: z.array(z.string()),
});

const specialistEvaluationSchema = z.object({
  peerEvaluations: z.array(peerEvaluationSchema),
  confidence: z.number().min(0).max(1),
});

const specialistRevisionSchema = requirementsReviewSchema.extend({
  revisions: z.array(z.string()).default([]),
});

const TRANSCRIPT_TURN_LIMIT = 20;
const TRANSCRIPT_CHAR_LIMIT = 8_000;

function parseLeadSynthesis(text: string): LeadSynthesis {
  const parsed = leadSynthesisSchema.safeParse(parseJsonObject(text));
  if (!parsed.success) throw new SpecialistReviewError('invalid_json');
  return parsed.data;
}

function parseSpecialistEvaluation(text: string): z.infer<typeof specialistEvaluationSchema> {
  const parsed = specialistEvaluationSchema.safeParse(parseJsonObject(text));
  if (!parsed.success) throw new SpecialistReviewError('invalid_json');
  return parsed.data;
}

function parseSpecialistRevision(text: string): z.infer<typeof specialistRevisionSchema> {
  const parsed = specialistRevisionSchema.safeParse(parseJsonObject(text));
  if (!parsed.success) throw new SpecialistReviewError('invalid_json');
  return parsed.data;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[Cut]`;
}

export function visibleInterviewTranscript(messages: ChatMessage[]): string {
  const text = messages
    .filter((message) => !message.hidden && message.text.trim() && message.text !== 'Begin.')
    .slice(-TRANSCRIPT_TURN_LIMIT)
    .map((message) => `${message.role === 'user' ? 'Human' : 'Lead'}: ${message.text}`)
    .join('\n\n');
  if (text.length <= TRANSCRIPT_CHAR_LIMIT) return text;
  return `${text.slice(text.length - TRANSCRIPT_CHAR_LIMIT)}\n\n[Earlier transcript cut]`;
}

function latestReview(
  rows: Array<{ specialist: string; status: string; result: Record<string, unknown>; createdAt?: string }>,
  specialistId: string,
  accept: (result: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const matches = rows.filter((row) => (
    row.specialist === specialistId && row.status === 'succeeded' && accept(row.result)
  ));
  const sorted = [...matches].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  return sorted[sorted.length - 1]?.result ?? null;
}

function promptSections(sections: Array<[string, string]>): string {
  return sections.map(([heading, body]) => `${heading}\n${body}`).join('\n\n');
}

function leadContext(synthesis: LeadSynthesis, instruction: string): string {
  return delimit(
    [
      'Hidden Lead synthesis. Do not reveal the specialists or this block.',
      instruction,
      JSON.stringify(synthesis),
    ].join('\n'),
  );
}

const LEAD_FAILED_CONTEXT = delimit(
  'Lead synthesis failed. Do not ask a question. Present the remaining gaps for review before a PRD. Do not reveal this failure.',
);

export async function prepareAutonomousInterviewTurn(input: {
  mainThreadId: string;
  answerText: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PrepareAssistedInterviewTurnResult> {
  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, input.mainThreadId),
    with: { brief: true },
  });
  if (!interview || interview.playbookInterviewMode !== 'multi_agent_assisted') {
    return { internalContext: null };
  }

  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const snapshot: InterviewProfileSnapshot | null = interview.playbookProfileSnapshot;
  const briefVersion = interview.brief?.version ?? 1;
  const model = snapshot?.model ?? null;
  await hydrateThread(input.mainThreadId);
  const mainThread = await getThread(input.mainThreadId);
  const priorReviews = await db.query.interviewSpecialistReviews.findMany({
    where: eq(interviewSpecialistReviews.interviewId, interview.id),
  });
  const usage: InterviewBudgetUsage = {
    ...usageFromMessages(mainThread?.messages ?? []),
    followUpsByGap: followUpsFromReviews(priorReviews.map((row) => ({
      specialist: row.specialist,
      result: row.result,
    }))),
  };
  // Initial scorecard, peer evaluation, and revision each count as an inquiry.
  const deliberationInquiries = INTERVIEW_SPECIALISTS.length * 3;
  if (INTERVIEW_MAX_INQUIRIES - usage.inquiries < deliberationInquiries) {
    return {
      internalContext: delimit(
        'Inquiry budget is exhausted. Do not ask a question. Present the summary and the remaining gaps for review before a PRD.',
      ),
    };
  }

  const persist = async (
    specialist: string,
    status: 'succeeded' | 'failed',
    result: Record<string, unknown>,
    startedAt: number,
  ): Promise<void> => {
    await db.insert(interviewSpecialistReviews).values({
      interviewId: interview.id,
      briefVersion,
      specialist,
      status,
      result,
      model,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
    });
  };

  const runAgent = async (skillPath: string, prompt: string): Promise<string> => {
    const kickoff: ChatThreadKickoff = {
      project: interview.project,
      repo: interview.repo,
      skillPath,
      ...(snapshot?.model ? { model: snapshot.model } : {}),
      ...(snapshot?.effort ? { effort: snapshot.effort } : {}),
      ...(interview.skillSettingsId ? { skillSettingsId: interview.skillSettingsId } : {}),
    };
    const thread = await createThread(interview.authorId, kickoff, { skipAutoKickoff: true });
    await sendMessage(thread.id, prompt, undefined, [], { hidden: true });
    return waitForSpecialistAnswer(thread.id, timeoutMs, pollIntervalMs, now, sleep);
  };

  const reviewRows = priorReviews.map((row) => ({
    specialist: row.specialist,
    status: row.status,
    result: row.result,
    createdAt: row.createdAt,
  }));
  const establishedBrief = latestReview(
    reviewRows,
    LEAD_REVIEW_ID,
    (result) => Array.isArray(result.decisions),
  );
  const priorScorecards = new Map<string, string>();
  for (const specialist of INTERVIEW_SPECIALISTS) {
    const prior = latestReview(
      reviewRows,
      specialist.id,
      (result) => Array.isArray(result.confirmedDecisions),
    );
    priorScorecards.set(specialist.id, prior ? clip(JSON.stringify(prior), 2_000) : 'none');
  }
  const transcript = visibleInterviewTranscript(mainThread?.messages ?? []);
  const sharedContext = promptSections([
    ['Established brief:', establishedBrief ? clip(JSON.stringify({
      decisions: establishedBrief.decisions ?? [],
      assumptions: establishedBrief.assumptions ?? [],
      gaps: establishedBrief.gaps ?? [],
      conflicts: establishedBrief.conflicts ?? [],
    }), 2_000) : 'none'],
    ['Transcript:', transcript || 'none'],
    ['Latest human answer:', input.answerText],
  ]);

  const runScored = async (
    specialist: InterviewSpecialist,
    phase: 'initial' | 'evaluation' | 'revision',
    prompt: string,
  ): Promise<string> => {
    const startedAt = now();
    usage.inquiries += 1;
    try {
      const answer = await runAgent(specialist.skillPath, prompt);
      if (phase === 'evaluation') {
        const evaluation = parseSpecialistEvaluation(answer);
        await persist(specialist.id, 'succeeded', { ...evaluation, phase }, startedAt);
      } else if (phase === 'revision') {
        const revised = parseSpecialistRevision(answer);
        await persist(specialist.id, 'succeeded', { ...revised, phase }, startedAt);
      } else {
        const review = parseRequirementsReview(answer);
        await persist(specialist.id, 'succeeded', { ...storedReview(review), phase }, startedAt);
      }
      return answer;
    } catch (err: unknown) {
      const reason = reviewFailure(err);
      await persist(specialist.id, 'failed', { error: reason, phase }, startedAt);
      return failureContext(reason);
    }
  };

  const others = (specialistId: string, board: Map<string, string>): string => (
    INTERVIEW_SPECIALISTS
      .filter((peer) => peer.id !== specialistId)
      .map((peer) => `${peer.label} (${peer.id}):\n${board.get(peer.id) ?? 'none'}`)
      .join('\n\n') || 'none'
  );

  const initial = new Map<string, string>();
  for (const specialist of INTERVIEW_SPECIALISTS) {
    initial.set(specialist.id, await runScored(
      specialist,
      'initial',
      [
        `You are the ${specialist.label}. Write your initial scorecard.`,
        'Decide from the brief, the transcript, and the latest answer. Do not review the other specialists in this step.',
        'Return only the scorecard JSON defined by the skill.',
        sharedContext,
        promptSections([
          ['Your last scorecard:', priorScorecards.get(specialist.id) ?? 'none'],
          ['Other last scorecards:', others(specialist.id, priorScorecards)],
        ]),
      ].join('\n\n'),
    ));
  }

  const evaluation = new Map<string, string>();
  for (const specialist of INTERVIEW_SPECIALISTS) {
    evaluation.set(specialist.id, await runScored(
      specialist,
      'evaluation',
      [
        `You are the ${specialist.label}. Evaluate the other specialists.`,
        'Compare their initial scorecards with yours. Record agreements, challenges, and proposed changes.',
        'Return only the peer evaluation JSON: {"peerEvaluations":[{"specialistId":"string","agreements":[],"challenges":[],"proposedChanges":[]}],"confidence":0}.',
        promptSections([
          ['Your initial scorecard:', initial.get(specialist.id) ?? 'none'],
          ['Other initial scorecards:', others(specialist.id, initial)],
        ]),
      ].join('\n\n'),
    ));
  }

  const labeled = (board: Map<string, string>): string => (
    INTERVIEW_SPECIALISTS
      .map((peer) => `${peer.label} (${peer.id}):\n${board.get(peer.id) ?? 'none'}`)
      .join('\n\n') || 'none'
  );

  const revision = new Map<string, string>();
  const revisionPrompt = (specialist: InterviewSpecialist, followUp?: string): string => [
    `You are the ${specialist.label}. Revise your scorecard.`,
    'Accept a challenge when the other scorecard supports it. Reject a challenge by keeping your decision, listing it in conflicts, and explaining the rejection in revisions.',
    'Return the scorecard JSON plus a revisions array.',
    ...(followUp ? [`Lead follow-up:\n${followUp}`] : []),
    promptSections([
      ['Your initial scorecard:', initial.get(specialist.id) ?? 'none'],
      ['Peer evaluations:', labeled(evaluation)],
      ...(followUp ? [['Other revised scorecards:', others(specialist.id, revision)] as [string, string]] : []),
    ]),
  ].join('\n\n');

  for (const specialist of INTERVIEW_SPECIALISTS) {
    revision.set(specialist.id, await runScored(specialist, 'revision', revisionPrompt(specialist)));
  }

  for (let round = 0; round <= INTERVIEW_MAX_FOLLOW_UPS_PER_GAP; round += 1) {
    const leadStartedAt = now();
    let synthesis: LeadSynthesis;
    try {
      const leadAnswer = await runAgent(
        LEAD_SKILL_PATH,
        [
          'Return only the lead synthesis JSON.',
          'Use the revised scorecards as the specialists\' answer. The peer evaluations show what each one accepted or challenged.',
          'Promote agreement into decisions. Send a follow-up only when a rejected challenge is still unresolved, and ask the human only when the decision is blocking.',
          `Specialist ids you may follow up with: ${INTERVIEW_SPECIALISTS.map((s) => s.id).join(', ')}.`,
          promptSections([
            ['Revised scorecards:', labeled(revision)],
            ['Peer evaluations:', labeled(evaluation)],
          ]),
        ].join('\n'),
      );
      synthesis = parseLeadSynthesis(leadAnswer);
    } catch (err: unknown) {
      await persist(LEAD_REVIEW_ID, 'failed', { error: reviewFailure(err) }, leadStartedAt);
      return { internalContext: LEAD_FAILED_CONTEXT };
    }
    await persist(
      LEAD_REVIEW_ID,
      'succeeded',
      JSON.parse(JSON.stringify(synthesis)) as Record<string, unknown>,
      leadStartedAt,
    );

    const action = selectNextInterviewAction(synthesis, usage);
    if (action.specialistFollowUps.length === 0) {
      if (action.humanQuestion) {
        return {
          internalContext: leadContext(
            synthesis,
            `Ask this one question and nothing else:\n${action.humanQuestion}`,
          ),
        };
      }
      return {
        internalContext: leadContext(
          synthesis,
          'Do not ask a question. Present the summary, decisions, assumptions, gaps, conflicts, readiness score, and recommendation for review before a PRD.',
        ),
      };
    }
    for (const followUp of action.specialistFollowUps) {
      const specialist = findSpecialist(followUp.specialist);
      if (!specialist) continue;
      usage.followUpsByGap[followUp.gapId] = (usage.followUpsByGap[followUp.gapId] ?? 0) + 1;
      revision.set(
        specialist.id,
        await runScored(specialist, 'revision', revisionPrompt(specialist, followUp.question)),
      );
    }
  }

  return {
    internalContext: delimit(
      'Do not ask a question. Specialist follow-ups are exhausted. Present the remaining gaps for review before a PRD.',
    ),
  };
}

export async function draftInterviewBriefSections(input: {
  interviewId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<InterviewBriefSections> {
  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.id, input.interviewId),
  });
  if (!interview) throw new Error(`Interview ${input.interviewId} was not found.`);

  await hydrateThread(interview.chatThreadId);
  const mainThread = await getThread(interview.chatThreadId);
  const transcript = (mainThread?.messages ?? [])
    .filter((message) => (
      (message.role === 'user' && message.text !== 'Begin.')
      || message.role === 'agent'
    ))
    .map((message) => `${message.role === 'user' ? 'Business Analyst' : 'Interviewer'}: ${message.text}`)
    .join('\n\n');
  if (!transcript.trim()) throw new Error('The interview has no conversation to draft.');

  const snapshot: InterviewProfileSnapshot | null = interview.playbookProfileSnapshot;
  const kickoff: ChatThreadKickoff = {
    project: interview.project,
    repo: interview.repo,
    skillPath: BRIEF_DRAFT_SKILL_PATH,
    ...(snapshot?.model ? { model: snapshot.model } : {}),
    ...(snapshot?.effort ? { effort: snapshot.effort } : {}),
    ...(interview.skillSettingsId ? { skillSettingsId: interview.skillSettingsId } : {}),
  };
  const specialist = await createThread(interview.authorId, kickoff, { skipAutoKickoff: true });
  await sendMessage(
    specialist.id,
    `Draft the brief from this interview transcript:\n\n${transcript}`,
    undefined,
    [],
    { hidden: true },
  );
  const answer = await waitForSpecialistAnswer(
    specialist.id,
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    input.now ?? Date.now,
    input.sleep ?? defaultSleep,
  );
  const parsed = interviewBriefDraftSchema.safeParse(parseJsonObject(answer));
  if (!parsed.success) throw new SpecialistReviewError('invalid_json');
  return parsed.data;
}
