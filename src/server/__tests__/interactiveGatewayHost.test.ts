import type http from 'http';
import type { Duplex } from 'stream';
import type { RequestHandler } from 'express';
import { WebSocketServer } from 'ws';
import { mountInteractiveGateway } from '../services/interactiveGatewayHost';
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
      thread: {
        id: 'thread-1',
        kickoff: { project: 'Apex' },
      },
    } as never);
  });

  it('authorizes the WebSocket gateway with the canonical V2 transport flag', async () => {
    let upgrade:
      | ((req: http.IncomingMessage, socket: Duplex, head: Buffer) => void)
      | undefined;
    const handleUpgrade = jest.fn();
    mockWebSocketServer.mockImplementation(() => ({
      handleUpgrade,
    }));
    mockIsFeatureEnabled.mockImplementation(
      async (key: string) => key === 'ai-runs-v2-transport',
    );
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

    expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
      'ai-runs-v2-transport',
      { userId: 'user-1', project: 'Apex' },
    );
    expect(handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
