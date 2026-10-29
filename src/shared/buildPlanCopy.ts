/**
 * Planning sentences and test ids for the build header and Plan tab.
 * FEAT-008 renders them. This feature owns the words.
 */

export const BUILD_PLAN_TEST_IDS = {
  stageText: 'build-stage-text',
  repairNotice: 'build-plan-repair-notice',
  invalidNotice: 'build-plan-invalid-notice',
  invalidContacts: 'build-plan-invalid-contacts',
  emptyState: 'build-plan-empty-state',
} as const;

export function taskReuseTestId(taskKey: string): string {
  return `build-plan-task-reuse-${taskKey}`;
}

export function taskNoReuseTestId(taskKey: string): string {
  return `build-plan-task-no-reuse-${taskKey}`;
}

export function planningHeaderText(repairAttempts: number): string {
  if (repairAttempts <= 0) return 'Planning — writing the technical plan';
  const used = Math.min(repairAttempts, 2);
  return `Planning — fixing the plan (repair ${used} of 2)`;
}

export function formatSupportContacts(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter((name) => name.length > 0);
  if (clean.length === 0) return 'the Build support contacts';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

export function planInvalidNotice(input: {
  kind: 'validation' | 'stopped';
  contacts: readonly string[];
}): string {
  const who = formatSupportContacts(input.contacts);
  if (input.kind === 'stopped') {
    return `We could not get a plan for this build. The planning agent stopped before it wrote one. Contact ${who}. You can cancel this build or ask for changes.`;
  }
  return `We could not get a valid plan for this build. The planning agent's plan failed our checks twice. Contact ${who}. You can cancel this build or ask for changes.`;
}

export const PLAN_EMPTY_WHILE_PLANNING = 'Your plan is being written.';
export const PLAN_EMPTY_AFTER_INVALID = 'No plan was produced.';
export const NOTHING_REUSABLE_FOUND = 'Nothing reusable found';
export const REUSE_NOT_RECORDED = 'Reuse not recorded';
