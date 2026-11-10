/**
 * Generates logo options through a replaceable image provider and keeps them
 * out of the Build revision state until a person approves one.
 */
import { createHash, randomInt } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { BuildRunStatus } from '../../../shared/types/build';
import type {
  BuildLogoCandidateStatus,
  BuildLogoReviewView,
} from '../../../shared/buildLogoReview';
import { db } from '../../db/drizzle';
import {
  buildLogoCandidateBatches,
  buildLogoCandidates,
  buildRuns,
} from '../../db/schema';
import { resolveDataRoot } from '../../utils/dataDir';
import { canActOnBuild, type BuildActorContext } from './buildAccessPolicy';
import { createCursorSvgLogoProvider } from './cursorSvgLogoProvider';
import { LogoProviderError, type LogoImageProvider } from './logoImageProvider';

export class BuildLogoCandidateError extends Error {
  readonly code:
    | 'BUILD_NOT_FOUND'
    | 'BUILD_PROJECT_MISMATCH'
    | 'NOT_REQUESTER_OR_ADMIN'
    | 'LOGO_CANDIDATE_NOT_FOUND'
    | 'LOGO_CANDIDATE_DECIDED';
  readonly statusCode: number;

  constructor(
    code: BuildLogoCandidateError['code'],
    message: string,
    statusCode: number
  ) {
    super(message);
    this.name = 'BuildLogoCandidateError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface LogoRunRecord {
  id: string;
  project: string;
  status: BuildRunStatus;
  requesterUserId: string;
  prompt?: string;
  modelOverride?: string | null;
}

interface LogoCandidateRecord {
  id: string;
  batchId: string;
  buildRunId: string;
  status: BuildLogoCandidateStatus;
  digest: string | null;
  storageKey: string | null;
  createdAt: string;
}

interface LogoBatchRecord {
  id: string;
  buildRunId: string;
  prompt: string;
  status: 'running' | 'ready' | 'failed';
  failureMessage: string | null;
  createdAt: string;
  candidates: LogoCandidateRecord[];
}

export interface LogoCandidateFileStore {
  save(bytes: Buffer): Promise<{ digest: string; storageKey: string }>;
  read(storageKey: string): Promise<Buffer | null>;
}

export interface BuildLogoCandidateDeps {
  loadRun(buildId: string): Promise<LogoRunRecord | null>;
  findRunningBatch(buildId: string): Promise<LogoBatchRecord | null>;
  latestBatch(buildId: string): Promise<LogoBatchRecord | null>;
  readBatch(batchId: string): Promise<LogoBatchRecord | null>;
  readCandidate(candidateId: string): Promise<LogoCandidateRecord | null>;
  insertBatch(input: {
    buildRunId: string;
    prompt: string;
  }): Promise<LogoBatchRecord>;
  insertCandidate(input: {
    batchId: string;
    buildRunId: string;
    digest: string;
    storageKey: string;
  }): Promise<void>;
  updateBatch(
    batchId: string,
    patch: { status: 'ready' | 'failed'; failureMessage?: string | null }
  ): Promise<void>;
  decideCandidate(input: {
    candidateId: string;
    status: 'approved' | 'rejected';
  }): Promise<boolean>;
  supersedePending(batchId: string, exceptCandidateId?: string): Promise<void>;
  store: LogoCandidateFileStore;
  provider: LogoImageProvider;
  now(): string;
  awaitGeneration?: boolean;
  candidateCount?: number;
}

export function createLogoCandidateFileStore(
  root = path.join(resolveDataRoot(), 'logo-candidates')
): LogoCandidateFileStore {
  return {
    async save(bytes) {
      const hex = createHash('sha256').update(bytes).digest('hex');
      await mkdir(root, { recursive: true });
      const storageKey = `${hex}.png`;
      try {
        await writeFile(path.join(root, storageKey), bytes, { flag: 'wx' });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
      }
      return { digest: `sha256:${hex}`, storageKey };
    },
    async read(storageKey) {
      if (!/^[0-9a-f]{64}\.png$/.test(storageKey)) return null;
      try {
        return await readFile(path.join(root, storageKey));
      } catch {
        return null;
      }
    },
  };
}

function toView(batch: LogoBatchRecord): BuildLogoReviewView {
  const candidates = [...batch.candidates].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
  return {
    batchId: batch.id,
    status: batch.status,
    prompt: batch.prompt,
    failureMessage: batch.failureMessage,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
    })),
    approvedCandidateId:
      candidates.find((candidate) => candidate.status === 'approved')?.id ??
      null,
  };
}

