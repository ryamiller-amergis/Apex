#!/usr/bin/env node
// Local interactive turns need a Dapr sidecar on 127.0.0.1:3500 (gRPC 50001).
// dapr.exe is often blocked by AppLocker because it is unsigned, so this starts
// the sidecar, placement, and scheduler as Docker containers. The Node host
// stays on the machine and listens on port 8080.

import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const NETWORK = 'apex-dapr';
const RESOURCES = resolve('runners/ai-runs-interactive/dapr');
const PLACEMENT = 'apex-dapr-placement';
const SCHEDULER = 'apex-dapr-scheduler';
const SIDECAR = 'apex-dapr-sidecar';

function portOpen(port) {
  return new Promise((resolvePort) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end();
      resolvePort(true);
    });
    const giveUp = () => {
      socket.destroy();
      resolvePort(false);
    };
    socket.setTimeout(1000);
    socket.on('timeout', giveUp);
    socket.on('error', giveUp);
  });
}

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8' });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (
  (await portOpen(3500)) &&
  (await portOpen(50001)) &&
  containerStatus(SIDECAR) === 'running' &&
  sidecarHasComponents() &&
  containerOnNetwork(SIDECAR, NETWORK) &&
  containerStatus(SCHEDULER) === 'running' &&
  commandIncludes(SCHEDULER, '/tmp/dapr-scheduler')
) {
  console.log('Dapr sidecar already listening on 127.0.0.1:3500 and :50001');
  process.exit(0);
}

const info = docker(['info']);
if (info.status !== 0) {
  fail('Docker is not running. Start Docker Desktop, then run npm run dev again.');
}

const network = docker(['network', 'create', NETWORK]);
if (network.status !== 0 && !/already exists/i.test(network.stderr || '')) {
  fail(network.stderr || `docker network create ${NETWORK} failed`);
}

function containerStatus(name) {
  const result = docker(['inspect', '-f', '{{.State.Status}}', name]);
  if (result.status !== 0) return 'missing';
  return (result.stdout || '').trim();
}

function commandIncludes(name, text) {
  const inspect = docker(['inspect', '-f', '{{json .Config.Cmd}}', name]);
  return inspect.status === 0 && (inspect.stdout || '').includes(text);
}

function containerOnNetwork(name, network) {
  const inspect = docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', name]);
  if (inspect.status !== 0) return false;
  return (inspect.stdout || '').includes(`"${network}"`);
}

function sidecarHasComponents() {
  const inspect = docker(['inspect', '-f', '{{json .HostConfig.Binds}}', SIDECAR]);
  if (inspect.status !== 0) return false;
  const binds = inspect.stdout || '';
  const expected = RESOURCES.replace(/\\/g, '/').toLowerCase();
  return binds.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase().includes(expected);
}

function ensureContainer(name, runArgs, { recreateWhen } = {}) {
  const status = containerStatus(name);
  if (status !== 'missing' && recreateWhen?.()) {
    const removed = docker(['rm', '-f', name]);
    if (removed.status !== 0) fail(removed.stderr || `docker rm ${name} failed`);
  }
  const after = containerStatus(name);
  if (after === 'running') return;
  if (after !== 'missing') {
    const started = docker(['start', name]);
    if (started.status !== 0) fail(started.stderr || `docker start ${name} failed`);
    return;
  }
  const created = docker(['run', '-d', '--name', name, '--network', NETWORK, ...runArgs]);
  if (created.status !== 0) fail(created.stderr || `docker run ${name} failed`);
}

ensureContainer(PLACEMENT, [
  '--entrypoint',
  '/placement',
  'daprio/dapr:1.16.2',
  '-port',
  '50005',
]);

ensureContainer(SCHEDULER, [
  '--entrypoint',
  '/scheduler',
  'daprio/dapr:1.16.2',
  '--port',
  '50006',
  '--etcd-data-dir',
  '/tmp/dapr-scheduler',
  '--override-broadcast-host-port',
  `${SCHEDULER}:50006`,
], {
  recreateWhen: () => !commandIncludes(SCHEDULER, '/tmp/dapr-scheduler'),
});

ensureContainer(SIDECAR, [
  '-p',
  '3500:3500',
  '-p',
  '50001:50001',
  '-v',
  `${RESOURCES}:/components:ro`,
  '--entrypoint',
  '/daprd',
  'daprio/daprd:1.16.2',
  '--app-id',
  'apex-ai-interactive',
  '--app-port',
  '8080',
  '--app-protocol',
  'http',
  '--app-channel-address',
  'host.docker.internal',
  '--dapr-listen-addresses',
  '0.0.0.0',
  '--dapr-http-port',
  '3500',
  '--dapr-grpc-port',
  '50001',
  '--resources-path',
  '/components',
  '--placement-host-address',
  `${PLACEMENT}:50005`,
  '--scheduler-host-address',
  `${SCHEDULER}:50006`,
], {
  recreateWhen: () => !sidecarHasComponents() || !containerOnNetwork(SIDECAR, NETWORK),
});

for (let attempt = 0; attempt < 40; attempt += 1) {
  if ((await portOpen(3500)) && (await portOpen(50001))) {
    console.log('Dapr sidecar listening on 127.0.0.1:3500 and :50001');
    process.exit(0);
  }
  await new Promise((done) => setTimeout(done, 500));
}

const logs = docker(['logs', '--tail', '40', SIDECAR]);
fail(
  `Dapr sidecar did not open ports 3500 and 50001.\n${logs.stdout || ''}${logs.stderr || ''}`,
);
