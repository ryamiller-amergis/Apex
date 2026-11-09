import type { MyWorkItemContext, MyWorkItemContextChild } from '../../shared/types/devWorkbench';
import { normalizeAdoHtml } from '../utils/adoRichText';
import { AzureDevOpsService } from './azureDevOps';

export interface MyWorkItemContextClient {
  getWorkItemsByIds: AzureDevOpsService['getWorkItemsByIds'];
  getFeatureChildren: AzureDevOpsService['getFeatureChildren'];
}

export async function buildMyWorkItemContext(
  client: MyWorkItemContextClient,
  workItemId: number,
): Promise<MyWorkItemContext | null> {
  const items = await client.getWorkItemsByIds([workItemId]);
  const item = items[0];
  if (!item) return null;

  let children: MyWorkItemContextChild[] = [];
  if (item.workItemType === 'Feature') {
    const raw = await client.getFeatureChildren(workItemId);
    children = raw.map((child) => ({
      id: child.id,
      title: child.title,
      workItemType: child.workItemType,
      state: child.state,
    }));
  }

  return {
    id: item.id,
    title: item.title,
    workItemType: item.workItemType,
    state: item.state,
    description: normalizeAdoHtml(item.description ?? ''),
    acceptanceCriteria: normalizeAdoHtml(item.acceptanceCriteria ?? ''),
    reproSteps: normalizeAdoHtml(item.reproSteps ?? ''),
    design: normalizeAdoHtml(item.design ?? ''),
    children,
  };
}

export async function getMyWorkItemContext(
  project: string,
  workItemId: number,
): Promise<MyWorkItemContext | null> {
  const ado = new AzureDevOpsService(project);
  return buildMyWorkItemContext(ado, workItemId);
}
