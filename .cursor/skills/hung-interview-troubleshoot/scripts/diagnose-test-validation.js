#!/usr/bin/env node
/**
 * Diagnose PRD test-case generation + validation pipeline from Postgres.
 *
 * Usage:
 *   node diagnose-test-validation.js --env dev <prdId>
 *   DEV_DATABASE_URL=... node diagnose-test-validation.js <prdId>
 *
 * What to look for after the thin/scratch deploy:
 *   - test-cases agent_run: workflow_class=test-cases, checkout_ref set (shared SHA),
 *     workspace_ref = thread path (NOT a full MaxView clone under grounding-workspaces)
 *   - validation agent_run: workflow_class=validation, checkout_ref NULL,
 *     materialization reason scratch-only (App Insights), workspace_ref = thread path
 *   - test_cases.status ready + non-empty test_cases_json before validation starts
 *   - prds.status validating → pending_review/draft with validation_score set
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ENV_PATH = path.join(
  __dirname,
  '..',
  '..',
  'interactive-chat-troubleshoot',
  'environments.json',
);

function parseArgs(argv) {
  let env = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--env' || argv[i] === '-e') && argv[i + 1]) {
      env = argv[++i];
      continue;
    }
    if (argv[i].startsWith('--env=')) {
      env = argv[i].slice(6);
      continue;
    }
    rest.push(argv[i]);
  }
  return { env, prdId: rest[0] };
}

function fetchDatabaseUrl(envKey) {
  const data = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8'));
  const cfg = data.envs[envKey];
  if (!cfg) throw new Error(`Unknown env: ${envKey}`);
  const r = spawnSync(
    'az',
    [
      'webapp',
      'config',
      'appsettings',
      'list',
      '--name',
      cfg.appName,
      '--resource-group',
      cfg.appResourceGroup,
      '--query',
      "[?name=='DATABASE_URL'].value",
      '-o',
      'tsv',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  const url = (r.stdout || '').trim();
  if (!url || !url.startsWith('postgres')) {
    throw new Error(`Failed to fetch DATABASE_URL for ${cfg.appName}`);
  }
  return url;
}

async function dumpThread(c, label, threadId) {
  if (!threadId) {
    console.log(`=== ${label} ===`);
    console.log('(none)');
    return null;
  }
  const t = await c.query(
    `SELECT id, status, active_run_id, last_error, last_activity_at,
            grounding_mode,
            kickoff->>'skillPath' AS skill_path,
            kickoff->>'skillProvider' AS skill_provider,
            kickoff->>'project' AS kickoff_project,
            kickoff->>'repo' AS kickoff_repo,
            kickoff->>'model' AS kickoff_model,
            workspace_dir
     FROM chat_threads WHERE id = $1`,
    [threadId],
  );
  console.log(`=== ${label} THREAD ===`);
  console.log(JSON.stringify(t.rows[0] ?? null, null, 2));

  const runs = await c.query(
    `SELECT id, status, lane, progress_label, progress_phase,
            last_error, created_at, updated_at, started_at,
            EXTRACT(EPOCH FROM (NOW() - heartbeat_at::timestamptz))::int AS heartbeat_age_s,
            EXTRACT(EPOCH FROM (NOW() - progress_at::timestamptz))::int AS progress_age_s,
            execution_snapshot->>'workflowClass' AS workflow_class,
            execution_snapshot->>'workspaceRef' AS workspace_ref,
            execution_snapshot->>'checkoutRef' AS checkout_ref,
            left(execution_snapshot->>'skillPath', 120) AS skill_path
     FROM agent_runs
     WHERE thread_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [threadId],
  );
  console.log(`=== ${label} AGENT RUNS ===`);
  console.log(JSON.stringify(runs.rows, null, 2));

  if (runs.rows[0]) {
    const tools = await c.query(
      `SELECT event_type, status, left(detail::text, 200) AS detail, event_timestamp
       FROM agent_run_events
       WHERE run_id = $1 AND event_type = 'tool'
       ORDER BY ordinal DESC LIMIT 8`,
      [runs.rows[0].id],
    );
    console.log(`=== ${label} LAST TOOL EVENTS (${runs.rows[0].id}) ===`);
    console.log(JSON.stringify(tools.rows, null, 2));
  }

  const msgs = await c.query(
    `SELECT role, left(text, 180) AS preview, ts
     FROM chat_messages WHERE thread_id = $1
     ORDER BY ts DESC LIMIT 4`,
    [threadId],
  );
  console.log(`=== ${label} RECENT MSGS ===`);
  console.log(JSON.stringify(msgs.rows, null, 2));

  return t.rows[0] ?? null;
}

function classifyPath(workspaceRef, checkoutRef) {
  const ws = workspaceRef || '';
  const co = checkoutRef || '';
  const thinThread =
    /[/\\]workspaces[/\\][0-9a-f-]{36}/i.test(ws)
    || /[/\\]threads[/\\]/i.test(ws)
    || /[/\\]chat-threads[/\\]/i.test(ws);
  const groundingWs = /grounding-workspaces|[/\\]workspaces[/\\]grounding[/\\]/i.test(ws);
  const shared = /grounding-shared/i.test(co);
  if (!ws && !co) return 'unknown-empty';
  if (thinThread && shared) return 'thin+shared-read (expected for test-cases)';
  if (thinThread && !co) return 'scratch-only thread (expected for validation)';
  if (groundingWs) return 'legacy full clone (unexpected after thin deploy)';
  return 'other';
}

async function main() {
  const { env, prdId } = parseArgs(process.argv.slice(2));
  if (!prdId) {
    console.error('Usage: diagnose-test-validation.js [--env dev|stg|prd] <prdId>');
    process.exit(2);
  }

  const connectionString =
    process.env.APEX_TROUBLESHOOT_DATABASE_URL ||
    process.env.DEV_DATABASE_URL ||
    process.env.PROD_DATABASE_URL ||
    process.env.DATABASE_URL ||
    (env ? fetchDatabaseUrl(env === 'staging' ? 'stg' : env) : null);

  if (!connectionString) {
    console.error('Set DATABASE_URL or pass --env dev|stg|prd');
    process.exit(2);
  }

  const c = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const prd = await c.query(
    `SELECT id, title, status, project, interview_id, chat_thread_id,
            validation_thread_id, validation_score, validation_phase,
            length(content) AS content_len,
            length(validation_report_md) AS report_len,
            (validation_scorecard IS NOT NULL) AS has_scorecard,
            updated_at, created_at
     FROM prds WHERE id = $1`,
    [prdId],
  );
  console.log('=== PRD ===');
  console.log(JSON.stringify(prd.rows[0] ?? null, null, 2));
  if (!prd.rows[0]) {
    await c.end();
    process.exit(1);
  }

  const tcs = await c.query(
    `SELECT id, status, chat_thread_id,
            length(coalesce(test_cases_md, '')) AS md_len,
            (test_cases_json IS NOT NULL) AS has_json,
            CASE
              WHEN jsonb_typeof(test_cases_json) = 'array'
                THEN jsonb_array_length(test_cases_json)
              WHEN test_cases_json ? 'test_cases'
                   AND jsonb_typeof(test_cases_json->'test_cases') = 'array'
                THEN jsonb_array_length(test_cases_json->'test_cases')
              ELSE NULL
            END AS case_count,
            coverage_summary,
            created_at, updated_at
     FROM test_cases
     WHERE prd_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [prdId],
  );
  console.log('=== TEST CASES ROWS ===');
  console.log(JSON.stringify(tcs.rows, null, 2));

  const latestTc = tcs.rows[0] ?? null;
  const tcThread = await dumpThread(c, 'TEST-CASES', latestTc?.chat_thread_id);
  const valThread = await dumpThread(
    c,
    'VALIDATION',
    prd.rows[0].validation_thread_id,
  );

  // Recent pipeline runs for this PRD (by thread ids + workflow class window)
  const threadIds = [
    latestTc?.chat_thread_id,
    prd.rows[0].validation_thread_id,
    prd.rows[0].chat_thread_id,
  ].filter(Boolean);

  const pipelineRuns = await c.query(
    `SELECT id, thread_id, status, lane, last_error, progress_label,
            created_at, updated_at,
            execution_snapshot->>'workflowClass' AS workflow_class,
            execution_snapshot->>'workspaceRef' AS workspace_ref,
            execution_snapshot->>'checkoutRef' AS checkout_ref
     FROM agent_runs
     WHERE thread_id = ANY($1::text[])
        OR (
          created_at > NOW() - INTERVAL '6 hours'
          AND execution_snapshot->>'workflowClass' IN ('test-cases', 'validation')
          AND (
            execution_snapshot->>'threadId' = ANY($1::text[])
            OR thread_id = ANY($1::text[])
          )
        )
     ORDER BY created_at DESC
     LIMIT 15`,
    [threadIds.map(String)],
  );
  console.log('=== PIPELINE RUN PATH CLASSIFICATION ===');
  for (const row of pipelineRuns.rows) {
    console.log(
      JSON.stringify(
        {
          id: row.id,
          thread_id: row.thread_id,
          status: row.status,
          workflow_class: row.workflow_class,
          path_class: classifyPath(row.workspace_ref, row.checkout_ref),
          workspace_ref: row.workspace_ref,
          checkout_ref: row.checkout_ref,
          last_error: row.last_error,
          progress_label: row.progress_label,
          created_at: row.created_at,
        },
        null,
        2,
      ),
    );
  }

  // Groundings on destination threads (validation should not need materialize)
  const gr = await c.query(
    `SELECT run_type, run_id, repo_role, is_active, provider, project, repository,
            branch, grounded_sha, grounded_at, created_at
     FROM run_groundings
     WHERE run_id = ANY($1::text[])
     ORDER BY created_at DESC
     LIMIT 12`,
    [threadIds.map(String)],
  ).catch((err) => {
    console.log('run_groundings query error', err.message);
    return { rows: [] };
  });
  console.log('=== RUN GROUNDINGS (pipeline threads) ===');
  console.log(JSON.stringify(gr.rows, null, 2));

  // Compact verdict for watchers / humans
  const verdict = {
    prd_status: prd.rows[0].status,
    test_cases_status: latestTc?.status ?? null,
    test_cases_has_json: latestTc?.has_json ?? false,
    test_cases_case_count: latestTc?.case_count ?? null,
    validation_thread: Boolean(prd.rows[0].validation_thread_id),
    validation_score: prd.rows[0].validation_score,
    validation_phase: prd.rows[0].validation_phase,
    has_scorecard: prd.rows[0].has_scorecard,
    test_cases_thread_status: tcThread?.status ?? null,
    validation_thread_status: valThread?.status ?? null,
  };
  console.log('=== VERDICT ===');
  console.log(JSON.stringify(verdict, null, 2));

  const now = await c.query(`SELECT NOW() AS now`);
  console.log('=== DB NOW ===');
  console.log(JSON.stringify(now.rows[0], null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
