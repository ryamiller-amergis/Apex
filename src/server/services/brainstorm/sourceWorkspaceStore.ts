import fsSync from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { BrainstormSourceKind, BrainstormSourceState } from '../../../shared/types/brainstormSources';
import { db } from '../../db/drizzle';
import { brainstormMessages, brainstormSessions, brainstormSources } from '../../db/schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SourceRecord {
  id: string;
  sessionId: string;
  project: string;
  kind: BrainstormSourceKind;
  displayName: string;
  cloneUrl: string | null;
  requestedRevision: string | null;
  commitSha: string | null;
  state: BrainstormSourceState;
  refId: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  sizeBytes: number | null;
  mcpReadOnlyToolCount: number | null;
  groundingProvider: 'github' | 'ado' | null;
  groundingProject: string | null;
  groundingRepository: string | null;
  updatedAt: string;
  workspaceRemovedAt: string | null;
  workspacePath?: string | null;
}

export interface NewSource {
  sessionId: string;
  project: string;
  kind: BrainstormSourceKind;
  displayName: string;
  cloneUrl?: string | null;
  requestedRevision?: string | null;
  refId?: string | null;
  state?: BrainstormSourceState;
  mcpReadOnlyToolCount?: number | null;
}

export interface SourcePatch {
  state?: BrainstormSourceState;
  commitSha?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  sizeBytes?: number | null;
  groundingProvider?: 'github' | 'ado' | null;
  groundingProject?: string | null;
  groundingRepository?: string | null;
  workspaceRemovedAt?: string | null;
  displayName?: string;
}

export interface EndedSessionResult {
  id: string;
  state: 'ended';
  endedAt: string;
  alreadyEnded: boolean;
}

export interface SweepCandidate {
  sessionId: string;
  project: string;
  lastActivityAt: string;
}

export interface SourceWorkspaceStore {
  listSession(sessionId: string, project: string): Promise<SourceRecord[]>;
  findById(id: string, sessionId: string, project: string): Promise<SourceRecord | null>;
  findDuplicate(sessionId: string, kind: BrainstormSourceKind, refId: string | null, cloneUrl: string | null, revision: string | null): Promise<SourceRecord | null>;
  /** Holds the project clone lock, counts preparing and restoring rows, and inserts only under the limit. */
  insertIfSlot(limit: number, row: NewSource): Promise<{ ok: true; row: SourceRecord } | { ok: false; cloning: number }>;
  insert(row: NewSource): Promise<SourceRecord>;
  compareAndSet(id: string, from: BrainstormSourceState[], patch: SourcePatch): Promise<SourceRecord | null>;
  touchActivity(sessionId: string, atIso: string): Promise<void>;
  hasActiveRun(sessionId: string): Promise<boolean>;
  sessionState(sessionId: string): Promise<{ state: string; version: number; lastActivityAt: string } | null>;
  markEnded(sessionId: string, project: string, expectedVersion: number, atIso: string): Promise<EndedSessionResult | { conflict: true; state: string; endedAt: string | null }>;
  listInactive(cutoffIso: string): Promise<SweepCandidate[]>;
  listStale(olderThanIso: string): Promise<SourceRecord[]>;
}

export function sourceWorkspaceRoot(dataRoot: string): string {
  return path.join(dataRoot, 'workspaces', 'brainstorm-workspaces');
}

export function sourceWorkspacePath(dataRoot: string, sessionId: string, sourceId: string): string {
  if (!UUID.test(sessionId) || !UUID.test(sourceId)) {
    throw new Error('Workspace ids must be UUIDs');
  }
  const shared = path.join(sourceWorkspaceRoot(dataRoot), sessionId, sourceId);
  const legacy = path.join(dataRoot, 'brainstorm-workspaces', sessionId, sourceId);
  if (!fsSync.existsSync(shared) && fsSync.existsSync(legacy)) {
    return legacy;
  }
  return shared;
}

