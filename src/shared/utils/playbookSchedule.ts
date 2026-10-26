import { z } from 'zod';

export const PLAYBOOK_SCHEDULE_WINDOW_MS = 15 * 60_000;

export const playbookScheduleKinds = ['manual', 'daily'] as const;
export type PlaybookScheduleKind = (typeof playbookScheduleKinds)[number];

export const playbookScheduleSchema = z.object({
  scheduleKind: z.enum(playbookScheduleKinds),
  scheduleHour: z.number().int().min(0).max(23).nullable(),
  scheduleMinute: z.number().int().min(0).max(59),
}).superRefine((value, ctx) => {
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
      message: 'Run now only does not use an hour.',
    });
  }
});

export type PlaybookScheduleDraft = z.infer<typeof playbookScheduleSchema>;

export const playbookScheduleFormSchema = z.object({
  scheduleKind: z.enum(playbookScheduleKinds),
  scheduleHour: z.number().int().min(0).max(23),
  scheduleMinute: z.number().int().min(0).max(59),
});

export type PlaybookScheduleFormValues = z.infer<typeof playbookScheduleFormSchema>;

export function playbookScheduleDraftFromForm(
  values: PlaybookScheduleFormValues,
): PlaybookScheduleDraft {
  return playbookScheduleSchema.parse({
    scheduleKind: values.scheduleKind,
    scheduleHour: values.scheduleKind === 'daily' ? values.scheduleHour : null,
    scheduleMinute: values.scheduleKind === 'daily' ? values.scheduleMinute : 0,
  });
}

export function playbookScheduleFormFromDefinition(input: {
  scheduleKind: PlaybookScheduleKind;
  scheduleHour: number | null;
  scheduleMinute: number;
}): PlaybookScheduleFormValues {
  return {
    scheduleKind: input.scheduleKind,
    scheduleHour: input.scheduleHour ?? 2,
    scheduleMinute: input.scheduleMinute,
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
 * A daily trigger is due from its UTC minute until 15 minutes later, and only
 * when it has not already started in that window. A process that was down
 * past the window waits until the next day.
 */
export function isDailyPlaybookScheduleDue(input: {
  scheduleKind: PlaybookScheduleKind;
  scheduleHour: number | null;
  scheduleMinute: number;
  lastScheduledAt: string | null;
  now: Date;
}): boolean {
  if (input.scheduleKind !== 'daily' || input.scheduleHour == null) return false;
  const scheduledMs = dailyScheduleInstantUtc(
    input.now,
    input.scheduleHour,
    input.scheduleMinute,
  ).getTime();
  const nowMs = input.now.getTime();
  if (nowMs < scheduledMs || nowMs >= scheduledMs + PLAYBOOK_SCHEDULE_WINDOW_MS) {
    return false;
  }
  if (!input.lastScheduledAt) return true;
  const lastMs = Date.parse(input.lastScheduledAt);
  if (Number.isNaN(lastMs)) return true;
  return lastMs < scheduledMs;
}

export function formatPlaybookSchedule(input: {
  scheduleKind: PlaybookScheduleKind;
  scheduleHour: number | null;
  scheduleMinute: number;
}): string {
  if (input.scheduleKind === 'manual' || input.scheduleHour == null) return 'Run now only';
  const hour = String(input.scheduleHour).padStart(2, '0');
  const minute = String(input.scheduleMinute).padStart(2, '0');
  return `Daily at ${hour}:${minute} UTC`;
}
