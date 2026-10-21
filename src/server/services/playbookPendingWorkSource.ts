import type { PendingWorkSource } from './pendingWorkService';
import { listPendingGateRows } from './playbookGateService';
import { playbookAssignedToMeHref } from '../../shared/types/playbook';

function urgencyText(deadline: string): string {
  const remainingMs = new Date(deadline).getTime() - Date.now();
  if (remainingMs <= 0) return 'Due now';
  const hours = Math.ceil(remainingMs / (60 * 60 * 1000));
  if (hours < 24) return `Due in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.ceil(hours / 24);
  return `Due in ${days} day${days === 1 ? '' : 's'}`;
}

export const playbookPendingWorkSource: PendingWorkSource = {
  key: 'playbook-gates',
  async listPending(input) {
    const result = await listPendingGateRows(input);
    return {
      total: result.total,
      items: result.rows.map((row) => ({
        id: row.id,
        source: 'playbook-gates',
        title: row.title,
        deadline: row.deadline,
        href: playbookAssignedToMeHref(row.runId),
        urgencyText: urgencyText(row.deadline),
      })),
    };
  },
};

export const PRODUCTION_PENDING_WORK_SOURCES = [playbookPendingWorkSource] as const;
