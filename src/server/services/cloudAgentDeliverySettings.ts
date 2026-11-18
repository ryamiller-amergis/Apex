import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { projectCloudAgentDelivery } from '../db/schema';
import { parseReviewerList } from './implementationDelivery';
import { getSkillConfig } from './projectSettingsService';

export interface CloudAgentDelivery {
  /** Branch the work is cut from and the pull request merges into. Null uses the skill branch. */
  targetBranch: string | null;
  /** Azure DevOps team or group names added as required reviewers. */
  requiredReviewers: string[];
}

const EMPTY_DELIVERY: CloudAgentDelivery = {
  targetBranch: null,
  requiredReviewers: [],
};

function fromRow(row: {
  targetBranch: string | null;
  requiredReviewers: string[] | null;
} | undefined): CloudAgentDelivery {
  if (!row) return EMPTY_DELIVERY;
  return {
    targetBranch: row.targetBranch?.trim() || null,
    requiredReviewers: parseReviewerList(row.requiredReviewers),
  };
}

export async function getCloudAgentDelivery(
  settingsId: string | null | undefined,
): Promise<CloudAgentDelivery> {
  if (!settingsId) return EMPTY_DELIVERY;
  const rows = await db
    .select({
      targetBranch: projectCloudAgentDelivery.targetBranch,
      requiredReviewers: projectCloudAgentDelivery.requiredReviewers,
    })
    .from(projectCloudAgentDelivery)
    .where(eq(projectCloudAgentDelivery.settingsId, settingsId))
    .limit(1);
  return fromRow(rows[0]);
}

export const CLOUD_AGENT_SETUP_REASON =
  'Set the cloud agent merge branch and required reviewers in Project Settings first.';

/**
 * Why this project cannot use a Playbook Cloud agent step yet, or null when it can.
 * A Playbook PR needs a branch to merge into and people to review it.
 */
export async function cloudAgentPlaybookSetupGap(project: string): Promise<string | null> {
  const config = await getSkillConfig(project);
  const delivery = await getCloudAgentDelivery(config?.id);
  return delivery.targetBranch && delivery.requiredReviewers.length ? null : CLOUD_AGENT_SETUP_REASON;
}

export async function listCloudAgentDelivery(): Promise<Map<string, CloudAgentDelivery>> {
  try {
    const rows = await db
      .select({
        settingsId: projectCloudAgentDelivery.settingsId,
        targetBranch: projectCloudAgentDelivery.targetBranch,
        requiredReviewers: projectCloudAgentDelivery.requiredReviewers,
      })
      .from(projectCloudAgentDelivery);
    return new Map(rows.map((row) => [row.settingsId, fromRow(row)]));
  } catch (err) {
    console.warn(
      '[cloud-agent] pull request settings are unavailable',
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}

export async function saveCloudAgentDelivery(
  settingsId: string,
  input: { targetBranch?: string | null; requiredReviewers?: unknown },
): Promise<CloudAgentDelivery> {
  const delivery: CloudAgentDelivery = {
    targetBranch: input.targetBranch?.trim() || null,
    requiredReviewers: parseReviewerList(input.requiredReviewers),
  };
  const now = new Date().toISOString();
  await db
    .insert(projectCloudAgentDelivery)
    .values({
      settingsId,
      targetBranch: delivery.targetBranch,
      requiredReviewers: delivery.requiredReviewers,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectCloudAgentDelivery.settingsId,
      set: {
        targetBranch: delivery.targetBranch,
        requiredReviewers: delivery.requiredReviewers,
        updatedAt: now,
      },
    });
  return delivery;
}
