/**
 * The formatting rules PBI-002 and PBI-003 attach conditions to.
 *
 * Status labels and deadline forms are tested here rather than only through the rendered view,
 * because "every status has a text label" is a claim about the whole union — and a render test can
 * only ever check the statuses its fixtures happen to contain.
 */
import {
  absoluteTime,
  formatDeadline,
  relativeTime,
  runStatusLabel,
  stepStatusLabel,
  suspendReasonLabel,
} from '../playbookStatusFormat';
import {
  PLAYBOOK_RUN_STATUSES,
  PLAYBOOK_STEP_RUN_STATUSES,
} from '../../../shared/types/playbook';

describe('status labels', () => {
  it('gives every run status a human label distinct from the raw token', () => {
    for (const status of PLAYBOOK_RUN_STATUSES) {
      const label = runStatusLabel(status);
      expect(label.trim()).toBeTruthy();
      expect(label).not.toBe(status);
    }
  });

  it('gives every step status a human label distinct from the raw token', () => {
    for (const status of PLAYBOOK_STEP_RUN_STATUSES) {
      const label = stepStatusLabel(status);
      expect(label.trim()).toBeTruthy();
      expect(label).not.toBe(status);
    }
  });

  it('distinguishes expiry from failure in words', () => {
    // The distinction `expired` exists to draw: nobody came, rather than something broke.
    expect(runStatusLabel('expired')).toMatch(/deadline/i);
    expect(runStatusLabel('expired')).not.toMatch(/fail/i);
  });

  it('says what can be done about a retryable failure', () => {
    expect(stepStatusLabel('failed_retryable')).toMatch(/retried/i);
  });

  it('explains both suspension reasons in words', () => {
    expect(suspendReasonLabel('approval_gate')).toMatch(/approve/i);
    expect(suspendReasonLabel('agent_run')).toMatch(/agent/i);
  });

  it('falls back to the raw value for a reason it does not know', () => {
    // Better an unfamiliar token on screen than an empty space where the cause should be.
    expect(suspendReasonLabel('something_new')).toBe('something_new');
  });
});

describe('deadline formatting', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');

  it('renders the absolute form as a date and time', () => {
    expect(absoluteTime('2026-09-18T14:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('phrases a future deadline as "in ..."', () => {
    expect(relativeTime('2026-09-20T14:00:00.000Z', now)).toBe('in 2 hours');
    expect(relativeTime('2026-09-20T12:30:00.000Z', now)).toBe('in 30 minutes');
    expect(relativeTime('2026-09-22T12:00:00.000Z', now)).toBe('in 2 days');
  });

  it('phrases a passed deadline as "... ago" rather than a negative interval', () => {
    // The thing that survives to a demo if it is not handled: "in -1 hours".
    expect(relativeTime('2026-09-20T11:00:00.000Z', now)).toBe('1 hour ago');
    expect(relativeTime('2026-09-19T12:00:00.000Z', now)).toBe('1 day ago');
  });

  it('singularises a single unit', () => {
    expect(relativeTime('2026-09-20T13:00:00.000Z', now)).toBe('in 1 hour');
    expect(relativeTime('2026-09-20T12:01:00.000Z', now)).toBe('in 1 minute');
  });

  it('avoids "in 0 minutes" for something imminent', () => {
    expect(relativeTime('2026-09-20T12:00:30.000Z', now)).toBe('in less than a minute');
  });

  it('never returns the relative form alone', () => {
    const formatted = formatDeadline('2026-09-20T14:00:00.000Z', now);

    // PBI-003's accessibility requirement: absolute and relative, so it is understandable
    // without colour cues and precise enough to act on.
    expect(formatted.absolute).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatted.relative).toBe('in 2 hours');
  });
});
