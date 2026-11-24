import type http from 'http';
import type { Duplex } from 'stream';
import type { RequestHandler } from 'express';
import { WebSocketServer } from 'ws';
import {
  isInteractiveGatewayEnabled,
  mountInteractiveGateway,
} from '../services/interactiveGatewayHost';
import { getUserId } from '../utils/requestUser';
import { resolveThreadAccess } from '../services/threadAccessService';
import { isFeatureEnabled } from '../services/featureFlagService';

jest.mock('ws', () => ({
  WebSocketServer: jest.fn(),
}));

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn(),
}));

jest.mock('../services/threadAccessService', () => ({
  resolveThreadAccess: jest.fn(),
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
}));

jest.mock('../services/interactiveGatewayService', () => ({
  attachInteractiveThreadStream: jest.fn(),
  createInteractiveGatewayDependencies: jest.fn((overrides) => overrides),
}));

jest.mock('../services/chatHarness/chatHarnessCommandHandler', () => ({
  canCommandThread: jest.fn(async () => true),
  chatHarnessCommandHandler: { handle: jest.fn() },
  inferHarnessAreaFromThread: jest.fn(() => 'agent-home'),
}));

const mockGetUserId = getUserId as jest.MockedFunction<typeof getUserId>;
const mockResolveThreadAccess =
  resolveThreadAccess as jest.MockedFunction<typeof resolveThreadAccess>;
const mockIsFeatureEnabled =
  isFeatureEnabled as jest.MockedFunction<typeof isFeatureEnabled>;
const mockWebSocketServer = WebSocketServer as unknown as jest.Mock;

const pass: RequestHandler = (_req, _res, next) => next();

describe('interactive gateway host', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserId.mockReturnValue('user-1');
    mockResolveThreadAccess.mockResolvedValue({
      access: 'owner',
      thread: {
        id: 'thread-1',
        kickoff: { project: 'Apex' },
      },
    } as never);
  });

  it('opens the WebSocket gateway without env or feature-flag gates when session and read access succeed', async () => {
    let upgrade:
      | ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void)
      | undefined;
    const handleUpgrade = jest.fn();
    mockWebSocketServer.mockImplementation(() => ({
      handleUpgrade,
    }));
    mockIsFeatureEnabled.mockResolvedValue(false);
    const server = {
      on: jest.fn((event: string, handler: typeof upgrade) => {
        if (event === 'upgrade') upgrade = handler;
      }),
    } as unknown as http.Server;
    const socket = {
      destroy: jest.fn(),
    } as unknown as Duplex;

    expect(isInteractiveGatewayEnabled()).toBe(true);

    mountInteractiveGateway(server, {
      sessionMiddleware: pass,
      passportInitialize: pass,
      passportSession: pass,
    });
    upgrade?.(
      { url: '/api/interactive/threads/thread-1/stream' } as http.IncomingMessage,
      socket,
      Buffer.alloc(0),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('destroys the socket when the caller lacks thread read access', async () => {
    let upgrade:
      | ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void)
      | undefined;
    const handleUpgrade = jest.fn();
    mockWebSocketServer.mockImplementation(() => ({
      handleUpgrade,
    }));
    mockResolveThreadAccess.mockResolvedValueOnce(null);
    const server = {
      on: jest.fn((event: string, handler: typeof upgrade) => {
        if (event === 'upgrade') upgrade = handler;
      }),
    } as unknown as http.Server;
    const socket = {
      destroy: jest.fn(),
    } as unknown as Duplex;

    mountInteractiveGateway(server, {
      sessionMiddleware: pass,
      passportInitialize: pass,
      passportSession: pass,
    });
    upgrade?.(
      { url: '/api/interactive/threads/thread-1/stream' } as http.IncomingMessage,
      socket,
      Buffer.alloc(0),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});
