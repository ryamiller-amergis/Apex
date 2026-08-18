import fs from 'fs/promises';
import path from 'path';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { apexDeployments } from '../db/schema';
import type {
  ApexDeployment,
  ApexDeploymentEnvironment,
  RecordApexDeploymentDTO,
} from '../../shared/types/apexWorkItem';

const DEPLOYMENTS_JSON = path.join(process.cwd(), 'public', 'deployments.json');

const ENVIRONMENTS: ApexDeploymentEnvironment[] = ['dev', 'staging', 'prod'];

function httpError(msg: string, status = 400): Error {
  const e = new Error(msg);
  (e as Error & { status?: number }).status = status;
  return e;
}

function requireProject(project: string | undefined): string {
  if (!project?.trim()) throw httpError('project is required', 400);
  return project.trim();
}

function normalizeEnvironment(raw: string): ApexDeploymentEnvironment {
  const v = raw.trim().toLowerCase();
  if (v === 'production') return 'prod';
  if (ENVIRONMENTS.includes(v as ApexDeploymentEnvironment)) {
    return v as ApexDeploymentEnvironment;
  }
  throw httpError(`environment must be one of: ${ENVIRONMENTS.join(', ')}`);
}

function toDeployment(row: typeof apexDeployments.$inferSelect): ApexDeployment {
  return {
    id: row.id,
    project: row.project,
    releaseId: row.releaseId,
    environment: row.environment as ApexDeploymentEnvironment,
    version: row.version,
    deployedAt: row.deployedAt,
    deployedBy: row.deployedBy,
    notes: row.notes,
    workItemIds: Array.isArray(row.workItemIds) ? row.workItemIds : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listDeployments(
  project: string,
  env?: string,
): Promise<ApexDeployment[]> {
  const p = requireProject(project);
  const conditions = [eq(apexDeployments.project, p)];
  if (env) {
    conditions.push(eq(apexDeployments.environment, normalizeEnvironment(env)));
  }
  const rows = await db
    .select()
    .from(apexDeployments)
    .where(and(...conditions))
    .orderBy(desc(apexDeployments.deployedAt));
  return rows.map(toDeployment);
}

export async function recordDeployment(
  actorId: string,
  project: string,
  dto: RecordApexDeploymentDTO,
): Promise<ApexDeployment> {
  const p = requireProject(project);
  if (!dto.version?.trim()) throw httpError('version is required');
  const environment = normalizeEnvironment(dto.environment);
  const now = new Date().toISOString();

  const [row] = await db
    .insert(apexDeployments)
    .values({
      project: p,
      releaseId: dto.releaseId ?? null,
      environment,
      version: dto.version.trim(),
      deployedAt: dto.deployedAt ?? now,
      deployedBy: actorId || null,
      notes: dto.notes?.trim() || null,
      workItemIds: dto.workItemIds ?? [],
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return toDeployment(row);
}

/**
 * One-time seed: if the project has no PG deployments, import from
 * public/deployments.json (legacy JSON tracker). Defaults project to Apex.
 */
export async function seedDeploymentsFromJsonIfEmpty(
  project = 'Apex',
): Promise<{ seeded: number; skipped: boolean }> {
  const p = requireProject(project);
  const existing = await db
    .select({ id: apexDeployments.id })
    .from(apexDeployments)
    .where(eq(apexDeployments.project, p))
    .limit(1);

  if (existing.length > 0) {
    return { seeded: 0, skipped: true };
  }

  let raw: string;
  try {
    raw = await fs.readFile(DEPLOYMENTS_JSON, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { seeded: 0, skipped: true };
    throw err;
  }

  let parsed: { deployments?: Array<{
    releaseVersion?: string;
    environment?: string;
    workItemIds?: unknown[];
    deployedBy?: string;
    deployedAt?: string;
    notes?: string;
  }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { seeded: 0, skipped: true };
  }

  const items = Array.isArray(parsed.deployments) ? parsed.deployments : [];
  if (items.length === 0) return { seeded: 0, skipped: true };

  let seeded = 0;
  for (const d of items) {
    if (!d.releaseVersion || !d.environment) continue;
    try {
      await recordDeployment(d.deployedBy ?? 'system', p, {
        environment: normalizeEnvironment(d.environment),
        version: d.releaseVersion,
        notes: d.notes ?? null,
        workItemIds: [],
        deployedAt: d.deployedAt,
      });
      seeded += 1;
    } catch (err) {
      console.warn('[apexDeploymentService] seed skip:', (err as Error).message);
    }
  }

  return { seeded, skipped: false };
}
