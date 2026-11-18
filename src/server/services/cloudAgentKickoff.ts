import { AI_CODE_TAG } from '../../shared/utils/cloudAgentLaunch';
import { AzureDevOpsService } from './azureDevOps';

const IN_PROGRESS = 'In Progress';
const MOVE_TO_IN_PROGRESS = ['New', 'Approved', 'Committed'];

export interface CloudAgentKickoffChild {
  id: number;
  workItemType: string;
  state: string;
}

export interface CloudAgentKickoffInput {
  project: string;
  workItemId: number;
  workItemType: string;
  state: string;
  /** When set, the started work item and any children moved to In Progress get the tag. */
  tagAiCode?: boolean;
}

export interface CloudAgentKickoffClient {
  getFeatureChildren: (featureId: number) => Promise<CloudAgentKickoffChild[]>;
  setWorkItemState: (workItemId: number, state: string) => Promise<void>;
  addTag?: (workItemId: number, tag: string) => Promise<void>;
}

/** Work items that should move to In Progress. Never In Pull Request. */
export function kickoffInProgressIds(input: {
  workItemId: number;
  state: string;
  workItemType: string;
  children: CloudAgentKickoffChild[];
}): number[] {
  const ids: number[] = [];
  if (MOVE_TO_IN_PROGRESS.includes(input.state)) ids.push(input.workItemId);
  if (input.workItemType !== 'Feature') return ids;
  for (const child of input.children) {
    if (!MOVE_TO_IN_PROGRESS.includes(child.state)) continue;
    if (!ids.includes(child.id)) ids.push(child.id);
  }
  return ids;
}

async function tryKickoffStep(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.warn(
      `[cloud-agent] ${label} failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function applyCloudAgentKickoff(
  input: CloudAgentKickoffInput,
  client: CloudAgentKickoffClient,
): Promise<void> {
  let children: CloudAgentKickoffChild[] = [];
  if (input.workItemType === 'Feature') {
    try {
      children = await client.getFeatureChildren(input.workItemId);
    } catch (err) {
      console.warn(
        `[cloud-agent] child lookup for feature ${input.workItemId} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const movedIds = kickoffInProgressIds({ ...input, children });
  for (const workItemId of movedIds) {
    await tryKickoffStep(
      `setWorkItemState(${workItemId} -> ${IN_PROGRESS})`,
      () => client.setWorkItemState(workItemId, IN_PROGRESS),
    );
  }

  if (!input.tagAiCode || !client.addTag) return;
  const tagIds = movedIds.includes(input.workItemId)
    ? movedIds
    : [input.workItemId, ...movedIds];
  for (const workItemId of tagIds) {
    await tryKickoffStep(
      `addTag(${workItemId}, ${AI_CODE_TAG})`,
      () => client.addTag!(workItemId, AI_CODE_TAG),
    );
  }
}

/** ADO updates that run when Start cloud agent is kicked off. Failures are logged and skipped. */
export async function prepareCloudAgentKickoff(input: CloudAgentKickoffInput): Promise<void> {
  const ado = new AzureDevOpsService(input.project);
  await applyCloudAgentKickoff(input, {
    getFeatureChildren: (featureId) => ado.getFeatureChildren(featureId),
    setWorkItemState: (workItemId, state) => ado.setWorkItemState(workItemId, state),
    addTag: (workItemId, tag) => ado.addTagToWorkItem(workItemId, tag),
  });
}
