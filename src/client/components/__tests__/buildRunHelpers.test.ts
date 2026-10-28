/**
 * PBI-016 AC-0, AC-2, AC-3; PBI-017 AC-0; PBI-018 AC-0 / VT-22 (copy), VT-28 (tab resolution), VT-30.
 */
import type { BuildSuspendReason } from '../../../shared/types/build';
import type { BuildStageView, BuildTimingView } from '../../../shared/types/buildView';
import {
  capLines,
  elapsedLabel,
  exceptionCopy,
  formatDuration,
  stageText,
  targetText,
} from '../buildStatusFormat';
import { groupTasksByBlockers } from '../buildPlanGrouping';
import { BUILD_RUN_TABS, resolveBuildRunTab } from '../buildRunTabList';

function stage(partial: Partial<BuildStageView> & Pick<BuildStageView, 'kind' | 'key'>): BuildStageView {
  return { tasks: null, queuePosition: null, suspendReason: null, ...partial } as BuildStageView;
}

const contacts = [{ displayName: 'Dana', email: 'dana@example.com' }, { displayName: 'Lee', email: null }];

describe('stageText', () => {
  it('VT-21 PBI-016 AC-2 reads "Building, 3 of 5 tasks"', () => {
    expect(stageText(stage({ kind: 'stage', key: 'building', tasks: { merged: 3, total: 5 } }), 0)).toBe('Building, 3 of 5 tasks');
  });

  it('PBI-016 AC-0 writes a sentence for every stage', () => {
    expect(stageText(stage({ kind: 'stage', key: 'queued', queuePosition: 2 }), 0)).toBe('Queued, number 2 in line');
    expect(stageText(stage({ kind: 'stage', key: 'queued' }), 0)).toBe('Queued');
    expect(stageText(stage({ kind: 'stage', key: 'intake' }), 0)).toBe('Intake');
    expect(stageText(stage({ kind: 'stage', key: 'planning' }), 0)).toBe('Planning — writing the technical plan');
    expect(stageText(stage({ kind: 'stage', key: 'planning' }), 1)).toBe('Planning — fixing the plan (repair 1 of 2)');
    expect(stageText(stage({ kind: 'stage', key: 'building' }), 0)).toBe('Building');
    expect(stageText(stage({ kind: 'stage', key: 'checking' }), 0)).toBe('Checking');
    expect(stageText(stage({ kind: 'stage', key: 'deploying' }), 0)).toBe('Deploying');
    expect(stageText(stage({ kind: 'stage', key: 'preview_ready' }), 0)).toBe('Preview ready');
    expect(stageText(stage({ kind: 'exception', key: 'deployment_failed' }), 0)).toBe('Deployment failed');
    expect(stageText(stage({ kind: 'exception', key: 'needs_developer' }), 0)).toBe('Needs a developer');
  });
});

describe('exceptionCopy', () => {
  it('returns null for a running stage', () => {
    expect(exceptionCopy(stage({ kind: 'stage', key: 'building' }), contacts)).toBeNull();
  });

  const suspended: Array<[BuildSuspendReason, RegExp, RegExp]> = [
    ['cost_cap', /cost limit/, /Project Admin/],
    ['elapsed_cap', /reached a limit on revisions, time or parallel agents/, /Project Admin/],
    ['repair_cap', /reached a limit on revisions, time or parallel agents/, /Project Admin/],
    ['flag_disabled', /Builds are turned off for now/, /Platform Admin/],
    ['permission_revoked', /can no longer run builds/, /Project Admin/],
    ['configuration', /Build settings are incomplete or changed/, /Project Admin/],
    ['plan_invalid', /could not get a valid plan/, /Dana \(dana@example\.com\) and Lee/],
  ];

  it.each(suspended)('VT-22 PBI-016 AC-3 explains suspended/%s and names the contact', (reason, cause, contact) => {
    const copy = exceptionCopy(stage({ kind: 'exception', key: 'suspended', suspendReason: reason }), contacts);
    expect(copy?.cause).toMatch(cause);
    expect(copy?.contact).toMatch(contact);
    expect(copy?.resume).toBe('The requester, a Project Admin or a Platform Admin can resume this build once the cause is cleared.');
  });

  it('VT-22 shows a data-error line for a suspended build with no reason', () => {
    const copy = exceptionCopy(stage({ kind: 'exception', key: 'suspended', suspendReason: null }), contacts);
    expect(copy?.dataError).toBe(true);
    expect(copy?.cause).toMatch(/reason is missing/);
  });

  it('VT-22 explains deployment failed, needs developer and failed with the support contacts', () => {
    expect(exceptionCopy(stage({ kind: 'exception', key: 'deployment_failed' }), contacts)?.cause)
      .toBe('Your feature was built and passed its checks, but deployment failed. Dana (dana@example.com) and Lee have been notified.');
    expect(exceptionCopy(stage({ kind: 'exception', key: 'needs_developer' }), contacts)?.cause)
      .toBe('Apex could not merge your change with the latest code. Dana (dana@example.com) and Lee have been notified.');
    const failed = exceptionCopy(stage({ kind: 'exception', key: 'failed' }), contacts);
    expect(failed?.cause).toBe('Apex could not finish this build.');
    expect(failed?.contact).toMatch(/Dana/);
  });

  it('VT-22 names no contact for cancelled and accepted', () => {
    expect(exceptionCopy(stage({ kind: 'exception', key: 'cancelled' }), contacts)).toMatchObject({ cause: 'This build was cancelled.', contact: null });
    expect(exceptionCopy(stage({ kind: 'exception', key: 'accepted' }), contacts)).toMatchObject({ cause: 'This build was accepted.', contact: null });
  });
});

