import {
  buildCloudBackgroundJobPrompt,
  cloudBackgroundJobBranchName,
  cloudBackgroundJobDraftFromForm,
  cloudBackgroundJobSchema,
  emptyCloudBackgroundJobForm,
  isDailyCloudBackgroundJobDue,
} from '../cloudBackgroundJob';

const daily = {
  name: 'Nightly cleanup',
  instructions: 'Remove the unused helper.',
  skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
  model: 'composer-2.5',
  workItemMode: 'none' as const,
  workItemId: null,
  scheduleKind: 'daily' as const,
  scheduleHour: 2,
  scheduleMinute: 0,
  enabled: true,
};

describe('cloud background job draft', () => {
  it('accepts a daily job with no work item', () => {
    expect(cloudBackgroundJobSchema.parse(daily)).toMatchObject({
      scheduleHour: 2,
      workItemId: null,
    });
  });

  it('requires a work item id only when attaching', () => {
    expect(cloudBackgroundJobSchema.safeParse({
      ...daily,
      scheduleKind: 'manual',
      scheduleHour: null,
      workItemMode: 'attach',
      workItemId: null,
    }).success).toBe(false);

    expect(cloudBackgroundJobSchema.parse({
      ...daily,
      scheduleKind: 'manual',
      scheduleHour: null,
      workItemMode: 'attach',
      workItemId: 45681,
    }).workItemId).toBe(45681);
  });

  it('maps the form so a manual job does not store an hour', () => {
    const draft = cloudBackgroundJobDraftFromForm({
      ...emptyCloudBackgroundJobForm(),
      name: 'Cleanup',
      instructions: 'Do the cleanup.',
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      model: 'composer-2.5',
      scheduleHour: 2,
    });
    expect(draft.scheduleKind).toBe('manual');
    expect(draft.scheduleHour).toBeNull();
    expect(draft.workItemId).toBeNull();
  });
});

describe('isDailyCloudBackgroundJobDue', () => {
  const now = new Date('2026-10-23T02:05:00.000Z');

  it('is due inside the 15 minute window when it has not started today', () => {
    expect(isDailyCloudBackgroundJobDue({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 0,
      lastStartedAt: '2026-10-22T02:01:00.000Z',
      now,
    })).toBe(true);
  });

  it('waits until the next day after the window', () => {
    expect(isDailyCloudBackgroundJobDue({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 0,
      lastStartedAt: null,
      now: new Date('2026-10-23T02:16:00.000Z'),
    })).toBe(false);
  });

  it('does not start twice in the same window', () => {
    expect(isDailyCloudBackgroundJobDue({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 0,
      lastStartedAt: '2026-10-23T02:00:30.000Z',
      now,
    })).toBe(false);
  });

  it('ignores a manual job', () => {
    expect(isDailyCloudBackgroundJobDue({
      scheduleKind: 'manual',
      scheduleHour: null,
      scheduleMinute: 0,
      lastStartedAt: null,
      now,
    })).toBe(false);
  });
});

describe('cloud background job prompt', () => {
  it('names the branch and leaves work items alone when the job has none', () => {
    const branchName = cloudBackgroundJobBranchName({
      jobId: 'abcdef12-3456-7890-abcd-ef1234567890',
      name: 'Nightly cleanup',
    });
    expect(branchName).toBe('feature/apex-bg-abcdef-nightly-cleanup');
    const prompt = buildCloudBackgroundJobPrompt({
      name: 'Nightly cleanup',
      instructions: 'Remove the unused helper.',
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      skillName: 'dev-orchestrator',
      branchName,
    });
    expect(prompt).toContain('Work on branch `feature/apex-bg-abcdef-nightly-cleanup`');
    expect(prompt).toContain('This job has no work item.');
    expect(prompt).toContain('Remove the unused helper.');
  });

  it('mentions an attached work item', () => {
    const prompt = buildCloudBackgroundJobPrompt({
      name: 'Fix the board',
      instructions: 'Fix the empty column.',
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      skillName: 'dev-orchestrator',
      branchName: 'feature/apex-bg-99-fix-the-board',
      workItemId: 99,
      workItemUrl: 'https://dev.azure.com/example/_workitems/edit/99',
    });
    expect(prompt).toContain('#99');
    expect(prompt).toContain('https://dev.azure.com/example/_workitems/edit/99');
  });
});
