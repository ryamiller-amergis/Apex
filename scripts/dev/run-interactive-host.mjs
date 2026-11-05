#!/usr/bin/env node
// Node process for the interactive actor host. The Dapr sidecar is started
// separately (scripts/dev/ensure-local-dapr.mjs) and is reached at
// 127.0.0.1:3500. This process binds 8080, which is
// AI_RUNS_INTERACTIVE_DISPATCH_URL. If a host is already up, this stays alive
// so `concurrently` does not treat the dev stack as finished.

import { spawn, spawnSync } from 'node:child_process';

const APP_PORT = 8080;
const SIDECAR = 'apex-dapr-sidecar';

async function hostUp() {
  try {
    const response = await fetch(`http://127.0.0.1:${APP_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.status === 200 || response.status === 503;
  } catch {
    return false;
  }
}

async function restartDaprSidecarWhenHostListening(childProcess) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (childProcess.killed || childProcess.exitCode !== null) return;
    if (await hostUp()) {
      spawnSync('docker', ['restart', SIDECAR], { stdio: 'ignore' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function stayAlive(message) {
  console.log(message);
  setInterval(() => {}, 60_000);
}

if (await hostUp()) {
  stayAlive(`Interactive host already listening on 127.0.0.1:${APP_PORT}`);
} else {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'dotenv/config',
      '-r',
      'ts-node/register',
      'src/server/services/interactiveActorHost/entrypoint.ts',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        TS_NODE_PROJECT: 'tsconfig.server.json',
        AI_RUNS_INTERACTIVE_TARGET_PORT: String(APP_PORT),
        AI_RUNS_INTERACTIVE_DAPR_APP_ID: 'apex-ai-interactive',
        DAPR_HTTP_PORT: '3500',
      },
    },
  );

  void restartDaprSidecarWhenHostListening(child);

  const stop = () => {
    if (!child.killed) child.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}
