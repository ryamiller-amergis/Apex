/**
 * FEAT-007 / TBI-008 + FEAT-002 / TBI-010 — WebSocket agent gateway host mount.
 *
 * Adapts real `ws` upgrade requests on `/api/interactive/threads/:id/stream`
 * to the transport-agnostic {@link attachInteractiveThreadStream} core. The
 * upgrade is authenticated by replaying the SAME express-session + passport
 * chain the HTTP routes use, then authorized against thread read access.
 *
 * The gateway is unconditionally active in all deployments (no env var or
 * feature-flag gates); any auth or thread-access failure destroys the socket
 * without leaking thread existence (BR-017, BR-019).
 */
import http from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { RequestHandler, Request } from 'express';
import { WebSocketServer } from 'ws';
import { getUserId } from '../utils/requestUser';
import { resolveThreadAccess } from './threadAccessService';
import { getAdoTokenForUser } from './adoUserToken';
import {
  attachInteractiveThreadStream,
  createInteractiveGatewayDependencies,
  type InteractiveGatewaySocket,
} from './interactiveGatewayService';
import { getAreaProfile } from './chatHarness/areaProfiles';
import {
  canCommandThread,
  chatHarnessCommandHandler,
  inferHarnessAreaFromThread,
} from './chatHarness/chatHarnessCommandHandler';

const GATEWAY_PATH = /^\/api\/interactive\/threads\/([^/]+)\/stream$/;

/** Always enabled (TBI-010 removed the env-var and feature-flag rollout gates). */
export function isInteractiveGatewayEnabled(): boolean {
  return true;
}

export interface InteractiveGatewayHostDependencies {
  /** express-session middleware instance (same one the app mounts). */
  sessionMiddleware: RequestHandler;
  /** passport.initialize() result. */
  passportInitialize: RequestHandler;
  /** passport.session() result. */
  passportSession: RequestHandler;
}

function runMiddleware(
  middleware: RequestHandler,
  req: IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    middleware(req as unknown as Request, res as never, (err?: unknown) =>
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
    );
  });
}

function rawWsDataToString(
  raw: Buffer | ArrayBuffer | Buffer[] | string,
): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

/**
 * Attach the interactive WebSocket gateway to `server`. Returns the
 * WebSocketServer (noServer mode) so callers can close it on shutdown.
 */
export function mountInteractiveGateway(
  server: http.Server,
  dependencies: InteractiveGatewayHostDependencies,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rawUrl = req.url ?? '';
    const pathname = rawUrl.split('?')[0];
    const match = GATEWAY_PATH.exec(pathname);
    // Not our path — leave the upgrade for any other handler/no-op.
    if (!match) return;

    const threadId = decodeURIComponent(match[1]);

    void (async () => {
      try {
        // Replay the HTTP auth chain against the raw upgrade request.
        const res = new http.ServerResponse(req);
        await runMiddleware(dependencies.sessionMiddleware, req, res);
        await runMiddleware(dependencies.passportInitialize, req, res);
        await runMiddleware(dependencies.passportSession, req, res);

        const userId = getUserId(req as unknown as Request);
        if (!userId || userId === 'anonymous') {
          socket.destroy();
          return;
        }

        const access = await resolveThreadAccess(userId, threadId);
        if (!access) {
          socket.destroy();
          return;
        }

        const area = inferHarnessAreaFromThread(access.thread);
        const canWrite = await canCommandThread(
          userId,
          access,
          getAreaProfile(area),
        ).catch(() => false);

        wss.handleUpgrade(req, socket, head, (ws) => {
          const lastEventId =
            new URL(rawUrl, 'http://localhost').searchParams.get('lastEventId') ??
            undefined;

          const gatewaySocket: InteractiveGatewaySocket = {
            send: (data: string) => {
              if (ws.readyState === ws.OPEN) ws.send(data);
            },
            onClose: (handler: () => void) => {
              ws.on('close', handler);
              ws.on('error', handler);
            },
            onMessage: (handler: (data: string) => void) => {
              ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[] | string) => {
                handler(rawWsDataToString(raw));
              });
            },
          };

          const gatewayDeps = createInteractiveGatewayDependencies({
            onCommand: async (body) => {
              const requestAdoToken = await getAdoTokenForUser(
                req as unknown as Request,
              ).catch(() => null);
              return chatHarnessCommandHandler.handle({
                userId,
                threadId,
                body,
                transport: 'socket',
                requestAdoToken,
              });
            },
          });

          void attachInteractiveThreadStream(
            gatewaySocket,
            threadId,
            { lastEventId, canWrite },
            gatewayDeps,
          );
        });
      } catch {
        // Never leak details on the upgrade path.
        socket.destroy();
      }
    })();
  });

  return wss;
}
