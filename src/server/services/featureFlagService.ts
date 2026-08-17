import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  featureFlags,
  featureFlagRules,
  featureFlagAudit,
  appGroupMembers,
  appGroups,
} from '../db/schema';
import { getAppEnvironment } from '../utils/superAdmin';
import type {
  FeatureFlag,
  FeatureFlagRule,
  FeatureFlagWithRules,
  FlagAuditEntry,
  FlagAuditAction,
  FlagAuditDetails,
  CreateFlagRequest,
  UpdateFlagRequest,
  AddRuleRequest,
  FlagEvaluationContext,
} from '../../shared/types/featureFlags';

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GROUNDING_FLAG = 'repo-grounding-workspace-profile';
const LIFECYCLE_BINDING_FLAG = 'repo-grounding-lifecycle-binding';
const REMOTE_SEARCH_CONVERGENCE_FLAG = 'repo-grounding-remote-search-convergence';
const NATIVE_READ_FLAG = 'native-read';
const SHARED_READ_CHECKOUT_FLAG = 'shared-readonly-grounding-checkout';
const PROJECT_REPOSITORY_CHECKOUT_READINESS_FLAG =
  'project-repository-checkout-readiness';

// ── listFlags ────────────────────────────────────────────────────────────────

export async function listFlags(): Promise<FeatureFlagWithRules[]> {
  return db.query.featureFlags.findMany({
    with: { rules: true },
    orderBy: desc(featureFlags.createdAt),
  });
}

// ── getFlag ──────────────────────────────────────────────────────────────────

export async function getFlag(id: string): Promise<FeatureFlagWithRules | null> {
  const row = await db.query.featureFlags.findFirst({
    where: eq(featureFlags.id, id),
    with: { rules: true },
  });
  return row ?? null;
}

// ── createFlag ───────────────────────────────────────────────────────────────

export async function createFlag(
  input: CreateFlagRequest,
  actor: { id: string; email: string },
): Promise<FeatureFlag> {
  if (!KEBAB_CASE_RE.test(input.key)) {
    throw new Error(`Invalid flag key "${input.key}": must be kebab-case (a-z, 0-9, hyphens)`);
  }

  return db.transaction(async (tx) => {
    const [flag] = await tx
      .insert(featureFlags)
      .values({
        key: input.key,
        description: input.description ?? null,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(featureFlagAudit).values({
      flagId: flag.id,
      flagKey: flag.key,
      action: 'created',
      actorId: actor.id,
      actorEmail: actor.email,
    });

    return flag;
  });
}

// ── updateFlag ───────────────────────────────────────────────────────────────

export async function updateFlag(
  id: string,
  patch: UpdateFlagRequest,
  actor: { id: string; email: string },
): Promise<FeatureFlag> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.featureFlags.findFirst({
      where: eq(featureFlags.id, id),
    });
    if (!existing) throw new Error(`Flag not found: ${id}`);

    const set: Partial<typeof featureFlags.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (patch.description !== undefined) set.description = patch.description ?? null;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.lifecycle !== undefined) set.lifecycle = patch.lifecycle;
    if (patch.cleanupReady !== undefined) set.cleanupReady = patch.cleanupReady;

    const [updated] = await tx
      .update(featureFlags)
      .set(set)
      .where(eq(featureFlags.id, id))
      .returning();

    let action: FlagAuditAction = 'updated';
    let details: FlagAuditDetails | undefined;

    if (patch.enabled !== undefined && patch.enabled !== existing.enabled) {
      action = patch.enabled ? 'enabled' : 'disabled';
    } else if (patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle) {
      action = 'lifecycle_changed';
      details = { previousValue: existing.lifecycle, newValue: patch.lifecycle };
    }

    await tx.insert(featureFlagAudit).values({
      flagId: id,
      flagKey: existing.key,
      action,
      actorId: actor.id,
      actorEmail: actor.email,
      details: details ?? null,
    });

    return updated;
  });
}

// ── addRule ──────────────────────────────────────────────────────────────────

