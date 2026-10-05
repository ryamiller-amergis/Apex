import type { WorkItem } from './workitem';

export type RelatedItemCycleTimeIncompleteReason =
  | 'missing_in_progress'
  | 'missing_done'
  | 'end_not_after_start';

export interface RelatedItemCycleTime {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  lastInProgressAt: string | null;
  lastDoneAt: string | null;
  cycleTimeDays: number | null;
  incompleteReason: RelatedItemCycleTimeIncompleteReason | null;
  /** Full ADO work item so the report can open the details panel without another fetch. */
  workItem: WorkItem;
}

export interface RelatedItemsCycleTimeResponse {
  items: RelatedItemCycleTime[];
  medianDays: number | null;
  avgDays: number | null;
  sampleSize: number;
  incompleteCount: number;
}
