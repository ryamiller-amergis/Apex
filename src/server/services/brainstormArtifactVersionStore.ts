/**
 * FEAT-003 TBI-007 — Brainstorm artifact version store.
 *
 * The artifact is plain Markdown with an append-only list of versions. Every write
 * runs in one transaction, requires an active session, and carries the version the
 * caller last saw: the artifact row is bumped with `WHERE version = :expected`, so a
 * stale write changes nothing. Version rows are never updated except to set a
 * checkpoint name once, from null, and are never deleted.
 */
import { and, desc, eq, isNotNull, isNull, lt, max, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  brainstormArtifacts,
  brainstormArtifactVersions,
  brainstormMessages,
  brainstormSessions,
} from '../db/schema';
import {
  BRAINSTORM_ARTIFACT_FAILURE_SUMMARIES,
  BRAINSTORM_ARTIFACT_MAX_BYTES,
  BRAINSTORM_ARTIFACT_TYPE_LABELS,
  BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH,
  type BrainstormArtifactDto,
  type BrainstormArtifactErrorCode,
  type BrainstormArtifactFailureCode,
  type BrainstormArtifactOrigin,
  type BrainstormArtifactType,
  type BrainstormCompareDto,
  type BrainstormVersionDto,
  type BrainstormVersionListDto,
  type BrainstormVersionSummaryDto,
  type FrozenBrainstormArtifact,
} from '../../shared/types/brainstormArtifact';
import { sanitizeBrainstormMarkdown } from '../../shared/utils/sanitizeBrainstormMarkdown';
import { trackEvent } from './telemetry';

export class BrainstormArtifactError extends Error {
  constructor(
    readonly code: BrainstormArtifactErrorCode,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'BrainstormArtifactError';
  }
}

export interface ArtifactRow {
  id: string;
  sessionId: string;
  project: string;
  artifactType: BrainstormArtifactType | null;
  markdown: string;
  version: number;
  updatedAt: string;
}

export interface VersionRow {
  sequence: number;
  markdown: string;
  changeOrigin: BrainstormArtifactOrigin;
  checkpointName: string | null;
  artifactType: BrainstormArtifactType | null;
  authorId: string | null;
  createdAt: string;
}

export type VersionSummaryRow = Omit<VersionRow, 'markdown'> & { sizeBytes: number };

export interface NewVersion {
  artifactId: string;
  project: string;
  sequence: number;
  markdown: string;
  changeOrigin: BrainstormArtifactOrigin;
  checkpointName: string | null;
  artifactType: BrainstormArtifactType | null;
  authorId: string | null;
  runId: string | null;
}

/** Statements available inside one write transaction. */
export interface ArtifactTx {
  /** Session state read with FOR SHARE; ending a session takes FOR UPDATE. Null outside the project. */
  lockSession(sessionId: string, project: string): Promise<{ state: string } | null>;
  readArtifact(sessionId: string, project: string): Promise<ArtifactRow | null>;
  /** Inserts the artifact at version 1. Null when a row already exists. */
  insertFirstArtifact(input: { sessionId: string; project: string; markdown: string; type: BrainstormArtifactType | null }): Promise<ArtifactRow | null>;
  /** `UPDATE ... SET version = version + 1 WHERE version = :expected`. Null when zero rows matched. */
  bumpArtifact(input: { artifactId: string; expectedVersion: number; markdown: string; type: BrainstormArtifactType | null }): Promise<number | null>;
  insertVersion(row: NewVersion): Promise<VersionRow>;
  findVersion(artifactId: string, sequence: number): Promise<VersionRow | null>;
  checkpointNameTaken(artifactId: string, name: string): Promise<boolean>;
  /** Sets the name only `WHERE checkpoint_name IS NULL`. False when the version already had one. */
  nameVersion(artifactId: string, sequence: number, name: string): Promise<boolean>;
  latestSequenceForRun(artifactId: string, runId: string): Promise<number | null>;
  touchSession(sessionId: string, type: BrainstormArtifactType | null): Promise<void>;
}

