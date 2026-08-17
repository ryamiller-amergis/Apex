#!/usr/bin/env node
/**
 * Subscribe to the interactive Redis live bus and watch for TOKEN envelopes.
 *
 * Usage (repo root):
 *   node .cursor/skills/interactive-chat-troubleshoot/scripts/probe_live_bus.js --env stg --thread <uuid> --wait 90
 *
 * Credentials via az (REDIS_HOST / REDIS_KEY from App Service) or RH/RK env.
 * Never prints the Redis key.
 *
 * Exit: 0 = TOKEN seen, 2 = timeout/silent, 3 = redis error
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', 'environments.json');

function parseArgs(argv) {
  let env = null;
  let thread = null;
  let wait = 60;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--env' || argv[i] === '-e') && argv[i + 1]) {
      env = argv[++i];
      continue;
    }
    if (argv[i].startsWith('--env=')) {
      env = argv[i].slice(6);
      continue;
    }
    if (argv[i] === '--thread' && argv[i + 1]) {
      thread = argv[++i];
      continue;
    }
    if (argv[i].startsWith('--thread=')) {
      thread = argv[i].slice(9);
      continue;
    }
    if (argv[i] === '--wait' && argv[i + 1]) {
      wait = Math.min(120, Math.max(5, Number(argv[++i]) || 60));
      continue;
    }
  }
  return { env, thread, wait };
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
  if (!cfg) throw new Error(`Unknown env ${envKey}`);
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
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || 'az failed').trim().slice(0, 400));
  }
  return (r.stdout || '').trim();
}

function fetchRedisFromApp(cfg) {
  const base = [
    'webapp',
    'config',
    'appsettings',
    'list',
    '--name',
    cfg.appName,
    '--resource-group',
    cfg.appResourceGroup,
  ];
  if (cfg.slot) base.push('--slot', cfg.slot);

  const host = az([...base, '--query', "[?name=='REDIS_HOST'].value | [0]", '-o', 'tsv']);
  const port =
    az([...base, '--query', "[?name=='REDIS_SSL_PORT'].value | [0]", '-o', 'tsv']) || '10000';
  let key = az([...base, '--query', "[?name=='REDIS_KEY'].value | [0]", '-o', 'tsv']);
  if (!key) {
    key = az([...base, '--query', "[?name=='REDIS_PASSWORD'].value | [0]", '-o', 'tsv']);
  }
  if (!host || !key) {
    throw new Error(
      `REDIS_HOST/KEY missing on ${cfg.appName} slot=${cfg.slot || 'production'} (bucket A)`,
    );
  }
  console.log(`[probe] REDIS_HOST_SET=true port=${port} (key redacted)`);
  return { host, port: Number(port) || 10000, password: key };
}

async function main() {
  const { env: envRaw, thread, wait } = parseArgs(process.argv.slice(2));
  const envKey = normalizeEnv(envRaw);
  if (!envKey) {
    console.error('Usage: probe_live_bus.js --env <dev|stg|prd> [--thread <uuid>] [--wait 60]');
    process.exit(2);
  }
  const cfg = loadEnvConfig(envKey);

  let host = process.env.RH || process.env.REDIS_HOST;
  let password = process.env.RK || process.env.REDIS_KEY || process.env.REDIS_PASSWORD;
  let port = Number(process.env.REDIS_SSL_PORT || process.env.RP || 10000);

  if (!host || !password) {
    const redis = fetchRedisFromApp(cfg);
    host = redis.host;
    password = redis.password;
    port = redis.port;
  }

  // Resolve ioredis from repo root
  const Redis = require(path.join(process.cwd(), 'node_modules', 'ioredis'));

  const channelPattern = thread
    ? `apex:interactive:live:${thread}`
    : 'apex:interactive:live:*';

  const sub = new Redis({
    host,
    port,
    password,
    tls: {},
    connectTimeout: 10000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  let done = false;
  const finish = (code, msg) => {
    if (done) return;
    done = true;
    console.log(msg);
    try {
      sub.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  sub.on('error', (e) =>
    finish(3, `[probe] REDIS_ERROR ${e.code || ''} ${e.message}`),
  );

  sub.on('ready', async () => {
    if (thread) {
      await sub.subscribe(channelPattern);
      console.log(
        `[probe] SUBSCRIBED channel=${channelPattern} wait=${wait}s @ ${new Date().toISOString()}`,
      );
    } else {
      await sub.psubscribe(channelPattern);
      console.log(
        `[probe] SUBSCRIBED pattern=${channelPattern} wait=${wait}s @ ${new Date().toISOString()}`,
      );
    }
  });

  const onMessage = (channel, message) => {
    const tid = String(channel).replace('apex:interactive:live:', '');
    let kind = '?';
    try {
      const env = JSON.parse(message);
      kind = env.type || env.event?.type || env.eventId || 'envelope';
    } catch {
      /* ignore */
    }
    console.log(
      `[probe] TOKEN thread=${tid.slice(0, 8)} kind=${kind} bytes=${message.length} @ ${new Date().toISOString()}`,
    );
    finish(0, '[probe] OK — live bus received at least one message');
  };

  sub.on('message', onMessage);
  sub.on('pmessage', (_p, channel, message) => onMessage(channel, message));

  setTimeout(
    () => finish(2, `[probe] TIMEOUT — no TOKEN in ${wait}s (silent live bus)`),
    wait * 1000,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(3);
});
