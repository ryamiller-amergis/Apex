import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';

const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_PORT = 3000;

export function createStudioApiLoopbackBridge(target) {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:') {
    throw new Error('APEX_API_PROXY_TARGET must use http.');
  }
  const upstreamPort = Number(upstream.port || 80);
  if (
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65_535
  ) {
    throw new Error('APEX_API_PROXY_TARGET has an invalid port.');
  }

  return createServer((downstream) => {
    const upstreamSocket = connect({
      host: upstream.hostname,
      port: upstreamPort,
    });
    downstream.pipe(upstreamSocket);
    upstreamSocket.pipe(downstream);
    const closeBoth = () => {
      downstream.destroy();
      upstreamSocket.destroy();
    };
    downstream.once('error', closeBoth);
    upstreamSocket.once('error', closeBoth);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(LOOPBACK_PORT, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function main() {
  const target = process.env.APEX_API_PROXY_TARGET?.trim();
  if (!target) {
    throw new Error('APEX_API_PROXY_TARGET is required for Studio.');
  }

  const bridge = createStudioApiLoopbackBridge(target);
  await listen(bridge);
  console.log(
    `[studio] API loopback bridge listening on ${LOOPBACK_HOST}:${LOOPBACK_PORT}`
  );

  const vite = spawn(
    'corepack',
    [
      'pnpm',
      '--filter',
      '@project-scope/web',
      'exec',
      'vite',
      '--host',
      '0.0.0.0',
      '--port',
      '5173',
      '--strictPort',
    ],
    { stdio: 'inherit' }
  );

  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    bridge.close();
    vite.kill(signal);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  vite.once('error', (error) => {
    console.error('[studio] Could not start Vite.', error);
    bridge.close();
    process.exitCode = 1;
  });
  vite.once('exit', (code, signal) => {
    bridge.close();
    if (!stopping && (code ?? 1) !== 0) {
      console.error(
        `[studio] Vite exited unexpectedly (${signal ?? `code ${code}`}).`
      );
    }
    process.exitCode = code ?? (stopping ? 0 : 1);
  });
}

if (process.argv[1]?.endsWith('studio-runner.mjs')) {
  void main().catch((error) => {
    console.error('[studio] Could not start the editable preview.', error);
    process.exitCode = 1;
  });
}
