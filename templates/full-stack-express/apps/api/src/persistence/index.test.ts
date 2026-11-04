import { describe, expect, it } from 'vitest';
import * as persistence from './index.ts';

describe('persistence public surface', () => {
  it('TBI-006 DoD-1 exports createPersistence and the typed errors only', () => {
    expect(Object.keys(persistence).sort()).toEqual([
      'PersistenceError',
      'PersistenceUnavailableError',
      'ProfileConflictError',
      'SchemaNotMigratedError',
      'createPersistence',
    ]);
  });

  it('TBI-006 DoD-1 builds a store with find, create, and update by subject', async () => {
    const instance = persistence.createPersistence({
      databaseUrl: 'postgresql://app_user:unused@127.0.0.1:1/project_db',
    });
    try {
      expect(Object.keys(instance.users).sort()).toEqual([
        'create',
        'findBySubject',
        'updateBySubject',
      ]);
      expect(typeof instance.ping).toBe('function');
    } finally {
      await instance.close();
    }
  });

  it('FEAT-006 PBI-012 AC-2 a ping gives up within the configured connection timeout', async () => {
    const instance = persistence.createPersistence({
      // TEST-NET-1 (RFC 5737): never routed, so the connect attempt hangs or fails.
      databaseUrl: 'postgresql://app_user:unused@192.0.2.1:5432/project_db',
      connectionTimeoutMs: 200,
    });
    const started = Date.now();
    try {
      await expect(instance.ping()).rejects.toBeInstanceOf(
        persistence.PersistenceUnavailableError
      );
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await instance.close();
    }
  });
});
