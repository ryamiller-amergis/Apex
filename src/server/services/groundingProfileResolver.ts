import { randomBytes } from 'crypto';
import type {
  GroundingProfile,
  GroundingProfileId,
  RepoReader,
  RepositoryIdentity,
} from '../../shared/types/repoReader';
import {
  isFeatureEnabled as evaluateFeatureFlag,
  isRemoteSearchConvergenceEnabled as evaluateConvergence,
} from './featureFlagService';
import { LocalCheckoutReader } from './localCheckoutReader';
import { RemoteCatalogReader } from './remoteCatalogReader';
import { createRepoReader, RepoReaderError } from './repoReader';

const PROFILE_FLAG = 'repo-grounding-workspace-profile';
const DEFAULT_PROFILE_TTL_MS = 60 * 60 * 1_000;

export interface GroundingProfileRegistration extends RepositoryIdentity {
  runRef: string;
  checkoutPath: string;
  caller?: string;
  ttlMs?: number;
}

export interface GroundingCallerContext {
  userId: string;
  runRef: string;
  project: string;
}

export interface RunProjectAuthorizationInput {
  userId: string;
  callerRunRef: string;
  ownerRunRef: string;
  callerProject: string;
  ownerProject: string;
  provider: RepositoryIdentity['provider'];
  repo: string;
}

/**
 * Injectable adapter for the existing run/project authorization services.
 * The polymorphic runRef remains opaque to this foundational resolver.
 */
export interface RunProjectAuthorization {
  authorize(input: RunProjectAuthorizationInput): Promise<boolean>;
}

export interface GroundingProfileResolverOptions {
  authorization: RunProjectAuthorization;
  isFeatureEnabled?: typeof evaluateFeatureFlag;
  isRemoteSearchConvergenceEnabled?: typeof evaluateConvergence;
  now?: () => number;
}

export type GroundingProfileReauthorization = () => Promise<boolean>;

interface ConnectionProfileOwner {
  caller: GroundingCallerContext;
  reauthorize: GroundingProfileReauthorization;
}

interface StoredGroundingProfile extends RepositoryIdentity {
  runRef: string;
  checkoutPath: string;
  caller?: string;
  expiresAt: number;
}

export class GroundingProfileResolver {
  private readonly profiles = new Map<
    GroundingProfileId,
    StoredGroundingProfile
  >();
  private readonly connectionOwners = new Map<
    GroundingProfileId,
    ConnectionProfileOwner
  >();
  private readonly authorization: RunProjectAuthorization;
  private readonly featureEnabled: typeof evaluateFeatureFlag;
  private readonly convergenceEnabled: typeof evaluateConvergence;
  private readonly now: () => number;

  constructor(options: GroundingProfileResolverOptions) {
    this.authorization = options.authorization;
    this.featureEnabled = options.isFeatureEnabled ?? evaluateFeatureFlag;
    this.convergenceEnabled =
      options.isRemoteSearchConvergenceEnabled ?? evaluateConvergence;
    this.now = options.now ?? Date.now;
  }

  registerProfile(input: GroundingProfileRegistration): GroundingProfile {
    const id = randomBytes(32).toString('base64url') as GroundingProfileId;
    const expiresAt = this.now() + (input.ttlMs ?? DEFAULT_PROFILE_TTL_MS);
    this.profiles.set(id, {
      runRef: input.runRef,
      provider: input.provider,
      project: input.project,
      repo: input.repo,
      sha: input.sha,
      checkoutPath: input.checkoutPath,
      caller: input.caller,
      expiresAt,
    });
    return { id, expiresAt };
  }

  registerConnectionProfile(
    input: GroundingProfileRegistration,
    caller: GroundingCallerContext,
    reauthorize: GroundingProfileReauthorization
  ): GroundingProfile {
    const profile = this.registerProfile(input);
    this.connectionOwners.set(profile.id, {
      caller: { ...caller },
      reauthorize,
    });
    return profile;
  }

  revokeProfile(profileId: GroundingProfileId): void {
    this.profiles.delete(profileId);
    this.connectionOwners.delete(profileId);
  }

