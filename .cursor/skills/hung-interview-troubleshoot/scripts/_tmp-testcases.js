#!/usr/bin/env node
const { Client } = require('pg');

async function main() {
  const c = new Client({
    connectionString: process.env.DEV_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const prds = await c.query(
    `SELECT id, title, status, length(content) AS content_len, chat_thread_id,
            test_case_thread_id, updated_at, created_at
     FROM prds
     WHERE project = 'MaxView' AND title ILIKE '%counter%'
     ORDER BY created_at DESC
     LIMIT 5`,
  );
  console.log('=== PRDS ===');
  console.log(JSON.stringify(prds.rows, null, 2));

  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'prds' AND column_name ILIKE '%test%'
     ORDER BY column_name`,
  );
  console.log('=== PRD TEST COLS ===');
  console.log(cols.rows.map((r) => r.column_name).join(', '));

  const runs = await c.query(
    `SELECT id, status, last_error, progress_label, progress_phase, lane,
            execution_snapshot->>'workflowClass' AS workflow_class,
            execution_snapshot->>'workspaceRef' AS workspace_ref,
            execution_snapshot->>'checkoutRef' AS checkout_ref,
            left(execution_snapshot->>'skillPath', 80) AS skill_path,
            started_at, updated_at
     FROM agent_runs
     WHERE project_id = 'MaxView'
       AND created_at > NOW() - INTERVAL '4 hours'
     ORDER BY created_at DESC
     LIMIT 20`,
  );
  console.log('=== RECENT RUNS ===');
  console.log(JSON.stringify(runs.rows, null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
