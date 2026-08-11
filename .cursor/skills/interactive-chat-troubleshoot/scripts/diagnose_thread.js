#!/usr/bin/env node
/**
 * Diagnose an interactive chat thread from Postgres.
 *
 * Usage (repo root):
 *   node .cursor/skills/interactive-chat-troubleshoot/scripts/diagnose_thread.js --env stg <threadUuid>
 *
 * Credentials (first wins):
 *   APEX_TROUBLESHOOT_DATABASE_URL | PROD_DATABASE_URL | DATABASE_URL
 *   Or --env + az CLI (fetches DATABASE_URL from the env's App Service; never prints it).
 *
 * Never logs the connection string.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ENV_PATH = path.join(__dirname, '..', 'environments.json');

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
  return { env, rest };
}

function normalizeEnv(env) {
  if (!env) return null;
  const key = env.toLowerCase();
  if (key === 'staging' || key === 'stage') return 'stg';
  if (key === 'prod' || key === 'production') return 'prd';
  if (key === 'cloud-dev' || key === 'development') return 'dev';
  return key;
}

function loadEnvConfig(envKey) {
  const data = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8'));
  const cfg = data.envs[envKey];
  if (!cfg) {
    console.error(`Unknown env ${envKey}. Use: dev | stg | prd`);
    process.exit(2);
  }
  return { env: envKey, ...cfg };
}

function resolveAz() {
  const candidates = [
    'az',
    'az.cmd',
    'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd',
    'C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd',
  ];
  for (const c of candidates) {
    if (c === 'az' || c === 'az.cmd') {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0) return c;
      continue;
    }
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Azure CLI (az / az.cmd) not found');
}

function az(args) {
  const bin = resolveAz();
  // Windows az.cmd requires shell so cmd.exe can run the batch wrapper.
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim();
    throw new Error(`az failed: ${err.slice(0, 400)}`);
  }
  return (r.stdout || '').trim();
}

function fetchDatabaseUrl(cfg) {
  const args = [
    'webapp',
    'config',
    'appsettings',
    'list',
    '--name',
    cfg.appName,
    '--resource-group',
    cfg.appResourceGroup,
    '--query',
    "[?name=='DATABASE_URL'].value | [0]",
    '-o',
    'tsv',
  ];
  if (cfg.slot) args.push('--slot', cfg.slot);
  const url = az(args);
  if (!url || !url.startsWith('postgres')) {
    throw new Error(`DATABASE_URL missing on ${cfg.appName} slot=${cfg.slot || 'production'}`);
  }
  console.error(`DATABASE_URL_SET=true length=${url.length}`);
  return url;
}

function age(seconds) {
  if (seconds == null) return 'n/a';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function classify({ thread, runs, events }) {
  if (!thread) return { verdict: 'missing', bucket: 'B', detail: 'Thread not found' };
  const latest = runs[0];
  if (!latest) {
    if (thread.status === 'running') {
      return {
        verdict: 'stuck',
        bucket: 'B/G',
        detail: 'Thread running with no agent_runs row — send may not have landed or status stuck',
      };
    }
    return { verdict: 'idle', bucket: null, detail: 'No runs yet' };
  }

  const interactive = latest.lane === 'ai-runs-interactive';
  const terminal = ['completed', 'failed', 'cancelled'].includes(latest.status);
  const eventTypes = (events || []).map((e) => e.event_type);

  if (thread.status === 'running' && terminal) {
    return {
      verdict: 'stuck-client',
      bucket: 'G',
      detail: 'Run terminal but thread still running — client likely missed done (WS/live-bus)',
    };
  }
  if (latest.status === 'queued' && latest.run_age_s >= 90) {
    return { verdict: 'hung', bucket: 'D', detail: 'Interactive/background run queued too long' };
  }
  if (['running', 'dispatched'].includes(latest.status) && latest.heartbeat_age_s >= 300) {
    return { verdict: 'hung', bucket: 'D', detail: 'Worker heartbeat expired' };
  }
  if (!interactive && ['running', 'completed', 'failed'].includes(latest.status)) {
    return {
      verdict: 'in-process',
      bucket: 'C/F',
      detail:
        'Latest run is not ai-runs-interactive lane — in-process path (expect live-bus bridge for WS clients)',
    };
  }
  if (interactive && terminal && !eventTypes.includes('done') && !eventTypes.includes('token')) {
    return {
      verdict: 'no-stream-events',
      bucket: 'D/C',
      detail: 'Interactive lane run finished with few/no stream events in agent_run_events',
    };
  }
  if (thread.status === 'idle' && terminal) {
    return { verdict: 'healthy', bucket: null, detail: 'Thread idle; latest run terminal' };
  }
  return {
    verdict: 'watch',
    bucket: interactive ? 'D?' : 'C?',
    detail: `Latest run status=${latest.status} lane=${latest.lane || 'null'}`,
  };
}

async function main() {
  const { env: envRaw, rest } = parseArgs(process.argv.slice(2));
  const threadId = rest[0];
  if (!threadId || !/^[0-9a-f-]{36}$/i.test(threadId)) {
    console.error(
      'Usage: node diagnose_thread.js --env <dev|stg|prd> <threadUuid>',
    );
    process.exit(2);
  }

  const envKey = normalizeEnv(envRaw);
  let cfg = null;
  if (envKey) cfg = loadEnvConfig(envKey);

  let connectionString =
    process.env.APEX_TROUBLESHOOT_DATABASE_URL ||
    process.env.PROD_DATABASE_URL ||
    process.env.DATABASE_URL;

  if (!connectionString) {
    if (!cfg) {
      console.error('Set --env or APEX_TROUBLESHOOT_DATABASE_URL / DATABASE_URL');
      process.exit(2);
    }
    try {
      connectionString = fetchDatabaseUrl(cfg);
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(2);
    }
  }

  const c = new Client({
    connectionString,
    ssl: connectionString.includes('localhost')
      ? undefined
      : { rejectUnauthorized: false },
  });
  await c.connect();

  const threadRes = await c.query(
    `SELECT id, status, active_run_id,
            left(coalesce(last_error,''), 400) AS last_error,
            title, user_id,
            kickoff->>'project' AS project,
            kickoff->>'model' AS model,
            created_at, last_activity_at,
            EXTRACT(EPOCH FROM (now() - last_activity_at))::int AS idle_s
     FROM chat_threads WHERE id = $1`,
    [threadId],
  );
  const thread = threadRes.rows[0];

  const runsRes = await c.query(
    `SELECT id, status, lane, progress_label, progress_phase,
            left(coalesce(last_error,''), 300) AS last_error,
            dispatch_message_id IS NOT NULL AS has_dispatch,
            created_at, started_at, heartbeat_at, progress_at,
            EXTRACT(EPOCH FROM (now() - created_at))::int AS run_age_s,
            EXTRACT(EPOCH FROM (now() - coalesce(heartbeat_at, created_at)))::int AS heartbeat_age_s,
            EXTRACT(EPOCH FROM (now() - coalesce(progress_at, created_at)))::int AS progress_age_s
     FROM agent_runs
     WHERE thread_id = $1
     ORDER BY created_at DESC
     LIMIT 5`,
    [threadId],
  );
  const runs = runsRes.rows;

  let events = [];
  if (runs[0]) {
    const ev = await c.query(
      `SELECT event_type, status, left(coalesce(detail,''), 120) AS detail,
              event_timestamp, ordinal
       FROM agent_run_events
       WHERE run_id = $1
       ORDER BY ordinal DESC
       LIMIT 15`,
      [runs[0].id],
    );
    events = ev.rows;
  }

  const msgRes = await c.query(
    `SELECT role, left(coalesce(text, ''), 80) AS preview, ts
     FROM chat_messages
     WHERE thread_id = $1
     ORDER BY ts DESC
     LIMIT 6`,
    [threadId],
  );

  await c.end();

  const classification = classify({ thread, runs, events });
  const out = {
    env: envKey || 'url-override',
    threadId,
    classification,
    thread: thread
      ? {
          status: thread.status,
          active_run_id: thread.active_run_id,
          project: thread.project,
          idle: age(thread.idle_s),
          last_error: thread.last_error || null,
        }
      : null,
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      lane: r.lane,
      has_dispatch: r.has_dispatch,
      progress_label: r.progress_label,
      ages: {
        run: age(r.run_age_s),
        heartbeat: age(r.heartbeat_age_s),
        progress: age(r.progress_age_s),
      },
      last_error: r.last_error || null,
    })),
    recentEvents: events.map((e) => ({
      type: e.event_type,
      status: e.status,
      detail: e.detail,
      at: e.event_timestamp,
    })),
    recentMessages: msgRes.rows,
  };

  console.log(JSON.stringify(out, null, 2));
  process.exit(thread ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
