import {
  displayNameMaxLength,
  type Profile,
  type UpdateProfileBody,
} from '@project-scope/contracts';
import type { Principal } from '../identity/principal.ts';
import {
  ProfileConflictError,
  type AppUser,
  type AppUserStore,
} from '../persistence/index.ts';

/**
 * Stored when the identity provider sends no usable display name. The subject
 * is never used as a name, because it is an identity value (BR-007).
 */
export const DEFAULT_DISPLAY_NAME = 'New user';

/** The row was missing after a create conflict, or before an update. */
export class ProfileVanishedError extends Error {
  constructor() {
    super('The profile row could not be found.');
    this.name = 'ProfileVanishedError';
  }
}

export interface ProfileServiceDeps {
  users: AppUserStore;
  /** Called once per created row, for the profile.created log event. */
  onProfileCreated?: () => void;
}

export interface ProfileService {
  getOwnProfile(principal: Principal): Promise<Profile>;
  updateOwnProfile(
    principal: Principal,
    input: UpdateProfileBody
  ): Promise<Profile>;
}

function toProfile(row: Pick<AppUser, 'displayName' | 'email' | 'status'>) {
  return { displayName: row.displayName, email: row.email, status: row.status };
}

// The column holds 100 characters; cut by code point so no emoji is split.
function initialDisplayName(principal: Principal): string {
  const trimmed = principal.displayName?.trim() ?? '';
  if (trimmed === '') {
    return DEFAULT_DISPLAY_NAME;
  }
  return [...trimmed].slice(0, displayNameMaxLength).join('').trim();
}

/**
 * Every operation takes the principal and nothing that names a user, so a
 * caller can reach only its own row. The data layer sees principal.subject
 * and nothing else from the request.
 */
export function createProfileService(deps: ProfileServiceDeps): ProfileService {
  const { users } = deps;

  async function ensureProfile(principal: Principal): Promise<AppUser> {
    const existing = await users.findBySubject(principal.subject);
    if (existing) {
      return existing;
    }
    try {
      const created = await users.create({
        externalSubject: principal.subject,
        displayName: initialDisplayName(principal),
      });
      deps.onProfileCreated?.();
      return created;
    } catch (error) {
      if (!(error instanceof ProfileConflictError)) {
        throw error;
      }
      // A parallel first request created the row; read the winner once.
      const winner = await users.findBySubject(principal.subject);
      if (!winner) {
        throw new ProfileVanishedError();
      }
      return winner;
    }
  }

  return {
    async getOwnProfile(principal) {
      return toProfile(await ensureProfile(principal));
    },

    async updateOwnProfile(principal, input) {
      await ensureProfile(principal);
      const updated = await users.updateBySubject(principal.subject, {
        displayName: input.displayName,
        email: input.email ?? null,
      });
      if (!updated) {
        throw new ProfileVanishedError();
      }
      return toProfile(updated);
    },
  };
}
