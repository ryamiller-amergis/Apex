#!/usr/bin/env node
/** Inspect a feature flag's rows on an env. Read-only.
 * Usage: node check-flag.js --env dev ai-runs-background
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ENV_PATH = path.join(__dirname, '..', '..', 'interactive-chat-troubleshoot', 'environments.json');

function parseArgs(argv) {
  let env = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--env' || argv[i] === '-e') && argv[i + 1]) env = argv[++i];
    else if (argv[i].startsWith('--env=')) env = argv[i].slice(6);
    else rest.push(argv[i]);
  }
  return { env, key: rest[0] };
}

function fetchDatabaseUrl(envKey) {
  const cfg = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8')).envs[envKey];
  const r = spawnSync('az', [
    'webapp', 'config', 'appsettings', 'list',
    '--name', cfg.appName, '--resource-group', cfg.appResourceGroup,
    '--query', "[?name=='DATABASE_URL'].value", '-o', 'tsv',
  ], { encoding: 'utf8', shell: process.platform === 'win32' });
  const url = (r.stdout || '').trim();
  if (!url.startsWith('postgres')) throw new Error('no DATABASE_URL: ' + r.stderr);
  return url;
}

async function main() {
  const { env, key } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DEV_DATABASE_URL || (env ? fetchDatabaseUrl(env === 'staging' ? 'stg' : env) : null);
  const c = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'feature_flags' ORDER BY ordinal_position`
  );
  console.log('feature_flags columns:', cols.rows.map((r) => r.column_name).join(', '));

  const flag = await c.query(`SELECT * FROM feature_flags WHERE key = $1`, [key]).catch((e) => {
    console.log('flag query error', e.message);
    return { rows: [] };
  });
  console.log('=== FLAG ROW(S) ===');
  console.log(JSON.stringify(flag.rows, null, 2));

  // overrides/targeting tables if present
  for (const tbl of ['feature_flag_overrides', 'feature_flag_targets', 'feature_flag_rules']) {
    const exists = await c.query(`SELECT to_regclass($1) AS t`, [tbl]);
    if (exists.rows[0].t) {
      const rows = await c.query(`SELECT * FROM ${tbl} WHERE flag_key = $1 OR key = $1`, [key]).catch(() => ({ rows: [] }));
      console.log(`=== ${tbl} ===`);
      console.log(JSON.stringify(rows.rows, null, 2));
    }
  }

  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
