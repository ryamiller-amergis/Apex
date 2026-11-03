import { createHash } from 'crypto';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { groundingProfiles } from '../db/schema';
import type { GroundingProfileId } from '../../shared/types/repoReader';
import type { SkillProvider } from '../../shared/types/projectSettings';

export interface SharedGroundingProfile {
  runRef: string;
  provider: SkillProvider;
  project: string;
  repo: string;
  sha: string;
  checkoutPath: string;
  mirrorPath?: string;
  caller?: string;
  owner: { userId: string; runRef: string; project: string };
  expiresAt: number;
}

/**
 * Cross-instance copy of connection profiles. App Service runs several
 * instances behind one host name, and V2 workers reach the tool relay without
 * an affinity cookie, so a tool call can land on an instance that did not
 * register the profile. The profile ID is a bearer secret, so only its hash is
 * stored.
 */
export interface GroundingProfileStore {
  save(profileId: GroundingProfileId, profile: SharedGroundingProfile): Promise<void>;
  load(profileId: GroundingProfileId): Promise<SharedGroundingProfile | null>;
  remove(profileId: GroundingProfileId): Promise<void>;
}

function hashProfileId(profileId: GroundingProfileId): string {
  return createHash('sha256').update(profileId).digest('hex');
}

export const groundingProfileStore: GroundingProfileStore = {
  async save(profileId, profile) {
    await db.delete(groundingProfiles).where(lt(groundingProfiles.expiresAt, sql`now()`));
    await db.insert(groundingProfiles).values({
      idHash: hashProfileId(profileId),
      runRef: profile.runRef,
      provider: profile.provider,
      project: profile.project,
      repo: profile.repo,
      sha: profile.sha,
      checkoutPath: profile.checkoutPath,
      mirrorPath: profile.mirrorPath ?? null,
      caller: profile.caller ?? null,
      ownerUserId: profile.owner.userId,
      ownerRunRef: profile.owner.runRef,
      ownerProject: profile.owner.project,
      expiresAt: new Date(profile.expiresAt).toISOString(),
    });
  },

  async load(profileId) {
    const [row] = await db
      .select()
      .from(groundingProfiles)
      .where(and(
        eq(groundingProfiles.idHash, hashProfileId(profileId)),
        gt(groundingProfiles.expiresAt, sql`now()`),
      ))
      .limit(1);
    if (!row) return null;
    return {
      runRef: row.runRef,
      provider: row.provider as SkillProvider,
      project: row.project,
      repo: row.repo,
      sha: row.sha,
      checkoutPath: row.checkoutPath,
      mirrorPath: row.mirrorPath ?? undefined,
      caller: row.caller ?? undefined,
      owner: { userId: row.ownerUserId, runRef: row.ownerRunRef, project: row.ownerProject },
      expiresAt: Date.parse(row.expiresAt),
    };
  },

  async remove(profileId) {
    await db.delete(groundingProfiles).where(eq(groundingProfiles.idHash, hashProfileId(profileId)));
  },
};