function createDefaultDeps(): BuildLogoCandidateDeps {
  const mapBatch = async (
    row: typeof buildLogoCandidateBatches.$inferSelect
  ): Promise<LogoBatchRecord> => {
    const candidates = await db
      .select()
      .from(buildLogoCandidates)
      .where(eq(buildLogoCandidates.batchId, row.id))
      .orderBy(buildLogoCandidates.createdAt);
    return {
      id: row.id,
      buildRunId: row.buildRunId,
      prompt: row.prompt,
      status: row.status,
      failureMessage: row.failureMessage,
      createdAt: row.createdAt,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        batchId: candidate.batchId,
        buildRunId: candidate.buildRunId,
        status: candidate.status,
        digest: candidate.digest,
        storageKey: candidate.storageKey,
        createdAt: candidate.createdAt,
      })),
    };
  };

  return {
    async loadRun(buildId) {
      const [row] = await db
        .select({
          id: buildRuns.id,
          project: buildRuns.project,
          status: buildRuns.status,
          requesterUserId: buildRuns.requestedByUserId,
          prompt: buildRuns.prompt,
          modelOverride: buildRuns.modelOverride,
        })
        .from(buildRuns)
        .where(eq(buildRuns.id, buildId))
        .limit(1);
      return row ?? null;
    },
    async findRunningBatch(buildId) {
      const [row] = await db
        .select()
        .from(buildLogoCandidateBatches)
        .where(
          and(
            eq(buildLogoCandidateBatches.buildRunId, buildId),
            eq(buildLogoCandidateBatches.status, 'running')
          )
        )
        .limit(1);
      return row ? mapBatch(row) : null;
    },
    async latestBatch(buildId) {
      const [row] = await db
        .select()
        .from(buildLogoCandidateBatches)
        .where(eq(buildLogoCandidateBatches.buildRunId, buildId))
        .orderBy(desc(buildLogoCandidateBatches.createdAt))
        .limit(1);
      return row ? mapBatch(row) : null;
    },
    async readBatch(batchId) {
      const [row] = await db
        .select()
        .from(buildLogoCandidateBatches)
        .where(eq(buildLogoCandidateBatches.id, batchId))
        .limit(1);
      return row ? mapBatch(row) : null;
    },
    async readCandidate(candidateId) {
      const [row] = await db
        .select()
        .from(buildLogoCandidates)
        .where(eq(buildLogoCandidates.id, candidateId))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        batchId: row.batchId,
        buildRunId: row.buildRunId,
        status: row.status,
        digest: row.digest,
        storageKey: row.storageKey,
        createdAt: row.createdAt,
      };
    },
    async insertBatch(input) {
      const [row] = await db
        .insert(buildLogoCandidateBatches)
        .values({
          buildRunId: input.buildRunId,
          prompt: input.prompt,
          status: 'running',
          provider: 'cursor_svg',
        })
        .returning();
      return mapBatch(row);
    },
    async insertCandidate(input) {
      const now = new Date().toISOString();
      await db.insert(buildLogoCandidates).values({
        batchId: input.batchId,
        buildRunId: input.buildRunId,
        status: 'pending',
        digest: input.digest,
        storageKey: input.storageKey,
        createdAt: now,
        updatedAt: now,
      });
    },
    async updateBatch(batchId, patch) {
      await db
        .update(buildLogoCandidateBatches)
        .set({
          status: patch.status,
          failureMessage: patch.failureMessage ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(buildLogoCandidateBatches.id, batchId));
    },
    async decideCandidate(input) {
      const rows = await db
        .update(buildLogoCandidates)
        .set({ status: input.status, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(buildLogoCandidates.id, input.candidateId),
            eq(buildLogoCandidates.status, 'pending')
          )
        )
        .returning({ id: buildLogoCandidates.id });
      return rows.length > 0;
    },
    async supersedePending(batchId, exceptCandidateId) {
      const filters = [
        eq(buildLogoCandidates.batchId, batchId),
        eq(buildLogoCandidates.status, 'pending'),
      ];
      if (exceptCandidateId) {
        filters.push(ne(buildLogoCandidates.id, exceptCandidateId));
      }
      await db
        .update(buildLogoCandidates)
        .set({ status: 'superseded', updatedAt: new Date().toISOString() })
        .where(and(...filters));
    },
    store: createLogoCandidateFileStore(),
    provider: createCursorSvgLogoProvider(),
    now: () => new Date().toISOString(),
  };
}

