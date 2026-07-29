import type { WhatsNewState } from '../../shared/types/whatsNew';
import { semverGt, semverValid } from '../../shared/utils/semverStrict';
import {
  ChangelogContentError,
  resolveCurrentChangelogVersion,
} from './changelogService';
import { getChangelogPrefs, updateChangelogPrefs } from './rbacService';

function unavailableState(showOnLogin: boolean, lastSeenVersion: string | null): WhatsNewState {
  return {
    status: 'unavailable',
    currentVersion: null,
    lastSeenVersion,
    unread: false,
    showOnLogin,
    seeded: false,
  };
}

/**
 * Evaluates unified What's New state for an authenticated user (OID).
 * Runs once per authenticated app load — no project scoping.
 */
export async function evaluateWhatsNewState(userId: string): Promise<WhatsNewState> {
  const prefs = await getChangelogPrefs(userId);
  const lastSeenVersion = prefs.lastSeenVersion;
  const showOnLogin = prefs.showOnLogin;

  let currentVersion: string | null;
  try {
    currentVersion = await resolveCurrentChangelogVersion();
  } catch {
    return unavailableState(showOnLogin, lastSeenVersion);
  }

  if (!currentVersion || !semverValid(currentVersion)) {
    return unavailableState(showOnLogin, lastSeenVersion);
  }

  // Existing null acknowledgement = established unread user (not first-login seed).
  // Seeded first-login rows already store currentVersion → unread false + status seeded.
  const lastSeenValid = semverValid(lastSeenVersion);

  if (lastSeenVersion == null) {
    return {
      status: 'ready',
      currentVersion,
      lastSeenVersion,
      unread: true,
      showOnLogin,
      seeded: false,
    };
  }

  if (!lastSeenValid) {
    return {
      status: 'ready',
      currentVersion,
      lastSeenVersion,
      unread: false,
      showOnLogin,
      seeded: false,
    };
  }

  if (lastSeenValid === currentVersion || !semverGt(currentVersion, lastSeenValid)) {
    const seeded = lastSeenValid === currentVersion;
    return {
      status: seeded ? 'seeded' : 'ready',
      currentVersion,
      lastSeenVersion,
      unread: false,
      showOnLogin,
      seeded,
    };
  }

  return {
    status: 'ready',
    currentVersion,
    lastSeenVersion,
    unread: true,
    showOnLogin,
    seeded: false,
  };
}

/** State for a brand-new user insert that was seeded to the current release. */
export function buildSeededWhatsNewState(
  currentVersion: string,
  showOnLogin = true,
): WhatsNewState {
  return {
    status: 'seeded',
    currentVersion,
    lastSeenVersion: currentVersion,
    unread: false,
    showOnLogin,
    seeded: true,
  };
}

/**
 * Persists acknowledgement of the captured current release for the session user.
 * Rejects versions that are not the current valid bundled release.
 */
export async function acknowledgeWhatsNew(
  userId: string,
  requestedVersion: string | undefined,
): Promise<WhatsNewState> {
  const currentVersion = await resolveCurrentChangelogVersion();
  if (!currentVersion || !semverValid(currentVersion)) {
    throw new ChangelogContentError('Changelog unavailable for acknowledgement');
  }

  const version = requestedVersion ?? currentVersion;
  if (!semverValid(version) || version !== currentVersion) {
    const err = new Error('Acknowledgement version must equal the current bundled release');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  await updateChangelogPrefs(userId, { lastSeenChangelogVersion: currentVersion });
  return evaluateWhatsNewState(userId);
}

export async function updateWhatsNewPreference(
  userId: string,
  showChangelogOnLogin: boolean,
): Promise<WhatsNewState> {
  await updateChangelogPrefs(userId, { showChangelogOnLogin });
  return evaluateWhatsNewState(userId);
}
