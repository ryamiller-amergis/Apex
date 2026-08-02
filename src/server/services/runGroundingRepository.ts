import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { runGroundings } from '../db/schema';
import type {
  ActiveRepositoryBranchQuery,
  CreateRunGroundingInput,
  RepoRole,
  RunGrounding,
  RunRef,
} from '../../shared/types/runGrounding';

export interface RunGroundingStore {
  insert(input: CreateRunGroundingInput): Promise<RunGrounding>;
  insertMany(inputs: CreateRunGroundingInput[]): Promise<RunGrounding[]>;
  findByRun(ref: RunRef): Promise<RunGrounding[]>;
  findActiveByRole(ref: RunRef, role: RepoRole): Promise<RunGrounding | null>;
  findActiveByRepoBranch(
    query: ActiveRepositoryBranchQuery
  ): Promise<RunGrounding[]>;
  /**
   * Atomically deactivates the current role row and inserts its replacement.
   * Returns null when no active row exists in the supplied run/project scope.
   */
  reground(
    ref: RunRef,
    role: RepoRole,
    newSha: string,
    groundedAt: string
  ): Promise<RunGrounding | null>;
  deactivateByRun(ref: RunRef): Promise<number>;
}

export type RunGroundingRepositoryOperation =
  | 'create'
  | 'activate'
  | 'copy'
  | 'query'
  | 'reground'
  | 'deactivate';

/**
 * Stable error boundary for lifecycle callers. Database error details remain
 * inside the repository rather than becoming part of downstream API contracts.
 */
export class RunGroundingRepositoryError extends Error {
  readonly code = 'run_grounding_persistence_failed';

  constructor(readonly operation: RunGroundingRepositoryOperation) {
    super(`Run grounding ${operation} failed`);
    this.name = 'RunGroundingRepositoryError';
  }
}

export interface RunGroundingRepository {
  createGrounding(input: CreateRunGroundingInput): Promise<RunGrounding>;
  activateGroundings(
    inputs: CreateRunGroundingInput[]
  ): Promise<RunGrounding[]>;
  copyGrounding(
    from: RunRef,
    to: RunRef,
    role: RepoRole
  ): Promise<RunGrounding | null>;
  findByRun(ref: RunRef): Promise<RunGrounding[]>;
  findActiveByRepoBranch(
    query: ActiveRepositoryBranchQuery
  ): Promise<RunGrounding[]>;
  reground(
    ref: RunRef,
    role: RepoRole,
    newSha: string
  ): Promise<RunGrounding | null>;
  deactivateByRun(ref: RunRef): Promise<number>;
}

const scopeConditions = (ref: RunRef) =>
  and(
    eq(runGroundings.runType, ref.runType),
    eq(runGroundings.runId, ref.runId),
    eq(runGroundings.project, ref.project)
  );

