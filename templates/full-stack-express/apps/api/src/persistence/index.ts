// The only public surface of the persistence module. Code outside
// src/persistence imports from here and never from drizzle-orm or pg.
import { sql } from 'drizzle-orm';
import { createAppUserStore, type AppUserStore } from './appUserStore.ts';
import { createDatabaseClient } from './client.ts';
import { mapDatabaseError } from './mapDatabaseError.ts';

export type {
  AppUser,
  AppUserPatch,
  AppUserStatus,
  AppUserStore,
  NewAppUser,
} from './appUserStore.ts';
export {
  PersistenceError,
  PersistenceUnavailableError,
  ProfileConflictError,
  SchemaNotMigratedError,
} from './errors.ts';

export interface Persistence {
  users: AppUserStore;
  /** Throws PersistenceUnavailableError when the database cannot be reached. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createPersistence(options: {
  databaseUrl: string;
  /**
   * How long a query waits for a pool connection. Keep it at or below the
   * readiness timeout, so an abandoned readiness ping frees its slot.
   */
  connectionTimeoutMs?: number;
}): Persistence {
  const client = createDatabaseClient(
    options.databaseUrl,
    options.connectionTimeoutMs
  );
  return {
    users: createAppUserStore(client.db),
    async ping() {
      try {
        await client.db.execute(sql`select 1`);
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },
    close: () => client.end(),
  };
}