export interface ArtifactPersistence {
  transaction<T>(work: (tx: ArtifactTx) => Promise<T>): Promise<T>;
  getArtifact(sessionId: string, project: string): Promise<ArtifactRow | null>;
  findArtifactById(artifactId: string): Promise<{ sessionId: string; project: string } | null>;
  listVersions(artifactId: string, options: { limit: number; before: number | null }): Promise<VersionSummaryRow[]>;
  getVersion(artifactId: string, sequence: number): Promise<VersionRow | null>;
  countVersions(artifactId: string): Promise<number>;
  latestArtifactFailure(sessionId: string): Promise<{ code: BrainstormArtifactFailureCode; at: string } | null>;
}

export interface ArtifactStoreDeps {
  persistence: ArtifactPersistence;
  track?: (event: string, properties: Record<string, string>) => void;
}

export interface WriteContext {
  sessionId: string;
  project: string;
  authorId: string;
}

export function byteLength(markdown: string): number {
  return Buffer.byteLength(markdown, 'utf8');
}

/** Sanitizes then checks the size cap. Every write path calls this, rollback included. */
export function prepareMarkdown(markdown: string): string {
  const clean = sanitizeBrainstormMarkdown(markdown);
  if (byteLength(clean) > BRAINSTORM_ARTIFACT_MAX_BYTES) {
    throw new BrainstormArtifactError('ARTIFACT_TOO_LARGE', 413, { maxBytes: BRAINSTORM_ARTIFACT_MAX_BYTES });
  }
  return clean;
}

export function validateCheckpointName(raw: unknown): string {
  if (typeof raw !== 'string') throw new BrainstormArtifactError('INVALID_CHECKPOINT_NAME', 400);
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new BrainstormArtifactError('INVALID_CHECKPOINT_NAME', 400, { maxLength: BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH });
  }
  return name;
}

function toSummary(row: VersionRow): BrainstormVersionSummaryDto {
  return {
    sequence: row.sequence,
    origin: row.changeOrigin,
    checkpointName: row.checkpointName,
    artifactType: row.artifactType,
    authorId: row.authorId,
    createdAt: row.createdAt,
    sizeBytes: byteLength(row.markdown),
  };
}

function toVersionDto(row: VersionRow): BrainstormVersionDto {
  return { ...toSummary(row), markdown: row.markdown };
}

function emptyArtifact(sessionId: string): BrainstormArtifactDto {
  return {
    id: null,
    sessionId,
    type: null,
    markdown: '',
    version: 0,
    updatedAt: null,
    lastOrigin: null,
    lastChangeFailure: null,
  };
}

