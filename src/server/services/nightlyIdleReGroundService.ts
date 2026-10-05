import { eq, or } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  adrs,
  chatThreads,
  designDocs,
  interviews,
  prds,
  testCases,
} from '../db/schema';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import { runGroundingRepository } from './runGroundingRepository';
import { runGroundingService } from './runGroundingService';
import { readCachedOriginSha as readCachedOriginShaFromRepoCache } from './repoCacheService';

const NIGHTLY_TZ = 'America/New_York';
const NIGHTLY_HOUR = 23;

/** ADR interview / assistant chats that are still open. */
const OPEN_ADR_STATUSES = new Set(['in_progress', 'generating', 'proposed']);

/** Document assistants stay eligible until the document is fully approved. */
const CLOSED_PRD_STATUSES = new Set(['approved']);
const CLOSED_DESIGN_DOC_STATUSES = new Set(['approved']);

export interface NightlyIdleReGroundDependencies {
  listActiveGroundings?: () => Promise<RunGrounding[]>;
  reGroundFromCache?: (
    ref: RunRef,
    role: 'target',
  ) => Promise<{ previousSha: string; newSha: string; groundedAt: string } | null>;
  readCachedOriginSha?: (
    grounding: Pick<
      RunGrounding,
      'provider' | 'project' | 'repository' | 'branch' | 'groundedSha'
    >,
  ) => Promise<string | null>;
  isThreadIdle?: (threadId: string) => Promise<boolean>;
  /**
   * Long-lived chats that should quietly catch up overnight when idle:
   * home, in-progress interviews, open ADR chats/assistants, open PRD /
   * design-doc assistants. Generation / validation / test-case jobs are out.
   */
  isEligibleLongLivedChat?: (threadId: string) => Promise<boolean>;
  /** @deprecated Use isEligibleLongLivedChat */
  isInProgressInterviewOrHomeChat?: (threadId: string) => Promise<boolean>;
  now?: () => Date;
}

export interface NightlyIdleReGroundResult {
  due: boolean;
  etDate: string;
  considered: number;
  reGrounded: number;
  skippedRunning: number;
  skippedFresh: number;
  skippedIneligible: number;
  errors: number;
}

function formatEtParts(date: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NIGHTLY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const month = get('month');
  const day = get('day');
  const year = get('year');
  const hour = Number(get('hour'));
  return { date: `${year}-${month}-${day}`, hour };
}

/** True once per ET calendar day after 23:00 America/New_York. */
export function isNightlyIdleReGroundDue(
  now: Date,
  lastRunEtDate: string | null,
): boolean {
  const { date, hour } = formatEtParts(now);
  if (hour < NIGHTLY_HOUR) return false;
  if (lastRunEtDate === date) return false;
  return true;
}

export function etCalendarDate(now: Date): string {
  return formatEtParts(now).date;
}

async function defaultIsThreadIdle(threadId: string): Promise<boolean> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { status: true, activeRunId: true },
  });
  if (!row) return false;
  return row.status !== 'running' && !row.activeRunId;
}

/**
 * Allow idle overnight pin catch-up for long-lived conversational surfaces.
 * Deny generation / validation / test-case worker threads so mid-pipeline
 * pins stay fixed until the job finishes or the user chooses "use latest."
 */
export async function defaultIsEligibleLongLivedChat(
  threadId: string,
): Promise<boolean> {
  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
    columns: { status: true },
  });
  if (interview) {
    return interview.status === 'in_progress';
  }

  const adr = await db.query.adrs.findFirst({
    where: or(
      eq(adrs.chatThreadId, threadId),
      eq(adrs.adrAssistantThreadId, threadId),
    ),
    columns: { status: true },
  });
  if (adr) {
    return OPEN_ADR_STATUSES.has(adr.status);
  }

  const prdAssistant = await db.query.prds.findFirst({
    where: eq(prds.prdAssistantThreadId, threadId),
    columns: { status: true },
  });
  if (prdAssistant) {
    return !CLOSED_PRD_STATUSES.has(prdAssistant.status);
  }

  const designDocAssistant = await db.query.designDocs.findFirst({
    where: eq(designDocs.docAssistantThreadId, threadId),
    columns: { status: true },
  });
  if (designDocAssistant) {
    return !CLOSED_DESIGN_DOC_STATUSES.has(designDocAssistant.status);
  }

  // Generation / validation / test-case jobs — keep pin until they finish.
  const prdGeneration = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
    columns: { id: true },
  });
  if (prdGeneration) return false;

  const designDocJob = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.validationThreadId, threadId),
    ),
    columns: { id: true },
  });
  if (designDocJob) return false;

  const testCaseJob = await db.query.testCases.findFirst({
    where: eq(testCases.chatThreadId, threadId),
    columns: { id: true },
  });
  if (testCaseJob) return false;

  // Unlinked chat thread → home chat.
  return true;
}

