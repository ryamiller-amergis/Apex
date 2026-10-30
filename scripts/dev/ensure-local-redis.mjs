#!/usr/bin/env node
// Local `npm run dev` expects Redis at redis://127.0.0.1:6379 (no password).
// If that port is already open, this exits. Otherwise it starts the apex-redis
// container. Docker Desktop has to be running; this does not start it.

import net from 'node:net';
import { spawnSync } from 'node:child_process';

const PORT = 6379;
const CONTAINER = 'apex-redis';

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolve(true);
    });
    const giveUp = () => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(1000);
    socket.on('timeout', giveUp);
    socket.on('error', giveUp);
  });
}

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

if (await portOpen(PORT)) {
  console.log(`Redis already listening on 127.0.0.1:${PORT}`);
  process.exit(0);
}

const info = docker(['info']);
if (info.status !== 0) {
  console.error(
    `Redis is not listening on 127.0.0.1:${PORT}, and Docker is not running. Start Docker Desktop, then run npm run dev again.`,
  );
  process.exit(1);
}

const listed = docker([
  'ps',
  '-a',
  '--filter',
  `name=^${CONTAINER}$`,
  '--format',
  '{{.Names}}',
]);
const names = (listed.stdout || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (names.includes(CONTAINER)) {
  const started = docker(['start', CONTAINER]);
  if (started.status !== 0) {
    console.error(started.stderr || `docker start ${CONTAINER} failed`);
    process.exit(started.status || 1);
  }
} else {
  const created = docker([
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `${PORT}:6379`,
    'redis:7-alpine',
  ]);
  if (created.status !== 0) {
    console.error(created.stderr || 'docker run redis failed');
    process.exit(created.status || 1);
  }
}

for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await portOpen(PORT)) {
    console.log(`Redis listening on 127.0.0.1:${PORT}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.error(`Redis container ${CONTAINER} started, but port ${PORT} did not open.`);
process.exit(1);