export function createArtifactVersionStore(deps: ArtifactStoreDeps) {
  const { persistence } = deps;
  const track = deps.track ?? trackEvent;

  async function requireActive(tx: ArtifactTx, sessionId: string, project: string): Promise<void> {
    const session = await tx.lockSession(sessionId, project);
    if (!session) throw new BrainstormArtifactError('VERSION_NOT_FOUND', 404);
    if (session.state !== 'active') throw new BrainstormArtifactError('SESSION_NOT_ACTIVE', 409);
  }

  function conflict(current: number, operation: string, ctx: WriteContext): BrainstormArtifactError {
    track('brainstorm.artifact.stale_write_rejected', { project: ctx.project, sessionId: ctx.sessionId, operation });
    return new BrainstormArtifactError('ARTIFACT_VERSION_CONFLICT', 409, { currentVersion: current });
  }

  /**
   * Writes the next version. `expectedVersion` 0 creates the artifact row; any
   * other value must match the row's version or nothing is written.
   */
  async function writeVersion(
    tx: ArtifactTx,
    ctx: WriteContext,
    input: {
      expectedVersion: number;
      markdown: string;
      type: BrainstormArtifactType | null;
      origin: BrainstormArtifactOrigin;
      checkpointName?: string | null;
      runId?: string | null;
      operation: string;
    },
  ): Promise<VersionRow> {
    const current = await tx.readArtifact(ctx.sessionId, ctx.project);
    let artifactId: string;
    let sequence: number;
    if (input.expectedVersion === 0) {
      if (current) throw conflict(current.version, input.operation, ctx);
      const created = await tx.insertFirstArtifact({
        sessionId: ctx.sessionId,
        project: ctx.project,
        markdown: input.markdown,
        type: input.type,
      });
      if (!created) {
        const raced = await tx.readArtifact(ctx.sessionId, ctx.project);
        throw conflict(raced?.version ?? 1, input.operation, ctx);
      }
      artifactId = created.id;
      sequence = 1;
    } else {
      if (!current) throw conflict(0, input.operation, ctx);
      const next = await tx.bumpArtifact({
        artifactId: current.id,
        expectedVersion: input.expectedVersion,
        markdown: input.markdown,
        type: input.type,
      });
      if (next === null) throw conflict(current.version, input.operation, ctx);
      artifactId = current.id;
      sequence = next;
    }
    const version = await tx.insertVersion({
      artifactId,
      project: ctx.project,
      sequence,
      markdown: input.markdown,
      changeOrigin: input.origin,
      checkpointName: input.checkpointName ?? null,
      artifactType: input.type,
      authorId: ctx.authorId,
      runId: input.runId ?? null,
    });
    await tx.touchSession(ctx.sessionId, input.type);
    track('brainstorm.artifact.version_written', {
      project: ctx.project,
      sessionId: ctx.sessionId,
      origin: input.origin,
      sequence: String(sequence),
    });
    return version;
  }

  /** The version an AI change in this run must build on: the newest one the run wrote, else the frozen base. */
  async function expectedForRun(tx: ArtifactTx, ctx: WriteContext, runId: string, baseVersion: number): Promise<number> {
    const current = await tx.readArtifact(ctx.sessionId, ctx.project);
    if (!current) return baseVersion;
    const written = await tx.latestSequenceForRun(current.id, runId);
    return written !== null && written > baseVersion ? written : baseVersion;
  }

  return {
    /** An AI-requested change: applies at once and writes a version (BR-004). */
    async applyAiChange(ctx: WriteContext & { runId: string; baseVersion: number; markdown: string }): Promise<BrainstormVersionSummaryDto> {
      const markdown = prepareMarkdown(ctx.markdown);
      return persistence.transaction(async (tx) => {
        await requireActive(tx, ctx.sessionId, ctx.project);
        const expectedVersion = await expectedForRun(tx, ctx, ctx.runId, ctx.baseVersion);
        const current = await tx.readArtifact(ctx.sessionId, ctx.project);
        return toSummary(await writeVersion(tx, ctx, {
          expectedVersion,
          markdown,
          type: current?.artifactType ?? null,
          origin: 'ai_change',
          runId: ctx.runId,
          operation: 'ai_change',
        }));
      });
    },

    /**
     * The reshaped artifact from a type-switch turn. Labels the previous version,
     * writes the new one and sets the type in one transaction (BR-005).
     */
    async applyTypeSwitch(ctx: WriteContext & { runId: string; baseVersion: number; newType: BrainstormArtifactType; markdown: string }): Promise<BrainstormVersionSummaryDto> {
      const markdown = prepareMarkdown(ctx.markdown);
      return persistence.transaction(async (tx) => {
        await requireActive(tx, ctx.sessionId, ctx.project);
        const expectedVersion = await expectedForRun(tx, ctx, ctx.runId, ctx.baseVersion);
        const current = await tx.readArtifact(ctx.sessionId, ctx.project);
        if (current && current.version === expectedVersion) {
          const label = `Before switch to ${BRAINSTORM_ARTIFACT_TYPE_LABELS[ctx.newType]}`;
          const name = (await tx.checkpointNameTaken(current.id, label)) ? `${label} (v${current.version})` : label;
          if (!(await tx.checkpointNameTaken(current.id, name))) {
            await tx.nameVersion(current.id, current.version, name);
          }
        }
        return toSummary(await writeVersion(tx, ctx, {
          expectedVersion,
          markdown,
          type: ctx.newType,
          origin: 'type_switch',
          runId: ctx.runId,
          operation: 'type_switch',
        }));
      });
    },

    /**
     * Type choice while the artifact has no content: no turn. The first choice
     * writes version 1; a later one on still-empty content writes the next version.
     */
    async setTypeOnEmpty(ctx: WriteContext & { expectedVersion: number; type: BrainstormArtifactType }): Promise<BrainstormVersionSummaryDto> {
      return persistence.transaction(async (tx) => {
        await requireActive(tx, ctx.sessionId, ctx.project);
        const current = await tx.readArtifact(ctx.sessionId, ctx.project);
        const currentVersion = current?.version ?? 0;
        if (currentVersion !== ctx.expectedVersion) throw conflict(currentVersion, 'type_switch', ctx);
        if (current && current.markdown.trim().length > 0) {
          throw new BrainstormArtifactError('INVALID_REQUEST', 409, { reason: 'artifact_has_content' });
        }
        const label = `Type set: ${BRAINSTORM_ARTIFACT_TYPE_LABELS[ctx.type]}`;
        const taken = current ? await tx.checkpointNameTaken(current.id, label) : false;
        return toSummary(await writeVersion(tx, ctx, {
          expectedVersion: currentVersion,
          markdown: '',
          type: ctx.type,
          origin: 'type_switch',
          checkpointName: taken ? `${label} (v${currentVersion + 1})` : label,
          operation: 'type_switch',
        }));
      });
    },

    /** Names the current version. The version counter does not move. */
    async labelCheckpoint(ctx: WriteContext & { expectedVersion: number; name: unknown }): Promise<BrainstormVersionSummaryDto> {
      const name = validateCheckpointName(ctx.name);
      return persistence.transaction(async (tx) => {
        await requireActive(tx, ctx.sessionId, ctx.project);
        const current = await tx.readArtifact(ctx.sessionId, ctx.project);
        if (!current || current.version !== ctx.expectedVersion) {
          throw conflict(current?.version ?? 0, 'checkpoint', ctx);
        }
        const version = await tx.findVersion(current.id, current.version);
        if (!version) throw new BrainstormArtifactError('VERSION_NOT_FOUND', 404);
        if (version.checkpointName) throw new BrainstormArtifactError('CHECKPOINT_EXISTS', 409);
        if (await tx.checkpointNameTaken(current.id, name)) {
          throw new BrainstormArtifactError('CHECKPOINT_NAME_TAKEN', 409);
        }
        if (!(await tx.nameVersion(current.id, current.version, name))) {
          throw new BrainstormArtifactError('CHECKPOINT_EXISTS', 409);
        }
        return toSummary({ ...version, checkpointName: name });
      });
    },

    /** Adds a version with an earlier version's content and type. History stays whole. */
    async rollback(ctx: WriteContext & { expectedVersion: number; toSequence: number }): Promise<BrainstormVersionSummaryDto> {
      return persistence.transaction(async (tx) => {
        await requireActive(tx, ctx.sessionId, ctx.project);
        const current = await tx.readArtifact(ctx.sessionId, ctx.project);
        if (!current || current.version !== ctx.expectedVersion) {
          throw conflict(current?.version ?? 0, 'rollback', ctx);
        }
        const target = await tx.findVersion(current.id, ctx.toSequence);
        if (!target) throw new BrainstormArtifactError('VERSION_NOT_FOUND', 404);
        const written = await writeVersion(tx, ctx, {
          expectedVersion: ctx.expectedVersion,
          markdown: prepareMarkdown(target.markdown),
          type: target.artifactType ?? current.artifactType,
          origin: 'rollback',
          operation: 'rollback',
        });
        track('brainstorm.artifact.rolled_back', {
          project: ctx.project,
          sessionId: ctx.sessionId,
          fromSequence: String(current.version),
          toSequence: String(ctx.toSequence),
        });
        return toSummary(written);
      });
    },

    async getArtifact(sessionId: string, project: string): Promise<BrainstormArtifactDto> {
      const [row, failure] = await Promise.all([
        persistence.getArtifact(sessionId, project),
        persistence.latestArtifactFailure(sessionId),
      ]);
      const lastChangeFailure = failure
        ? { code: failure.code, summary: BRAINSTORM_ARTIFACT_FAILURE_SUMMARIES[failure.code], at: failure.at }
        : null;
      if (!row) return { ...emptyArtifact(sessionId), lastChangeFailure };
      const latest = await persistence.getVersion(row.id, row.version);
      return {
        id: row.id,
        sessionId,
        type: row.artifactType,
        markdown: row.markdown,
        version: row.version,
        updatedAt: row.updatedAt,
        lastOrigin: latest?.changeOrigin ?? null,
        checkpointName: latest?.checkpointName ?? null,
        lastChangeFailure,
      };
    },

    findArtifactById(artifactId: string) {
      return persistence.findArtifactById(artifactId);
    },

    async listVersions(sessionId: string, project: string, options: { limit?: number; cursor?: number | null } = {}): Promise<BrainstormVersionListDto> {
      const row = await persistence.getArtifact(sessionId, project);
      if (!row) return { versions: [], nextCursor: null };
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const rows = await persistence.listVersions(row.id, { limit: limit + 1, before: options.cursor ?? null });
      const page = rows.slice(0, limit);
      return {
        versions: page.map((version) => ({
          sequence: version.sequence,
          origin: version.changeOrigin,
          checkpointName: version.checkpointName,
          artifactType: version.artifactType,
          authorId: version.authorId,
          createdAt: version.createdAt,
          sizeBytes: version.sizeBytes,
        })),
        nextCursor: rows.length > limit ? page[page.length - 1].sequence : null,
      };
    },

    async getVersion(sessionId: string, project: string, sequence: number): Promise<BrainstormVersionDto> {
      const row = await persistence.getArtifact(sessionId, project);
      const version = row ? await persistence.getVersion(row.id, sequence) : null;
      if (!version) throw new BrainstormArtifactError('VERSION_NOT_FOUND', 404);
      return toVersionDto(version);
    },

    /** Both versions in sequence order; the client computes the diff. */
    async compareVersions(sessionId: string, project: string, a: number, b: number): Promise<BrainstormCompareDto> {
      const row = await persistence.getArtifact(sessionId, project);
      if (!row || (await persistence.countVersions(row.id)) < 2 || a === b) {
        throw new BrainstormArtifactError('NOTHING_TO_COMPARE', 409);
      }
      const [low, high] = a < b ? [a, b] : [b, a];
      const [from, to] = await Promise.all([persistence.getVersion(row.id, low), persistence.getVersion(row.id, high)]);
      if (!from || !to) throw new BrainstormArtifactError('VERSION_NOT_FOUND', 404);
      return { from: toVersionDto(from), to: toVersionDto(to) };
    },

    /** The artifact as a turn freezes it onto the V2 specification. */
    async resolveArtifactContext(sessionId: string, project: string): Promise<FrozenBrainstormArtifact> {
      const row = await persistence.getArtifact(sessionId, project);
      return row
        ? { type: row.artifactType, version: row.version, markdown: row.markdown }
        : { type: null, version: 0, markdown: '' };
    },
  };
}

