/**
 * One Requirements review per Business Analyst answer, then a hidden context block for the Lead.
 *
 * Ordinary and human-led threads do not create a specialist thread. A failed review is stored and
 * the Lead still receives a safe context so the visible interview can continue. The specialist list
 * is the extension point for later reviewers; Phase 1 runs requirements once.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatThread, ChatThreadKickoff } from '../../shared/types/chat';
import type { InterviewBriefSections } from '../../shared/types/interview';
import type { InterviewProfileSnapshot } from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import { interviewSpecialistReviews, interviews } from '../db/schema';
import { createThread, getThread, hydrateThread, isThreadIdle, sendMessage } from './chatAgentService';

const REQUIREMENTS_SKILL_PATH = '.cursor/skills/interview-requirements-review/SKILL.md';
const BRIEF_DRAFT_SKILL_PATH = '.cursor/skills/interview-brief-draft/SKILL.md';
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
