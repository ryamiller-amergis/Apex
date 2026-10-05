import { and, eq, sql } from 'drizzle-orm';
import type {
  PlaybookSpendPolicy,
  PlaybookSpendPolicyView,
  UpdatePlaybookSpendPolicyRequest,
} from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import { playbookSpendPolicies } from '../db/schema';
import { getAppSetting } from './appSettingsService';
import { getSummary } from './aiCostAnalyticsService';
import { createNotification } from './notificationService';
import { getUserPermissions, listUsersForProject } from './rbacService';
import { trackEvent } from './telemetry';

export const DEFAULT_NO_HISTORY_CAP_SETTING =
  'playbooks.spend.default_no_history_cap_usd';
const REQUIRED_PERMISSION = 'playbooks:admin' as const;

type PolicyChanges = Partial<
  Omit<PlaybookSpendPolicy, 'project' | 'createdAt'>
>;

export interface PlaybookSpendPolicyStore {
  get(project: string): Promise<PlaybookSpendPolicy | null>;
  create(
    policy: Omit<PlaybookSpendPolicy, 'createdAt' | 'updatedAt'>
  ): Promise<PlaybookSpendPolicy>;
  setWarningCrossing(input: {
    project: string;
    crossedAt: string;
    recipientUserIds: string[];
  }): Promise<PlaybookSpendPolicy | null>;
  clearWarningCrossing(project: string, updatedAt: string): Promise<void>;
  update(project: string, changes: PolicyChanges): Promise<PlaybookSpendPolicy>;
  getDefaultNoHistoryCapUsd(): Promise<string | null>;
}

export interface SpendNotification {
  kind: 'warning' | 'override';
  project: string;
  capUsd: string;
  currentSpendUsd: string;
  generation: number;
}

export interface PlaybookSpendPolicyDependencies {
  store: PlaybookSpendPolicyStore;
  getSummary: typeof getSummary;
  listAdminUserIds(project: string): Promise<string[]>;
  notify(userId: string, notification: SpendNotification): Promise<unknown>;
  now(): Date;
}

export class PlaybookSpendConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookSpendConfigurationError';
  }
}

export class PlaybookSpendPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookSpendPolicyValidationError';
  }
}

export class PlaybookSpendCapExceededError extends Error {
  readonly code = 'PLAYBOOK_SPEND_CAP_EXCEEDED' as const;
  readonly requiredPermission = REQUIRED_PERMISSION;

  constructor(
    public readonly currentSpendUsd: string,
    public readonly capUsd: string
  ) {
    super(
      `New Playbook starts are blocked by the project spend policy: trailing 30-day spend ` +
        `$${currentSpendUsd} is at or above the $${capUsd} cap. A user with ` +
        `${REQUIRED_PERMISSION} can raise the cap.`
    );
    this.name = 'PlaybookSpendCapExceededError';
  }
}

function usd(value: number | string): string {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PlaybookSpendPolicyValidationError(
      'USD amount must be a finite non-negative value.'
    );
  }
  return parsed.toFixed(6);
}

export function trailingThirtyDayRange(now: Date): {
  from: string;
  to: string;
} {
  const to = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
  const from = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 29,
      0,
      0,
      0,
      0
    )
  );
  return { from: from.toISOString(), to: to.toISOString() };
}

