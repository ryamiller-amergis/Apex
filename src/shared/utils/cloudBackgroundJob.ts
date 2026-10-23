import { z } from 'zod';

export const CLOUD_BACKGROUND_JOB_WINDOW_MS = 15 * 60_000;

export const cloudBackgroundWorkItemModes = ['create_bug', 'attach', 'none'] as const;
export const cloudBackgroundScheduleKinds = ['manual', 'daily'] as const;

export type CloudBackgroundWorkItemMode = (typeof cloudBackgroundWorkItemModes)[number];
export type CloudBackgroundScheduleKind = (typeof cloudBackgroundScheduleKinds)[number];

export const cloudBackgroundJobSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use 80 characters or fewer.'),
  instructions: z.string().trim().min(1, 'Enter the instructions.').max(8000, 'Use 8000 characters or fewer.'),
  skillPath: z.string().trim().min(1, 'Choose a skill.').max(500),
  model: z.string().trim().min(1, 'Choose a model.').max(200),
  workItemMode: z.enum(cloudBackgroundWorkItemModes),
  workItemId: z.number().int().positive().nullable(),
  scheduleKind: z.enum(cloudBackgroundScheduleKinds),
  scheduleHour: z.number().int().min(0).max(23).nullable(),
  scheduleMinute: z.number().int().min(0).max(59),
  enabled: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.workItemMode === 'attach' && value.workItemId == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workItemId'],
      message: 'Enter the Azure DevOps work item id.',
    });
  }
  if (value.workItemMode !== 'attach' && value.workItemId != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workItemId'],
      message: 'A work item id is only used when the job attaches to an existing work item.',
    });
  }
  if (value.scheduleKind === 'daily' && value.scheduleHour == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduleHour'],
      message: 'Choose the hour.',
    });
  }
  if (value.scheduleKind === 'manual' && value.scheduleHour != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduleHour'],
      message: 'A manual job does not use an hour.',
    });
  }
});

export type CloudBackgroundJobDraft = z.infer<typeof cloudBackgroundJobSchema>;

export const cloudBackgroundJobFormSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use 80 characters or fewer.'),
  instructions: z.string().trim().min(1, 'Enter the instructions.').max(8000, 'Use 8000 characters or fewer.'),
  skillPath: z.string().trim().min(1, 'Choose a skill.'),
  model: z.string().trim().min(1, 'Choose a model.'),
  workItemMode: z.enum(cloudBackgroundWorkItemModes),
  workItemId: z.string(),
  scheduleKind: z.enum(cloudBackgroundScheduleKinds),
  scheduleHour: z.number().int().min(0).max(23),
  scheduleMinute: z.number().int().min(0).max(59),
  enabled: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.workItemMode !== 'attach') return;
  if (!/^[1-9]\d*$/.test(value.workItemId.trim())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['workItemId'],
      message: 'Enter the Azure DevOps work item id.',
    });
  }
});

export type CloudBackgroundJobFormValues = z.infer<typeof cloudBackgroundJobFormSchema>;

export function cloudBackgroundJobDraftFromForm(
  values: CloudBackgroundJobFormValues,
): CloudBackgroundJobDraft {
  const parsed = cloudBackgroundJobSchema.parse({
    name: values.name,
    instructions: values.instructions,
    skillPath: values.skillPath,
    model: values.model,
    workItemMode: values.workItemMode,
    workItemId: values.workItemMode === 'attach' ? Number(values.workItemId.trim()) : null,
    scheduleKind: values.scheduleKind,
    scheduleHour: values.scheduleKind === 'daily' ? values.scheduleHour : null,
    scheduleMinute: values.scheduleKind === 'daily' ? values.scheduleMinute : 0,
    enabled: values.enabled,
  });
  return parsed;
}

export function emptyCloudBackgroundJobForm(): CloudBackgroundJobFormValues {
  return {
    name: '',
    instructions: '',
    skillPath: '',
    model: '',
    workItemMode: 'none',
    workItemId: '',
    scheduleKind: 'manual',
    scheduleHour: 2,
    scheduleMinute: 0,
    enabled: true,
  };
}

