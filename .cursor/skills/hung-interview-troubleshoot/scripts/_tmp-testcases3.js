#!/usr/bin/env node
const { Client } = require('pg');

async function main() {
  const c = new Client({
    connectionString: process.env.DEV_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const tcols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'chat_threads' ORDER BY ordinal_position`,
  );
  console.log(
    'thread cols:',
    tcols.rows.map((r) => r.column_name).filter((n) => /skill|work|error|status|kick/i.test(n)).join(', '),
  );

  const threads = await c.query(
    `SELECT id, status, last_error, workspace_dir, last_activity_at, created_at,
            kickoff->>'skillPath' AS skill_path
     FROM chat_threads
     WHERE created_at > NOW() - INTERVAL '4 hours'
       AND (
         kickoff->>'skillPath' ILIKE '%test-case%'
         OR id = '0eef7fd0-43ba-4af4-b0c3-74e88b202d1d'
       )
     ORDER BY created_at DESC
     LIMIT 10`,
  );
  console.log('=== THREADS ===');
  console.log(JSON.stringify(threads.rows, null, 2));

  const runs = await c.query(
    `SELECT id, status, last_error, progress_label, lane,
            execution_snapshot->>'workflowClass' AS workflow_class,
            execution_snapshot->>'workspaceRef' AS workspace_ref,
            execution_snapshot->>'checkoutRef' AS checkout_ref,
            started_at, updated_at
     FROM agent_runs
     WHERE created_at > NOW() - INTERVAL '2 hours'
     ORDER BY created_at DESC
     LIMIT 15`,
  );
  console.log('=== RUNS ===');
  console.log(JSON.stringify(runs.rows, null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
