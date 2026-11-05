import type { FrozenBuildRunConfig, PreflightResult } from '../../shared/types/buildPreflight';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import { PlaybookGuardViolationError } from '../services/playbookGuardService';
import { BuildStartError } from '../services/buildOrchestrator/errors';
import { startBuild, type StartBuildDeps } from '../services/buildOrchestrator/startBuild';
import type { StoredBuild } from '../services/buildOrchestrator/store';

const config = { caps: { costUsd: 1, elapsedMinutesPerRevision: 60, maxRevisions: 5, maxParallelism: 2 } } as FrozenBuildRunConfig;

function command(overrides: Record<string, string> = {}) {
  return {
    requesterUserId: 'user-1',
    project: 'Apex',
    repository: 'apex',
    prompt: 'Add a reports page',
    clientRequestId: 'req-1',
    ...overrides,
  };
}

function stored(overrides: Partial<StoredBuild> = {}): StoredBuild {
  return {
    id: 'build-1',
    project: 'Apex',
    repository: 'apex',
    requestedByUserId: 'user-1',
    prompt: 'Add a reports page',
    status: 'intake',
    playbookRunId: 'run-1',
    playbookStepRunId: null,
    skillSettingsId: 'settings-1',
    queuedAt: null,
    interviewId: null,
    ...overrides,
  };
}

function deps(overrides: Partial<StartBuildDeps> = {}): StartBuildDeps & {
  events: Array<{ eventType: string; promptLength: number }>;
  calls: { preflight: number; start: number };
} {
  const events: Array<{ eventType: string; promptLength: number }> = [];
  const calls = { preflight: 0, start: 0 };
  const base: StartBuildDeps = {
    isEnabled: async () => true,
    isAllowed: async () => true,
    listConfigs: async () => [{ id: 'settings-1', skillRepo: 'apex', isDefault: true, friendlyName: 'Apex' } as ProjectSkillConfig],
    listModels: async () => [{ id: 'composer' }],
    preflight: async () => {
      calls.preflight += 1;
      return { ok: true, config } as PreflightResult;
    },
    ensurePublished: async () => ({ definitionId: 'def-1' }),
    startRun: async () => {
      calls.start += 1;
      return { runId: 'run-1' };
    },
    findReplay: async () => null,
    admit: async () => ({ build: stored(), replayed: false, queueReason: null }),
    linkPlaybookRun: async () => undefined,
    markFailed: async () => undefined,
    queuePosition: async () => 1,
    queueReason: async () => 'platform_limit',
    writeEvent: async (input) => {
      events.push({ eventType: input.eventType, promptLength: input.promptLength });
    },
    now: () => new Date('2026-10-26T12:00:00.000Z'),
    track: () => undefined,
    ...overrides,
  };
  return Object.assign(base, { events, calls });
}

