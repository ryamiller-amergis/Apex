import './setup';
import type { SessionData, Store } from 'express-session';
import pool from '../../src/server/db';
import { createSessionStore } from '../../src/server/sessionStore';

type PostgreSqlSessionStore = Store & {
  close(): void | Promise<void>;
  pruneSessions(callback?: (error: Error | null) => void): void;
};

interface TouchSessionStore {
  touch(
    sid: string,
    data: SessionData,
    callback: (error?: unknown) => void
  ): void;
}

const TEST_SID_PREFIX = 'integration-session-';

function sessionData(expires: Date, marker: string): SessionData {
  return {
    cookie: {
      expires,
      originalMaxAge: expires.getTime() - Date.now(),
    },
    marker,
  } as SessionData;
}

function setSession(
  store: Store,
  sid: string,
  data: SessionData
): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(sid, data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function getSession(store: Store, sid: string): Promise<SessionData | null> {
  return new Promise((resolve, reject) => {
    store.get(sid, (error, data) => {
      if (error) reject(error);
      else resolve(data ?? null);
    });
  });
}

function touchSession(
  store: Store,
  sid: string,
  data: SessionData
): Promise<void> {
  return new Promise((resolve, reject) => {
    (store as unknown as TouchSessionStore).touch(sid, data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(store: Store, sid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    store.destroy(sid, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function pruneSessions(store: PostgreSqlSessionStore): Promise<void> {
  return new Promise((resolve, reject) => {
    store.pruneSessions((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('PostgreSQL session store integration', () => {
  const { store } = createSessionStore({
    env: { NODE_ENV: 'production' },
    pgPool: pool,
    log: () => undefined,
  });
  const postgresStore = store as PostgreSqlSessionStore;

  afterEach(async () => {
    await pool.query('DELETE FROM express_sessions WHERE sid LIKE $1', [
      `${TEST_SID_PREFIX}%`,
    ]);
  });

  afterAll(async () => {
    await postgresStore.close();
  });

  it('persists, retrieves, touches, and destroys a session', async () => {
    const sid = `${TEST_SID_PREFIX}lifecycle`;
    const initialExpiry = new Date(Date.now() + 60_000);
    await setSession(store, sid, sessionData(initialExpiry, 'persisted'));

    const fetched = await getSession(store, sid);
    expect((fetched as SessionData & { marker: string }).marker).toBe(
      'persisted'
    );

    const touchedExpiry = new Date(Date.now() + 60 * 60 * 1000);
    await touchSession(store, sid, sessionData(touchedExpiry, 'persisted'));

    const expiryResult = await pool.query<{ expire: Date }>(
      'SELECT expire FROM express_sessions WHERE sid = $1',
      [sid]
    );
    expect(expiryResult.rows[0].expire.getTime()).toBeGreaterThan(
      initialExpiry.getTime()
    );

    await destroySession(store, sid);
    await expect(getSession(store, sid)).resolves.toBeNull();
  });

  it('prunes expired sessions', async () => {
    const sid = `${TEST_SID_PREFIX}expired`;
    await setSession(
      store,
      sid,
      sessionData(new Date(Date.now() - 60_000), 'expired')
    );

    await pruneSessions(postgresStore);

    const result = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM express_sessions WHERE sid = $1',
      [sid]
    );
    expect(result.rows[0].count).toBe('0');
  });
});
