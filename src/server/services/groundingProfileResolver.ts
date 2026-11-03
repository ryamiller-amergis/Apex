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
  isRepoReadServiceEnabledForCaller as evaluateRepoReadService,
} from './featureFlagService';
import { LocalCheckoutReader } from './localCheckoutReader';
import { RemoteCatalogReader } from './remoteCatalogReader';
import { BareRepoReader } from './repoRead/bareRepoReader';
import { isUsableBareMirror } from './repoRead/mirrorStore';
import {
  RepoServiceReader,
  resolveRepoReadServiceUrl,
} from './repoRead/repoServiceReader';
import { createRepoReader, RepoReaderError } from './repoReader';
import {
  groundingProfileStore,
  type GroundingProfileStore,
} from './groundingProfileStore';

const PROFILE_FLAG = 'repo-grounding-workspace-profile';
const DEFAULT_PROFILE_TTL_MS = 60 * 60 * 1_000;

export interface GroundingProfileRegistration extends RepositoryIdentity {
  runRef: string;
  checkoutPath: string;
  /** Bare-mirror path. Preferred for in-process reads when the cache exists. */
  mirrorPath?: string;
  caller?: string;
  ttlMs?: number;
  /**
   * Also save the profile so another App Service instance can resolve it.
   * Other instances rebuild the owner without the caller's reauthorize
   * callback, so set this only when that callback always allows.
   */
  shareAcrossInstances?: boolean;
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
  isRepoReadServiceEnabledForCaller?: typeof evaluateRepoReadService;
  now?: () => number;
  store?: GroundingProfileStore;
}

export type GroundingProfileReauthorization = () => Promise<boolean>;

interface ConnectionProfileOwner {
  caller: GroundingCallerContext;
  reauthorize: GroundingProfileReauthorization;
}

interface StoredGroundingProfile extends RepositoryIdentity {
  runRef: string;
  checkoutPath: string;
  mirrorPath?: string;
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
  private readonly repoReadEnabled: typeof evaluateRepoReadService;
  private readonly now: () => number;
  private readonly store?: GroundingProfileStore;
  private readonly pendingShares = new Map<GroundingProfileId, Promise<void>>();

  constructor(options: GroundingProfileResolverOptions) {
    this.authorization = options.authorization;
    this.store = options.store;
    this.featureEnabled = options.isFeatureEnabled ?? evaluateFeatureFlag;
    this.convergenceEnabled =
      options.isRemoteSearchConvergenceEnabled ?? evaluateConvergence;
    this.repoReadEnabled =
      options.isRepoReadServiceEnabledForCaller ?? evaluateRepoReadService;
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
      mirrorPath: input.mirrorPath,
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
    if (input.shareAcrossInstances && this.store) {
      this.shareProfile(profile.id, caller, this.store);
    }
    return profile;
  }

  /** Resolves once a shared profile is saved (or the save failed and was logged). */
  async whenShared(profileId: GroundingProfileId): Promise<void> {
    await this.pendingShares.get(profileId);
  }

  revokeProfile(profileId: GroundingProfileId): void {
    this.profiles.delete(profileId);
    this.connectionOwners.delete(profileId);
    if (this.pendingShares.delete(profileId) && this.store) {
      this.store.remove(profileId).catch((error: unknown) => {
        console.warn(
          '[grounding-profile] shared profile removal failed; expiry will clear it:',
          error instanceof Error ? error.message : String(error)
        );
      });
    }
  }

  private shareProfile(
    profileId: GroundingProfileId,
    caller: GroundingCallerContext,
    store: GroundingProfileStore
  ): void {
    const stored = this.profiles.get(profileId);
    if (!stored) return;
    const save = store
      .save(profileId, {
        runRef: stored.runRef,
        provider: stored.provider,
        project: stored.project,
        repo: stored.repo,
        sha: stored.sha,
        checkoutPath: stored.checkoutPath,
        mirrorPath: stored.mirrorPath,
        caller: stored.caller,
        owner: { ...caller },
        expiresAt: stored.expiresAt,
      })
      .catch((error: unknown) => {
        console.warn(
          '[grounding-profile] share failed; other instances cannot resolve this profile:',
          error instanceof Error ? error.message : String(error)
        );
      });
    this.pendingShares.set(profileId, save);
  }

