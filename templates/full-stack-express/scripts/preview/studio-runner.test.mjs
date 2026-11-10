import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createStudioApiLoopbackBridge } from './studio-runner.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address.');
  }
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

describe('Studio API loopback bridge', () => {
  it('forwards legacy localhost traffic to the dynamic runtime target', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"items":[{"id":"todo-1"}]}');
    });
    const upstreamPort = await listen(upstream);
    const bridge = createStudioApiLoopbackBridge(
      `http://127.0.0.1:${upstreamPort}`
    );
    const bridgePort = await listen(bridge);

    try {
      const response = await fetch(
        `http://127.0.0.1:${bridgePort}/api/v1/todos`
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        items: [{ id: 'todo-1' }],
      });
    } finally {
      await close(bridge);
      await close(upstream);
    }
  });
});
