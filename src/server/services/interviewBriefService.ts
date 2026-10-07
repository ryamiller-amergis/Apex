/**
 * Current interview brief plus an immutable revision for every save and approval.
 *
 * A Playbook-linked interview resumes its suspended step only when this approval is the one that
 * moves the step. A second approval returns the same version and leaves the run alone.
 */
import { and, eq } from 'drizzle-orm';
import type { InterviewBriefRecord, InterviewBriefSections, InterviewBriefStatus } from '../../shared/types/interview';
import { INTERVIEW_BRIEF_SECTIONS } from '../../shared/types/interview';
import type { InterviewStepOutput } from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import {
  interviewBriefRevisions,
  interviewBriefs,
  interviews,
  playbookStepRuns,
} from '../db/schema';
import { advanceRun } from './playbookAdvanceService';
import { parseStepOutput } from './playbookSteps/descriptorValidation';
import { resumeStepRun } from './playbookSteps/stepRuns';

const TEXT_SECTION_KEYS = INTERVIEW_BRIEF_SECTIONS
  .map((section) => section.key)
  .filter((key) => key !== 'unresolvedItems');

export class InterviewBriefError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'InterviewBriefError';
    this.statusCode = statusCode;
  }
}

export interface ApproveInterviewBriefResult {
  briefId: string;
  version: number;
  approvedBy: string;
  approvedAt: string;
  unresolvedCount: number;
  output: InterviewStepOutput;
  resumed: boolean;
}

type BriefRow = {
  id: string;
  interviewId: string;
  status: InterviewBriefStatus;
  version: number;
  sections: InterviewBriefSections;
  approvedBy: string | null;
  approvedAt: string | null;
};

type InterviewLink = {
  id: string;
  playbookRunId: string | null;
  playbookStepRunId: string | null;
};

export function parseInterviewBriefSections(value: unknown): InterviewBriefSections {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InterviewBriefError('Brief sections must be an object.');
  }

  const record = value as Record<string, unknown>;
  for (const section of INTERVIEW_BRIEF_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(record, section.key)) {
      throw new InterviewBriefError(`Brief sections must include ${section.key}.`);
    }
  }

  const expected = new Set<string>(INTERVIEW_BRIEF_SECTIONS.map((section) => section.key));
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new InterviewBriefError('Brief sections must be exactly the design sections.');
    }
  }

  for (const key of TEXT_SECTION_KEYS) {
    if (typeof record[key] !== 'string') {
      throw new InterviewBriefError(`${key} must be a string.`);
    }
  }

  const unresolvedItems = record.unresolvedItems;
  if (!Array.isArray(unresolvedItems) || unresolvedItems.some((item) => typeof item !== 'string')) {
    throw new InterviewBriefError('unresolvedItems must be an array of strings.');
  }

  return {
    problemAndOutcome: record.problemAndOutcome as string,
    users: record.users as string,
    scope: record.scope as string,
    businessRules: record.businessRules as string,
    scenarios: record.scenarios as string,
    acceptanceCriteria: record.acceptanceCriteria as string,
    assumptions: record.assumptions as string,
    unresolvedItems: [...unresolvedItems],
  };
}

function unresolvedCount(sections: InterviewBriefSections): number {
  return sections.unresolvedItems.length;
}

function registeredOutput(output: InterviewStepOutput): InterviewStepOutput {
  return parseStepOutput('interview', { ...output }) as unknown as InterviewStepOutput;
}

function toRecord(row: BriefRow): InterviewBriefRecord {
  return {
    id: row.id,
    interviewId: row.interviewId,
    status: row.status,
    version: row.version,
    sections: row.sections,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
  };
}

export function formatInterviewBriefForPrd(brief: InterviewBriefRecord): string {
  const lines = [
    '# Approved Interview Brief',
    '',
    `Brief version: ${brief.version}`,
    '',
  ];

  for (const section of INTERVIEW_BRIEF_SECTIONS) {
    const value = brief.sections[section.key];
    const body = Array.isArray(value)
      ? (value.length > 0 ? value.map((item) => `- ${item}`).join('\n') : '_None_')
      : (value.trim() || '_Not specified_');
    lines.push(`## ${section.label.replace(/\b\w/g, (letter) => letter.toUpperCase())}`, '', body, '');
  }

  return lines.join('\n').trim();
}

