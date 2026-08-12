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
function run(command) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ command, dir: '/home' });
    const req = https.request(
      {
        hostname: `${ENV.appName}.scm.azurewebsites.net`,
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
            resolve(`${p.Output || ''}${p.Error || ''}`);
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
(async () => {
  const g = 'bc222a8509d8a83f00f27b6d1ecf74bb08c12d501d76bf5d60dfdf9b9094b729';
  console.log('LIST\n', await run(`ls -la /home/data/ai-pilot/workspaces/grounding/${g}`));
  console.log('HEAD\n', await run(`git -C /home/data/ai-pilot/workspaces/grounding/${g} rev-parse HEAD`));
  console.log(
    'PS\n',
    await run(`ps -eo pid,etime,cmd`),
  );
})().catch(console.error);
