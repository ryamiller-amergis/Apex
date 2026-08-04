#!/usr/bin/env node
/**
 * List migration files pending on the target DB (PROD_DATABASE_URL / DATABASE_URL).
 * Never logs the connection string.
 *
 * Usage (repo root):
 *   node .cursor/skills/prod-db-migrate/scripts/list-pending-migrations.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const connectionString = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set PROD_DATABASE_URL or DATABASE_URL');
  process.exit(2);
}

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.replace(/\.sql$/, ''))
  .sort();

async function main() {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const { rows } = await client.query('SELECT name FROM pgmigrations');
    const applied = new Set(rows.map((r) => r.name));
    const pending = files.filter((name) => !applied.has(name));

    console.log(`APPLIED_COUNT=${applied.size}`);
    console.log(`DISK_COUNT=${files.length}`);
    console.log(`PENDING_COUNT=${pending.length}`);
    for (const name of pending) {
      console.log(`PENDING ${name}`);
    }
    if (pending.length === 0) {
      console.log('NO_PENDING');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
