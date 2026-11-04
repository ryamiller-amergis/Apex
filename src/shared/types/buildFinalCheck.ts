/**
 * Shared types for Merge, Final Check and Repair (FEAT-012).
 */
export const MAX_REPAIR_ATTEMPTS = 2;

export type RepairReason =
  | 'plan_invalid'
  | 'merge_conflict'
  | 'revision_sync_conflict'
  | 'final_check_fix';

export type FinalCheckKind = 'unit_full' | 'unit_related' | 'type_check' | 'lint';

export interface FinalCheckCommandResult {
  kind: FinalCheckKind;
  outcome: 'passed' | 'failed';
  failedTests?: string[]; // names only, max 50
  summary: string; // max 500 chars
}

export type StandardsRule =
  | 'duplicate_helper'
  | 'hard_coded_colour'
  | 'off_library_component'
  | 'missing_accessibility';

export interface StandardsFinding {
  rule: StandardsRule;
  file: string;
  line?: number;
  resolution: 'fixed' | 'exception' | 'open';
  detail: string; // max 500 chars, no code excerpts
  exceptionReason?: string; // required when resolution is 'exception'
}

export type StandardsReview =
  | { status: 'reviewed'; findings: StandardsFinding[]; reviewSeconds?: number }
  | { status: 'unreadable_input'; path: string };

export interface FinalCheckReport {
  schemaVersion: 1;
  validatedCommit: string;
  repairedInSession: boolean;
  checks: FinalCheckCommandResult[]; // must include unit_full and unit_related
  standards: StandardsReview;
  summary: string;
}
