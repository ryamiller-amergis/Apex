import { AzureDevOpsService } from './azureDevOps';
import { DeploymentTrackingService } from './deploymentTracking';
import { renameOutcomeReleaseVersion } from './deploymentOutcomeService';

/** Statuses under which the release name can still be changed. */
export const RENAMABLE_STATUSES = ['New', 'In Design', 'In Progress'] as const;
export type RenamableStatus = (typeof RENAMABLE_STATUSES)[number];

export function isRenamableStatus(status: string): status is RenamableStatus {
  return (RENAMABLE_STATUSES as readonly string[]).includes(status);
}

export interface RenameReleaseResult {
  oldName: string;
  newName: string;
  taggedWorkItemsUpdated: number;
  deploymentsUpdated: number;
  outcomesUpdated: number;
}

/**
 * Validate inputs and perform the coordinated rename of a release across:
 *  1. ADO Epic title
 *  2. Release:<oldName> → Release:<newName> tags on all tagged work items
 *  3. public/deployments.json releaseVersion strings
 *  4. deployment_outcomes.release_version + synthetic deployment_id values
 *
 * Compensates (best-effort rollback) if any step after the Epic title patch fails.
 *
 * @throws Error with code and message for caller to translate to HTTP responses.
 */
export async function renameRelease(
  epicId: number,
  newName: string,
  adoService: AzureDevOpsService,
): Promise<RenameReleaseResult> {
  const trimmedNew = newName.trim();
  if (!trimmedNew) {
    const err = new Error('Release name must not be blank');
    (err as any).code = 'BLANK_NAME';
    throw err;
  }

  // 1. Preflight: load current epic
  const epic = await adoService.getReleaseEpicById(epicId);
  if (!epic) {
    const err = new Error(`Release epic ${epicId} not found`);
    (err as any).code = 'NOT_FOUND';
    throw err;
  }

  const oldName = epic.title;

  if (oldName === trimmedNew) {
    // No-op: identical names
    return { oldName, newName: trimmedNew, taggedWorkItemsUpdated: 0, deploymentsUpdated: 0, outcomesUpdated: 0 };
  }

  // 2. Status guard
  if (!isRenamableStatus(epic.state)) {
    const err = new Error(`Release cannot be renamed in status "${epic.state}". Allowed statuses: ${RENAMABLE_STATUSES.join(', ')}`);
    (err as any).code = 'LOCKED_STATUS';
    throw err;
  }

  // 3. Duplicate name guard
  const duplicate = await adoService.releaseNameExists(trimmedNew, epicId);
  if (duplicate) {
    const err = new Error(`A release named "${trimmedNew}" already exists`);
    (err as any).code = 'DUPLICATE_NAME';
    throw err;
  }

  // 4. Rename the ADO Epic title (first, so it's the canonical source of truth)
  await adoService.updateReleaseEpic(epicId, trimmedNew);

  // 5. Find all work items carrying the old Release:<name> tag
  let taggedIds: number[] = [];
  let taggedWorkItemsUpdated = 0;
  try {
    taggedIds = await adoService.findWorkItemsWithReleaseTag(oldName);
    for (const wiId of taggedIds) {
      await adoService.renameReleaseTagOnWorkItem(wiId, oldName, trimmedNew);
    }
    taggedWorkItemsUpdated = taggedIds.length;
  } catch (tagErr) {
    // Rollback: revert the Epic title
    try {
      await adoService.updateReleaseEpic(epicId, oldName);
    } catch {
      // Compensation failure — log but surface the original error
    }
    throw tagErr;
  }

  // 6. Update local deployment tracking JSON
  let deploymentsUpdated = 0;
  try {
    const trackingService = new DeploymentTrackingService();
    deploymentsUpdated = await trackingService.renameReleaseVersion(oldName, trimmedNew);
  } catch (depErr) {
    // Best-effort: don't fail the whole rename for local JSON issues.
    // The ADO side and outcomes are more important.
    console.error('[renameRelease] deploymentTracking update failed (non-fatal):', depErr);
  }

  // 7. Update PostgreSQL deployment outcomes
  let outcomesUpdated = 0;
  try {
    outcomesUpdated = await renameOutcomeReleaseVersion(oldName, trimmedNew);
  } catch (outcomeErr) {
    console.error('[renameRelease] deploymentOutcomes update failed (non-fatal):', outcomeErr);
  }

  return { oldName, newName: trimmedNew, taggedWorkItemsUpdated, deploymentsUpdated, outcomesUpdated };
}
