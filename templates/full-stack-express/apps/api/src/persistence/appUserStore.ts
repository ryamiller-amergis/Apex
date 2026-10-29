import { eq, sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { PersistenceError } from './errors.ts';
import { mapDatabaseError } from './mapDatabaseError.ts';
import { appUsers } from './schema.ts';

export type AppUserStatus = 'active' | 'disabled';

export interface AppUser {
  id: string;
  externalSubject: string;
  displayName: string;
  email: string | null;
  status: AppUserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAppUser {
  externalSubject: string;
  displayName: string;
  /** Omitted means null. Status is always `active`. */
  email?: string | null;
}

export interface AppUserPatch {
  /** Undefined leaves the value unchanged. */
  displayName?: string;
  /** Null clears the value; undefined leaves it unchanged. */
  email?: string | null;
}

export interface AppUserStore {
  findBySubject(subject: string): Promise<AppUser | null>;
  /** Throws ProfileConflictError when the subject already exists. */
  create(input: NewAppUser): Promise<AppUser>;
  /** Returns null when no row matches. An empty patch writes nothing. */
  updateBySubject(
    subject: string,
    patch: AppUserPatch
  ): Promise<AppUser | null>;
}

async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export function createAppUserStore(db: Database): AppUserStore {
  async function findBySubject(subject: string): Promise<AppUser | null> {
    const rows = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.externalSubject, subject))
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    findBySubject: (subject) => guard(() => findBySubject(subject)),

    create: (input) =>
      guard(async () => {
        const [row] = await db
          .insert(appUsers)
          .values({
            externalSubject: input.externalSubject,
            displayName: input.displayName,
            email: input.email ?? null,
          })
          .returning();
        if (!row) {
          throw new PersistenceError();
        }
        return row;
      }),

    updateBySubject: (subject, patch) =>
      guard(async () => {
        const changes: { displayName?: string; email?: string | null } = {};
        if (patch.displayName !== undefined) {
          changes.displayName = patch.displayName;
        }
        if (patch.email !== undefined) {
          changes.email = patch.email;
        }
        if (Object.keys(changes).length === 0) {
          return findBySubject(subject);
        }
        const [row] = await db
          .update(appUsers)
          .set({ ...changes, updatedAt: sql`now()` })
          .where(eq(appUsers.externalSubject, subject))
          .returning();
        return row ?? null;
      }),
  };
}
