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
});
