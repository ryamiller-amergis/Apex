import { db } from '../db/drizzle';
import { deploymentOutcomes } from '../db/schema';
import { eq, desc, and, sql, inArray } from 'drizzle-orm';
import type {
  DeploymentOutcome,
  CreateOutcomeInput,
  UpdateOutcomeInput,
  OutcomeFilters,
  OutcomeSummary,
} from '../../shared/types/deploymentOutcome';

// ── recordOutcome ─────────────────────────────────────────────────────────────

export async function recordOutcome(
  data: CreateOutcomeInput,
  reportedBy: string,
): Promise<DeploymentOutcome> {
  const [row] = await db
    .insert(deploymentOutcomes)
    .values({
      deploymentId: data.deploymentId,
      releaseVersion: data.releaseVersion,
      result: data.result,
      downtimeMinutes: data.downtimeMinutes ?? null,
      details: data.details ?? null,
      reportedBy,
      deployedAt: data.deployedAt ?? null,
    })
    .returning();

  return mapRow(row);
}

// ── getOutcomeById ────────────────────────────────────────────────────────────

export async function getOutcomeById(id: string): Promise<DeploymentOutcome | null> {
  const rows = await db
    .select()
    .from(deploymentOutcomes)
    .where(eq(deploymentOutcomes.id, id))
    .limit(1);

  return rows.length > 0 ? mapRow(rows[0]) : null;
}

// ── updateOutcome ─────────────────────────────────────────────────────────────

export async function updateOutcome(
  id: string,
  data: UpdateOutcomeInput,
): Promise<DeploymentOutcome | null> {
    const [row] = await db
    .update(deploymentOutcomes)
    .set({
      result: data.result,
      downtimeMinutes: data.downtimeMinutes ?? null,
      details: data.details ?? null,
      ...(data.deployedAt !== undefined ? { deployedAt: data.deployedAt } : {}),
    })
    .where(eq(deploymentOutcomes.id, id))
    .returning();

  return row ? mapRow(row) : null;
}

// ── deleteOutcome ─────────────────────────────────────────────────────────────

export async function deleteOutcome(id: string): Promise<boolean> {
  const deleted = await db
    .delete(deploymentOutcomes)
    .where(eq(deploymentOutcomes.id, id))
    .returning({ id: deploymentOutcomes.id });

  return deleted.length > 0;
}

// ── getOutcomeByDeployment ────────────────────────────────────────────────────

export async function getOutcomeByDeployment(
  deploymentId: string,
): Promise<DeploymentOutcome | null> {
  const rows = await db
    .select()
    .from(deploymentOutcomes)
    .where(eq(deploymentOutcomes.deploymentId, deploymentId))
    .limit(1);

  return rows.length > 0 ? mapRow(rows[0]) : null;
}

// ── getOutcomesByRelease ──────────────────────────────────────────────────────

export async function getOutcomesByRelease(
  releaseVersion: string,
): Promise<DeploymentOutcome[]> {
  const rows = await db
    .select()
    .from(deploymentOutcomes)
    .where(eq(deploymentOutcomes.releaseVersion, releaseVersion))
    .orderBy(desc(deploymentOutcomes.reportedAt));

  return rows.map(mapRow);
}

// ── getAllOutcomes ─────────────────────────────────────────────────────────────

export async function getAllOutcomes(
  filters?: OutcomeFilters,
): Promise<DeploymentOutcome[]> {
  const conditions = buildFilterConditions(filters);

  const rows = conditions.length > 0
    ? await db.select().from(deploymentOutcomes).where(and(...conditions)).orderBy(desc(deploymentOutcomes.reportedAt))
    : await db.select().from(deploymentOutcomes).orderBy(desc(deploymentOutcomes.reportedAt));

  return rows.map(mapRow);
}

// ── getOutcomeSummary ─────────────────────────────────────────────────────────

export async function getOutcomeSummary(
  filters?: OutcomeFilters,
): Promise<OutcomeSummary> {
  const outcomes = await getAllOutcomes(filters);

  const total = outcomes.length;
  const success = outcomes.filter((o) => o.result === 'success').length;
  const downtime = outcomes.filter((o) => o.result === 'downtime').length;
  const rollback = outcomes.filter((o) => o.result === 'rollback').length;

  const downtimeOutcomes = outcomes.filter((o) => o.result === 'downtime' && o.downtimeMinutes != null);
  const avgDowntimeMinutes =
    downtimeOutcomes.length > 0
      ? Math.round(downtimeOutcomes.reduce((sum, o) => sum + (o.downtimeMinutes ?? 0), 0) / downtimeOutcomes.length)
      : 0;

  const monthMap = new Map<string, { success: number; downtime: number; rollback: number }>();
  for (const o of outcomes) {
    // Group by deployedAt (when the release actually shipped) and fall back to reportedAt
    const month = (o.deployedAt ?? o.reportedAt).slice(0, 7); // 'YYYY-MM'
    if (!monthMap.has(month)) {
      monthMap.set(month, { success: 0, downtime: 0, rollback: 0 });
    }
    const entry = monthMap.get(month)!;
    if (o.result === 'success') entry.success++;
    else if (o.result === 'downtime') entry.downtime++;
    else if (o.result === 'rollback') entry.rollback++;
  }

  const byMonth = Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, counts]) => ({ month, ...counts }));

  return { total, success, downtime, rollback, avgDowntimeMinutes, byMonth };
}

// ── getDistinctReleaseVersions ────────────────────────────────────────────────

export async function getDistinctReleaseVersions(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ releaseVersion: deploymentOutcomes.releaseVersion })
    .from(deploymentOutcomes)
    .orderBy(desc(deploymentOutcomes.releaseVersion));
  return rows.map((r) => r.releaseVersion);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFilterConditions(filters?: OutcomeFilters) {
  const conditions = [];
  if (filters?.releaseVersions && filters.releaseVersions.length > 0) {
    conditions.push(inArray(deploymentOutcomes.releaseVersion, filters.releaseVersions));
  } else if (filters?.releaseVersion) {
    conditions.push(eq(deploymentOutcomes.releaseVersion, filters.releaseVersion));
  }
  if (filters?.startDate) {
    // Filter on deployedAt when set, otherwise fall back to reportedAt
    conditions.push(
      sql`COALESCE(${deploymentOutcomes.deployedAt}, ${deploymentOutcomes.reportedAt}) >= ${filters.startDate}`,
    );
  }
  if (filters?.endDate) {
    conditions.push(
      sql`COALESCE(${deploymentOutcomes.deployedAt}, ${deploymentOutcomes.reportedAt}) <= ${filters.endDate}`,
    );
  }
  if (filters?.result) {
    conditions.push(eq(deploymentOutcomes.result, filters.result));
  }
  return conditions;
}

type OutcomeRow = typeof deploymentOutcomes.$inferSelect;

function mapRow(row: OutcomeRow): DeploymentOutcome {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    releaseVersion: row.releaseVersion,
    environment: row.environment,
    result: row.result as DeploymentOutcome['result'],
    downtimeMinutes: row.downtimeMinutes ?? undefined,
    details: row.details ?? undefined,
    reportedBy: row.reportedBy,
    reportedAt: row.reportedAt,
    deployedAt: row.deployedAt ?? undefined,
  };
}