export function createPlaybookSpendPolicyService(
  deps: PlaybookSpendPolicyDependencies
) {
  async function currentSpend(project: string): Promise<string> {
    const range = trailingThirtyDayRange(deps.now());
    const summary = await deps.getSummary({ ...range, project });
    return usd(summary.totalCostUsd);
  }

  async function resolveInitialCap(baselineCostUsd: string): Promise<string> {
    if (Number(baselineCostUsd) > 0) return usd(Number(baselineCostUsd) * 3);
    const configured = await deps.store.getDefaultNoHistoryCapUsd();
    const parsed = Number(configured);
    if (!configured || !Number.isFinite(parsed) || parsed <= 0) {
      throw new PlaybookSpendConfigurationError(
        `${DEFAULT_NO_HISTORY_CAP_SETTING} must be configured as a positive USD amount.`
      );
    }
    return usd(parsed);
  }

  async function notifyCrossing(
    recipientUserIds: string[],
    notification: SpendNotification
  ): Promise<void> {
    await Promise.all(
      recipientUserIds.map((userId) => deps.notify(userId, notification))
    );
  }

  async function assertAdmission(project: string): Promise<void> {
    const startedAt = Date.now();
    const policy = await deps.store.get(project);
    if (!policy?.enabled) return;

    const currentSpendUsd = await currentSpend(project);
    const spend = Number(currentSpendUsd);
    const cap = Number(policy.capUsd);
    const warningThreshold = cap * 0.75;

    if (spend < warningThreshold && policy.warningActive) {
      await deps.store.clearWarningCrossing(project, deps.now().toISOString());
    } else if (spend >= warningThreshold && !policy.warningActive) {
      const recipientUserIds = await deps.listAdminUserIds(project);
      const crossed = await deps.store.setWarningCrossing({
        project,
        crossedAt: deps.now().toISOString(),
        recipientUserIds,
      });
      if (crossed) {
        await notifyCrossing(recipientUserIds, {
          kind: 'warning',
          project,
          capUsd: policy.capUsd,
          currentSpendUsd,
          generation: crossed.warningGeneration,
        });
        trackEvent('playbook_spend.warning_sent', { project });
      }
    }

    const durationMs = Date.now() - startedAt;
    if (spend >= cap) {
      trackEvent(
        'playbook_spend.admission_blocked',
        { project, requiredPermission: REQUIRED_PERMISSION },
        { durationMs, currentSpendUsd: spend, capUsd: cap }
      );
      throw new PlaybookSpendCapExceededError(currentSpendUsd, policy.capUsd);
    }
    trackEvent(
      'playbook_spend.admission_checked',
      { project, outcome: 'admitted' },
      { durationMs }
    );
  }

  async function getPolicy(
    project: string
  ): Promise<PlaybookSpendPolicyView | null> {
    const policy = await deps.store.get(project);
    if (!policy) return null;
    const currentSpendUsd = await currentSpend(project);
    const cap = Number(policy.capUsd);
    return {
      ...policy,
      currentSpendUsd,
      warningThresholdUsd: usd(cap * 0.75),
      startsBlocked: policy.enabled && Number(currentSpendUsd) >= cap,
    };
  }

  async function updatePolicy(
    input: UpdatePlaybookSpendPolicyRequest & { actorUserId: string }
  ): Promise<PlaybookSpendPolicyView> {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 500) {
      throw new PlaybookSpendPolicyValidationError(
        'Reason must be between 10 and 500 characters.'
      );
    }

    const existing = await deps.store.get(input.project);
    const currentSpendUsd = await currentSpend(input.project);
    const now = deps.now().toISOString();

    if (!existing) {
      if (input.enabled !== true || input.capUsd !== undefined) {
        throw new PlaybookSpendPolicyValidationError(
          'A spend policy must first be enabled with its calculated initial cap.'
        );
      }
      const capUsd = await resolveInitialCap(currentSpendUsd);
      const created = await deps.store.create({
        project: input.project,
        enabled: true,
        baselineCostUsd: currentSpendUsd,
        capUsd,
        warningActive: false,
        warningGeneration: 0,
        warningCrossedAt: null,
        warningRecipientUserIds: [],
        overrideByUserId: null,
        overrideToUsd: null,
        overrideAt: null,
        overrideReason: null,
      });
      return {
        ...created,
        currentSpendUsd,
        warningThresholdUsd: usd(Number(capUsd) * 0.75),
        startsBlocked: Number(currentSpendUsd) >= Number(capUsd),
      };
    }

    const changes: PolicyChanges = { updatedAt: now };
    if (input.enabled !== undefined) changes.enabled = input.enabled;
    const priorRecipients = existing.warningRecipientUserIds;
    if (input.capUsd !== undefined) {
      const capUsd = usd(input.capUsd);
      if (
        Number(capUsd) <= Number(currentSpendUsd) ||
        Number(capUsd) <= Number(existing.capUsd)
      ) {
        throw new PlaybookSpendPolicyValidationError(
          'The new cap must be greater than both the current cap and trailing 30-day spend.'
        );
      }
      Object.assign(changes, {
        capUsd,
        overrideByUserId: input.actorUserId,
        overrideToUsd: capUsd,
        overrideAt: now,
        overrideReason: reason,
      });
      if (Number(currentSpendUsd) < Number(capUsd) * 0.75) {
        Object.assign(changes, {
          warningActive: false,
          warningCrossedAt: null,
          warningRecipientUserIds: [],
        });
      }
    }

    const updated = await deps.store.update(input.project, changes);
    if (input.capUsd !== undefined) {
      await notifyCrossing(priorRecipients, {
        kind: 'override',
        project: input.project,
        capUsd: updated.capUsd,
        currentSpendUsd,
        generation: existing.warningGeneration,
      });
      trackEvent('playbook_spend.override_saved', { project: input.project });
    }
    return {
      ...updated,
      currentSpendUsd,
      warningThresholdUsd: usd(Number(updated.capUsd) * 0.75),
      startsBlocked:
        updated.enabled && Number(currentSpendUsd) >= Number(updated.capUsd),
    };
  }

  return { assertAdmission, getPolicy, updatePolicy };
}

