import https from 'https';
import { EventEmitter } from 'events';
import { mintCursorUserSubToken } from '../services/cursorSubTokenService';

jest.mock('https');

describe('cursorSubTokenService', () => {
  const mockHttps = https as jest.Mocked<typeof https>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POSTs forUserEmail to /v1/sub-tokens with Bearer service-account key', async () => {
    const response = new EventEmitter() as EventEmitter & {
      statusCode?: number;
    };
    response.statusCode = 200;

    const request = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      end: jest.Mock;
      destroy: jest.Mock;
      setTimeout: jest.Mock;
    };
    request.write = jest.fn();
    request.end = jest.fn();
    request.destroy = jest.fn();
    request.setTimeout = jest.fn();

    mockHttps.request.mockImplementation(((
      _opts: https.RequestOptions,
      callback?: (res: import('http').IncomingMessage) => void,
    ) => {
      callback?.(response as unknown as import('http').IncomingMessage);
      process.nextTick(() => {
        response.emit(
          'data',
          Buffer.from(JSON.stringify({
            accessToken: 'user-scoped-token',
            expiresAt: '2026-09-03T15:00:00.000Z',
            userId: 42,
            teamId: 7,
          })),
        );
        response.emit('end');
      });
      return request as unknown as import('http').ClientRequest;
    }) as typeof https.request);

    const result = await mintCursorUserSubToken({
      serviceAccountApiKey: 'sa-key',
      forUserEmail: 'dev@example.com',
    });

    expect(result.accessToken).toBe('user-scoped-token');
    expect(mockHttps.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'api.cursor.com',
        path: '/v1/sub-tokens',
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sa-key',
        }),
      }),
      expect.any(Function),
    );
    expect(request.write).toHaveBeenCalledWith(
      JSON.stringify({ forUserEmail: 'dev@example.com' }),
    );
  });

  it('surfaces non-2xx responses as errors', async () => {
    const response = new EventEmitter() as EventEmitter & { statusCode?: number };
    response.statusCode = 403;

    const request = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      end: jest.Mock;
      setTimeout: jest.Mock;
    };
    request.write = jest.fn();
    request.end = jest.fn();
    request.setTimeout = jest.fn();

    mockHttps.request.mockImplementation(((
      _opts: https.RequestOptions,
      callback?: (res: import('http').IncomingMessage) => void,
    ) => {
      callback?.(response as unknown as import('http').IncomingMessage);
      process.nextTick(() => {
        response.emit('data', Buffer.from(JSON.stringify({ message: 'not allowed' })));
        response.emit('end');
      });
      return request as unknown as import('http').ClientRequest;
    }) as typeof https.request);

    await expect(mintCursorUserSubToken({
      serviceAccountApiKey: 'sa-key',
      forUserEmail: 'dev@example.com',
    })).rejects.toThrow('Cursor sub-token 403: not allowed');
  });
});
