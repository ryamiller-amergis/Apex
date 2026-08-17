#!/usr/bin/env node
const { Client } = require('pg');

async function main() {
  const enabled = process.argv.includes('--on');
  const disabled = process.argv.includes('--off');
  if (enabled === disabled) {
    console.error('Usage: _tmp-set-bg-flag.js --on | --off');
    process.exit(2);
  }
  const c = new Client({
    connectionString: process.env.DEV_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const after = await c.query(
    `UPDATE feature_flags
     SET enabled = $1, updated_at = NOW()
     WHERE key = 'ai-runs-background'
     RETURNING key, enabled, updated_at`,
    [enabled],
  );
  console.log(JSON.stringify(after.rows[0], null, 2));
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