function fromRow(row: typeof brainstormSources.$inferSelect, mcpReadOnlyToolCount: number | null = row.mcpReadOnlyToolCount): SourceRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    project: row.project,
    kind: row.kind,
    displayName: row.displayName,
    cloneUrl: row.cloneUrl,
    requestedRevision: row.requestedRevision,
    commitSha: row.resolvedSha,
    state: row.workspaceState,
    refId: row.refId,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    sizeBytes: row.sizeBytes,
    mcpReadOnlyToolCount,
    groundingProvider: row.groundingProvider,
    groundingProject: row.groundingProject,
    groundingRepository: row.groundingRepository,
    updatedAt: row.updatedAt,
    workspaceRemovedAt: row.workspaceRemovedAt,
  };
}

export function createDrizzleSourceStore(): SourceWorkspaceStore {
  return {
    async listSession(sessionId, project) {
      const rows = await db.select().from(brainstormSources).where(and(
        eq(brainstormSources.sessionId, sessionId),
        eq(brainstormSources.project, project),
      ));
      return rows.filter((row) => row.workspaceState !== 'removed').map((row) => fromRow(row));
    },

    async findById(id, sessionId, project) {
      const rows = await db.select().from(brainstormSources).where(and(
        eq(brainstormSources.id, id),
        eq(brainstormSources.sessionId, sessionId),
        eq(brainstormSources.project, project),
      )).limit(1);
      return rows[0] ? fromRow(rows[0]) : null;
    },

    async findDuplicate(sessionId, kind, refId, cloneUrl, revision) {
      const rows = await db.select().from(brainstormSources).where(and(
        eq(brainstormSources.sessionId, sessionId),
        eq(brainstormSources.kind, kind),
      ));
      const match = rows.find((row) => {
        if (row.workspaceState === 'removed') return false;
        if (kind === 'temporary-repository') {
          return row.cloneUrl === cloneUrl && row.requestedRevision === revision;
        }
        return row.refId === refId;
      });
      return match ? fromRow(match) : null;
    },

    async insertIfSlot(limit, row) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`brainstorm-clone:${row.project}`}))`);
        const cloning = await tx.select({ id: brainstormSources.id }).from(brainstormSources).where(and(
          eq(brainstormSources.project, row.project),
          inArray(brainstormSources.workspaceState, ['preparing', 'restoring']),
        ));
        if (cloning.length >= limit) return { ok: false as const, cloning: cloning.length };
        const inserted = await tx.insert(brainstormSources).values({
          sessionId: row.sessionId,
          project: row.project,
          kind: row.kind,
          displayName: row.displayName,
          cloneUrl: row.cloneUrl ?? null,
          requestedRevision: row.requestedRevision ?? null,
          refId: row.refId ?? null,
          workspaceState: row.state ?? 'preparing',
          mcpReadOnlyToolCount: row.mcpReadOnlyToolCount ?? null,
        }).returning();
        return { ok: true as const, row: fromRow(inserted[0], row.mcpReadOnlyToolCount ?? null) };
      });
    },

    async insert(row) {
      const inserted = await db.insert(brainstormSources).values({
        sessionId: row.sessionId,
        project: row.project,
        kind: row.kind,
        displayName: row.displayName,
        cloneUrl: row.cloneUrl ?? null,
        requestedRevision: row.requestedRevision ?? null,
        refId: row.refId ?? null,
        workspaceState: row.state ?? 'ready',
        mcpReadOnlyToolCount: row.mcpReadOnlyToolCount ?? null,
      }).returning();
      return fromRow(inserted[0], row.mcpReadOnlyToolCount ?? null);
    },

    async compareAndSet(id, from, patch) {
      const updated = await db.update(brainstormSources).set({
        ...(patch.state ? { workspaceState: patch.state } : {}),
        ...(patch.commitSha !== undefined ? { resolvedSha: patch.commitSha } : {}),
        ...(patch.reasonCode !== undefined ? { reasonCode: patch.reasonCode } : {}),
        ...(patch.reasonText !== undefined ? { reasonText: patch.reasonText } : {}),
        ...(patch.sizeBytes !== undefined ? { sizeBytes: patch.sizeBytes } : {}),
        ...(patch.groundingProvider !== undefined ? { groundingProvider: patch.groundingProvider } : {}),
        ...(patch.groundingProject !== undefined ? { groundingProject: patch.groundingProject } : {}),
        ...(patch.groundingRepository !== undefined ? { groundingRepository: patch.groundingRepository } : {}),
        ...(patch.workspaceRemovedAt !== undefined ? { workspaceRemovedAt: patch.workspaceRemovedAt } : {}),
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        updatedAt: new Date().toISOString(),
      }).where(and(
        eq(brainstormSources.id, id),
        inArray(brainstormSources.workspaceState, from),
      )).returning();
      return updated[0] ? fromRow(updated[0]) : null;
    },

    async touchActivity(sessionId, atIso) {
      await db.update(brainstormSessions).set({
        lastActivityAt: atIso,
        updatedAt: atIso,
      }).where(eq(brainstormSessions.id, sessionId));
    },

    async hasActiveRun(sessionId) {
      const rows = await db.select({ id: brainstormMessages.id }).from(brainstormMessages).where(and(
        eq(brainstormMessages.sessionId, sessionId),
        eq(brainstormMessages.status, 'streaming'),
      )).limit(1);
      return rows.length > 0;
    },

    async sessionState(sessionId) {
      const rows = await db.select({
        state: brainstormSessions.state,
        version: brainstormSessions.version,
        lastActivityAt: brainstormSessions.lastActivityAt,
      }).from(brainstormSessions).where(eq(brainstormSessions.id, sessionId)).limit(1);
      return rows[0] ?? null;
    },

    async markEnded(sessionId, project, expectedVersion, atIso) {
      const updated = await db.update(brainstormSessions).set({
        state: 'ended',
        endedAt: atIso,
        version: expectedVersion + 1,
        updatedAt: atIso,
        updatedBy: sql`${brainstormSessions.creatorId}`,
      }).where(and(
        eq(brainstormSessions.id, sessionId),
        eq(brainstormSessions.project, project),
        eq(brainstormSessions.version, expectedVersion),
        eq(brainstormSessions.state, 'active'),
      )).returning({ id: brainstormSessions.id, endedAt: brainstormSessions.endedAt });
      if (updated[0]?.endedAt) {
        return { id: updated[0].id, state: 'ended', endedAt: updated[0].endedAt, alreadyEnded: false };
      }
      const current = await db.select({
        state: brainstormSessions.state,
        endedAt: brainstormSessions.endedAt,
      }).from(brainstormSessions).where(and(
        eq(brainstormSessions.id, sessionId),
        eq(brainstormSessions.project, project),
      )).limit(1);
      return { conflict: true, state: current[0]?.state ?? 'ended', endedAt: current[0]?.endedAt ?? null };
    },

    async listInactive(cutoffIso) {
      const rows = await db.select({
        sessionId: brainstormSessions.id,
        project: brainstormSessions.project,
        lastActivityAt: brainstormSessions.lastActivityAt,
      }).from(brainstormSessions).innerJoin(
        brainstormSources,
        eq(brainstormSources.sessionId, brainstormSessions.id),
      ).where(and(
        eq(brainstormSessions.state, 'active'),
        eq(brainstormSources.workspaceState, 'ready'),
        lte(brainstormSessions.lastActivityAt, cutoffIso),
      ));
      const seen = new Set<string>();
      return rows.filter((row) => {
        if (seen.has(row.sessionId)) return false;
        seen.add(row.sessionId);
        return true;
      });
    },

    async listStale(olderThanIso) {
      const rows = await db.select().from(brainstormSources).where(and(
        inArray(brainstormSources.workspaceState, ['preparing', 'restoring']),
        lte(brainstormSources.updatedAt, olderThanIso),
      ));
      return rows.map((row) => fromRow(row));
    },
  };
}
