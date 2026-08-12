#!/usr/bin/env node
const { spawnSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ENV = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'interactive-chat-troubleshoot', 'environments.json'),
    'utf8',
  ),
).envs.dev;

const creds = JSON.parse(
  spawnSync(
    'az',
    [
      'webapp',
      'deployment',
      'list-publishing-credentials',
      '--name',
      ENV.appName,
      '--resource-group',
      ENV.appResourceGroup,
      '-o',
      'json',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  ).stdout,
);

const auth = Buffer.from(
  `${creds.publishingUserName}:${creds.publishingPassword}`,
).toString('base64');
const scm = `${ENV.appName}.scm.azurewebsites.net`;

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: `Basic ${auth}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      {
        hostname: scm,
        path: apiPath,
        method,
        headers,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => {
          b += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function run(command) {
  const r = await request('POST', '/api/command', { command, dir: '/home' });
  let out = r.body;
  try {
    const parsed = JSON.parse(r.body);
    out = [parsed.Output, parsed.Error, parsed.ExitCode]
      .filter((x) => x !== undefined && x !== null && x !== '')
      .join('\n');
  } catch {
    /* raw */
  }
  console.log(`\n##### ${command}\n${out}\n`);
}

async function main() {
  const digest =
    '78a0bf5a3f50a03d21e70962ba46e035f702b52d73e08267b6e08d13dc5094e7';
  const interviewWs = 'bf7fb629-1d85-4b87-b7d8-701843aa529c';
  const prdWs = '74566e0e-4fb8-4a2a-b15e-556a116f5e92';

  await run('pwd; ls -la /home');
  await run('ls -la /home/data');
  await run('ls -la /home/data/ai-pilot');
  await run('ls -la /home/data/ai-pilot/workspaces | head -n 40');
  await run('ls -la /home/data/ai-pilot/workspaces/grounding-shared | head -n 40');
  await run(`ls -la /home/data/ai-pilot/workspaces/grounding-shared/${digest}`);
  await run(
    `cat /home/data/ai-pilot/workspaces/grounding-shared/${digest}/.apex-shared-ready`,
  );
  await run(
    `git -C /home/data/ai-pilot/workspaces/grounding-shared/${digest} rev-parse HEAD`,
  );
  await run(`ls -la /home/data/ai-pilot/workspaces/${interviewWs}`);
  await run(`ls -la /home/data/ai-pilot/workspaces/${interviewWs}/.ai-pilot`);
  await run(`ls -la /home/data/ai-pilot/workspaces/${prdWs}/.ai-pilot`);
  await run(
    `ls -la /home/data/ai-pilot/workspaces/${prdWs}/.ai-pilot/output; wc -c /home/data/ai-pilot/workspaces/${prdWs}/.ai-pilot/kickoff-transcript.md; head -n 20 /home/data/ai-pilot/workspaces/${prdWs}/.ai-pilot/kickoff-transcript.md`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
