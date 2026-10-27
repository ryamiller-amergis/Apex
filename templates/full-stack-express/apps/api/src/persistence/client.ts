import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

const CONNECTION_TIMEOUT_MS = 5000;

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  db: Database;
  end(): Promise<void>;
}

export function createDatabaseClient(
  databaseUrl: string,
  connectionTimeoutMs: number = CONNECTION_TIMEOUT_MS
): DatabaseClient {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectionTimeoutMs,
  });
  // An idle client error would otherwise crash the process. The next query
  // reports the failure through mapDatabaseError.
  pool.on('error', () => {});
  return {
    db: drizzle({ client: pool, schema }),
    end: () => pool.end(),
  };
}
