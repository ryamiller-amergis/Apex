import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  projectDesignPreferenceProfiles,
  projectDesignPreferenceProposals,
} from '../db/schema';
import { getSkillConfigById } from './projectSettingsService';
import { trackEvent } from './telemetry';
import { parseDesignPreferenceProfile } from '../../shared/designPreferenceProfileSchema';
import {
  emptyDesignPreferenceProfile,
  type DesignPreferenceProfile,
  type DesignPreferenceProfileResponse,
  type DesignPreferenceProposalSource,
  type DesignPreferenceProposalView,
} from '../../shared/types/designPreferenceProfile';

export class DesignPreferenceProfileError extends Error {
  constructor(
    readonly kind: 'not_found' | 'validation' | 'conflict',
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'DesignPreferenceProfileError';
  }
}

function mergeProfile(
  base: DesignPreferenceProfile,
  patch: Partial<DesignPreferenceProfile>,
): DesignPreferenceProfile {
  return {
    ...base,
    ...patch,
    preferredPatterns: patch.preferredPatterns ?? base.preferredPatterns,
    avoidedPatterns: patch.avoidedPatterns ?? base.avoidedPatterns,
  };
}

function toProposalView(row: typeof projectDesignPreferenceProposals.$inferSelect): DesignPreferenceProposalView {
  return {
    id: row.id,
    settingsId: row.settingsId,
    proposedProfile: row.proposedProfile,
    source: row.source,
    sourceRef: row.sourceRef,
    feedbackExcerpt: row.feedbackExcerpt,
    status: row.status,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
  };
}

export function seedProfileFromProject(input: {
  friendlyName: string | null;
  project: string;
}): DesignPreferenceProfile {
  const friendly = input.friendlyName?.trim();
  const fallback =
    input.project.trim().split(/[/\\]/).pop()?.replace(/-/g, ' ') ?? 'Application';
  const appName = friendly || fallback;
  return {
    ...emptyDesignPreferenceProfile(),
    appName,
    productName: appName,
  };
}

export async function getApprovedDesignPreferenceProfile(
  settingsId: string,
): Promise<DesignPreferenceProfileResponse | null> {
  const row = await getSkillConfigById(settingsId);
  if (!row) return null;

  const profileRow = await db.query.projectDesignPreferenceProfiles.findFirst({
    where: eq(projectDesignPreferenceProfiles.settingsId, settingsId),
  });

  const profile =
    profileRow?.profile ??
    seedProfileFromProject({
      friendlyName: row.friendlyName,
      project: row.project,
    });

  return {
    settingsId: row.id,
    project: row.project,
    profile,
    version: profileRow?.version ?? 0,
    updatedAt: profileRow?.updatedAt ?? null,
    updatedBy: profileRow?.updatedBy ?? null,
  };
}

export async function saveApprovedDesignPreferenceProfile(input: {
  settingsId: string;
  profile: DesignPreferenceProfile;
  actorOid: string | null;
}): Promise<DesignPreferenceProfileResponse> {
  const row = await getSkillConfigById(input.settingsId);
  if (!row) throw new DesignPreferenceProfileError('not_found', 'Repository configuration not found');

  const parsed = parseDesignPreferenceProfile(input.profile);
  if (!parsed.ok) {
    throw new DesignPreferenceProfileError('validation', 'Validation failed', parsed.fieldErrors);
  }

  const now = new Date().toISOString();
  const existing = await db.query.projectDesignPreferenceProfiles.findFirst({
    where: eq(projectDesignPreferenceProfiles.settingsId, input.settingsId),
  });
  const nextVersion = (existing?.version ?? 0) + 1;

  await db
    .insert(projectDesignPreferenceProfiles)
    .values({
      settingsId: input.settingsId,
      profile: parsed.profile,
      version: nextVersion,
      updatedAt: now,
      updatedBy: input.actorOid,
    })
    .onConflictDoUpdate({
      target: projectDesignPreferenceProfiles.settingsId,
      set: {
        profile: parsed.profile,
        version: nextVersion,
        updatedAt: now,
        updatedBy: input.actorOid,
      },
    });

  trackEvent(
    'DesignPreferenceProfileSaved',
    {
      settingsId: input.settingsId,
      project: row.project,
    },
    { version: nextVersion },
  );

  return {
    settingsId: row.id,
    project: row.project,
    profile: parsed.profile,
    version: nextVersion,
    updatedAt: now,
    updatedBy: input.actorOid,
  };
}

export async function listPendingProposals(settingsId: string): Promise<DesignPreferenceProposalView[]> {
  const rows = await db
    .select()
    .from(projectDesignPreferenceProposals)
    .where(
      and(
        eq(projectDesignPreferenceProposals.settingsId, settingsId),
        eq(projectDesignPreferenceProposals.status, 'pending'),
      ),
    )
    .orderBy(desc(projectDesignPreferenceProposals.createdAt));
  return rows.map(toProposalView);
}

