/**
 * TBI-009 / PBI-009 — whatsNewStateService unit tests (VT-01–VT-05, DoD-0–DoD-3).
 */
jest.mock('../services/changelogService', () => {
  const actual = jest.requireActual('../services/changelogService') as Record<string, unknown>;
  return {
    ...actual,
    resolveCurrentChangelogVersion: jest.fn(),
  };
});

jest.mock('../services/rbacService', () => ({
  getChangelogPrefs: jest.fn(),
  updateChangelogPrefs: jest.fn(),
}));

import { resolveCurrentChangelogVersion } from '../services/changelogService';
import { getChangelogPrefs, updateChangelogPrefs } from '../services/rbacService';
import {
  acknowledgeWhatsNew,
  evaluateWhatsNewState,
} from '../services/whatsNewStateService';

const mockResolve = resolveCurrentChangelogVersion as jest.MockedFunction<
  typeof resolveCurrentChangelogVersion
>;
const mockPrefs = getChangelogPrefs as jest.MockedFunction<typeof getChangelogPrefs>;
const mockUpdate = updateChangelogPrefs as jest.MockedFunction<typeof updateChangelogPrefs>;

beforeEach(() => {
  mockResolve.mockReset();
  mockPrefs.mockReset();
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue(undefined);
});

describe('evaluateWhatsNewState', () => {
  it('DoD-2 / VT-01 / AC-0: returns ready + unread when lastSeen is lower than current', async () => {
    mockResolve.mockResolvedValue('1.4.3');
    mockPrefs.mockResolvedValue({
      lastSeenVersion: '1.4.2',
      showOnLogin: true,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });

    await expect(evaluateWhatsNewState('user-1')).resolves.toEqual({
      status: 'ready',
      currentVersion: '1.4.3',
      lastSeenVersion: '1.4.2',
      unread: true,
      showOnLogin: true,
      seeded: false,
    });
  });

  it('DoD-2 / VT-02 / AC-3: unread false when lastSeen equals or exceeds current', async () => {
    mockResolve.mockResolvedValue('1.4.3');
    mockPrefs.mockResolvedValue({
      lastSeenVersion: '1.4.3',
      showOnLogin: true,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });
    await expect(evaluateWhatsNewState('user-1')).resolves.toMatchObject({
      unread: false,
      status: 'seeded',
      seeded: true,
    });

    mockPrefs.mockResolvedValue({
      lastSeenVersion: '1.5.0',
      showOnLogin: true,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });
    await expect(evaluateWhatsNewState('user-1')).resolves.toMatchObject({
      unread: false,
      status: 'ready',
      seeded: false,
    });
  });

  it('DoD-2 / VT-03 / AC-1 / AC-3: unavailable and never unread when changelog invalid', async () => {
    mockResolve.mockResolvedValue(null);
    mockPrefs.mockResolvedValue({
      lastSeenVersion: '1.4.2',
      showOnLogin: true,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });

    await expect(evaluateWhatsNewState('user-1')).resolves.toEqual({
      status: 'unavailable',
      currentVersion: null,
      lastSeenVersion: '1.4.2',
      unread: false,
      showOnLogin: true,
      seeded: false,
    });
  });

  it('DoD-1 / VT-05 / AC-2: existing null acknowledgement is unread (not silently reseeded)', async () => {
    mockResolve.mockResolvedValue('2.0.1');
    mockPrefs.mockResolvedValue({
      lastSeenVersion: null,
      showOnLogin: true,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });

    await expect(evaluateWhatsNewState('user-1')).resolves.toMatchObject({
      status: 'ready',
      currentVersion: '2.0.1',
      lastSeenVersion: null,
      unread: true,
      seeded: false,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('AC-2: patch release remains unread', async () => {
    mockResolve.mockResolvedValue('1.0.1');
    mockPrefs.mockResolvedValue({
      lastSeenVersion: '1.0.0',
      showOnLogin: false,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });

    await expect(evaluateWhatsNewState('user-1')).resolves.toMatchObject({
      unread: true,
      showOnLogin: false,
      currentVersion: '1.0.1',
    });
  });

  it('AC-3: malformed persisted lastSeen never creates unread', async () => {
    mockResolve.mockResolvedValue('1.4.3');
    mockPrefs.mockResolvedValue({
      lastSeenVersion: 'not-semver',
      showOnLogin: true,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });

    await expect(evaluateWhatsNewState('user-1')).resolves.toMatchObject({
      unread: false,
      status: 'ready',
    });
  });
});

describe('acknowledgeWhatsNew', () => {
  it('DoD-0 / AC-4: persists lastSeenVersion equal to current bundled release', async () => {
    mockResolve.mockResolvedValue('2.0.1');
    mockPrefs.mockResolvedValue({
      lastSeenVersion: '2.0.1',
      showOnLogin: true,
      dismissedBetaProdAnnouncement: false,
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });

    const state = await acknowledgeWhatsNew('user-1', '2.0.1');
    expect(mockUpdate).toHaveBeenCalledWith('user-1', { lastSeenChangelogVersion: '2.0.1' });
    expect(state.unread).toBe(false);
  });

  it('AC-3 / VT-08: rejects acknowledgement of a non-current version', async () => {
    mockResolve.mockResolvedValue('2.0.1');
    await expect(acknowledgeWhatsNew('user-1', '9.9.9')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
