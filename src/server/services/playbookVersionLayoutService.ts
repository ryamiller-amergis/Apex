import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  playbookDefinitionVersions,
  playbookVersionLayouts,
} from '../db/schema';
import {
  PlaybookVersionImmutableError,
  PlaybookVersionNotFoundError,
  assertContentMutable,
} from './playbookDefinitionService';
import type {
  PlaybookGraph,
  PlaybookLayoutPositions,
  PlaybookVersionLayout,
} from '../../shared/types/playbook';

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

function sanitizePositions(
  positions: PlaybookLayoutPositions,
  allowedNodeIds?: Set<string>
): PlaybookLayoutPositions {
  const sanitized: PlaybookLayoutPositions = {};
  for (const [nodeId, point] of Object.entries(positions)) {
    if (allowedNodeIds && !allowedNodeIds.has(nodeId)) continue;
    if (!point || typeof point !== 'object') continue;
    const x = (point as { x?: unknown }).x;
    const y = (point as { y?: unknown }).y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    sanitized[nodeId] = { x, y };
  }
  return sanitized;
}

async function expectVersionInProject(
  project: string,
  definitionId: string,
  versionId: string
): Promise<{ versionId: string; status: typeof playbookDefinitionVersions.$inferSelect.status }> {
  const row = await db.query.playbookDefinitionVersions.findFirst({
    where: eq(playbookDefinitionVersions.id, versionId),
    columns: { id: true, status: true, definitionId: true },
    with: {
      definition: {
        columns: { id: true, project: true },
      },
    },
  });
  if (
    !row?.definition ||
    row.definition.id !== definitionId ||
    row.definition.project !== project
  ) {
    throw new PlaybookVersionNotFoundError(versionId);
  }
  return { versionId: row.id, status: row.status };
}

export async function getVersionLayout(
  project: string,
  definitionId: string,
  versionId: string
): Promise<PlaybookVersionLayout> {
  await expectVersionInProject(project, definitionId, versionId);

  const row = await db.query.playbookVersionLayouts.findFirst({
    where: eq(playbookVersionLayouts.versionId, versionId),
  });
  if (!row) {
    return { versionId, positions: {}, updatedAt: new Date(0).toISOString() };
  }
  return {
    versionId: row.versionId,
    positions: row.positions ?? {},
    updatedAt: row.updatedAt,
  };
}

export async function replaceDraftVersionLayout(input: {
  project: string;
  definitionId: string;
  versionId: string;
  positions: PlaybookLayoutPositions;
}): Promise<PlaybookVersionLayout> {
  const version = await expectVersionInProject(
    input.project,
    input.definitionId,
    input.versionId
  );
  assertContentMutable(version.versionId, version.status);

  const now = new Date().toISOString();
  const positions = sanitizePositions(input.positions);

  const existing = await db.query.playbookVersionLayouts.findFirst({
    where: eq(playbookVersionLayouts.versionId, input.versionId),
  });

  if (existing) {
    const [updated] = await db
      .update(playbookVersionLayouts)
      .set({ positions, updatedAt: now })
      .where(eq(playbookVersionLayouts.versionId, input.versionId))
      .returning();
    return {
      versionId: updated.versionId,
      positions: updated.positions ?? {},
      updatedAt: updated.updatedAt,
    };
  }

  const [inserted] = await db
    .insert(playbookVersionLayouts)
    .values({
      versionId: input.versionId,
      positions,
      updatedAt: now,
    })
    .returning();

  return {
    versionId: inserted.versionId,
    positions: inserted.positions ?? {},
    updatedAt: inserted.updatedAt,
  };
}

/** Copies layout from the draft version onto a newly published version in the same transaction. */
export async function copyLayoutToPublishedVersion(
  tx: TransactionClient,
  input: {
    fromVersionId: string;
    toVersionId: string;
    graph: PlaybookGraph;
  }
): Promise<void> {
  const allowed = new Set(input.graph.nodes.map((node) => node.id));
  const source = await tx.query.playbookVersionLayouts.findFirst({
    where: eq(playbookVersionLayouts.versionId, input.fromVersionId),
  });
  const positions = sanitizePositions(source?.positions ?? {}, allowed);
  const now = new Date().toISOString();

  await tx.insert(playbookVersionLayouts).values({
    versionId: input.toVersionId,
    positions,
    updatedAt: now,
  });
}

export async function assertLayoutMutable(versionId: string): Promise<void> {
  const version = await db.query.playbookDefinitionVersions.findFirst({
    where: eq(playbookDefinitionVersions.id, versionId),
    columns: { id: true, status: true },
  });
  if (!version) throw new PlaybookVersionNotFoundError(versionId);
  if (version.status !== 'draft') {
    throw new PlaybookVersionImmutableError(versionId, version.status);
  }
}
