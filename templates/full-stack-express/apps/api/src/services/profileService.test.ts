import { describe, expect, it } from 'vitest';
import { createMemoryPersistence } from '../../test/support/memoryPersistence.ts';
import { PRINCIPAL_A } from '../../test/support/testApp.ts';
import {
  PersistenceUnavailableError,
  ProfileConflictError,
} from '../persistence/index.ts';
import {
  createProfileService,
  DEFAULT_DISPLAY_NAME,
  ProfileVanishedError,
} from './profileService.ts';

function setup() {
  const persistence = createMemoryPersistence();
  const events: string[] = [];
  const service = createProfileService({
    users: persistence.users,
    onProfileCreated: () => events.push('profile.created'),
  });
  return { persistence, service, events };
}

function subjectsSeen(persistence: ReturnType<typeof createMemoryPersistence>) {
  return [...new Set(persistence.calls.map((call) => call.subject))];
}

describe('profileService.getOwnProfile (VT-30)', () => {
  it('TBI-015 PBI-010 AC-0 returns an existing row as a profile without subject or id', async () => {
    const { persistence, service, events } = setup();
    persistence.seed({
      externalSubject: PRINCIPAL_A.subject,
      displayName: 'Stored Name',
      email: 'stored@example.test',
    });
    expect(await service.getOwnProfile(PRINCIPAL_A)).toEqual({
      displayName: 'Stored Name',
      email: 'stored@example.test',
      status: 'active',
    });
    expect(persistence.calls.map((call) => call.method)).toEqual([
      'findBySubject',
    ]);
    expect(events).toEqual([]);
  });

  it('TBI-015 DoD-1 PBI-010 AC-2 creates the row from the principal on first access', async () => {
    const { persistence, service, events } = setup();
    const profile = await service.getOwnProfile(PRINCIPAL_A);
    expect(profile).toEqual({
      displayName: PRINCIPAL_A.displayName,
      email: null,
      status: 'active',
    });
    expect(persistence.row(PRINCIPAL_A.subject)).toMatchObject({
      displayName: PRINCIPAL_A.displayName,
      email: null,
    });
    expect(events).toEqual(['profile.created']);
  });

  it('PBI-010 AC-2 retries once on a unique conflict and returns the winner row', async () => {
    const { persistence, service } = setup();
    let finds = 0;
    persistence.override('findBySubject', () => {
      finds += 1;
      return finds === 1
        ? null
        : { displayName: 'Winner', email: null, status: 'active' };
    });
    persistence.override('create', () => {
      throw new ProfileConflictError();
    });
    expect(await service.getOwnProfile(PRINCIPAL_A)).toEqual({
      displayName: 'Winner',
      email: null,
      status: 'active',
    });
    expect(persistence.calls.map((call) => call.method)).toEqual([
      'findBySubject',
      'create',
      'findBySubject',
    ]);
  });

  it('PBI-010 AC-2 throws when the row is still missing after a conflict', async () => {
    const { persistence, service } = setup();
    persistence.override('findBySubject', () => null);
    persistence.override('create', () => {
      throw new ProfileConflictError();
    });
    await expect(service.getOwnProfile(PRINCIPAL_A)).rejects.toBeInstanceOf(
      ProfileVanishedError
    );
  });

  it.each([
    ['no display name', { subject: 'synthetic-subject-nodn' }],
    [
      'a blank display name',
      { subject: 'synthetic-subject-nodn', displayName: '   ' },
    ],
  ])(
    'PBI-010 AC-2 stores the fallback name, never the subject, for %s',
    async (_label, principal) => {
      const { persistence, service } = setup();
      const profile = await service.getOwnProfile(principal);
      expect(DEFAULT_DISPLAY_NAME).toBe('New user');
      expect(profile.displayName).toBe(DEFAULT_DISPLAY_NAME);
      expect(persistence.row(principal.subject)?.displayName).toBe(
        DEFAULT_DISPLAY_NAME
      );
    }
  );

  it('PBI-010 AC-2 trims the principal name and cuts it to 100 code points', async () => {
    const { persistence, service } = setup();
    const long = `  ${'\u{1F600}'.repeat(120)}  `;
    await service.getOwnProfile({
      subject: 'synthetic-long',
      displayName: long,
    });
    const stored = persistence.row('synthetic-long')!.displayName;
    expect([...stored]).toHaveLength(100);
    expect(stored.startsWith('\u{1F600}')).toBe(true);
  });

  it('VT-30 TBI-015 NFR passes only principal.subject to the data layer', async () => {
    const { persistence, service } = setup();
    await service.getOwnProfile(PRINCIPAL_A);
    await service.updateOwnProfile(PRINCIPAL_A, {
      displayName: 'Changed',
      email: null,
    });
    expect(subjectsSeen(persistence)).toEqual([PRINCIPAL_A.subject]);
  });

  it('PBI-010 AC-1 lets PersistenceUnavailableError through unchanged', async () => {
    const { persistence, service } = setup();
    const failure = new PersistenceUnavailableError();
    persistence.override('findBySubject', () => {
      throw failure;
    });
    await expect(service.getOwnProfile(PRINCIPAL_A)).rejects.toBe(failure);
  });
});

describe('profileService.updateOwnProfile', () => {
  it('PBI-011 AC-0 replaces both editable fields and returns the stored state', async () => {
    const { persistence, service } = setup();
    persistence.seed({
      externalSubject: PRINCIPAL_A.subject,
      displayName: 'Old',
      email: 'old@example.test',
    });
    expect(
      await service.updateOwnProfile(PRINCIPAL_A, {
        displayName: 'New Name',
        email: 'new@example.test',
      })
    ).toEqual({
      displayName: 'New Name',
      email: 'new@example.test',
      status: 'active',
    });
  });

  it('PBI-011 AC-2 an omitted email clears the stored email', async () => {
    const { persistence, service } = setup();
    persistence.seed({
      externalSubject: PRINCIPAL_A.subject,
      displayName: 'Old',
      email: 'old@example.test',
    });
    const profile = await service.updateOwnProfile(PRINCIPAL_A, {
      displayName: 'Old',
    });
    expect(profile.email).toBeNull();
    expect(persistence.row(PRINCIPAL_A.subject)?.email).toBeNull();
  });

  it('VT-14 creates the row first when PUT comes before any GET', async () => {
    const { persistence, service } = setup();
    const profile = await service.updateOwnProfile(PRINCIPAL_A, {
      displayName: 'First Write',
      email: 'first@example.test',
    });
    expect(profile.displayName).toBe('First Write');
    expect(persistence.rowCount()).toBe(1);
  });

  it('throws when the row disappears between ensure and update', async () => {
    const { persistence, service } = setup();
    persistence.override('updateBySubject', () => null);
    await expect(
      service.updateOwnProfile(PRINCIPAL_A, { displayName: 'X' })
    ).rejects.toBeInstanceOf(ProfileVanishedError);
  });
});