async function loadInterview(interviewId: string): Promise<InterviewLink> {
  const [row] = await db
    .select({
      id: interviews.id,
      playbookRunId: interviews.playbookRunId,
      playbookStepRunId: interviews.playbookStepRunId,
    })
    .from(interviews)
    .where(eq(interviews.id, interviewId));

  if (!row) {
    throw new InterviewBriefError(`Interview ${interviewId} was not found.`, 404);
  }
  return row;
}

async function loadBrief(interviewId: string): Promise<BriefRow | null> {
  const [row] = await db
    .select({
      id: interviewBriefs.id,
      interviewId: interviewBriefs.interviewId,
      status: interviewBriefs.status,
      version: interviewBriefs.version,
      sections: interviewBriefs.sections,
      approvedBy: interviewBriefs.approvedBy,
      approvedAt: interviewBriefs.approvedAt,
    })
    .from(interviewBriefs)
    .where(eq(interviewBriefs.interviewId, interviewId));

  return row ?? null;
}

export async function getInterviewBrief(interviewId: string): Promise<InterviewBriefRecord | null> {
  await loadInterview(interviewId);
  const brief = await loadBrief(interviewId);
  return brief ? toRecord(brief) : null;
}

export async function getApprovedInterviewBriefForPrd(
  interviewId: string,
): Promise<InterviewBriefRecord | null> {
  const brief = await getInterviewBrief(interviewId);
  return brief?.status === 'approved' ? brief : null;
}

export async function saveInterviewBrief(input: {
  interviewId: string;
  sections: InterviewBriefSections;
  savedBy: string;
}): Promise<InterviewBriefRecord> {
  const sections = parseInterviewBriefSections(input.sections);
  const interview = await loadInterview(input.interviewId);
  const existing = await loadBrief(interview.id);
  const now = new Date().toISOString();

  if (!existing) {
    const created = await db.transaction(async (tx) => {
      const [brief] = await tx
        .insert(interviewBriefs)
        .values({
          interviewId: interview.id,
          status: 'draft',
          version: 1,
          sections,
          approvedBy: null,
          approvedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: interviewBriefs.id,
          interviewId: interviewBriefs.interviewId,
          status: interviewBriefs.status,
          version: interviewBriefs.version,
          sections: interviewBriefs.sections,
          approvedBy: interviewBriefs.approvedBy,
          approvedAt: interviewBriefs.approvedAt,
        });

      await tx.insert(interviewBriefRevisions).values({
        briefId: brief.id,
        interviewId: interview.id,
        version: 1,
        status: 'draft',
        sections,
        createdBy: input.savedBy,
        createdAt: now,
      });

      return brief;
    });

    return toRecord(created);
  }

  if (existing.status !== 'draft') {
    throw new InterviewBriefError('An approved brief is frozen.');
  }

  const nextVersion = existing.version + 1;
  const updated = await db.transaction(async (tx) => {
    const [brief] = await tx
      .update(interviewBriefs)
      .set({
        status: 'draft',
        version: nextVersion,
        sections,
        updatedAt: now,
      })
      .where(and(
        eq(interviewBriefs.id, existing.id),
        eq(interviewBriefs.status, 'draft'),
        eq(interviewBriefs.version, existing.version),
      ))
      .returning({
        id: interviewBriefs.id,
        interviewId: interviewBriefs.interviewId,
        status: interviewBriefs.status,
        version: interviewBriefs.version,
        sections: interviewBriefs.sections,
        approvedBy: interviewBriefs.approvedBy,
        approvedAt: interviewBriefs.approvedAt,
      });

    if (!brief) {
      throw new InterviewBriefError('The brief changed during save.');
    }

    await tx.insert(interviewBriefRevisions).values({
      briefId: brief.id,
      interviewId: interview.id,
      version: nextVersion,
      status: 'draft',
      sections,
      createdBy: input.savedBy,
      createdAt: now,
    });

    return brief;
  });

  return toRecord(updated);
}

