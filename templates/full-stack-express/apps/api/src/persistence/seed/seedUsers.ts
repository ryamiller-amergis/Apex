import type { AppUserStore, NewAppUser } from '../appUserStore.ts';
import { ProfileConflictError } from '../errors.ts';

// Synthetic values only: `seed-user-` subjects, `Sample Person` names, and the
// reserved example.com domain. Never add a real name, email, or subject.
export const SEED_USERS: readonly NewAppUser[] = [
  {
    externalSubject: 'seed-user-001',
    displayName: 'Sample Person One',
    email: 'sample.one@example.com',
  },
  {
    externalSubject: 'seed-user-002',
    displayName: 'Sample Person Two',
    email: 'sample.two@example.com',
  },
  {
    externalSubject: 'seed-user-003',
    displayName: 'Sample Person Three',
    email: 'sample.three@example.com',
  },
];

export interface SeedResult {
  created: number;
  existing: number;
}

// Insert-if-absent: an existing row is counted and never updated, so a row a
// developer edited stays edited.
export async function seedUsers(
  store: Pick<AppUserStore, 'findBySubject' | 'create'>,
  fixtures: readonly NewAppUser[] = SEED_USERS
): Promise<SeedResult> {
  const result: SeedResult = { created: 0, existing: 0 };
  for (const fixture of fixtures) {
    if (await store.findBySubject(fixture.externalSubject)) {
      result.existing += 1;
      continue;
    }
    try {
      await store.create(fixture);
      result.created += 1;
    } catch (error) {
      if (!(error instanceof ProfileConflictError)) {
        throw error;
      }
      result.existing += 1;
    }
  }
  return result;
}