export type ArtifactVersionStore = ReturnType<typeof createArtifactVersionStore>;

// ── Drizzle persistence ───────────────────────────────────────────────────────

type Executor = Pick<typeof db, 'select' | 'insert' | 'update'>;

const artifactColumns = {
  id: brainstormArtifacts.id,
  sessionId: brainstormArtifacts.sessionId,
  project: brainstormArtifacts.project,
  artifactType: brainstormArtifacts.artifactType,
  markdown: brainstormArtifacts.markdown,
  version: brainstormArtifacts.version,
  updatedAt: brainstormArtifacts.updatedAt,
};

const versionColumns = {
  sequence: brainstormArtifactVersions.sequence,
  markdown: brainstormArtifactVersions.markdown,
  changeOrigin: brainstormArtifactVersions.changeOrigin,
  checkpointName: brainstormArtifactVersions.checkpointName,
  artifactType: brainstormArtifactVersions.artifactType,
  authorId: brainstormArtifactVersions.authorId,
  createdAt: brainstormArtifactVersions.createdAt,
};

async function readArtifactRow(executor: Executor, sessionId: string, project: string): Promise<ArtifactRow | null> {
  const [row] = await executor
    .select(artifactColumns)
    .from(brainstormArtifacts)
    .where(and(eq(brainstormArtifacts.sessionId, sessionId), eq(brainstormArtifacts.project, project)))
    .limit(1);
  return row ?? null;
}

