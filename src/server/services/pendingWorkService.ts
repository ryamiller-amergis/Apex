import type { AssignedToMeData, PendingWorkItem } from '../../shared/types/homeDashboard';
import { playbookAssignedToMeHref } from '../../shared/types/playbook';

export interface PendingWorkSource {
  key: string;
  listPending(input: {
    project: string;
    userId: string;
    limit: number;
  }): Promise<{ items: PendingWorkItem[]; total: number }>;
}

export const ASSIGNED_TO_ME_DISPLAY_CAP = 5;

export function createPendingWorkService(sources: readonly PendingWorkSource[]) {
  const keys = sources.map((source) => source.key);
  if (new Set(keys).size !== keys.length) throw new Error('Pending-work source keys must be unique.');

  return {
    async listPending(input: { project: string; userId: string }): Promise<AssignedToMeData> {
      const results = await Promise.all(sources.map((source) => source.listPending({
        ...input,
        limit: ASSIGNED_TO_ME_DISPLAY_CAP,
      })));
      const items = results.flatMap((result) => result.items)
        .sort((left, right) =>
          left.deadline.localeCompare(right.deadline) || left.id.localeCompare(right.id))
        .slice(0, ASSIGNED_TO_ME_DISPLAY_CAP);
      return {
        items,
        total: results.reduce((sum, result) => sum + result.total, 0),
        soonestDeadline: items[0]?.deadline ?? null,
        viewAllHref: playbookAssignedToMeHref(),
      };
    },
  };
}