export async function addRule(
  flagId: string,
  rule: AddRuleRequest,
  actor: { id: string; email: string },
): Promise<FeatureFlagRule> {
  return db.transaction(async (tx) => {
    const flag = await tx.query.featureFlags.findFirst({
      where: eq(featureFlags.id, flagId),
    });
    if (!flag) throw new Error(`Flag not found: ${flagId}`);

    const [inserted] = await tx
      .insert(featureFlagRules)
      .values({
        flagId,
        type: rule.type,
        value: rule.value ?? null,
        createdBy: actor.id,
      })
      .returning();

    await tx.insert(featureFlagAudit).values({
      flagId,
      flagKey: flag.key,
      action: 'rule_added',
      actorId: actor.id,
      actorEmail: actor.email,
      details: { ruleType: rule.type, ruleValue: rule.value ?? null },
    });

    return inserted;
  });
}

// ── removeRule ───────────────────────────────────────────────────────────────

export async function removeRule(
  ruleId: string,
  actor: { id: string; email: string },
): Promise<void> {
  const rule = await db.query.featureFlagRules.findFirst({
    where: eq(featureFlagRules.id, ruleId),
    with: { flag: true },
  });
  if (!rule) throw new Error(`Rule not found: ${ruleId}`);

  await db.transaction(async (tx) => {
    await tx.delete(featureFlagRules).where(eq(featureFlagRules.id, ruleId));

    await tx.insert(featureFlagAudit).values({
      flagId: rule.flagId,
      flagKey: rule.flag.key,
      action: 'rule_removed',
      actorId: actor.id,
      actorEmail: actor.email,
      details: { ruleType: rule.type, ruleValue: rule.value },
    });
  });
}

// ── deleteFlag ───────────────────────────────────────────────────────────────

export async function deleteFlag(
  id: string,
  actor: { id: string; email: string },
): Promise<void> {
  const flag = await db.query.featureFlags.findFirst({
    where: eq(featureFlags.id, id),
  });
  if (!flag) throw new Error(`Flag not found: ${id}`);

  await db.transaction(async (tx) => {
    await tx.delete(featureFlags).where(eq(featureFlags.id, id));

    await tx.insert(featureFlagAudit).values({
      flagId: null,
      flagKey: flag.key,
      action: 'deleted',
      actorId: actor.id,
      actorEmail: actor.email,
    });
  });
}

// ── getFlagAudit ─────────────────────────────────────────────────────────────

export async function getFlagAudit(flagId: string): Promise<FlagAuditEntry[]> {
  const rows = await db.query.featureFlagAudit.findMany({
    where: eq(featureFlagAudit.flagId, flagId),
    orderBy: desc(featureFlagAudit.createdAt),
  });
  return rows as FlagAuditEntry[];
}

// ── getUserGroupIdsForProject ────────────────────────────────────────────────

export async function getUserGroupIdsForProject(
  userId: string,
  project: string,
): Promise<string[]> {
  const rows = await db
    .select({ groupId: appGroupMembers.groupId })
    .from(appGroupMembers)
    .innerJoin(appGroups, eq(appGroupMembers.groupId, appGroups.id))
    .where(and(eq(appGroupMembers.userId, userId), eq(appGroups.project, project)));

  return rows.map((r) => r.groupId);
}

// ── evaluateFlags ────────────────────────────────────────────────────────────