export function createBuildLogoCandidateService(
  deps: BuildLogoCandidateDeps = createDefaultDeps()
) {
  const requireRun = async (
    buildId: string,
    project: string,
    actor: BuildActorContext
  ): Promise<LogoRunRecord> => {
    const run = await deps.loadRun(buildId);
    if (!run) {
      throw new BuildLogoCandidateError(
        'BUILD_NOT_FOUND',
        'This build does not exist.',
        404
      );
    }
    if (run.project !== project) {
      throw new BuildLogoCandidateError(
        'BUILD_PROJECT_MISMATCH',
        'This build belongs to another project.',
        403
      );
    }
    if (!canActOnBuild(actor, run).allowed) {
      throw new BuildLogoCandidateError(
        'NOT_REQUESTER_OR_ADMIN',
        'Only the requester or a project admin can review logos for this build.',
        403
      );
    }
    return run;
  };

  const execute = async (
    batch: LogoBatchRecord,
    prompt: string
  ): Promise<void> => {
    try {
      const run = await deps.loadRun(batch.buildRunId);
      const images = await deps.provider.generate({
        prompt,
        applicationPrompt: run?.prompt,
        count: deps.candidateCount ?? 3,
        seed: randomInt(1, 1_000_000_000),
        modelId: run?.modelOverride ?? undefined,
      });
      if (images.length === 0) {
        throw new LogoProviderError('Cursor returned no logo images.');
      }
      for (const image of images) {
        const saved = await deps.store.save(image);
        await deps.insertCandidate({
          batchId: batch.id,
          buildRunId: batch.buildRunId,
          digest: saved.digest,
          storageKey: saved.storageKey,
        });
      }
      await deps.updateBatch(batch.id, { status: 'ready' });
    } catch (error) {
      await deps.updateBatch(batch.id, {
        status: 'failed',
        failureMessage:
          error instanceof LogoProviderError
            ? error.message
            : 'The logo generator failed before it returned an image.',
      });
    }
  };

  return {
    async review(buildId: string): Promise<BuildLogoReviewView | null> {
      const batch = await deps.latestBatch(buildId);
      return batch ? toView(batch) : null;
    },

    async generate(input: {
      buildId: string;
      project: string;
      prompt: string;
      actor: BuildActorContext;
    }): Promise<BuildLogoReviewView> {
      const run = await requireRun(input.buildId, input.project, input.actor);
      const prompt = input.prompt.trim();
      const running = await deps.findRunningBatch(run.id);
      if (running) return toView(running);

      const previous = await deps.latestBatch(run.id);
      if (previous?.status === 'ready') {
        await deps.supersedePending(previous.id);
      }
      const batch = await deps.insertBatch({ buildRunId: run.id, prompt });
      const work = execute(batch, prompt);
      if (deps.awaitGeneration) await work;
      else {
        void work.catch((error) => {
          console.error(
            '[logo-candidates] generation failed:',
            error instanceof Error ? error.message : String(error)
          );
        });
      }
      return toView((await deps.readBatch(batch.id)) ?? batch);
    },

    async image(input: {
      buildId: string;
      project: string;
      candidateId: string;
      actor: BuildActorContext;
    }): Promise<Buffer> {
      const run = await requireRun(input.buildId, input.project, input.actor);
      const candidate = await deps.readCandidate(input.candidateId);
      if (
        !candidate ||
        candidate.buildRunId !== run.id ||
        !candidate.storageKey
      ) {
        throw new BuildLogoCandidateError(
          'LOGO_CANDIDATE_NOT_FOUND',
          'This logo option does not exist.',
          404
        );
      }
      const bytes = await deps.store.read(candidate.storageKey);
      if (!bytes) {
        throw new BuildLogoCandidateError(
          'LOGO_CANDIDATE_NOT_FOUND',
          'This logo option does not exist.',
          404
        );
      }
      return bytes;
    },

    async decide(input: {
      buildId: string;
      project: string;
      candidateId: string;
      decision: 'approved' | 'rejected';
      actor: BuildActorContext;
    }): Promise<BuildLogoReviewView> {
      const run = await requireRun(input.buildId, input.project, input.actor);
      const candidate = await deps.readCandidate(input.candidateId);
      if (!candidate || candidate.buildRunId !== run.id) {
        throw new BuildLogoCandidateError(
          'LOGO_CANDIDATE_NOT_FOUND',
          'This logo option does not exist.',
          404
        );
      }
      const decided = await deps.decideCandidate({
        candidateId: candidate.id,
        status: input.decision,
      });
      if (!decided) {
        throw new BuildLogoCandidateError(
          'LOGO_CANDIDATE_DECIDED',
          'This logo option was already reviewed.',
          409
        );
      }
      if (input.decision === 'approved') {
        await deps.supersedePending(candidate.batchId, candidate.id);
      }
      const batch = await deps.readBatch(candidate.batchId);
      if (!batch) {
        throw new BuildLogoCandidateError(
          'LOGO_CANDIDATE_NOT_FOUND',
          'This logo option does not exist.',
          404
        );
      }
      return toView(batch);
    },
  };
}

export const defaultBuildLogoCandidateService =
  createBuildLogoCandidateService();
