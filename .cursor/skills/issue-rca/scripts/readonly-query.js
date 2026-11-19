#!/usr/bin/env node
/**
 * Run one read-only SQL statement against DATABASE_URL or PROD_DATABASE_URL.
 *
 * Usage (from repo root):
 *   node .cursor/skills/issue-rca/scripts/readonly-query.js "SELECT id FROM chat_threads WHERE id = $1 LIMIT 5" <id>
 *
 * Opens a READ ONLY transaction, sets a 15s statement timeout, returns at most
 * 50 rows, and redacts credential-like column values. Never prints the URL.
 * Refuses anything other than a single SELECT, WITH, EXPLAIN, or SHOW.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MAX_ROWS = 50;
const STATEMENT_TIMEOUT_MS = 15000;
const MAX_SQL_CHARS = 4000;

const sql = process.argv[2];
const params = process.argv.slice(3);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function loadEnvFile(name) {
  const filePath = path.join(process.cwd(), name);
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function assertReadOnly(statement) {
  if (!statement || !statement.trim()) {
    fail('Usage: node readonly-query.js "<sql>" [param...]');
  }
  if (statement.length > MAX_SQL_CHARS) {
    fail(`SQL is longer than ${MAX_SQL_CHARS} characters`);
  }
  const body = statement.trim().replace(/;+\s*$/g, '');
  if (body.includes(';')) {
    fail('Only one SQL statement is allowed');
  }
  if (!/^(select|with|explain|show)\b/i.test(body)) {
    fail('Only SELECT, WITH, EXPLAIN, or SHOW statements are allowed');
  }
  if (/^\s*(explain\b[^;]*\b(analyze|analyse)\b)/i.test(body)) {
    fail('EXPLAIN ANALYZE runs the statement; use EXPLAIN without ANALYZE');
  }
  return body;
}

function redact(rows) {
  const sensitive = /password|secret|token|connection_string|api_key|credential/i;
  return rows.map((row) => {
    const copy = {};
    for (const [key, value] of Object.entries(row)) {
      copy[key] = sensitive.test(key) ? '[redacted]' : value;
    }
    return copy;
  });
}

async function main() {
  const statement = assertReadOnly(sql);
  loadEnvFile('.env');
  loadEnvFile('.env.local');

  const connectionString = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    fail('Set PROD_DATABASE_URL or DATABASE_URL (or add DATABASE_URL to .env). Do not fetch it from Azure.');
  }

  const client = new Client({
    connectionString,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const result = await client.query(statement, params);
    await client.query('ROLLBACK');
    const rows = Array.isArray(result.rows) ? result.rows : [];
    console.log(JSON.stringify({
      rowCount: result.rowCount,
      truncated: rows.length > MAX_ROWS,
      rows: redact(rows.slice(0, MAX_ROWS)),
    }, null, 2));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already closed */ }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
