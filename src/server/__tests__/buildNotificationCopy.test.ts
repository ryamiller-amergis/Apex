/**
 * S3 — Pure build notification copy and redaction tests (PBI-037 AC-0, AC-3, TBI-030 DoD-0 / VT-23).
 */
import { buildNotificationCopy } from '../services/buildNotificationCopy';

describe('buildNotificationCopy (PBI-037 AC-0, AC-3, TBI-030 DoD-0 / VT-23)', () => {
  it('VT-23 PBI-037 AC-3 builds plain-language copy for all 5 notification kinds, names the cap and resume guidance on suspension, and redacts secrets', () => {
    const started = buildNotificationCopy('build_started', {
      buildRunId: 'run-1',
      featureTitle: 'Add Export with Bearer secretBearerToken111',
    });
    expect(started.title).toBe('Your build has started');
    expect(started.body).not.toContain('secretBearerToken111');
    expect(started.link).toBe('/builds/run-1');

    const preview = buildNotificationCopy('preview_ready', {
      buildRunId: 'run-1',
      featureTitle: 'Export CSV',
      revisionNumber: 2,
    });
    expect(preview.title).toBe('Your build preview is ready');
    expect(preview.body).toContain('Revision 2 of "Export CSV" is ready to review.');

    const suspendedCost = buildNotificationCopy('run_suspended', {
      buildRunId: 'run-1',
      featureTitle: 'Export CSV',
      reason: 'cost_cap',
    });
    expect(suspendedCost.title).toBe('Your build is paused');
    expect(suspendedCost.body).toMatch(/cost limit/i);
    expect(suspendedCost.body).toMatch(/resume/i);
    expect(suspendedCost.body).not.toContain('cost_cap');

    const deployFailed = buildNotificationCopy('deployment_failed', {
      buildRunId: 'run-1',
      featureTitle: 'Export CSV',
      failedStage: 'Deploy_Dev',
    });
    expect(deployFailed.title).toBe('A build failed to deploy');
    expect(deployFailed.body).toContain('Deploy_Dev');

    const prCreated = buildNotificationCopy('pull_request_created', {
      buildRunId: 'run-1',
      featureTitle: 'Export CSV',
      riskDecisionCount: 3,
    });
    expect(prCreated.title).toBe('Your pull request is ready');
    expect(prCreated.body).toContain('3 risk decisions');
  });
});