describe('timing and caps', () => {
  const timing = (partial: Partial<BuildTimingView>): BuildTimingView => ({
    elapsedSeconds: 125, targetSeconds: 300, state: 'within', includesDeployment: false, ...partial,
  });

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(125)).toBe('2 min 5 s');
    expect(formatDuration(3600)).toBe('1 h 0 min');
  });

  it('PBI-016 AC-0 labels elapsed time and the target', () => {
    expect(elapsedLabel(timing({}))).toBe('Elapsed: 2 min 5 s');
    expect(elapsedLabel(timing({ includesDeployment: true }))).toBe('Elapsed (includes deployment): 2 min 5 s');
    expect(elapsedLabel(timing({ elapsedSeconds: null }))).toBe('Elapsed: not started');
    expect(targetText(timing({}))).toBe('Target: 5 min');
    expect(targetText(timing({ state: 'over', elapsedSeconds: 400 }))).toBe('Taking longer than the usual 5 min');
    expect(targetText(timing({ targetSeconds: null, state: 'none' }))).toBe('No delivery target yet');
  });

  it('PBI-016 AC-0 writes one line per cap with cost as an estimate', () => {
    expect(capLines({
      cost: { usedUsd: '3.5000', limitUsd: '25.0000' },
      revisions: { used: 1, limit: 5 },
      elapsedSeconds: { used: 120, limit: 3600 },
      parallelism: { used: 1, limit: 3 },
    })).toEqual({
      cost: 'Estimated cost: $3.50 of $25.00',
      revisions: 'Revisions: 1 of 5',
      elapsed: 'Time used: 2 min 0 s of 1 h 0 min',
      parallelism: 'Parallel agents: 1 of 3',
    });
  });
});

describe('groupTasksByBlockers', () => {
  const t = (key: string, dependsOn: string[] = []) => ({ key, dependsOn });

  it('VT-30 PBI-018 AC-0 puts a chain in successive waves', () => {
    const result = groupTasksByBlockers([t('c', ['b']), t('a'), t('b', ['a'])]);
    expect(result.waves.map((wave) => wave.map((task) => task.key))).toEqual([['a'], ['b'], ['c']]);
    expect(result.waiting).toEqual([]);
  });

  it('VT-30 puts side-by-side tasks in one wave', () => {
    const result = groupTasksByBlockers([t('a'), t('b'), t('c', ['a', 'b'])]);
    expect(result.waves.map((wave) => wave.map((task) => task.key))).toEqual([['a', 'b'], ['c']]);
  });

  it('VT-30 puts an unknown blocker key and its dependants in the waiting group', () => {
    const result = groupTasksByBlockers([t('a'), t('b', ['missing']), t('c', ['b'])]);
    expect(result.waves.map((wave) => wave.map((task) => task.key))).toEqual([['a']]);
    expect(result.waiting.map((task) => task.key)).toEqual(['b', 'c']);
  });

  it('VT-30 terminates on a cycle and puts it in the waiting group', () => {
    const result = groupTasksByBlockers([t('a', ['b']), t('b', ['a']), t('c')]);
    expect(result.waves.map((wave) => wave.map((task) => task.key))).toEqual([['c']]);
    expect(result.waiting.map((task) => task.key)).toEqual(['a', 'b']);
  });
});

describe('resolveBuildRunTab', () => {
  it('VT-28 PBI-017 AC-0 lists Overview, Plan and Timeline in order', () => {
    expect(BUILD_RUN_TABS.map((tab) => tab.key)).toEqual(['overview', 'plan', 'timeline']);
  });

  it('VT-28 defaults a bare address to Overview and redirects an unknown segment', () => {
    expect(resolveBuildRunTab(undefined)).toEqual({ tab: 'overview', redirect: false });
    expect(resolveBuildRunTab('plan')).toEqual({ tab: 'plan', redirect: false });
    expect(resolveBuildRunTab('unknown')).toEqual({ tab: 'overview', redirect: true });
  });
});
