import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function validateTarget(host, port) {
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(host) &&
    net.isIP(host) === 0
  ) {
    throw new Error('APEX_PREVIEW_UPSTREAM_HOST is invalid.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('APEX_PREVIEW_UPSTREAM_PORT is invalid.');
  }
}

function corsHeaders(request) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers':
      request.headers['access-control-request-headers'] ??
      'authorization, content-type',
    'access-control-expose-headers': '*',
    vary: 'Origin, Access-Control-Request-Headers',
  };
}

function proxyUpgrade(request, downstream, head, target) {
  const upstream = net.createConnection(target, () => {
    const headerLines = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headerLines.push(
        `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`
      );
    }
    upstream.write(
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headerLines.join('\r\n')}\r\n\r\n`
    );
    if (head.length > 0) upstream.write(head);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  upstream.on('error', () => downstream.destroy());
  downstream.on('error', () => upstream.destroy());
}

export function createPreviewHttpProxy({ host, port }) {
  validateTarget(host, port);
  const server = http.createServer((request, response) => {
    const headers = corsHeaders(request);
    if (
      request.method === 'OPTIONS' &&
      request.headers['access-control-request-method']
    ) {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    const upstream = http.request(
      {
        host,
        port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          ...upstreamResponse.headers,
          ...headers,
        });
        upstreamResponse.pipe(response);
      }
    );
    upstream.on('error', () => {
      if (!response.headersSent) {
        response.writeHead(502, headers);
      }
      response.end();
    });
    request.pipe(upstream);
  });
  server.on('upgrade', (request, downstream, head) => {
    proxyUpgrade(request, downstream, head, { host, port });
  });
  return server;
}

const entryPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (entryPath === import.meta.url) {
  const host = process.env.APEX_PREVIEW_UPSTREAM_HOST ?? '';
  const port = Number(process.env.APEX_PREVIEW_UPSTREAM_PORT);
  createPreviewHttpProxy({ host, port }).listen(3000, '0.0.0.0');
}
