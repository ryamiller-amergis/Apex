#!/usr/bin/env node
/**
 * Diagnose a PRD generation hang from Postgres.
 *
 * Usage:
 *   DEV_DATABASE_URL=... node diagnose-prd.js <prdId>
 *   node diagnose-prd.js --env dev <prdId>
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
  'environments.json'
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
    { encoding: 'utf8', shell: process.platform === 'win32' }
  );
  const url = (r.stdout || '').trim();
  if (!url || !url.startsWith('postgres')) {
    throw new Error(`Failed to fetch DATABASE_URL for ${cfg.appName}`);
  }
  return url;
}

async function main() {
  const { env, prdId } = parseArgs(process.argv.slice(2));
  if (!prdId) {
    console.error('Usage: diagnose-prd.js [--env dev|stg|prd] <prdId>');
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
    `SELECT id, title, status, interview_id, chat_thread_id, project,
            length(content) AS content_len, updated_at, created_at
     FROM prds WHERE id = $1`,
    [prdId]
  );
  console.log('=== PRD ===');
  console.log(JSON.stringify(prd.rows[0], null, 2));

  const threadId = prd.rows[0]?.chat_thread_id;
  if (!threadId) {
    await c.end();
    return;
  }

  const t = await c.query(
    `SELECT id, status, active_run_id, last_error, last_activity_at,
            grounding_mode, kickoff->>'skillPath' AS skill_path,
            kickoff->>'skillProvider' AS skill_provider,
            kickoff->>'project' AS kickoff_project,
            kickoff->>'repo' AS kickoff_repo,
            kickoff->>'branch' AS kickoff_branch,
            kickoff->>'model' AS kickoff_model,
            workspace_dir
     FROM chat_threads WHERE id = $1`,
    [threadId]
  );
  console.log('=== THREAD ===');
  console.log(JSON.stringify(t.rows[0], null, 2));

  const runs = await c.query(
    `SELECT id, status, progress_label, progress_phase, heartbeat_at, progress_at,
            last_error, created_at, updated_at,
            EXTRACT(EPOCH FROM (NOW() - heartbeat_at::timestamptz))::int AS heartbeat_age_s,
            EXTRACT(EPOCH FROM (NOW() - progress_at::timestamptz))::int AS progress_age_s
     FROM agent_runs WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 3`,
    [threadId]
  );
  console.log('=== AGENT RUNS ===');
  console.log(JSON.stringify(runs.rows, null, 2));

  if (runs.rows[0]) {
    const tools = await c.query(
      `SELECT event_type, status, detail, event_timestamp
       FROM agent_run_events
       WHERE run_id = $1 AND event_type = 'tool'
       ORDER BY ordinal DESC LIMIT 5`,
      [runs.rows[0].id]
    );
    console.log('=== LAST TOOL EVENTS ===');
    console.log(JSON.stringify(tools.rows, null, 2));
  }

  const msgs = await c.query(
    `SELECT role, left(text, 200) AS preview, ts
     FROM chat_messages WHERE thread_id = $1 ORDER BY ts DESC LIMIT 4`,
    [threadId]
  );
  console.log('=== RECENT MSGS ===');
  console.log(JSON.stringify(msgs.rows, null, 2));

  const interviewId = prd.rows[0]?.interview_id;
  let interviewThreadId = null;
  if (interviewId) {
    const i = await c.query(
      `SELECT id, title, status, chat_thread_id, project, repo, model, updated_at
       FROM interviews WHERE id = $1`,
      [interviewId]
    );
    console.log('=== INTERVIEW ===');
    console.log(JSON.stringify(i.rows[0], null, 2));
    interviewThreadId = i.rows[0]?.chat_thread_id ?? null;
  }

  const gr = await c.query(
    `SELECT run_type, run_id, repo_role, is_active, provider, project, repository,
            branch, grounded_sha, grounded_at, created_at
     FROM run_groundings
     WHERE run_id = ANY($1::text[])
     ORDER BY created_at DESC LIMIT 10`,
    [[threadId, interviewThreadId].filter(Boolean)]
  ).catch((err) => {
    console.log('run_groundings query error', err.message);
    return { rows: [] };
  });
  console.log('=== RUN GROUNDINGS ===');
  console.log(JSON.stringify(gr.rows, null, 2));

  const now = await c.query(`SELECT NOW() AS now`);
  console.log('=== DB NOW ===');
  console.log(JSON.stringify(now.rows[0], null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