export async function evaluateFlags(ctx: FlagEvaluationContext): Promise<Record<string, boolean>> {
  const flags = await db.query.featureFlags.findMany({
    where: ne(featureFlags.lifecycle, 'archived'),
    with: { rules: true },
  });

  const result: Record<string, boolean> = {};

  for (const flag of flags) {
    if (!flag.enabled) {
      result[flag.key] = false;
      continue;
    }

    const audienceRules = flag.rules.filter((rule) =>
      ['everyone', 'project', 'user', 'group'].includes(rule.type),
    );
    const callerRules = flag.rules.filter((rule) => rule.type === 'caller');
    const environmentRules = flag.rules.filter((rule) => rule.type === 'environment');

    const audienceMatches =
      audienceRules.length === 0 ||
      audienceRules.some((rule) => {
        switch (rule.type) {
          case 'everyone':
            return true;
          case 'project':
            return rule.value === ctx.project;
          case 'user':
            return rule.value === ctx.userId;
          case 'group':
            return Boolean(rule.value && ctx.groupIds.includes(rule.value));
          default:
            return false;
        }
      });
    const callerMatches =
      callerRules.length === 0 ||
      callerRules.some((rule) => rule.value === ctx.caller);
    const environmentMatches =
      environmentRules.length === 0 ||
      environmentRules.some((rule) => rule.value === ctx.environment);
    const knownRuleCount = audienceRules.length + callerRules.length + environmentRules.length;

    result[flag.key] =
      knownRuleCount > 0 &&
      audienceMatches &&
      callerMatches &&
      environmentMatches;
  }

  return result;
}

// ── isFeatureEnabled ─────────────────────────────────────────────────────────

export async function isFeatureEnabled(
  key: string,
  ctx: Omit<FlagEvaluationContext, 'groupIds'>,
): Promise<boolean> {
  const groupIds = await getUserGroupIdsForProject(ctx.userId, ctx.project);
  const result = await evaluateFlags({ ...ctx, groupIds });
  return result[key] ?? false;
}

export async function isFeatureOperational(key: string): Promise<boolean> {
  const flag = await db.query.featureFlags.findFirst({
    where: eq(featureFlags.key, key),
    columns: { enabled: true, lifecycle: true },
  });
  return Boolean(flag?.enabled && flag.lifecycle !== 'archived');
}

export interface GroundingFlagContext {
  userId: string;
  project: string;
  caller: string;
}

export type FlagEvaluationErrorHandler = () => void;

async function evaluateGroundingFlag(
  key: string,
  ctx: GroundingFlagContext,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  try {
    return await isFeatureEnabled(key, {
      ...ctx,
      environment: getAppEnvironment(),
    });
  } catch {
    onEvaluationError?.();
    return false;
  }
}

export async function isGroundingEnabledForCaller(
  ctx: GroundingFlagContext,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  return evaluateGroundingFlag(GROUNDING_FLAG, ctx, onEvaluationError);
}

export async function isLifecycleBindingEnabledForCaller(
  ctx: GroundingFlagContext,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  return evaluateGroundingFlag(
    LIFECYCLE_BINDING_FLAG,
    ctx,
    onEvaluationError,
  );
}

export async function isRemoteSearchConvergenceEnabled(
  ctx: GroundingFlagContext,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  return evaluateGroundingFlag(REMOTE_SEARCH_CONVERGENCE_FLAG, ctx, onEvaluationError);
}

export async function isNativeReadEnabledForCaller(
  ctx: GroundingFlagContext,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  return evaluateGroundingFlag(NATIVE_READ_FLAG, ctx, onEvaluationError);
}

export async function isSharedReadCheckoutEnabledForCaller(
  ctx: GroundingFlagContext,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  return evaluateGroundingFlag(SHARED_READ_CHECKOUT_FLAG, ctx, onEvaluationError);
}

export async function isProjectRepositoryCheckoutReadinessEnabled(
  ctx: GroundingFlagContext,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  return evaluateGroundingFlag(
    PROJECT_REPOSITORY_CHECKOUT_READINESS_FLAG,
    ctx,
    onEvaluationError,
  );
}

/**
 * Project-scoped checkout-readiness probe for maintenance / settings paths that
 * lack a real end-user caller. Uses a synthetic userId; audience matching is
 * driven by project (and optional environment) rules.
 */
export async function isProjectRepositoryCheckoutReadinessEnabledForProject(
  project: string,
  onEvaluationError?: FlagEvaluationErrorHandler,
): Promise<boolean> {
  return isProjectRepositoryCheckoutReadinessEnabled(
    {
      userId: 'system',
      project,
      caller: 'project-repository-checkout-readiness',
    },
    onEvaluationError,
  );
}
