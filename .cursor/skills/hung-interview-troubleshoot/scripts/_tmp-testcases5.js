#!/usr/bin/env node
const { Client } = require('pg');

async function main() {
  const c = new Client({
    connectionString: process.env.DEV_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='test_cases' ORDER BY 1`,
  );
  console.log(cols.rows.map((r) => r.column_name).join(','));
  const tcs = await c.query(
    `SELECT * FROM test_cases WHERE prd_id='b6528478-2e79-4489-a0cf-82c7c71d3ff7' ORDER BY created_at DESC`,
  );
  const rows = tcs.rows.map((r) => {
    const copy = { ...r };
    for (const [k, v] of Object.entries(copy)) {
      if (typeof v === 'string' && v.length > 300) copy[k] = v.slice(0, 300) + '…';
      if (v && typeof v === 'object') copy[k] = '[object]';
    }
    return copy;
  });
  console.log(JSON.stringify(rows, null, 2));
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