async function readVersionRow(executor: Executor, artifactId: string, sequence: number): Promise<VersionRow | null> {
  const [row] = await executor
    .select(versionColumns)
    .from(brainstormArtifactVersions)
    .where(and(eq(brainstormArtifactVersions.artifactId, artifactId), eq(brainstormArtifactVersions.sequence, sequence)))
    .limit(1);
  return row ?? null;
}

function drizzleTx(tx: Executor): ArtifactTx {
  return {
    async lockSession(sessionId, project) {
      const [row] = await tx
        .select({ state: brainstormSessions.state })
        .from(brainstormSessions)
        .where(and(eq(brainstormSessions.id, sessionId), eq(brainstormSessions.project, project)))
        .for('share');
      return row ?? null;
    },
    readArtifact: (sessionId, project) => readArtifactRow(tx, sessionId, project),
    async insertFirstArtifact(input) {
      const [row] = await tx
        .insert(brainstormArtifacts)
        .values({
          sessionId: input.sessionId,
          project: input.project,
          artifactType: input.type,
          markdown: input.markdown,
          version: 1,
        })
        .onConflictDoNothing({ target: brainstormArtifacts.sessionId })
        .returning(artifactColumns);
      return row ?? null;
    },
    async bumpArtifact(input) {
      const [row] = await tx
        .update(brainstormArtifacts)
        .set({
          version: sql`${brainstormArtifacts.version} + 1`,
          markdown: input.markdown,
          artifactType: input.type,
          updatedAt: sql`now()`,
        })
        .where(and(eq(brainstormArtifacts.id, input.artifactId), eq(brainstormArtifacts.version, input.expectedVersion)))
        .returning({ version: brainstormArtifacts.version });
      return row?.version ?? null;
    },
    async insertVersion(input) {
      const [row] = await tx.insert(brainstormArtifactVersions).values(input).returning(versionColumns);
      return row;
    },
    findVersion: (artifactId, sequence) => readVersionRow(tx, artifactId, sequence),
    async checkpointNameTaken(artifactId, name) {
      const [row] = await tx
        .select({ sequence: brainstormArtifactVersions.sequence })
        .from(brainstormArtifactVersions)
        .where(and(
          eq(brainstormArtifactVersions.artifactId, artifactId),
          sql`lower(${brainstormArtifactVersions.checkpointName}) = lower(${name})`,
        ))
        .limit(1);
      return Boolean(row);
    },
    async nameVersion(artifactId, sequence, name) {
      const rows = await tx
        .update(brainstormArtifactVersions)
        .set({ checkpointName: name })
        .where(and(
          eq(brainstormArtifactVersions.artifactId, artifactId),
          eq(brainstormArtifactVersions.sequence, sequence),
          isNull(brainstormArtifactVersions.checkpointName),
        ))
        .returning({ sequence: brainstormArtifactVersions.sequence });
      return rows.length === 1;
    },
    async latestSequenceForRun(artifactId, runId) {
      const [row] = await tx
        .select({ sequence: max(brainstormArtifactVersions.sequence) })
        .from(brainstormArtifactVersions)
        .where(and(eq(brainstormArtifactVersions.artifactId, artifactId), eq(brainstormArtifactVersions.runId, runId)));
      return row?.sequence ?? null;
    },
    async touchSession(sessionId, type) {
      await tx
        .update(brainstormSessions)
        .set({ lastActivityAt: sql`now()`, artifactType: type })
        .where(eq(brainstormSessions.id, sessionId));
    },
  };
}

