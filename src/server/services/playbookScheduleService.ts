/**
 * Daily trigger for a Playbook. Run now stays a person pressing the button.
 * This sweep starts the published version once inside the UTC window, as the
 * person who saved the trigger.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { db } from '../db/drizzle';
import {
  appUsers,
  playbookDefinitions,
  playbookDefinitionVersions,
  playbookRuns,
} from '../db/schema';
import { getUserPermissions } from './rbacService';
import { isFeatureEnabled } from './featureFlagService';
import { isSuperAdminEmail } from '../utils/superAdmin';
import {
  PlaybookDefinitionNotFoundError,
  getDefinitionDetail,
} from './playbookDefinitionService';
import { startRun } from './playbookRunService';
import type { PlaybookDefinitionDetail } from '../../shared/types/playbook';
import {
  isDailyPlaybookScheduleDue,
  playbookScheduleSchema,
  type PlaybookScheduleDraft,
} from '../../shared/utils/playbookSchedule';

const PLAYBOOKS_FLAG = 'playbooks-production-adapters';
const LIVE_RUN_STATUSES = ['running', 'suspended'] as const;

export class PlaybookScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookScheduleValidationError';
  }
}

async function ownerCanRun(userId: string, project: string): Promise<boolean> {
  const user = await db.query.appUsers.findFirst({
    where: eq(appUsers.oid, userId),
    columns: { email: true },
  });
  if (user?.email && isSuperAdminEmail(user.email)) return true;
  const permissions = await getUserPermissions(userId, project);
  return permissions.has('playbooks:run');
}

export async function updatePlaybookSchedule(input: {
  project: string;
  definitionId: string;
  actorUserId: string;
  schedule: PlaybookScheduleDraft;
}): Promise<PlaybookDefinitionDetail> {
  let draft: PlaybookScheduleDraft;
  try {
    draft = playbookScheduleSchema.parse(input.schedule);
  } catch (error) {
    const message = error instanceof ZodError
      ? (error.issues[0]?.message ?? 'Check the trigger and try again.')
      : 'Check the trigger and try again.';
    throw new PlaybookScheduleValidationError(message);
  }

  const nowIso = new Date().toISOString();
  const updated = await db
    .update(playbookDefinitions)
    .set({
      scheduleKind: draft.scheduleKind,
      scheduleHour: draft.scheduleKind === 'daily' ? draft.scheduleHour : null,
      scheduleMinute: draft.scheduleKind === 'daily' ? draft.scheduleMinute : 0,
      scheduleSetBy: draft.scheduleKind === 'daily' ? input.actorUserId : null,
      updatedAt: nowIso,
    })
    .where(and(
      eq(playbookDefinitions.id, input.definitionId),
      eq(playbookDefinitions.project, input.project),
    ))
    .returning({ id: playbookDefinitions.id });
  if (!updated[0]) throw new PlaybookDefinitionNotFoundError(input.definitionId);
  return getDefinitionDetail(input.project, input.definitionId);
}

async function stampSchedule(definitionId: string, now: Date): Promise<void> {
  await db
    .update(playbookDefinitions)
    .set({ lastScheduledAt: now.toISOString() })
    .where(eq(playbookDefinitions.id, definitionId));
}

/**
 * Claims one due Playbook. Returns true when the caller should start a run.
 * A run already in progress is left for a later minute in the same window.
 * A Playbook with no published version is left the same way, so publishing
 * during the window still starts it.
 */