describe('startBuild', () => {
  it('VT-01 returns intake with a Playbook run and records prompt length only', async () => {
    const harness = deps();
    const result = await startBuild(command({ model: 'composer' }), harness);
    expect(result).toMatchObject({ status: 'intake', buildRunId: 'build-1', playbookRunId: 'run-1', replayed: false });
    expect(harness.calls.start).toBe(1);
    expect(harness.events.map((event) => event.eventType)).toEqual(['build.requested', 'build.started']);
    expect(JSON.stringify(harness.events)).not.toContain('Add a reports page');
    expect(harness.events[0].promptLength).toBe('Add a reports page'.length);
  });

  it('links the build to its Playbook run before the first step runs', async () => {
    const linked = new Map<string, string>();
    const harness = deps({
      linkPlaybookRun: async (buildRunId, playbookRunId) => {
        linked.set(playbookRunId, buildRunId);
      },
      startRun: async ({ onRunCreated }) => {
        await onRunCreated('run-1');
        if (linked.get('run-1') !== 'build-1') throw new Error('intake could not find its build');
        return { runId: 'run-1' };
      },
    });
    const result = await startBuild(command(), harness);
    expect(result).toMatchObject({ status: 'intake', playbookRunId: 'run-1' });
  });

  it('VT-01 an unknown model is a 400 and does not run preflight', async () => {
    const harness = deps();
    await expect(startBuild(command({ model: 'nope' }), harness)).rejects.toMatchObject({ status: 400 });
    expect(harness.calls.preflight).toBe(0);
  });

  it('VT-03 returns every preflight refusal and does not start a run', async () => {
    const refusals = [
      { code: 'code_map_missing', item: 'code map', message: 'The code map is missing.', fixer: 'platform_admin', fixerLabel: 'A Platform Admin' },
      { code: 'coding_rules_missing', item: 'rules', message: 'The coding rules are missing.', fixer: 'platform_admin', fixerLabel: 'A Platform Admin' },
      { code: 'pipeline_missing', item: 'pipeline', message: 'The pipeline is missing.', fixer: 'project_admin', fixerLabel: 'A project admin' },
    ];
    const harness = deps({
      preflight: async () => ({ ok: false, refusals }) as PreflightResult,
    });
    await expect(startBuild(command(), harness)).rejects.toMatchObject({
      status: 409,
      code: 'BUILD_PREFLIGHT_REFUSED',
      refusals,
    });
    expect(harness.calls.start).toBe(0);
  });

  it('VT-05 a full project queues without a Playbook run', async () => {
    const harness = deps({
      admit: async () => ({
        build: stored({ status: 'queued', playbookRunId: null, queuedAt: '2026-10-26T12:00:00.000Z' }),
        replayed: false,
        queueReason: 'project_limit',
      }),
    });
    const result = await startBuild(command(), harness);
    expect(result).toMatchObject({ status: 'queued', playbookRunId: null, queuePosition: 1, queueReason: 'project_limit' });
    expect(harness.calls.start).toBe(0);
  });

  it('VT-06 a repeated client request returns the same build and skips preflight', async () => {
    const harness = deps({ findReplay: async () => stored() });
    const result = await startBuild(command(), harness);
    expect(result).toMatchObject({ buildRunId: 'build-1', replayed: true });
    expect(harness.calls.preflight).toBe(0);
    expect(harness.calls.start).toBe(0);
  });

  it('VT-06 a repeated queued request reports its place and the current reason', async () => {
    const harness = deps({
      findReplay: async () => stored({ status: 'queued', playbookRunId: null, queuedAt: '2026-10-26T12:00:00.000Z' }),
    });
    const result = await startBuild(command(), harness);
    expect(result).toMatchObject({
      status: 'queued',
      replayed: true,
      queuePosition: 1,
      queueReason: 'platform_limit',
    });
  });

  it('VT-10 checks flag, allow-list, then preflight, and stops at the first failure', async () => {
    const off = deps({ isEnabled: async () => false });
    await expect(startBuild(command(), off)).rejects.toMatchObject({ code: 'BUILDS_DISABLED' });
    expect(off.calls.preflight).toBe(0);

    const blocked = deps({ isAllowed: async () => false });
    await expect(startBuild(command(), blocked)).rejects.toMatchObject({ code: 'BUILD_REPOSITORY_NOT_ALLOWED' });
    expect(blocked.calls.preflight).toBe(0);
  });

  it('VT-11 a Playbook limit marks the build failed and returns 409', async () => {
    const failed: string[] = [];
    const harness = deps({
      startRun: async () => { throw new PlaybookGuardViolationError('active-run-cap', 'cap'); },
      markFailed: async (id) => { failed.push(id); },
    });
    await expect(startBuild(command(), harness)).rejects.toBeInstanceOf(BuildStartError);
    await expect(startBuild(command(), harness)).rejects.toMatchObject({ status: 409, code: 'BUILD_PLAYBOOK_LIMIT' });
    expect(failed).toEqual(['build-1', 'build-1']);
    expect(harness.events.some((event) => event.eventType === 'build.start_failed')).toBe(true);
  });

  it('VT-38 event text never contains the prompt', async () => {
    const harness = deps();
    await startBuild(command({ prompt: 'secret-token hunter2' }), harness);
    expect(JSON.stringify(harness.events)).not.toContain('hunter2');
  });
});
