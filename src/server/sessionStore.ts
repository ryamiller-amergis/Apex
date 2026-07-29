import fs from 'fs';
import path from 'path';
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import type { Pool } from 'pg';
import createFileStore from 'session-file-store';
import pool from './db';
import { resolveDataRoot } from './utils/dataDir';

export const SESSION_TTL_SECONDS = 24 * 60 * 60;
export const SESSION_COOKIE_MAX_AGE_MS = SESSION_TTL_SECONDS * 1000;
export const SESSION_TABLE_NAME = 'express_sessions';
export const SESSION_PRUNE_INTERVAL_SECONDS = 15 * 60;

export type SessionStoreBackend = 'postgres' | 'file';

export interface SessionStoreResult {
  backend: SessionStoreBackend;
  store: session.Store;
}

interface CreateSessionStoreOptions {
  env?: NodeJS.ProcessEnv;
  pgPool?: Pool;
  dataRoot?: string;
  mkdirSync?: typeof fs.mkdirSync;
  log?: (message: string) => void;
}

const PgStore = connectPgSimple(session);
const FileStore = createFileStore(session);

export function resolveSessionStoreBackend(
  env: NodeJS.ProcessEnv = process.env
): SessionStoreBackend {
  const requestedBackend = env.SESSION_STORE?.trim().toLowerCase();

  if (!requestedBackend) {
    return env.NODE_ENV === 'production' ? 'postgres' : 'file';
  }

  if (requestedBackend === 'postgres' || requestedBackend === 'postgresql') {
    return 'postgres';
  }

  if (requestedBackend === 'file') {
    return 'file';
  }

  throw new Error(
    `[session] Unsupported SESSION_STORE value "${env.SESSION_STORE}". Expected "postgres" or "file".`
  );
}

export function createSessionStore(
  options: CreateSessionStoreOptions = {}
): SessionStoreResult {
  const env = options.env ?? process.env;
  const backend = resolveSessionStoreBackend(env);
  const log = options.log ?? console.log;

  if (backend === 'postgres') {
    const store = new PgStore({
      pool: options.pgPool ?? pool,
      tableName: SESSION_TABLE_NAME,
      ttl: SESSION_TTL_SECONDS,
      createTableIfMissing: false,
      pruneSessionInterval: SESSION_PRUNE_INTERVAL_SECONDS,
    });
    log('[session] Using PostgreSQL store');
    return { backend, store };
  }

  const sessionsDir = path.join(
    options.dataRoot ?? resolveDataRoot(),
    'sessions'
  );
  (options.mkdirSync ?? fs.mkdirSync)(sessionsDir, { recursive: true });

  const store = new FileStore({
    path: sessionsDir,
    ttl: SESSION_TTL_SECONDS,
    // Azure Files can briefly miss a just-written session during concurrent OAuth
    // requests. Retries preserve the emergency fallback's established behavior.
    retries: 5,
  });
  log('[session] Using file store');
  return { backend, store };
}

export function createSessionOptions(
  store: session.Store,
  env: NodeJS.ProcessEnv = process.env
): session.SessionOptions {
  return {
    secret: env.SESSION_SECRET || 'your-secret-key-change-this',
    store,
    resave: false,
    saveUninitialized: true,
    name: 'connect.sid',
    cookie: {
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      sameSite: 'lax',
      path: '/',
    },
  };
}
