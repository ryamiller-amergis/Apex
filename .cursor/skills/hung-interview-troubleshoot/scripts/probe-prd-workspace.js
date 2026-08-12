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

function request(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: scm,
        path: '/api/command',
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => {
          b += c;
        });
        res.on('end', () => {
          try {
            const p = JSON.parse(b);
            resolve(p.Output || p.Error || b);
          } catch {
            resolve(b);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run(command) {
  const out = await request({ command, dir: '/home' });
  console.log(`\n##### ${command}\n${out}`);
}

async function main() {
  const prd = '74566e0e-4fb8-4a2a-b15e-556a116f5e92';
  const interview = 'bf7fb629-1d85-4b87-b7d8-701843aa529c';
  await run(`ls -la /home/data/ai-pilot/workspaces/${prd}/.ai-pilot/output`);
  await run(`wc -c /home/data/ai-pilot/workspaces/${prd}/.ai-pilot/kickoff-transcript.md`);
  await run(`head -n 25 /home/data/ai-pilot/workspaces/${prd}/.ai-pilot/kickoff-transcript.md`);
  await run(`cat /home/data/ai-pilot/workspaces/${prd}/.ai-pilot/session.json`);
  await run(`cat /home/data/ai-pilot/workspaces/${interview}/.ai-pilot/session.json`);
  await run(`ls -la /home/data/ai-pilot/workspaces/${interview}/.ai-pilot/output`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
