#!/usr/bin/env node
/**
 * Survey PRD generation health on an environment: all stuck-generating PRDs,
 * recent PRDs, and recent agent runs. Read-only.
 *
 * Usage: node survey-prds.js --env dev
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
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--env' || argv[i] === '-e') && argv[i + 1]) env = argv[++i];
    else if (argv[i].startsWith('--env=')) env = argv[i].slice(6);
  }
  return { env };
}

function fetchDatabaseUrl(envKey) {
  const data = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8'));
  const cfg = data.envs[envKey];
  if (!cfg) throw new Error(`Unknown env: ${envKey}`);
  const r = spawnSync(
    'az',
    [
      'webapp', 'config', 'appsettings', 'list',
      '--name', cfg.appName,
      '--resource-group', cfg.appResourceGroup,
      '--query', "[?name=='DATABASE_URL'].value",
      '-o', 'tsv',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' }
  );
  const url = (r.stdout || '').trim();
  if (!url || !url.startsWith('postgres')) {
    throw new Error(`Failed to fetch DATABASE_URL for ${cfg.appName}: ${r.stderr}`);
  }
  return url;
}

async function main() {
  const { env } = parseArgs(process.argv.slice(2));
  const connectionString =
    process.env.APEX_TROUBLESHOOT_DATABASE_URL ||
    process.env.DEV_DATABASE_URL ||
    (env ? fetchDatabaseUrl(env === 'staging' ? 'stg' : env) : null);
  if (!connectionString) {
    console.error('Set DEV_DATABASE_URL or pass --env');
    process.exit(2);
  }

  const c = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await c.connect();

  console.log('=== DB NOW ===');
  console.log((await c.query('SELECT NOW() AS now')).rows[0].now);

  console.log('\n=== ALL GENERATING PRDS ===');
  const stuck = await c.query(
    `SELECT id, title, project, status, length(content) AS len,
            created_at, updated_at,
            ROUND(EXTRACT(EPOCH FROM (NOW() - updated_at::timestamptz)) / 60.0)::int AS age_min
     FROM prds WHERE status = 'generating' ORDER BY created_at DESC`
  );
  console.log(JSON.stringify(stuck.rows, null, 2));

  console.log('\n=== RECENT PRDS (3h) ===');
  const recent = await c.query(
    `SELECT id, title, project, status, length(content) AS len, created_at, updated_at
     FROM prds WHERE created_at > NOW() - INTERVAL '3 hours'
     ORDER BY created_at DESC LIMIT 25`
  );
  console.log(JSON.stringify(recent.rows, null, 2));

  console.log('\n=== RECENT AGENT RUNS (3h) ===');
  const runs = await c.query(
    `SELECT id, thread_id, status, progress_label, created_at, updated_at, last_error
     FROM agent_runs WHERE created_at > NOW() - INTERVAL '3 hours'
     ORDER BY created_at DESC LIMIT 25`
  );
  console.log(JSON.stringify(runs.rows, null, 2));

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