export const drizzleArtifactPersistence: ArtifactPersistence = {
  transaction: (work) => db.transaction((tx) => work(drizzleTx(tx))),
  getArtifact: (sessionId, project) => readArtifactRow(db, sessionId, project),
  async findArtifactById(artifactId) {
    const [row] = await db
      .select({ sessionId: brainstormArtifacts.sessionId, project: brainstormArtifacts.project })
      .from(brainstormArtifacts)
      .where(eq(brainstormArtifacts.id, artifactId))
      .limit(1);
    return row ?? null;
  },
  async listVersions(artifactId, options) {
    return db
      .select({
        sequence: brainstormArtifactVersions.sequence,
        changeOrigin: brainstormArtifactVersions.changeOrigin,
        checkpointName: brainstormArtifactVersions.checkpointName,
        artifactType: brainstormArtifactVersions.artifactType,
        authorId: brainstormArtifactVersions.authorId,
        createdAt: brainstormArtifactVersions.createdAt,
        sizeBytes: sql<number>`octet_length(${brainstormArtifactVersions.markdown})::int`,
      })
      .from(brainstormArtifactVersions)
      .where(and(
        eq(brainstormArtifactVersions.artifactId, artifactId),
        options.before !== null ? lt(brainstormArtifactVersions.sequence, options.before) : undefined,
      ))
      .orderBy(desc(brainstormArtifactVersions.sequence))
      .limit(options.limit);
  },
  getVersion: (artifactId, sequence) => readVersionRow(db, artifactId, sequence),
  async countVersions(artifactId) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(brainstormArtifactVersions)
      .where(eq(brainstormArtifactVersions.artifactId, artifactId));
    return row?.count ?? 0;
  },
  async latestArtifactFailure(sessionId) {
    const [row] = await db
      .select({
        code: brainstormMessages.artifactFailureCode,
        at: brainstormMessages.createdAt,
      })
      .from(brainstormMessages)
      .where(and(
        eq(brainstormMessages.sessionId, sessionId),
        eq(brainstormMessages.role, 'assistant'),
        isNull(brainstormMessages.supersededByMessageId),
      ))
      .orderBy(desc(brainstormMessages.createdAt))
      .limit(1);
    return row?.code ? { code: row.code, at: row.at } : null;
  },
};

/** Records why the run's artifact change failed on its assistant message. */
export async function recordArtifactFailure(runId: string, code: BrainstormArtifactFailureCode): Promise<void> {
  await db
    .update(brainstormMessages)
    .set({ artifactFailureCode: code })
    .where(and(eq(brainstormMessages.runId, runId), isNotNull(brainstormMessages.runId)));
}

/** Clears a recorded failure once the same run writes a version. */
export async function clearArtifactFailure(runId: string): Promise<void> {
  await db
    .update(brainstormMessages)
    .set({ artifactFailureCode: null })
    .where(eq(brainstormMessages.runId, runId));
}

export const brainstormArtifactStore = createArtifactVersionStore({ persistence: drizzleArtifactPersistence });
