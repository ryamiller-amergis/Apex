import path from 'path';
import type { Pool } from 'pg';

const mockPgStoreConstructor = jest.fn();
const mockFileStoreConstructor = jest.fn();

jest.mock('connect-pg-simple', () => ({
  __esModule: true,
  default: jest.fn(() => mockPgStoreConstructor),
}));

jest.mock('session-file-store', () => ({
  __esModule: true,
  default: jest.fn(() => mockFileStoreConstructor),
}));

jest.mock('../db', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: jest.fn(() => 'default-data-root'),
}));

import {
  createSessionOptions,
  createSessionStore,
  resolveSessionStoreBackend,
  SESSION_COOKIE_MAX_AGE_MS,
  SESSION_PRUNE_INTERVAL_SECONDS,
  SESSION_TABLE_NAME,
  SESSION_TTL_SECONDS,
} from '../sessionStore';

describe('session store selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPgStoreConstructor.mockImplementation(() => ({ kind: 'postgres' }));
    mockFileStoreConstructor.mockImplementation(() => ({ kind: 'file' }));
  });

  it('defaults production to the shared PostgreSQL pool without runtime table creation', () => {
    const pgPool = { query: jest.fn() } as unknown as Pool;
    const mkdirSync = jest.fn();
    const log = jest.fn();

    const result = createSessionStore({
      env: { NODE_ENV: 'production' },
      pgPool,
      mkdirSync,
      log,
    });

    expect(result.backend).toBe('postgres');
    expect(mockPgStoreConstructor).toHaveBeenCalledWith({
      pool: pgPool,
      tableName: SESSION_TABLE_NAME,
      ttl: SESSION_TTL_SECONDS,
      createTableIfMissing: false,
      pruneSessionInterval: SESSION_PRUNE_INTERVAL_SECONDS,
    });
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[session] Using PostgreSQL store');
  });

  it('uses the file fallback when SESSION_STORE=file in production', () => {
    const mkdirSync = jest.fn();
    const log = jest.fn();
    const dataRoot = path.join('test', 'data');

    const result = createSessionStore({
      env: { NODE_ENV: 'production', SESSION_STORE: 'file' },
      dataRoot,
      mkdirSync,
      log,
    });

    const sessionsDir = path.join(dataRoot, 'sessions');
    expect(result.backend).toBe('file');
    expect(mkdirSync).toHaveBeenCalledWith(sessionsDir, { recursive: true });
    expect(mockFileStoreConstructor).toHaveBeenCalledWith({
      path: sessionsDir,
      ttl: SESSION_TTL_SECONDS,
      retries: 5,
    });
    expect(log).toHaveBeenCalledWith('[session] Using file store');
  });

  it('defaults local development to files and allows an explicit PostgreSQL override', () => {
    expect(resolveSessionStoreBackend({ NODE_ENV: 'development' })).toBe(
      'file'
    );
    expect(
      resolveSessionStoreBackend({
        NODE_ENV: 'development',
        SESSION_STORE: 'postgres',
      })
    ).toBe('postgres');
  });

  it('rejects an unsupported SESSION_STORE value instead of silently choosing a backend', () => {
    expect(() =>
      resolveSessionStoreBackend({
        NODE_ENV: 'production',
        SESSION_STORE: 'redis',
      })
    ).toThrow('Unsupported SESSION_STORE value');
  });
});

describe('OAuth-critical session options', () => {
  it('preserves the existing cookie name, TTL, persistence, and production cookie settings', () => {
    const store = { kind: 'test-store' } as never;
    const options = createSessionOptions(store, {
      NODE_ENV: 'production',
      SESSION_SECRET: 'test-secret',
    });

    expect(options).toEqual({
      secret: 'test-secret',
      store,
      resave: false,
      saveUninitialized: true,
      name: 'connect.sid',
      cookie: {
        secure: true,
        httpOnly: true,
        maxAge: SESSION_COOKIE_MAX_AGE_MS,
        sameSite: 'lax',
        path: '/',
      },
    });
    expect(SESSION_COOKIE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
