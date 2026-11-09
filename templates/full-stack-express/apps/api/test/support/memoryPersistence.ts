import { randomUUID } from 'node:crypto';
import type {
  AppUser,
  AppUserPatch,
  AppUserStore,
  NewAppUser,
  Persistence,
} from '../../src/persistence/index.ts';
import { ProfileConflictError } from '../../src/persistence/index.ts';

type Method = 'findBySubject' | 'create' | 'updateBySubject' | 'ping';

export interface MemoryPersistence extends Pick<Persistence, 'users' | 'ping'> {
  /** Every call in order, with the subject it received. */
  readonly calls: { method: Method; subject?: string }[];
  /** Makes every later call to `method` run `behavior` instead. */
  override(method: Method, behavior: (...args: unknown[]) => unknown): void;
  seed(row: NewAppUser): AppUser;
  row(subject: string): AppUser | undefined;
  rowCount(): number;
}

// Each operation yields to the event loop first, so parallel requests
// interleave the way they do against a real pool.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A test double for the persistence module that keeps the real contract: the
 * subject is unique, create throws ProfileConflictError on a duplicate, and an
 * update moves updatedAt forward.
 */
export function createMemoryPersistence(): MemoryPersistence {
  const rows = new Map<string, AppUser>();
  const calls: MemoryPersistence['calls'] = [];
  const overrides = new Map<Method, (...args: unknown[]) => unknown>();
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const nextDate = () => new Date((clock += 1000));

  function insert(input: NewAppUser): AppUser {
    if (rows.has(input.externalSubject)) {
      throw new ProfileConflictError();
    }
    const now = nextDate();
    const row: AppUser = {
      id: randomUUID(),
      externalSubject: input.externalSubject,
      displayName: input.displayName,
      email: input.email ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    rows.set(row.externalSubject, row);
    return { ...row };
  }

  async function run<T>(
    method: Method,
    subject: string | undefined,
    args: unknown[],
    real: () => T
  ): Promise<T> {
    calls.push(subject === undefined ? { method } : { method, subject });
    await tick();
    const behavior = overrides.get(method);
    return behavior ? ((await behavior(...args)) as T) : real();
  }

  const users: AppUserStore = {
    findBySubject: (subject) =>
      run('findBySubject', subject, [subject], () => {
        const row = rows.get(subject);
        return row ? { ...row } : null;
      }),
    create: (input) =>
      run('create', input.externalSubject, [input], () => insert(input)),
    updateBySubject: (subject, patch: AppUserPatch) =>
      run('updateBySubject', subject, [subject, patch], () => {
        const row = rows.get(subject);
        if (!row) {
          return null;
        }
        if (patch.displayName !== undefined) {
          row.displayName = patch.displayName;
        }
        if (patch.email !== undefined) {
          row.email = patch.email;
        }
        row.updatedAt = nextDate();
        return { ...row };
      }),
  };

  return {
    calls,
    users,
    ping: () => run('ping', undefined, [], () => undefined),
    override(method, behavior) {
      overrides.set(method, behavior);
    },
    seed: insert,
    row: (subject) => {
      const row = rows.get(subject);
      return row ? { ...row } : undefined;
    },
    rowCount: () => rows.size,
  };
}