async function defaultReadCachedOriginSha(
  grounding: Pick<
    RunGrounding,
    'provider' | 'project' | 'repository' | 'branch' | 'groundedSha'
  >,
): Promise<string | null> {
  return readCachedOriginShaFromRepoCache(grounding);
}

export function createNightlyIdleReGroundService(
  dependencies: NightlyIdleReGroundDependencies = {},
) {
  const listActiveGroundings =
    dependencies.listActiveGroundings ??
    (() => runGroundingRepository.listActiveGroundings());
  const reGroundFromCache =
    dependencies.reGroundFromCache ??
    ((ref: RunRef, role: 'target') =>
      runGroundingService.reGroundFromCache(ref, role));
  const readCachedOriginSha =
    dependencies.readCachedOriginSha ?? defaultReadCachedOriginSha;
  const isThreadIdle = dependencies.isThreadIdle ?? defaultIsThreadIdle;
  const isEligibleLongLivedChat =
    dependencies.isEligibleLongLivedChat ??
    dependencies.isInProgressInterviewOrHomeChat ??
    defaultIsEligibleLongLivedChat;
  const now = dependencies.now ?? (() => new Date());

  let lastRunEtDate: string | null = null;

  return {
    getLastRunEtDate(): string | null {
      return lastRunEtDate;
    },

    setLastRunEtDate(date: string | null): void {
      lastRunEtDate = date;
    },

    async runIfDue(): Promise<NightlyIdleReGroundResult> {
      const current = now();
      const etDate = etCalendarDate(current);
      if (!isNightlyIdleReGroundDue(current, lastRunEtDate)) {
        return {
          due: false,
          etDate,
          considered: 0,
          reGrounded: 0,
          skippedRunning: 0,
          skippedFresh: 0,
          skippedIneligible: 0,
          errors: 0,
        };
      }

      const result: NightlyIdleReGroundResult = {
        due: true,
        etDate,
        considered: 0,
        reGrounded: 0,
        skippedRunning: 0,
        skippedFresh: 0,
        skippedIneligible: 0,
        errors: 0,
      };

      const active = await listActiveGroundings();
      const targets = active.filter(
        (row) =>
          row.isActive &&
          row.runType === 'chat' &&
          row.repoRole === 'target',
      );
      result.considered = targets.length;

      for (const grounding of targets) {
        try {
          const eligible = await isEligibleLongLivedChat(grounding.runId);
          if (!eligible) {
            result.skippedIneligible += 1;
            continue;
          }
          const idle = await isThreadIdle(grounding.runId);
          if (!idle) {
            result.skippedRunning += 1;
            continue;
          }
          const tip = await readCachedOriginSha(grounding);
          if (!tip || tip === grounding.groundedSha) {
            result.skippedFresh += 1;
            continue;
          }
          const updated = await reGroundFromCache(
            {
              runType: grounding.runType,
              runId: grounding.runId,
              project: grounding.project,
            },
            'target',
          );
          if (updated && updated.newSha !== updated.previousSha) {
            result.reGrounded += 1;
          } else {
            result.skippedFresh += 1;
          }
        } catch (error) {
          result.errors += 1;
          console.warn(
            '[nightly-idle-reground] failed for run',
            grounding.runId,
            error instanceof Error ? error.message : error,
          );
        }
      }

      lastRunEtDate = etDate;
      console.log(
        `[nightly-idle-reground] etDate=${etDate} considered=${result.considered} reGrounded=${result.reGrounded} skippedRunning=${result.skippedRunning} skippedFresh=${result.skippedFresh} skippedIneligible=${result.skippedIneligible} errors=${result.errors}`,
      );
      return result;
    },
  };
}

export const nightlyIdleReGroundService = createNightlyIdleReGroundService();
