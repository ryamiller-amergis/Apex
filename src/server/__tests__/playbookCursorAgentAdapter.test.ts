/**
 * TBI-017 — the `cursor-agent` adapter.
 *
 * Covers VT-09 (enqueue with the right class and initiator, correlation written, step suspended),
 * VT-10 (a rejected enqueue leaves no correlation row) and VT-12 (it returns in the same tick, with
 * no await on completion). VT-11 — kill the process after enqueue and find the step still
 * suspended — needs a real database and a real process, so it lives in the integration suite.
 *
 * VT-12 is the one worth reading carefully. "Does not await completion" is not directly observable,
 * so it is approached from two sides: the agent run is never resolved during the call, and the
 * adapter's source contains no await on anything that would settle only when the run finishes.
 */
const enqueue = jest.fn();
jest.mock('../services/agentRunLifecycleService', () => ({ enqueue: (...a: unknown[]) => enqueue(...a) }));

const createThread = jest.fn();
jest.mock('../services/chatAgentService', () => ({ createThread: (...a: unknown[]) => createThread(...a) }));

const getSkillConfig = jest.fn();
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: (...a: unknown[]) => getSkillConfig(...a),
}));

// Stubbed so that pulling in the real stepRuns module below does not open a database connection.
jest.mock('../db/drizzle', () => ({ db: {} }));

const suspendStepRun = jest.fn().mockResolvedValue(undefined);
const failStepRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/playbookSteps/stepRuns', () => ({
  ...jest.requireActual('../services/playbookSteps/stepRuns'),
  suspendStepRun: (...a: unknown[]) => suspendStepRun(...a),
  failStepRun: (...a: unknown[]) => failStepRun(...a),
}));

import fs from 'fs';
import path from 'path';
import { executeCursorAgentStep } from '../services/playbookSteps/cursorAgentAdapter';
import { PHASE_0_ALLOWED_AGENT_SKILLS } from '../services/playbookSteps/registry';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

const INITIATOR = 'initiator-oid';
const ALLOWED_SKILL = PHASE_0_ALLOWED_AGENT_SKILLS[0];

function context(
  overrides: Partial<Record<string, unknown>> = {}
): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'draft',
    stepType: 'cursor-agent',
    project: 'Apex',
    initiatorUserId: INITIATOR,
    config: { skillPath: ALLOWED_SKILL, prompt: 'Summarise the design docs', ...overrides },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  createThread.mockResolvedValue({ id: 'thread-1', workspaceDir: '/tmp/threads/thread-1' });
  getSkillConfig.mockResolvedValue({
    skillRepo: 'apex/ai-pilot',
    skillBranch: 'main',
    skillProvider: 'github',
    defaultModel: 'claude-4',
  });
  enqueue.mockResolvedValue({ runId: 'agent-run-1' });
});

describe('VT-09 — enqueue, correlate, suspend', () => {
  it('enqueues on the background lane as the run initiator', async () => {
    await executeCursorAgentStep(context());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const input = enqueue.mock.calls[0][0];
    expect(input.lane).toBe('background');
    expect(input.projectId).toBe('Apex');
    expect(input.snapshot.workflowClass).toBe('playbook-step');
    expect(input.snapshot.skillPath).toBe(ALLOWED_SKILL);
    // BR-003: the thread is created as the initiator, so the run acts as them.
    expect(createThread.mock.calls[0][0]).toBe(INITIATOR);
  });

  it('creates its own thread and never starts a turn on it', async () => {
    await executeCursorAgentStep(context());

    // Thread-per-step: chat_threads.active_run_id holds one run, so a shared thread would collide
    // the moment two agent steps ran at once.
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(createThread.mock.calls[0][2]).toEqual({ skipAutoKickoff: true });
  });

  it('writes the correlation from the id enqueue returned, and suspends', async () => {
    const outcome = await executeCursorAgentStep(context());

    expect(suspendStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ stepRunId: 'step-run-1', agentRunId: 'agent-run-1' })
    );
    expect(outcome).toMatchObject({ kind: 'suspended', agentRunId: 'agent-run-1' });
  });

  it('gives the step a later deadline than the agent run it watches', async () => {
    const outcome = await executeCursorAgentStep(context());

    const agentTimeout = Date.parse(enqueue.mock.calls[0][0].timeoutAt);
    const stepDeadline = Date.parse(
      (outcome as { kind: 'suspended'; expiresAt: string }).expiresAt
    );

    // Otherwise the sweep could expire a step in the same instant its agent run went terminal, and
    // the same event would read as "expired" or "failed" depending on which won.
    expect(stepDeadline).toBeGreaterThan(agentTimeout);
  });

  it('refuses a Skill outside the allow-list before creating anything', async () => {
    await expect(
      executeCursorAgentStep(context({ skillPath: '.cursor/skills/build-test-push/SKILL.md' }))
    ).rejects.toThrow(/may not run Skill/);

    // The refusal has to cost nothing. Validating after the thread exists would mean cleaning up.
    expect(createThread).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
describe('VT-10 — a rejected enqueue leaves nothing dangling', () => {
  it('writes no correlation row and fails the step', async () => {
    enqueue.mockRejectedValue(new Error('admission refused'));

    await expect(executeCursorAgentStep(context())).rejects.toThrow('admission refused');

    expect(suspendStepRun).not.toHaveBeenCalled();
    expect(failStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ stepRunId: 'step-run-1', reason: 'admission refused' })
    );
  });
});
describe('VT-12 — it does not wait for the agent', () => {
  it('returns without the agent run ever settling', async () => {
    let agentFinished = false;
    // Stands in for the agent run: a promise that never settles. If the adapter awaited completion
    // in any form, the call below could not return. A pending promise rather than a timer, so the
    // test does not leave the event loop alive after it passes.
    const agentRunNeverFinishes = new Promise<void>(() => {});
    enqueue.mockImplementation(async () => {
      void agentRunNeverFinishes.then(() => {
        agentFinished = true;
      });
      return { runId: 'agent-run-1' };
    });

    const outcome = await executeCursorAgentStep(context());

    expect(outcome.kind).toBe('suspended');
    expect(agentFinished).toBe(false);
  });

  it('contains no await on agent-run completion in its source', () => {
    /*
     * The behavioural test above proves the adapter returns; it cannot prove that nobody later adds
     * a "just wait a moment for the result" await that happens to resolve quickly in tests. This
     * reads the file. Crude, and the crudeness is the point: the rule is about what the code may
     * contain, not only what it currently does.
     */
    const source = fs.readFileSync(
      path.resolve(__dirname, '../services/playbookSteps/cursorAgentAdapter.ts'),
      'utf8'
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const forbidden of [
      'waitForAgentRun',
      'awaitCompletion',
      'pollUntil',
      'getAgentRunResult',
      'onTerminal',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
