import type { ApexWorkItem, ApexWorkItemStatus } from '../../shared/types/apexWorkItem';
import type { WorkItem } from '../types/workitem';

/** Map Apex board status to ADO-like state strings used by Calendar / Cycle Time / Roadmap. */
export function apexStatusToAdoState(status: ApexWorkItemStatus): string {
  switch (status) {
    case 'idea':
    case 'ready':
      return 'New';
    case 'in-progress':
    case 'review':
      return 'In Progress';
    case 'done':
      return 'Closed';
    default:
      return 'New';
  }
}

/** Adapt an Apex work item into the legacy WorkItem shape consumed by Calendar / Planning. */
export function toLegacyWorkItem(item: ApexWorkItem): WorkItem {
  const acText = item.acceptanceCriteria
    .map((ac) => ac.text.trim())
    .filter(Boolean)
    .join('\n');

  return {
    id: item.itemNumber,
    title: item.title,
    workItemType: item.type,
    state: apexStatusToAdoState(item.status),
    assignedTo: item.owner.displayName,
    dueDate: item.dueDate ?? undefined,
    targetDate: item.release?.targetDate ?? undefined,
    changedDate: item.updatedAt,
    createdDate: item.createdAt,
    areaPath: item.project,
    iterationPath: item.release?.name ?? '',
    tags: item.release?.name,
    description: item.outcome,
    acceptanceCriteria: acText || undefined,
    parentId: undefined,
    apexWorkItemId: item.id,
    source: 'board',
    releaseId: item.releaseId ?? undefined,
  };
}
