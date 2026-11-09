import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CollectorRequest {
  path: string;
  contentType: string | undefined;
  authorization: string | undefined;
}

export class ServerPool {
  private readonly servers: Server[] = [];

  async listen(server: Server): Promise<number> {
    this.servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    return (server.address() as AddressInfo).port;
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      this.servers.splice(0).map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          })
      )
    );
  }
}

export async function startCollector(
  pool: ServerPool
): Promise<{ port: number; received: CollectorRequest[] }> {
  const received: CollectorRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  return { port: await pool.listen(server), received };
}

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function waitFor(
  check: () => boolean,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