  async resolveConnectionProfile(
    profileId: GroundingProfileId
  ): Promise<RepoReader> {
    const owner = this.connectionOwners.get(profileId);
    if (!owner || !(await owner.reauthorize())) {
      throw new RepoReaderError(
        'ACCESS_DENIED',
        'Grounding profile access denied',
        false
      );
    }
    const profile = await this.getAuthorizedProfile(profileId, owner.caller);
    return new LocalCheckoutReader({
      identity: {
        provider: profile.provider,
        project: profile.project,
        repo: profile.repo,
        sha: profile.sha,
      },
      checkoutPath: profile.checkoutPath,
      telemetryContext: {
        caller: profile.caller ?? 'repo-reader',
        project: profile.project,
        runId: profile.runRef.split(':').slice(1).join(':') || profile.runRef,
      },
    });
  }

  private async getAuthorizedProfile(
    profileId: GroundingProfileId,
    caller: GroundingCallerContext
  ): Promise<StoredGroundingProfile> {
    const profile = this.profiles.get(profileId);
    if (!profile || this.now() >= profile.expiresAt) {
      if (profile) this.revokeProfile(profileId);
      throw new RepoReaderError(
        'PROFILE_UNAVAILABLE',
        'Grounding profile is unavailable',
        false
      );
    }

    if (
      caller.runRef !== profile.runRef ||
      caller.project !== profile.project
    ) {
      throw new RepoReaderError(
        'ACCESS_DENIED',
        'Grounding profile access denied',
        false
      );
    }

    const authorized = await this.authorization.authorize({
      userId: caller.userId,
      callerRunRef: caller.runRef,
      ownerRunRef: profile.runRef,
      callerProject: caller.project,
      ownerProject: profile.project,
      provider: profile.provider,
      repo: profile.repo,
    });
    if (!authorized) {
      throw new RepoReaderError(
        'ACCESS_DENIED',
        'Grounding profile access denied',
        false
      );
    }
    return profile;
  }

  async resolveProfile(
    profileId: GroundingProfileId,
    caller: GroundingCallerContext
  ): Promise<RepoReader> {
    const profile = await this.getAuthorizedProfile(profileId, caller);

    const enabled = await this.featureEnabled(PROFILE_FLAG, {
      userId: caller.userId,
      project: caller.project,
    });
    const identity: RepositoryIdentity = {
      provider: profile.provider,
      project: profile.project,
      repo: profile.repo,
      sha: profile.sha,
    };
    const factories = {
      local: () =>
        new LocalCheckoutReader({
          identity,
          checkoutPath: profile.checkoutPath,
          telemetryContext: {
            caller: profile.caller ?? 'repo-reader',
            project: profile.project,
            runId:
              profile.runRef.split(':').slice(1).join(':') || profile.runRef,
          },
        }),
      remote: () =>
        new RemoteCatalogReader(identity, undefined, {
          flagContext: {
            userId: caller.userId,
            project: caller.project,
            caller: profile.caller ?? 'repo-reader',
          },
          isConvergenceEnabled: this.convergenceEnabled,
        }),
    };

    // Retain the enabled branch after two stable sprints at full rollout.
    // @feature-flag:repo-grounding-workspace-profile start winner=enabled
    if (!enabled) {
      // @feature-flag:repo-grounding-workspace-profile disabled-start
      const reader = createRepoReader('remote', factories);
      // @feature-flag:repo-grounding-workspace-profile disabled-end
      return reader;
    }

    // @feature-flag:repo-grounding-workspace-profile enabled-start
    const reader = createRepoReader('local', factories);
    // @feature-flag:repo-grounding-workspace-profile enabled-end
    // @feature-flag:repo-grounding-workspace-profile end
    return reader;
  }
}

/**
 * Process-local registry used by MCP connections. Each registered profile also
 * carries a caller-owned reauthorization callback, so resolving an opaque ID
 * never relies on the URL as authorization.
 */
export const groundingProfileResolver = new GroundingProfileResolver({
  authorization: {
    authorize: async (input) =>
      input.callerRunRef === input.ownerRunRef &&
      input.callerProject === input.ownerProject,
  },
});
