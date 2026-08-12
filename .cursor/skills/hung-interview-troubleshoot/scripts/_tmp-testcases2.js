#!/usr/bin/env node
const { Client } = require('pg');

async function main() {
  const c = new Client({
    connectionString: process.env.DEV_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'prds' ORDER BY ordinal_position`,
  );
  console.log(
    'prd cols with test/case/thread:',
    cols.rows
      .map((r) => r.column_name)
      .filter((n) => /test|case|thread|status/i.test(n))
      .join(', '),
  );

  const prds = await c.query(
    `SELECT id, title, status, length(content) AS content_len, chat_thread_id,
            updated_at, created_at
     FROM prds
     WHERE project = 'MaxView' AND title ILIKE '%counter%'
     ORDER BY created_at DESC
     LIMIT 5`,
  );
  console.log('=== PRDS ===');
  console.log(JSON.stringify(prds.rows, null, 2));

  for (const p of prds.rows.slice(0, 2)) {
    const t = await c.query(
      `SELECT id, status, last_error, skill_path, workspace_dir, last_activity_at
       FROM chat_threads WHERE id = $1`,
      [p.chat_thread_id],
    );
    console.log('=== PRD THREAD', p.id, '===');
    console.log(JSON.stringify(t.rows[0], null, 2));
  }

  const runs = await c.query(
    `SELECT id, status, last_error, progress_label, lane,
            execution_snapshot->>'workflowClass' AS workflow_class,
            execution_snapshot->>'workspaceRef' AS workspace_ref,
            started_at, updated_at
     FROM agent_runs
     WHERE created_at > NOW() - INTERVAL '2 hours'
       AND (
         execution_snapshot->>'workflowClass' = 'test-cases'
         OR execution_snapshot->>'skillPath' ILIKE '%test-case%'
         OR id::text IN (
           SELECT chat_thread_id::text FROM prds
           WHERE project='MaxView' AND title ILIKE '%counter%'
           ORDER BY created_at DESC LIMIT 3
         )
       )
     ORDER BY created_at DESC
     LIMIT 20`,
  );
  console.log('=== TEST/PRD RUNS ===');
  console.log(JSON.stringify(runs.rows, null, 2));

  // threads with test-case skill recently
  const threads = await c.query(
    `SELECT id, status, last_error, skill_path, workspace_dir, last_activity_at, created_at
     FROM chat_threads
     WHERE skill_path ILIKE '%test-case%'
       AND created_at > NOW() - INTERVAL '4 hours'
     ORDER BY created_at DESC
     LIMIT 10`,
  );
  console.log('=== TEST-CASE THREADS ===');
  console.log(JSON.stringify(threads.rows, null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