async function claimDuePlaybook(
  definitionId: string,
  now: Date,
): Promise<{ project: string; initiatorUserId: string } | null> {
  const lockKey = `playbook-schedule:${definitionId}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const [locked] = await tx
      .select()
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.id, definitionId))
      .limit(1);
    if (
      !locked?.scheduleSetBy
      || !isDailyPlaybookScheduleDue({
        scheduleKind: locked.scheduleKind,
        scheduleHour: locked.scheduleHour,
        scheduleMinute: locked.scheduleMinute,
        lastScheduledAt: locked.lastScheduledAt,
        now,
      })
    ) {
      return null;
    }

    const live = await tx
      .select({ id: playbookRuns.id })
      .from(playbookRuns)
      .innerJoin(
        playbookDefinitionVersions,
        eq(playbookRuns.definitionVersionId, playbookDefinitionVersions.id),
      )
      .where(and(
        eq(playbookDefinitionVersions.definitionId, locked.id),
        inArray(playbookRuns.status, [...LIVE_RUN_STATUSES]),
      ))
      .limit(1);
    if (live[0]) return null;

    const [published] = await tx
      .select({ id: playbookDefinitionVersions.id })
      .from(playbookDefinitionVersions)
      .where(and(
        eq(playbookDefinitionVersions.definitionId, locked.id),
        eq(playbookDefinitionVersions.status, 'published'),
      ))
      .limit(1);
    if (!published) return null;

    const playbooksOn = await isFeatureEnabled(PLAYBOOKS_FLAG, {
      userId: locked.scheduleSetBy,
      project: locked.project,
    });
    let start: { project: string; initiatorUserId: string } | null = null;
    // @feature-flag:playbooks-production-adapters start winner=enabled
    if (!playbooksOn) {
      // @feature-flag:playbooks-production-adapters disabled-start
      await tx
        .update(playbookDefinitions)
        .set({ lastScheduledAt: now.toISOString() })
        .where(eq(playbookDefinitions.id, locked.id));
      // @feature-flag:playbooks-production-adapters disabled-end
    } else {
      // @feature-flag:playbooks-production-adapters enabled-start
      const allowed = await ownerCanRun(locked.scheduleSetBy, locked.project);
      if (!allowed) {
        console.warn('[playbook-schedule] the person who set the trigger cannot run playbooks', JSON.stringify({
          definitionId: locked.id,
          project: locked.project,
        }));
      } else {
        start = { project: locked.project, initiatorUserId: locked.scheduleSetBy };
      }
      await tx
        .update(playbookDefinitions)
        .set({ lastScheduledAt: now.toISOString() })
        .where(eq(playbookDefinitions.id, locked.id));
      // @feature-flag:playbooks-production-adapters enabled-end
    }
    // @feature-flag:playbooks-production-adapters end
    return start;
  });
}

export async function sweepDuePlaybookSchedules(now = new Date()): Promise<void> {
  const due = await db
    .select({
      id: playbookDefinitions.id,
      project: playbookDefinitions.project,
      scheduleKind: playbookDefinitions.scheduleKind,
      scheduleHour: playbookDefinitions.scheduleHour,
      scheduleMinute: playbookDefinitions.scheduleMinute,
      lastScheduledAt: playbookDefinitions.lastScheduledAt,
      scheduleSetBy: playbookDefinitions.scheduleSetBy,
    })
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.scheduleKind, 'daily'));

  for (const definition of due) {
    if (!definition.scheduleSetBy || !isDailyPlaybookScheduleDue({
      scheduleKind: definition.scheduleKind,
      scheduleHour: definition.scheduleHour,
      scheduleMinute: definition.scheduleMinute,
      lastScheduledAt: definition.lastScheduledAt,
      now,
    })) continue;

    let claimed: { project: string; initiatorUserId: string } | null = null;
    try {
      claimed = await claimDuePlaybook(definition.id, now);
    } catch (err) {
      console.error('[playbook-schedule] could not claim the trigger', JSON.stringify({
        definitionId: definition.id,
        project: definition.project,
        error: err instanceof Error ? err.message : String(err),
      }));
      continue;
    }
    if (!claimed) continue;

    try {
      await startRun({
        project: claimed.project,
        definitionId: definition.id,
        initiatorUserId: claimed.initiatorUserId,
        spendAdmissionEnabled: true,
      });
    } catch (err) {
      console.error('[playbook-schedule] scheduled start failed', JSON.stringify({
        definitionId: definition.id,
        project: definition.project,
        error: err instanceof Error ? err.message : String(err),
      }));
      await stampSchedule(definition.id, now).catch(() => undefined);
    }
  }
}