export async function proposeDesignPreferenceUpdate(input: {
  settingsId: string;
  proposedProfile: DesignPreferenceProfile;
  source: DesignPreferenceProposalSource;
  sourceRef?: string | null;
  feedbackExcerpt?: string | null;
  actorOid: string | null;
}): Promise<DesignPreferenceProposalView> {
  const row = await getSkillConfigById(input.settingsId);
  if (!row) throw new DesignPreferenceProfileError('not_found', 'Repository configuration not found');

  const parsed = parseDesignPreferenceProfile(input.proposedProfile);
  if (!parsed.ok) {
    throw new DesignPreferenceProfileError('validation', 'Validation failed', parsed.fieldErrors);
  }

  await db
    .update(projectDesignPreferenceProposals)
    .set({ status: 'superseded', decidedAt: new Date().toISOString(), decidedBy: input.actorOid })
    .where(
      and(
        eq(projectDesignPreferenceProposals.settingsId, input.settingsId),
        eq(projectDesignPreferenceProposals.status, 'pending'),
      ),
    );

  const [inserted] = await db
    .insert(projectDesignPreferenceProposals)
    .values({
      settingsId: input.settingsId,
      proposedProfile: parsed.profile,
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      feedbackExcerpt: input.feedbackExcerpt ?? null,
      createdBy: input.actorOid,
      status: 'pending',
    })
    .returning();

  trackEvent('DesignPreferenceProposalCreated', {
    settingsId: input.settingsId,
    source: input.source,
    proposalId: inserted.id,
  });

  return toProposalView(inserted);
}

export async function proposeFromBuildFeedback(input: {
  settingsId: string;
  buildRunId: string;
  feedback: string;
  actorOid: string | null;
}): Promise<DesignPreferenceProposalView> {
  const approved = await getApprovedDesignPreferenceProfile(input.settingsId);
  if (!approved) throw new DesignPreferenceProfileError('not_found', 'Repository configuration not found');

  const excerpt = input.feedback.trim().slice(0, 4000);
  const lower = excerpt.toLowerCase();
  const patch: Partial<DesignPreferenceProfile> = {};
  if (/modern|polish|enterprise|dated|visual/i.test(excerpt)) {
    patch.visualTone = 'modern';
    patch.preferredPatterns = [
      ...new Set([
        ...approved.profile.preferredPatterns,
        'Use catalog surfaces and MUI primitives before custom grids',
      ]),
    ];
  }
  if (/mui|date.?picker|calendar component/i.test(excerpt)) {
    patch.preferredPatterns = [
      ...new Set([
        ...(patch.preferredPatterns ?? approved.profile.preferredPatterns),
        'Prefer @mui/x-date-pickers for calendar UI when available',
      ]),
    ];
  }
  if (/icon|logo|brand|project name|app name/i.test(excerpt)) {
    patch.avoidedPatterns = [
      ...new Set([
        ...approved.profile.avoidedPatterns,
        'Template placeholders such as project-name',
      ]),
    ];
  }
  if (/compact|dense/i.test(lower)) patch.density = 'compact';
  if (/comfortable|spacious/i.test(lower)) patch.density = 'comfortable';

  return proposeDesignPreferenceUpdate({
    settingsId: input.settingsId,
    proposedProfile: mergeProfile(approved.profile, patch),
    source: 'build_revision',
    sourceRef: input.buildRunId,
    feedbackExcerpt: excerpt,
    actorOid: input.actorOid,
  });
}

export async function acceptDesignPreferenceProposal(input: {
  settingsId: string;
  proposalId: string;
  actorOid: string | null;
}): Promise<DesignPreferenceProfileResponse> {
  const proposal = await db.query.projectDesignPreferenceProposals.findFirst({
    where: and(
      eq(projectDesignPreferenceProposals.id, input.proposalId),
      eq(projectDesignPreferenceProposals.settingsId, input.settingsId),
    ),
  });
  if (!proposal) throw new DesignPreferenceProfileError('not_found', 'Proposal not found');
  if (proposal.status !== 'pending') {
    throw new DesignPreferenceProfileError('conflict', 'This proposal is no longer pending');
  }

  const saved = await saveApprovedDesignPreferenceProfile({
    settingsId: input.settingsId,
    profile: proposal.proposedProfile,
    actorOid: input.actorOid,
  });

  const now = new Date().toISOString();
  await db
    .update(projectDesignPreferenceProposals)
    .set({ status: 'approved', decidedAt: now, decidedBy: input.actorOid })
    .where(eq(projectDesignPreferenceProposals.id, input.proposalId));

  await db
    .update(projectDesignPreferenceProposals)
    .set({ status: 'superseded', decidedAt: now, decidedBy: input.actorOid })
    .where(
      and(
        eq(projectDesignPreferenceProposals.settingsId, input.settingsId),
        eq(projectDesignPreferenceProposals.status, 'pending'),
        ne(projectDesignPreferenceProposals.id, input.proposalId),
      ),
    );

  trackEvent('DesignPreferenceProposalAccepted', {
    settingsId: input.settingsId,
    proposalId: input.proposalId,
  });

  return saved;
}

export async function rejectDesignPreferenceProposal(input: {
  settingsId: string;
  proposalId: string;
  actorOid: string | null;
}): Promise<void> {
  const proposal = await db.query.projectDesignPreferenceProposals.findFirst({
    where: and(
      eq(projectDesignPreferenceProposals.id, input.proposalId),
      eq(projectDesignPreferenceProposals.settingsId, input.settingsId),
    ),
  });
  if (!proposal) throw new DesignPreferenceProfileError('not_found', 'Proposal not found');
  if (proposal.status !== 'pending') {
    throw new DesignPreferenceProfileError('conflict', 'This proposal is no longer pending');
  }

  await db
    .update(projectDesignPreferenceProposals)
    .set({
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: input.actorOid,
    })
    .where(eq(projectDesignPreferenceProposals.id, input.proposalId));
}
