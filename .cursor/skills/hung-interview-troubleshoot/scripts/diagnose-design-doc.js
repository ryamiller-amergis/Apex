#!/usr/bin/env node
/**
 * Quick design-doc generation + validation diagnose (DEV).
 * Usage: node diagnose-design-doc.js --env dev <designDocId>
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
    rest.push(argv[i]);
  }
  return { env, designDocId: rest[0] };
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

function classifyPath(workspaceRef, checkoutRef) {
  const ws = workspaceRef || '';
  const co = checkoutRef || '';
  const thinThread = /[/\\]workspaces[/\\][0-9a-f-]{36}/i.test(ws);
  const groundingWs = /grounding-workspaces|[/\\]workspaces[/\\]grounding[/\\]/i.test(ws);
  const shared = /grounding-shared/i.test(co);
  if (thinThread && shared) return 'thin+shared-read (expected for design-doc gen)';
  if (thinThread && !co) return 'scratch-only thread (expected for validation)';
  if (groundingWs) return 'legacy full clone';
  return 'other';
}

async function dumpThread(c, label, threadId) {
  if (!threadId) {
    console.log(`=== ${label} ===`);
    console.log('(none)');
    return;
  }
  const t = await c.query(
    `SELECT id, status, active_run_id, last_error, last_activity_at,
            kickoff->>'skillPath' AS skill_path, workspace_dir
     FROM chat_threads WHERE id = $1`,
    [threadId],
  );
  console.log(`=== ${label} THREAD ===`);
  console.log(JSON.stringify(t.rows[0] ?? null, null, 2));

  const runs = await c.query(
    `SELECT id, status, lane, progress_label, progress_phase, last_error,
            created_at, updated_at,
            EXTRACT(EPOCH FROM (NOW() - heartbeat_at::timestamptz))::int AS hb_s,
            EXTRACT(EPOCH FROM (NOW() - progress_at::timestamptz))::int AS prog_s,
            execution_snapshot->>'workflowClass' AS workflow_class,
            execution_snapshot->>'workspaceRef' AS workspace_ref,
            execution_snapshot->>'checkoutRef' AS checkout_ref
     FROM agent_runs
     WHERE thread_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [threadId],
  );
  console.log(`=== ${label} RUNS ===`);
  for (const row of runs.rows) {
    console.log(
      JSON.stringify(
        {
          ...row,
          path_class: classifyPath(row.workspace_ref, row.checkout_ref),
        },
        null,
        2,
      ),
    );
  }

  if (runs.rows[0]) {
    const tools = await c.query(
      `SELECT status, left(detail::text, 180) AS detail, event_timestamp
       FROM agent_run_events
       WHERE run_id = $1 AND event_type = 'tool'
       ORDER BY ordinal DESC LIMIT 6`,
      [runs.rows[0].id],
    );
    console.log(`=== ${label} TOOLS ===`);
    console.log(JSON.stringify(tools.rows, null, 2));
  }
}

async function main() {
  const { env, designDocId } = parseArgs(process.argv.slice(2));
  if (!designDocId) {
    console.error('Usage: diagnose-design-doc.js [--env dev] <designDocId>');
    process.exit(2);
  }
  const connectionString =
    process.env.APEX_TROUBLESHOOT_DATABASE_URL ||
    process.env.DEV_DATABASE_URL ||
    process.env.DATABASE_URL ||
    (env ? fetchDatabaseUrl(env === 'staging' ? 'stg' : env) : null);
  if (!connectionString) {
    console.error('Set DATABASE_URL or pass --env dev');
    process.exit(2);
  }

  const c = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const doc = await c.query(
    `SELECT id, title, status, project, prd_id, chat_thread_id, validation_thread_id,
            validation_score, validation_phase, generation_error,
            length(design_content) AS design_len,
            length(tech_spec_content) AS tech_len,
            length(assumptions_content) AS assum_len,
            (validation_scorecard IS NOT NULL) AS has_scorecard,
            updated_at, created_at
     FROM design_docs WHERE id = $1`,
    [designDocId],
  );
  console.log('=== DESIGN DOC ===');
  console.log(JSON.stringify(doc.rows[0] ?? null, null, 2));
  if (!doc.rows[0]) {
    await c.end();
    process.exit(1);
  }

  await dumpThread(c, 'GENERATION', doc.rows[0].chat_thread_id);
  await dumpThread(c, 'VALIDATION', doc.rows[0].validation_thread_id);

  const now = await c.query(`SELECT NOW() AS now`);
  console.log('=== DB NOW ===');
  console.log(JSON.stringify(now.rows[0], null, 2));
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
