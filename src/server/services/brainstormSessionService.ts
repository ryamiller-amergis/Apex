import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, brainstormSessions } from '../db/schema';
import {
  BRAINSTORM_TITLE_MAX_LENGTH,
  type BrainstormSessionDetail,
  type BrainstormSessionSummary,
} from '../../shared/types/brainstorm';
import type { BrainstormErrorCode } from '../../shared/types/brainstorm';
import {
  canDeleteBrainstormSession,
  canMutateBrainstormSession,
  type BrainstormViewer,
} from './brainstormAccessPolicy';
import type { BrainstormSessionRow } from './brainstormThread';
import { resolveDataRoot } from '../utils/dataDir';
import { trackEvent } from './telemetry';

export class BrainstormError extends Error {
  constructor(
    readonly code: BrainstormErrorCode | 'not_found' | 'forbidden',
    readonly status: number,
  ) {
    super(code);
  }
}

export interface BrainstormSessionDeps {
  isV2TransportEnabled: (userId: string, project: string) => Promise<boolean>;
  getDefaultModel: () => Promise<string>;
  createThread: (userId: string, project: string, model: string) => Promise<{ id: string }>;
  deleteThread: (threadId: string) => Promise<void>;
  removeSessionWorkspaces?: (sessionId: string) => Promise<void>;
}

async function defaultIsV2TransportEnabled(userId: string, project: string): Promise<boolean> {
  const { isFeatureEnabled } = await import('./featureFlagService');
  return isFeatureEnabled('ai-runs-v2-transport', { userId, project, caller: 'brainstorm' }).catch(() => false);
}

async function defaultGetDefaultModel(): Promise<string> {
  const { getDefaultModel } = await import('./appSettingsService');
  return getDefaultModel();
}

async function defaultCreateThread(userId: string, project: string, model: string): Promise<{ id: string }> {
  const { createThread } = await import('./chatAgentService');
  // No repository: Source-Backed Exploration attaches sources later.
  return createThread(userId, { project, repo: '', agentModule: 'brainstorm', model }, { skipAutoKickoff: true });
}

async function defaultDeleteThread(threadId: string): Promise<void> {
  const { permanentlyDeleteThread } = await import('./chatAgentService');
  await permanentlyDeleteThread(threadId);
}

async function defaultRemoveSessionWorkspaces(sessionId: string): Promise<void> {
  const dataRoot = resolveDataRoot();
  await Promise.all([
    fs.rm(path.join(dataRoot, 'workspaces', 'brainstorm-workspaces', sessionId), { recursive: true, force: true }).catch(() => {}),
    fs.rm(path.join(dataRoot, 'brainstorm-workspaces', sessionId), { recursive: true, force: true }).catch(() => {}),
  ]);
}

const defaultDeps: BrainstormSessionDeps = {
  isV2TransportEnabled: defaultIsV2TransportEnabled,
  getDefaultModel: defaultGetDefaultModel,
  createThread: defaultCreateThread,
  deleteThread: defaultDeleteThread,
  removeSessionWorkspaces: defaultRemoveSessionWorkspaces,
};

