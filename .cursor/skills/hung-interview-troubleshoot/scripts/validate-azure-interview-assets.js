#!/usr/bin/env node
/**
 * Validate that the interview's pinned SHA shared checkout and thread
 * workspace artifacts exist on Azure App Service /home/data (Kudu VFS).
 *
 * Usage:
 *   node validate-azure-interview-assets.js --env dev <interviewId>
 */
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Client } = require('pg');

const ENV_PATH = path.join(
  __dirname,
  '..',
  '..',
  'interactive-chat-troubleshoot',
  'environments.json'
);

function parseArgs(argv) {
  let env = 'dev';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--env' || argv[i] === '-e') && argv[i + 1]) {
      env = argv[++i];
      continue;
    }
    rest.push(argv[i]);
  }
  return { env, interviewId: rest[0] };
}

function azJson(args) {
  const r = spawnSync('az', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`az failed: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  }
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

function fetchDatabaseUrl(cfg) {
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
  if (!url.startsWith('postgres')) throw new Error('Failed DATABASE_URL');
  return url;
}

function identityDigest({ provider, project, repo, branch, sha }) {
  const key = [provider, project, repo, branch, sha].join('\0');
  return crypto.createHash('sha256').update(key).digest('hex');
}

function kuduGet(creds, vfsPath) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${creds.publishingUserName}:${creds.publishingPassword}`).toString(
      'base64'
    );
    const url = `https://${creds.scm}/api/vfs/${vfsPath.replace(/^\/+/, '')}`;
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json, text/plain, */*',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body, contentType: res.headers['content-type'] });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('kudu timeout'));
    });
    req.end();
  });
}

async function main() {
  const { env, interviewId } = parseArgs(process.argv.slice(2));
  if (!interviewId) {
    console.error('Usage: validate-azure-interview-assets.js --env dev <interviewId>');
    process.exit(2);
  }

  const data = JSON.parse(fs.readFileSync(ENV_PATH, 'utf8'));
  const cfg = data.envs[env === 'staging' ? 'stg' : env];
  if (!cfg) throw new Error(`Unknown env ${env}`);

  const connectionString = fetchDatabaseUrl(cfg);
  const c = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const interview = await c.query(
    `SELECT id, title, status, chat_thread_id, project, repo, model, updated_at
     FROM interviews WHERE id = $1`,
    [interviewId]
  );
  console.log('=== INTERVIEW ===');
  console.log(JSON.stringify(interview.rows[0], null, 2));
  if (!interview.rows[0]) {
    await c.end();
    process.exit(1);
  }

  const threadId = interview.rows[0].chat_thread_id;
  const thread = await c.query(
    `SELECT id, status, workspace_dir, kickoff->>'project' AS project,
            kickoff->>'repo' AS repo, kickoff->>'branch' AS branch,
            left(kickoff->>'transcript', 200) AS transcript_preview,
            length(coalesce(kickoff->>'transcript','')) AS transcript_len
     FROM chat_threads WHERE id = $1`,
    [threadId]
  );
  console.log('=== INTERVIEW THREAD ===');
  console.log(JSON.stringify(thread.rows[0], null, 2));

  const msgs = await c.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE role = 'user')::int AS users,
            count(*) FILTER (WHERE role = 'agent')::int AS agents
     FROM chat_messages WHERE thread_id = $1`,
    [threadId]
  );
  console.log('=== INTERVIEW MESSAGES ===');
  console.log(JSON.stringify(msgs.rows[0], null, 2));

  const grounding = await c.query(
    `SELECT provider, project, repository, branch, grounded_sha, is_active, grounded_at
     FROM run_groundings
     WHERE run_id = $1 AND repo_role = 'target'
     ORDER BY created_at DESC LIMIT 3`,
    [threadId]
  );
  console.log('=== INTERVIEW GROUNDINGS ===');
  console.log(JSON.stringify(grounding.rows, null, 2));

  const g =
    grounding.rows.find((r) => r.is_active) || grounding.rows[0] || null;
  if (!g) {
    console.log('NO GROUNDING — cannot resolve shared checkout path');
    await c.end();
    process.exit(1);
  }

  const provider = g.provider === 'azure_devops' ? 'ado' : 'github';
  const digest = identityDigest({
    provider,
    project: g.project,
    repo: g.repository,
    branch: g.branch,
    sha: g.grounded_sha,
  });
  const sharedPath = `/home/data/ai-pilot/workspaces/grounding-shared/${digest}`;
  const markerPath = `${sharedPath}/.apex-shared-ready`;
  const interviewWs = thread.rows[0]?.workspace_dir;
  const interviewAiPilot = interviewWs ? `${interviewWs}/.ai-pilot` : null;

  console.log('=== EXPECTED AZURE PATHS ===');
  console.log(
    JSON.stringify(
      {
        provider,
        project: g.project,
        repo: g.repository,
        branch: g.branch,
        sha: g.grounded_sha,
        digest,
        sharedPath,
        markerPath,
        interviewWorkspace: interviewWs,
        interviewAiPilot,
      },
      null,
      2
    )
  );

  await c.end();

  console.log('=== FETCHING KUDU PUBLISH CREDS ===');
  const credsRaw = azJson([
    'webapp',
    'deployment',
    'list-publishing-credentials',
    '--name',
    cfg.appName,
    '--resource-group',
    cfg.appResourceGroup,
  ]);
  const scmHost = `${cfg.appName}.scm.azurewebsites.net`;
  const creds = {
    publishingUserName: credsRaw.publishingUserName,
    publishingPassword: credsRaw.publishingPassword,
    scm: scmHost,
  };

  async function check(label, vfsPath, { peek = false } = {}) {
    // VFS paths are relative to site root; /home/data is absolute on Linux
    // Kudu accepts home/data/... without leading slash sometimes; try both.
    const candidates = [
      vfsPath.replace(/^\//, ''),
      vfsPath.startsWith('/home/') ? vfsPath.slice(1) : null,
    ].filter(Boolean);

    for (const p of candidates) {
      try {
        const res = await kuduGet(creds, p);
        if (res.status === 200) {
          let summary = res.body.slice(0, 400);
          if (res.contentType && res.contentType.includes('json')) {
            try {
              const parsed = JSON.parse(res.body);
              if (Array.isArray(parsed)) {
                summary = parsed
                  .slice(0, 25)
                  .map((e) => e.name || e)
                  .join(', ');
              } else {
                summary = JSON.stringify(parsed).slice(0, 400);
              }
            } catch {
              /* keep raw */
            }
          }
          console.log(`OK  [${label}] status=${res.status} path=${p}`);
          console.log(`    ${summary}`);
          return { ok: true, body: res.body };
        }
        if (res.status !== 404) {
          console.log(`ERR [${label}] status=${res.status} path=${p} body=${res.body.slice(0, 200)}`);
        }
      } catch (e) {
        console.log(`ERR [${label}] path=${p}: ${e.message}`);
      }
    }
    console.log(`MISS [${label}] path=${vfsPath}`);
    return { ok: false };
  }

  console.log('=== AZURE FILES CHECKS ===');
  await check('shared-checkout-dir', sharedPath, { peek: true });
  await check('shared-ready-marker', markerPath, { peek: true });
  if (interviewWs) {
    await check('interview-workspace', interviewWs, { peek: true });
  }
  if (interviewAiPilot) {
    await check('interview-.ai-pilot', interviewAiPilot, { peek: true });
    await check(
      'interview-session.json',
      `${interviewAiPilot}/session.json`,
      { peek: true }
    );
  }

  // Also list grounding-shared root to see how many trees exist
  await check(
    'grounding-shared-root',
    '/home/data/ai-pilot/workspaces/grounding-shared',
    { peek: true }
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