/** UTC instant of today's scheduled minute. The date comes from `now`. */
export function dailyScheduleInstantUtc(now: Date, hour: number, minute: number): Date {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ));
}

/**
 * A daily job is due from its UTC minute until 15 minutes later, and only
 * when it has not already started in that window. A process that was down
 * past the window waits until the next day.
 */
export function isDailyCloudBackgroundJobDue(input: {
  scheduleKind: CloudBackgroundScheduleKind;
  scheduleHour: number | null;
  scheduleMinute: number;
  lastStartedAt: string | null;
  now: Date;
}): boolean {
  if (input.scheduleKind !== 'daily' || input.scheduleHour == null) return false;
  const scheduledMs = dailyScheduleInstantUtc(
    input.now,
    input.scheduleHour,
    input.scheduleMinute,
  ).getTime();
  const nowMs = input.now.getTime();
  if (nowMs < scheduledMs || nowMs >= scheduledMs + CLOUD_BACKGROUND_JOB_WINDOW_MS) {
    return false;
  }
  if (!input.lastStartedAt) return true;
  const lastMs = Date.parse(input.lastStartedAt);
  if (Number.isNaN(lastMs)) return true;
  return lastMs < scheduledMs;
}

function branchSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** Branch for a background job. Distinct from a My Work feature branch. */
export function cloudBackgroundJobBranchName(input: {
  jobId: string;
  name: string;
  workItemId?: number | null;
}): string {
  const slug = branchSlug(input.name);
  const token = input.workItemId
    ? String(input.workItemId)
    : (input.jobId.replace(/-/g, '').slice(0, 6) || 'job');
  const prefix = `feature/apex-bg-${token}`;
  return slug ? `${prefix}-${slug}` : prefix;
}

export function buildCloudBackgroundJobPrompt(input: {
  name: string;
  instructions: string;
  skillPath: string;
  skillName: string | null;
  branchName: string;
  workItemId?: number | null;
  workItemUrl?: string | null;
  pullRequestInstructions?: string | null;
}): string {
  const invocation = input.skillName ? `/${input.skillName}\n\n` : '';
  const pullRequestTitle = `[APEX] ${input.branchName.replace('feature/', '')}`;
  const workItemLine = input.workItemId
    ? `An Azure DevOps work item already exists: #${input.workItemId}${input.workItemUrl ? ` ${input.workItemUrl}` : ''}. Mention it in the pull request. Do not change its state, tags, or fields.`
    : 'Do not change Azure DevOps work items. This job has no work item.';
  return [
    `${invocation}A background job for this project is starting: ${input.name}.`,
    `Load \`${input.skillPath}\` from the repository and follow it, with these changes because nobody is watching this run:`,
    '- Do not wait for approval. Where the skill asks for approval of a plan, write that plan into the pull request description and continue.',
    '- If the instructions are unclear, or you cannot make the change with high confidence, do not change production code. End with your findings and the questions a developer must answer.',
    '- Open the pull request yourself. Do not hand off to another skill or ask for a new chat.',
    '',
    'Do the work the instructions describe. Change only what they need.',
    'Add a regression test when the change is a code fix. Run the relevant tests and lint before opening the pull request.',
    '',
    `Work on branch \`${input.branchName}\` and no other branch.`,
    input.pullRequestInstructions?.trim()
      || `Open a pull request titled \`${pullRequestTitle}\` so a developer can review the change. Describe what you changed and how you checked it.`,
    workItemLine,
    '',
    'Instructions:',
    input.instructions.trim(),
  ].join('\n');
}

export function formatCloudBackgroundSchedule(input: {
  scheduleKind: CloudBackgroundScheduleKind;
  scheduleHour: number | null;
  scheduleMinute: number;
}): string {
  if (input.scheduleKind === 'manual' || input.scheduleHour == null) return 'Run now only';
  const hour = String(input.scheduleHour).padStart(2, '0');
  const minute = String(input.scheduleMinute).padStart(2, '0');
  return `Daily at ${hour}:${minute} UTC`;
}