const postgresRunGroundingStore: RunGroundingStore = {
  async insert(input) {
    const [row] = await db.insert(runGroundings).values(input).returning();
    return row;
  },

  async insertMany(inputs) {
    return db.transaction(async (tx) => {
      const rows: RunGrounding[] = [];
      for (const input of inputs) {
        const [row] = await tx.insert(runGroundings).values(input).returning();
        rows.push(row);
      }
      return rows;
    });
  },

  async findByRun(ref) {
    return db
      .select()
      .from(runGroundings)
      .where(scopeConditions(ref))
      .orderBy(
        desc(runGroundings.groundedAt),
        desc(runGroundings.createdAt),
        desc(runGroundings.id)
      );
  },

  async findActiveByRole(ref, role) {
    const [row] = await db
      .select()
      .from(runGroundings)
      .where(
        and(
          scopeConditions(ref),
          eq(runGroundings.repoRole, role),
          eq(runGroundings.isActive, true)
        )
      )
      .limit(1);
    return row ?? null;
  },

  async findActiveByRepoBranch(query) {
    return db
      .select()
      .from(runGroundings)
      .where(
        and(
          eq(runGroundings.provider, query.provider),
          eq(runGroundings.project, query.project),
          eq(runGroundings.repository, query.repository),
          eq(runGroundings.branch, query.branch),
          eq(runGroundings.isActive, true)
        )
      );
  },

  async reground(ref, role, newSha, groundedAt) {
    return db.transaction(async (tx) => {
      const [active] = await tx
        .select()
        .from(runGroundings)
        .where(
          and(
            scopeConditions(ref),
            eq(runGroundings.repoRole, role),
            eq(runGroundings.isActive, true)
          )
        )
        .orderBy(
          desc(runGroundings.groundedAt),
          desc(runGroundings.createdAt),
          desc(runGroundings.id)
        )
        .limit(1);
      const [latest] = active
        ? [active]
        : await tx
            .select()
            .from(runGroundings)
            .where(
              and(
                scopeConditions(ref),
                eq(runGroundings.repoRole, role)
              )
            )
            .orderBy(
              desc(runGroundings.groundedAt),
              desc(runGroundings.createdAt),
              desc(runGroundings.id)
            )
            .limit(1);
      const current = active ?? latest;
      if (!current) return null;

      if (active) {
        await tx
          .update(runGroundings)
          .set({
            isActive: false,
            updatedAt: groundedAt,
          })
          .where(
            and(
              eq(runGroundings.id, active.id),
              eq(runGroundings.isActive, true)
            )
          );
      }

      const [replacement] = await tx
        .insert(runGroundings)
        .values({
          ...ref,
          repoRole: role,
          provider: current.provider,
          repository: current.repository,
          branch: current.branch,
          groundedSha: newSha,
          groundedAt,
        })
        .returning();
      return replacement;
    });
  },

  async deactivateByRun(ref) {
    const rows = await db
      .update(runGroundings)
      .set({
        isActive: false,
        updatedAt: sql`now()`,
      })
      .where(and(scopeConditions(ref), eq(runGroundings.isActive, true)))
      .returning({ id: runGroundings.id });
    return rows.length;
  },
};

async function withPersistenceBoundary<T>(
  operation: RunGroundingRepositoryOperation,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch {
    console.warn(`[run-grounding] ${operation} persistence failed`);
    throw new RunGroundingRepositoryError(operation);
  }
}

export function createRunGroundingRepository(
  store: RunGroundingStore = postgresRunGroundingStore,
  options: { now?: () => string } = {}
): RunGroundingRepository {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    createGrounding(input) {
      return withPersistenceBoundary('create', () =>
        store.insert({
          ...input,
          groundedAt: input.groundedAt ?? now(),
        })
      );
    },

    activateGroundings(inputs) {
      return withPersistenceBoundary('activate', () => {
        const groundedAt = now();
        return store.insertMany(
          inputs.map((input) => ({
            ...input,
            groundedAt: input.groundedAt ?? groundedAt,
          }))
        );
      });
    },

    copyGrounding(from, to, role) {
      return withPersistenceBoundary('copy', async () => {
        const source =
          (await store.findActiveByRole(from, role)) ??
          (await store.findByRun(from)).find((row) => row.repoRole === role) ??
          null;
        if (!source) return null;
        return store.insert({
          ...to,
          repoRole: role,
          provider: source.provider,
          repository: source.repository,
          branch: source.branch,
          groundedSha: source.groundedSha,
          groundedAt: now(),
        });
      });
    },

    findByRun(ref) {
      return withPersistenceBoundary('query', () => store.findByRun(ref));
    },

    findActiveByRepoBranch(query) {
      return withPersistenceBoundary('query', () =>
        store.findActiveByRepoBranch(query)
      );
    },

    reground(ref, role, newSha) {
      return withPersistenceBoundary('reground', () =>
        store.reground(ref, role, newSha, now())
      );
    },

    deactivateByRun(ref) {
      return withPersistenceBoundary('deactivate', () =>
        store.deactivateByRun(ref)
      );
    },
  };
}

export const runGroundingRepository = createRunGroundingRepository();
