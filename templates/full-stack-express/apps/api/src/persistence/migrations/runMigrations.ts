// Imported only by src/cli/migrate.ts and test support. The API's startup
// path never changes the schema (lint rule and source scan enforce this).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import { PersistenceError } from '../errors.ts';
import { findDriverError, mapDatabaseError } from '../mapDatabaseError.ts';

const CONNECTION_TIMEOUT_MS = 5000;
// Arbitrary, fixed key shared by every migrate run against a database, so two
// simultaneous runs queue instead of racing.
const MIGRATION_LOCK_KEY = 7340192711;

export interface Migration {
  tag: string;
  statements: string[];
  hash: string;
  folderMillis: number;
}

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsFolder: string;
}

export interface RunMigrationsResult {
  applied: string[];
}

export class MigrationFailedError extends Error {
  readonly tag: string;
  readonly sqlState: string;
  readonly reason: string;

  constructor(tag: string, sqlState: string, reason: string) {
    super(`Migration ${tag} failed.`);
    this.name = 'MigrationFailedError';
    this.tag = tag;
    this.sqlState = sqlState;
    this.reason = reason;
  }
}

export class MigrationsFolderError extends Error {
  constructor(folder: string) {
    super(`Cannot read migrations from ${folder}.`);
    this.name = 'MigrationsFolderError';
  }
}

// Same files, order, and hashes as Drizzle's own migrator, plus each tag.
export function readMigrations(migrationsFolder: string): Migration[] {
  try {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { tag: string }[] };
    const files = readMigrationFiles({ migrationsFolder });
    return files.map((file, index) => ({
      tag: journal.entries[index]?.tag ?? `#${index}`,
      statements: file.sql,
      hash: file.hash,
      folderMillis: file.folderMillis,
    }));
  } catch {
    throw new MigrationsFolderError(migrationsFolder);
  }
}

// Applies each pending file in its own transaction and records it in
// drizzle.__drizzle_migrations, as Drizzle's migrator does. Drizzle's migrate()
// runs the whole batch in one transaction and cannot name the failing file.
export async function runMigrations(
  options: RunMigrationsOptions
): Promise<RunMigrationsResult> {
  const migrations = readMigrations(options.migrationsFolder);
  const client = new pg.Client({
    connectionString: options.databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    throw mapDatabaseError(error);
  }

  const db = drizzle({ client });
  const applied: string[] = [];
  try {
    await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    await db.execute(sql`create schema if not exists "drizzle"`);
    await db.execute(sql`
      create table if not exists "drizzle"."__drizzle_migrations" (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);
    const last = await db.execute<{ created_at: string | null }>(
      sql`select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`
    );
    const lastMillis = Number(last.rows[0]?.created_at ?? Number.NaN);

    for (const migration of migrations) {
      if (!Number.isNaN(lastMillis) && migration.folderMillis <= lastMillis) {
        continue;
      }
      try {
        await db.transaction(async (tx) => {
          for (const statement of migration.statements) {
            await tx.execute(sql.raw(statement));
          }
          await tx.execute(
            sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values (${migration.hash}, ${migration.folderMillis})`
          );
        });
      } catch (error) {
        const driver = findDriverError(error);
        if (driver !== null && /^[0-9A-Z]{5}$/.test(driver.code)) {
          throw new MigrationFailedError(
            migration.tag,
            driver.code,
            driver.message ?? ''
          );
        }
        throw mapDatabaseError(error);
      }
      applied.push(migration.tag);
    }
    return { applied };
  } catch (error) {
    if (
      error instanceof MigrationFailedError ||
      error instanceof PersistenceError
    ) {
      throw error;
    }
    throw mapDatabaseError(error);
  } finally {
    // Ending the session also releases the advisory lock.
    await client.end().catch(() => {});
  }
}