function approvalResult(
  brief: BriefRow,
  interviewId: string,
  resumed: boolean,
): ApproveInterviewBriefResult {
  const sections = parseInterviewBriefSections(brief.sections);
  const count = unresolvedCount(sections);
  if (!brief.approvedBy || !brief.approvedAt) {
    throw new InterviewBriefError('An approved brief is missing its approver.');
  }

  const output = registeredOutput({
    interviewId,
    briefId: brief.id,
    briefVersion: brief.version,
    approvedBy: brief.approvedBy,
    approvedAt: brief.approvedAt,
    unresolvedCount: count,
  });

  return {
    briefId: brief.id,
    version: brief.version,
    approvedBy: brief.approvedBy,
    approvedAt: brief.approvedAt,
    unresolvedCount: count,
    output,
    resumed,
  };
}

async function resumeApprovedBrief(
  interview: InterviewLink,
  brief: BriefRow,
): Promise<ApproveInterviewBriefResult> {
  const base = approvalResult(brief, interview.id, false);
  if (!interview.playbookRunId || !interview.playbookStepRunId) return base;

  const moved = await resumeStepRun({
    stepRunId: interview.playbookStepRunId,
    output: { ...base.output },
  });
  if (moved) {
    const [step] = await db
      .select({ stepId: playbookStepRuns.stepId })
      .from(playbookStepRuns)
      .where(eq(playbookStepRuns.id, interview.playbookStepRunId));
    await advanceRun(interview.playbookRunId, step?.stepId);
  }
  return { ...base, resumed: moved };
}

export async function approveInterviewBrief(input: {
  interviewId: string;
  approvedBy: string;
}): Promise<ApproveInterviewBriefResult> {
  const interview = await loadInterview(input.interviewId);
  const existing = await loadBrief(interview.id);
  if (!existing) {
    throw new InterviewBriefError(`Interview ${interview.id} has no brief to approve.`, 404);
  }

  const sections = parseInterviewBriefSections(existing.sections);
  if (existing.status === 'approved') {
    return resumeApprovedBrief(interview, { ...existing, sections });
  }

  const approvedAt = new Date().toISOString();
  const nextVersion = existing.version + 1;

  const approved = await db.transaction(async (tx) => {
    const [brief] = await tx
      .update(interviewBriefs)
      .set({
        status: 'approved',
        version: nextVersion,
        sections,
        approvedBy: input.approvedBy,
        approvedAt,
        updatedAt: approvedAt,
      })
      .where(and(
        eq(interviewBriefs.id, existing.id),
        eq(interviewBriefs.status, 'draft'),
        eq(interviewBriefs.version, existing.version),
      ))
      .returning({
        id: interviewBriefs.id,
        interviewId: interviewBriefs.interviewId,
        status: interviewBriefs.status,
        version: interviewBriefs.version,
        sections: interviewBriefs.sections,
        approvedBy: interviewBriefs.approvedBy,
        approvedAt: interviewBriefs.approvedAt,
      });

    if (!brief) return null;

    await tx.insert(interviewBriefRevisions).values({
      briefId: brief.id,
      interviewId: interview.id,
      version: nextVersion,
      status: 'approved',
      sections,
      createdBy: input.approvedBy,
      createdAt: approvedAt,
    });

    await tx
      .update(interviews)
      .set({ status: 'complete', updatedAt: approvedAt })
      .where(eq(interviews.id, interview.id));

    return brief;
  });

  if (!approved) {
    const concurrent = await loadBrief(interview.id);
    if (concurrent?.status === 'approved') {
      return resumeApprovedBrief(interview, concurrent);
    }
    throw new InterviewBriefError('The brief was no longer a draft.');
  }

  return resumeApprovedBrief(interview, approved);
}
