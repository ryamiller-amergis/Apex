#!/usr/bin/env node
/**
 * Run a read-only SQL verify query against PROD_DATABASE_URL / DATABASE_URL.
 * Usage:
 *   node .cursor/skills/prod-db-migrate/scripts/verify-query.js "SELECT id, title, status FROM adrs WHERE id = $1" <uuid>
 *
 * Args after the SQL are bound as $1, $2, ...
 * Never logs the connection string.
 */
const { Client } = require('pg');

const sql = process.argv[2];
const params = process.argv.slice(3);

if (!sql) {
  console.error('Usage: node verify-query.js "<sql>" [param...]');
  process.exit(2);
}

const connectionString = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set PROD_DATABASE_URL or DATABASE_URL');
  process.exit(2);
}

async function main() {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const result = await client.query(sql, params);
    console.log(JSON.stringify({ rowCount: result.rowCount, rows: result.rows }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
