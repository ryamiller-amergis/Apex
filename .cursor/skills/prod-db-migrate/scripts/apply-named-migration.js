#!/usr/bin/env node
/**
 * Apply a single migrations/*.sql file by name and record it in pgmigrations.
 * Use when you need one seed/hotfix migration on prod without applying other pending files.
 *
 * Usage (repo root):
 *   node .cursor/skills/prod-db-migrate/scripts/apply-named-migration.js 20260730200000_seed-production-grounded-checkout-interviews-adr
 *
 * Never logs the connection string.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const nameArg = process.argv[2];
if (!nameArg) {
  console.error('Usage: node apply-named-migration.js <migration-name-without-or-with-.sql>');
  process.exit(2);
}

const name = nameArg.replace(/\.sql$/i, '');
const connectionString = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set PROD_DATABASE_URL or DATABASE_URL');
  process.exit(2);
}

const filePath = path.resolve(process.cwd(), 'migrations', `${name}.sql`);
if (!fs.existsSync(filePath)) {
  console.error(`Migration file not found: ${filePath}`);
  process.exit(2);
}

const sql = fs.readFileSync(filePath, 'utf8');

async function main() {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pgmigrations WHERE name = $1', [name]);
    if (existing.rowCount > 0) {
      console.log(`ALREADY_APPLIED=${name}`);
      return;
    }

    console.log(`APPLYING=${name}`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO pgmigrations (name, run_on) VALUES ($1, NOW())', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    console.log(`APPLIED_OK=${name}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
