import { describeRuntimeFailure, missingChecksMessage } from '../../../shared/buildRuntimeFailure';
import { buildProgressHeadline, userFacingBuildEvent } from '../buildProgressCopy';

describe('build progress copy', () => {
  it('explains a Node engine install failure in plain language', () => {
    const text = [
      'ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment (bad pnpm and/or Node.js version)',
      'Expected version: >=24.0.0 <25.0.0',
      'Got: v22.23.4',
    ].join('\n');
    expect(describeRuntimeFailure(text)).toBe(
      'The build machine could not install dependencies. This repository requires Node 24, and the build machine has Node 22.',
    );
  });

  it('names the checks that were missing', () => {
    expect(missingChecksMessage(['AC-1', 'AC-1', 'NFR-1'])).toBe(
      'The build finished without the required checks for AC-1, NFR-1.',
    );
  });

  it('hides internal task names and shows a stale build', () => {
    expect(userFacingBuildEvent('Task build-feature started.')).toBe(
      'Building and testing the feature.',
    );
    const now = Date.parse('2026-11-04T13:40:00.000Z');
    const headline = buildProgressHeadline({
      status: 'building',
      events: [
        {
          occurredAt: '2026-11-04T13:30:00.000Z',
          kind: 'task.launched',
          message: 'Task build-feature started.',
        },
      ],
      hasPullRequest: false,
      nowMs: now,
    });
    expect(headline.stale).toBe(true);
    expect(headline.headline).toBe('No update for 10 minutes.');
  });

  it('shows preview and deploy progress before pull request', () => {
    expect(
      buildProgressHeadline({
        status: 'preview_ready',
        events: [],
        hasPullRequest: false,
        nowMs: Date.now(),
      }).headline,
    ).toBe('Your preview is ready to review.');
    expect(
      buildProgressHeadline({
        status: 'deploying',
        events: [],
        hasPullRequest: false,
        nowMs: Date.now(),
      }).headline,
    ).toBe('Starting the preview.');
  });

  it('shows a failed build reason instead of a working headline', () => {
    const headline = buildProgressHeadline({
      status: 'failed',
      events: [
        {
          occurredAt: '2026-11-04T13:34:00.000Z',
          kind: 'verification.refused',
          message:
            'The build machine could not install dependencies. This repository requires Node 24, and the build machine has Node 22.',
        },
      ],
      hasPullRequest: false,
      nowMs: Date.parse('2026-11-04T13:40:00.000Z'),
    });
    expect(headline.failed).toBe(true);
    expect(headline.headline).toContain('Node 24');
  });
});