  /**
   * Shared profiles are read from the store on every call and never cached, so
   * a revoke on the registering instance takes effect everywhere.
   */
  private async resolveSharedOwner(
    profileId: GroundingProfileId
  ): Promise<{ owner: ConnectionProfileOwner; profile: StoredGroundingProfile }> {
    const shared = this.store ? await this.store.load(profileId) : null;
    if (!shared || this.now() >= shared.expiresAt) {
      throw new RepoReaderError(
        'ACCESS_DENIED',
        'Grounding profile access denied',
        false
      );
    }
    const { owner, ...profile } = shared;
    return {
      owner: { caller: owner, reauthorize: async () => true },
      profile,
    };
  }

  async resolveConnectionProfile(
    profileId: GroundingProfileId
  ): Promise<RepoReader> {
    const localOwner = this.connectionOwners.get(profileId);
    let owner: ConnectionProfileOwner;
    let profile: StoredGroundingProfile;
    if (localOwner) {
      if (!(await localOwner.reauthorize())) {
        throw new RepoReaderError(
          'ACCESS_DENIED',
          'Grounding profile access denied',
          false
        );
      }
      owner = localOwner;
      profile = await this.getAuthorizedProfile(profileId, owner.caller);
    } else {
      ({ owner, profile } = await this.resolveSharedOwner(profileId));
      await this.authorizeProfile(profile, owner.caller);
    }
    const identity: RepositoryIdentity = {
      provider: profile.provider,
      project: profile.project,
      repo: profile.repo,
      sha: profile.sha,
    };
    const telemetryContext = {
      caller: profile.caller ?? 'repo-reader',
      project: profile.project,
      runId: profile.runRef.split(':').slice(1).join(':') || profile.runRef,
    };

    let repoReadEnabled = false;
    try {
      repoReadEnabled = await this.repoReadEnabled({
        userId: owner.caller.userId,
        project: owner.caller.project,
        caller: profile.caller ?? 'repo-reader',
      });
    } catch {
      repoReadEnabled = false;
    }

    // HTTP extract stays behind the flag (Stage 3 env swap). In-process bare
    // reads are the Stage 6 default whenever a usable mirror exists.
    // @feature-flag:repo-read-service start winner=enabled
    if (repoReadEnabled) {
      // @feature-flag:repo-read-service enabled-start
      const serviceUrl = resolveRepoReadServiceUrl();
      if (serviceUrl) {
        return new RepoServiceReader({
          identity,
          baseUrl: serviceUrl,
          telemetryContext,
        });
      }
      // @feature-flag:repo-read-service enabled-end
    } else {
      // @feature-flag:repo-read-service disabled-start
      // Shared in-process selection below; flag-off no longer forces checkout.
      // @feature-flag:repo-read-service disabled-end
    }
    // @feature-flag:repo-read-service end

    if (isUsableBareMirror(profile.mirrorPath)) {
      return new BareRepoReader({
        identity,
        mirrorPath: profile.mirrorPath,
        telemetryContext,
      });
    }
    return new LocalCheckoutReader({
      identity,
      checkoutPath: profile.checkoutPath,
      telemetryContext,
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
    await this.authorizeProfile(profile, caller);
    return profile;
  }

  private async authorizeProfile(
    profile: StoredGroundingProfile,
    caller: GroundingCallerContext
  ): Promise<void> {
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
      bare: () =>
        new BareRepoReader({
          identity,
          mirrorPath: profile.mirrorPath ?? profile.checkoutPath,
          telemetryContext: {
            caller: profile.caller ?? 'repo-reader',
            project: profile.project,
            runId:
              profile.runRef.split(':').slice(1).join(':') || profile.runRef,
          },
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
    const reader = createRepoReader(
      isUsableBareMirror(profile.mirrorPath) ? 'bare' : 'local',
      factories
    );
    // @feature-flag:repo-grounding-workspace-profile enabled-end
    // @feature-flag:repo-grounding-workspace-profile end
    return reader;
  }
}

/**
 * Process-local registry used by MCP connections. Each registered profile also
 * carries a caller-owned reauthorization callback, so resolving an opaque ID
 * never relies on the URL as authorization. Profiles registered with
 * `shareAcrossInstances` are also saved to Postgres for other instances.
 */
export const groundingProfileResolver = new GroundingProfileResolver({
  authorization: {
    authorize: async (input) =>
      input.callerRunRef === input.ownerRunRef &&
      input.callerProject === input.ownerProject,
  },
  store: groundingProfileStore,
});
