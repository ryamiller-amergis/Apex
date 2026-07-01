import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  featureFlags,
  featureFlagRules,
  featureFlagAudit,
  appGroupMembers,
  appGroups,
} from '../db/schema';
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
} from '../../shared/types/featureFlags';

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

export async function evaluateFlags(ctx: {
  userId: string;
  project: string;
  groupIds: string[];
}): Promise<Record<string, boolean>> {
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

    let matched = false;
    for (const rule of flag.rules) {
      switch (rule.type) {
        case 'everyone':
          matched = true;
          break;
        case 'project':
          if (rule.value === ctx.project) matched = true;
          break;
        case 'user':
          if (rule.value === ctx.userId) matched = true;
          break;
        case 'group':
          if (rule.value && ctx.groupIds.includes(rule.value)) matched = true;
          break;
      }
      if (matched) break;
    }

    result[flag.key] = matched;
  }

  return result;
}

// ── isFeatureEnabled ─────────────────────────────────────────────────────────

export async function isFeatureEnabled(
  key: string,
  ctx: { userId: string; project: string },
): Promise<boolean> {
  const groupIds = await getUserGroupIdsForProject(ctx.userId, ctx.project);
  const result = await evaluateFlags({ ...ctx, groupIds });
  return result[key] ?? false;
}