function rowToPolicy(
  row: typeof playbookSpendPolicies.$inferSelect
): PlaybookSpendPolicy {
  return {
    ...row,
    warningRecipientUserIds: row.warningRecipientUserIds ?? [],
  };
}

export const postgresPlaybookSpendPolicyStore: PlaybookSpendPolicyStore = {
  async get(project) {
    const row = await db.query.playbookSpendPolicies.findFirst({
      where: eq(playbookSpendPolicies.project, project),
    });
    return row ? rowToPolicy(row) : null;
  },
  async create(policy) {
    const [row] = await db
      .insert(playbookSpendPolicies)
      .values(policy)
      .returning();
    return rowToPolicy(row);
  },
  async setWarningCrossing(input) {
    const [row] = await db
      .update(playbookSpendPolicies)
      .set({
        warningActive: true,
        warningCrossedAt: input.crossedAt,
        warningRecipientUserIds: input.recipientUserIds,
        warningGeneration: sql`${playbookSpendPolicies.warningGeneration} + 1`,
        updatedAt: input.crossedAt,
      })
      .where(
        and(
          eq(playbookSpendPolicies.project, input.project),
          eq(playbookSpendPolicies.warningActive, false)
        )
      )
      .returning();
    return row ? rowToPolicy(row) : null;
  },
  async clearWarningCrossing(project, updatedAt) {
    await db
      .update(playbookSpendPolicies)
      .set({
        warningActive: false,
        warningCrossedAt: null,
        warningRecipientUserIds: [],
        updatedAt,
      })
      .where(
        and(
          eq(playbookSpendPolicies.project, project),
          eq(playbookSpendPolicies.warningActive, true)
        )
      );
  },
  async update(project, changes) {
    const [row] = await db
      .update(playbookSpendPolicies)
      .set(changes)
      .where(eq(playbookSpendPolicies.project, project))
      .returning();
    return rowToPolicy(row);
  },
  getDefaultNoHistoryCapUsd: () =>
    getAppSetting(DEFAULT_NO_HISTORY_CAP_SETTING),
};

async function listAdminUserIds(project: string): Promise<string[]> {
  const users = await listUsersForProject(project);
  const permissionSets = await Promise.all(
    users.map((user) => getUserPermissions(user.oid, project))
  );
  return users
    .filter((_user, index) => permissionSets[index].has(REQUIRED_PERMISSION))
    .map((user) => user.oid);
}

async function notify(
  userId: string,
  notification: SpendNotification
): Promise<void> {
  const isWarning = notification.kind === 'warning';
  await createNotification(
    userId,
    {
      type: 'system',
      title: isWarning ? 'Playbook spend warning' : 'Playbook spend cap raised',
      body: isWarning
        ? `${notification.project} reached 75% of its $${notification.capUsd} Playbook spend cap.`
        : `${notification.project}'s Playbook spend cap was raised to $${notification.capUsd}.`,
      link: '/admin/project-settings',
    },
    {
      dedupeKey:
        `playbook-spend:${notification.kind}:${notification.project}:` +
        `${notification.generation}:${userId}`,
    }
  );
}

export const playbookSpendPolicyService = createPlaybookSpendPolicyService({
  store: postgresPlaybookSpendPolicyStore,
  getSummary,
  listAdminUserIds,
  notify,
  now: () => new Date(),
});
