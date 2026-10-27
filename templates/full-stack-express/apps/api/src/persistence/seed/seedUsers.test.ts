import { describe, expect, it } from 'vitest';
import type { AppUser, AppUserStore, NewAppUser } from '../appUserStore.ts';
import { ProfileConflictError } from '../errors.ts';
import { SEED_USERS, seedUsers } from './seedUsers.ts';

function memoryStore(): AppUserStore & { rows: Map<string, AppUser> } {
  const rows = new Map<string, AppUser>();
  return {
    rows,
    async findBySubject(subject) {
      return rows.get(subject) ?? null;
    },
    async create(input: NewAppUser) {
      if (rows.has(input.externalSubject)) {
        throw new ProfileConflictError({ sqlState: '23505' });
      }
      const now = new Date();
      const row: AppUser = {
        id: `id-${rows.size + 1}`,
        externalSubject: input.externalSubject,
        displayName: input.displayName,
        email: input.email ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.externalSubject, row);
      return row;
    },
    async updateBySubject() {
      throw new Error('the seed never updates rows');
    },
  };
}

describe('seed fixtures', () => {
  it('VT-24 TBI-008 DoD-0 DoD-3 BR-007 every fixture uses synthetic subjects, names, and domains', () => {
    expect(SEED_USERS).toHaveLength(3);
    const subjects = new Set<string>();
    for (const user of SEED_USERS) {
      expect(user.externalSubject).toMatch(/^seed-user-/);
      expect(user.displayName).toMatch(/^Sample Person /);
      expect(user.email).toMatch(/@example\.com$/);
      subjects.add(user.externalSubject);
    }
    expect(subjects.size).toBe(SEED_USERS.length);
  });
});

describe('seedUsers', () => {
  it('PBI-005 AC-0 inserts every fixture into an empty store', async () => {
    const store = memoryStore();
    expect(await seedUsers(store)).toEqual({ created: 3, existing: 0 });
    expect([...store.rows.keys()]).toEqual(
      SEED_USERS.map((user) => user.externalSubject)
    );
  });

  it('TBI-008 DoD-1 PBI-005 AC-2 running twice leaves the same rows', async () => {
    const store = memoryStore();
    await seedUsers(store);
    const first = new Map(store.rows);
    expect(await seedUsers(store)).toEqual({ created: 0, existing: 3 });
    expect(store.rows).toEqual(first);
  });

  it('counts a row created by a concurrent run as already present', async () => {
    const store = memoryStore();
    const racing: AppUserStore = {
      ...store,
      findBySubject: async () => null,
    };
    await store.create(SEED_USERS[0] as NewAppUser);
    expect(await seedUsers(racing)).toEqual({ created: 2, existing: 1 });
  });
});