/** First-message title: one line, no control characters, at most 80 characters. */
export function titleFromMessage(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= BRAINSTORM_TITLE_MAX_LENGTH) return flat;
  return `${flat.slice(0, BRAINSTORM_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

type SessionWithCreator = BrainstormSessionRow & { creatorName: string | null };

function toSummary(row: SessionWithCreator, viewer: BrainstormViewer): BrainstormSessionSummary {
  return {
    id: row.id,
    title: row.title,
    creatorId: row.creatorId,
    creatorName: row.creatorName,
    state: row.state,
    model: row.model,
    artifactType: row.artifactType,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    canMutate: canMutateBrainstormSession({ viewer, project: row.project, session: row }),
    canDelete: canDeleteBrainstormSession({ viewer, project: row.project, session: row }),
    isCreator: row.creatorId === viewer.id,
  };
}

export function toSessionDetail(row: SessionWithCreator, viewer: BrainstormViewer): BrainstormSessionDetail {
  return {
    ...toSummary(row, viewer),
    threadId: row.chatThreadId,
    version: row.version,
    failureReason: row.failureReason,
  };
}

export function createBrainstormSessionService(deps: BrainstormSessionDeps = defaultDeps) {
  return {
    async createSession(input: {
      viewer: BrainstormViewer;
      project: string;
      model?: string;
    }): Promise<BrainstormSessionDetail> {
      const { viewer, project } = input;
      if (!(await deps.isV2TransportEnabled(viewer.id, project))) {
        throw new BrainstormError('transport_unavailable', 409);
      }
      const model = input.model?.trim() || (await deps.getDefaultModel());
      const thread = await deps.createThread(viewer.id, project, model);
      let row: BrainstormSessionRow;
      try {
        [row] = await db
          .insert(brainstormSessions)
          .values({
            project,
            creatorId: viewer.id,
            state: 'active',
            model,
            chatThreadId: thread.id,
            version: 1,
            createdBy: viewer.id,
            updatedBy: viewer.id,
          })
          .returning();
      } catch (err) {
        await deps.deleteThread(thread.id).catch(() => {});
        throw err;
      }
      trackEvent('brainstorm.session.created', { project, sessionId: row.id });
      const [creator] = await db
        .select({ displayName: appUsers.displayName })
        .from(appUsers)
        .where(eq(appUsers.oid, viewer.id))
        .limit(1);
      return toSessionDetail({ ...row, creatorName: creator?.displayName ?? null }, viewer);
    },

    async listSessions(input: {
      viewer: BrainstormViewer;
      project: string;
      limit: number;
      offset: number;
    }): Promise<{ sessions: BrainstormSessionSummary[]; total: number }> {
      const [rows, [totals]] = await Promise.all([
        db
          .select({ session: brainstormSessions, creatorName: appUsers.displayName })
          .from(brainstormSessions)
          .leftJoin(appUsers, eq(appUsers.oid, brainstormSessions.creatorId))
          .where(eq(brainstormSessions.project, input.project))
          .orderBy(desc(brainstormSessions.lastActivityAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ total: count() })
          .from(brainstormSessions)
          .where(eq(brainstormSessions.project, input.project)),
      ]);
      return {
        sessions: rows.map((r) => toSummary({ ...r.session, creatorName: r.creatorName }, input.viewer)),
        total: Number(totals?.total ?? 0),
      };
    },

    async readSession(input: {
      viewer: BrainstormViewer;
      session: BrainstormSessionRow;
    }): Promise<BrainstormSessionDetail> {
      const [creator] = await db
        .select({ displayName: appUsers.displayName })
        .from(appUsers)
        .where(eq(appUsers.oid, input.session.creatorId))
        .limit(1);
      return toSessionDetail({ ...input.session, creatorName: creator?.displayName ?? null }, input.viewer);
    },

    /** Sets the title from the first message; later messages leave it alone. */
    async setTitleIfEmpty(sessionId: string, project: string, text: string, userId: string): Promise<void> {
      const title = titleFromMessage(text);
      if (!title) return;
      await db
        .update(brainstormSessions)
        .set({ title, updatedBy: userId, updatedAt: sql`now()` })
        .where(
          and(
            eq(brainstormSessions.id, sessionId),
            eq(brainstormSessions.project, project),
            sql`${brainstormSessions.title} IS NULL`,
          ),
        );
    },

    async renameSession(input: {
      viewer: BrainstormViewer;
      session: BrainstormSessionRow;
      project: string;
      title: string;
    }): Promise<BrainstormSessionDetail> {
      const { viewer, session, project } = input;
      if (session.creatorId !== viewer.id && !viewer.isSuperAdmin) {
        throw new BrainstormError('not_creator', 403);
      }
      const normalized = titleFromMessage(input.title);
      if (!normalized) {
        throw Object.assign(new Error('Title is required'), { status: 400 });
      }
      const [updated] = await db
        .update(brainstormSessions)
        .set({ title: normalized, updatedBy: viewer.id, updatedAt: sql`now()` })
        .where(
          and(
            eq(brainstormSessions.id, session.id),
            eq(brainstormSessions.project, project),
          ),
        )
        .returning();
      const target = updated ?? { ...session, title: normalized };
      const [creator] = await db
        .select({ displayName: appUsers.displayName })
        .from(appUsers)
        .where(eq(appUsers.oid, target.creatorId))
        .limit(1);
      trackEvent('brainstorm.session.renamed', { project, sessionId: session.id });
      return toSessionDetail({ ...target, creatorName: creator?.displayName ?? null }, viewer);
    },

    async updateModelIfChanged(sessionId: string, project: string, model: string, userId: string): Promise<void> {
      const trimmed = model.trim();
      if (!trimmed) return;
      await db
        .update(brainstormSessions)
        .set({ model: trimmed, updatedBy: userId, updatedAt: sql`now()` })
        .where(
          and(
            eq(brainstormSessions.id, sessionId),
            eq(brainstormSessions.project, project),
          ),
        );
    },

    async deleteSession(input: {
      viewer: BrainstormViewer;
      session: BrainstormSessionRow;
      project: string;
    }): Promise<{ deleted: true; id: string }> {
      const { viewer, session, project } = input;
      if (!canDeleteBrainstormSession({ viewer, project, session })) {
        throw new BrainstormError('not_creator', 403);
      }
      const removeWorkspaces = deps.removeSessionWorkspaces ?? defaultRemoveSessionWorkspaces;
      await removeWorkspaces(session.id).catch(() => {});
      await db
        .delete(brainstormSessions)
        .where(and(eq(brainstormSessions.id, session.id), eq(brainstormSessions.project, project)));
      await deps.deleteThread(session.chatThreadId).catch(() => {});
      trackEvent('brainstorm.session.deleted', { project, sessionId: session.id });
      return { deleted: true, id: session.id };
    },
  };
}

export type BrainstormSessionService = ReturnType<typeof createBrainstormSessionService>;

export const brainstormSessionService = createBrainstormSessionService();
