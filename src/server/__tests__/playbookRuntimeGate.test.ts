/**
 * FEAT-008 Wave 3 S7 — execution-time side-effect reclassification guard.
 *
 * The workflow builders are tiny doubles so these tests exercise the generated step body without
 * loading Mastra or its Postgres store. Publication-time behavior belongs to playbookGuards.test;
 * this suite proves the runtime asks that current-registry rule at the last boundary before an
 * adapter can run, and maps its one recoverable violation into the engine's suspension path.
 */
import fs from 'fs';
import path from 'path';
import type { PlaybookGraph } from '../../shared/types/playbook';

const beginStepRun = jest.fn();
const completeStepRunIfOpen = jest.fn();
const executeStep = jest.fn();
const failStepRun = jest.fn();
const failStepRunForHuman = jest.fn();

jest.mock('../services/playbookSteps', () => ({
  beginStepRun: (...args: unknown[]) => beginStepRun(...args),
  completeStepRunIfOpen: (...args: unknown[]) => completeStepRunIfOpen(...args),
  executeStep: (...args: unknown[]) => executeStep(...args),
  failStepRun: (...args: unknown[]) => failStepRun(...args),
  failStepRunForHuman: (...args: unknown[]) => failStepRunForHuman(...args),
}));

jest.mock('../services/playbookStepBindings', () => ({
  resolveRunStepConfig: jest.fn(async (_runId: string, config: Record<string, unknown>) => ({
    ...config,
    __resolved: true,
  })),
}));

// The gate rule is real and reads the production registry; only its unused database dependency is
// replaced. This is what makes VT-17 a current-classification conformance scenario.
jest.mock('../db/drizzle', () => ({ db: {} }));

import { assertStepGateSatisfied } from '../services/playbookGuardService';
import {
  armWorkflowId,
  engineResumeStep,
  retryStepRunOnEngine,
  translate,
} from '../services/playbookEngine/runtime';
import { owningLoop } from '../services/playbookLoopCursor';

const context = {
  runId: 'run-1',
  project: 'Apex',
  initiatorUserId: 'user-1',
};

const ungatedGraph: PlaybookGraph = {
  nodes: [
    { id: 'prepare', stepType: 'notify', config: { title: 'Ready' } },
    {
      id: 'external',
      stepType: 'cursor-agent',
      config: { skillPath: '.cursor/skills/app-knowledge/SKILL.md', prompt: 'Review' },
    },
  ],
  edges: [{ from: 'prepare', to: 'external' }],
};

const gatedGraph: PlaybookGraph = {
  nodes: [
    { id: 'approve', stepType: 'approval-gate', config: {} },
    {
      id: 'external',
      stepType: 'cursor-agent',
      config: { skillPath: '.cursor/skills/app-knowledge/SKILL.md', prompt: 'Review' },
    },
  ],
  edges: [{ from: 'approve', to: 'external' }],
};

type GeneratedStep = {
  id: string;
  execute: (input: { resumeData?: unknown; suspend: jest.Mock }) => Promise<unknown>;
};

function translatedSteps(graph: PlaybookGraph): GeneratedStep[] {
  const steps: GeneratedStep[] = [];
  const makeWorkflow = () => {
    const workflow: {
      then: jest.Mock;
      branch: jest.Mock;
      parallel: jest.Mock;
      commit: jest.Mock;
    } = {
      then: jest.fn((step: GeneratedStep) => {
        steps.push(step);
        return workflow;
      }),
      parallel: jest.fn((arms: unknown[]) => {
        for (const arm of arms) {
          if (arm && typeof arm === 'object' && 'id' in arm) steps.push(arm as GeneratedStep);
        }
        return workflow;
      }),
      branch: jest.fn((pairs: Array<[unknown, GeneratedStep | { committed: boolean }]>) => {
        for (const [, target] of pairs) {
          if (target && 'id' in target) steps.push(target);
        }
        return workflow;
      }),
      commit: jest.fn(() => ({ committed: true })),
    };
    return workflow;
  };
  const modules = {
    createStep: jest.fn((...args: unknown[]) => args[0]),
    createWorkflow: jest.fn((..._args: unknown[]) => makeWorkflow()),
    Mastra: class {
      constructor(..._args: unknown[]) {}
    },
    PostgresStore: class {
      constructor(..._args: unknown[]) {}
    },
  };

  translate(graph, context, modules);
  return steps;
}

function externalStep(graph: PlaybookGraph): GeneratedStep {
  const step = translatedSteps(graph).find((candidate) => candidate.id === 'external');
  if (!step) throw new Error('The test graph did not produce its external step');
  return step;
}

beforeEach(() => {
  jest.clearAllMocks();
  beginStepRun.mockResolvedValue({ id: 'step-run-external' });
  executeStep.mockResolvedValue({ kind: 'completed', output: { agentRunId: 'agent-1' } });
  failStepRunForHuman.mockResolvedValue(true);
  completeStepRunIfOpen.mockResolvedValue(undefined);
});

describe('FEAT-008 S7 — runtime reclassification guard', () => {
  it('VT-17 — refuses a type published as writes-apex but currently ungated leaves-apex', async () => {
    let violation: Error | undefined;
    try {
      assertStepGateSatisfied(ungatedGraph, 'external');
    } catch (error) {
      violation = error as Error;
    }
    expect(violation?.message).toContain('external');
    const suspend = jest.fn().mockResolvedValue({ suspended: 'external' });

    await expect(externalStep(ungatedGraph).execute({ suspend })).resolves.toEqual({
      suspended: 'external',
    });

    expect(beginStepRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      stepId: 'external',
      stepType: 'cursor-agent',
      inputInline: expect.objectContaining({ __resolved: true }),
    }));
    expect(executeStep).not.toHaveBeenCalled();
    expect(failStepRunForHuman).toHaveBeenCalledWith({
      stepRunId: 'step-run-external',
      reason: violation?.message,
    });
    expect(failStepRun).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledWith({ stepId: 'external' });
  });

  it('VT-18 — parks once and does not retry the violating step automatically', async () => {
    const suspend = jest.fn().mockResolvedValue({ suspended: 'external' });

    await externalStep(ungatedGraph).execute({ suspend });

    expect(beginStepRun).toHaveBeenCalledTimes(1);
    expect(failStepRunForHuman).toHaveBeenCalledTimes(1);
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('TBI-037 VT-17 — retry re-runs the current ungated guard before adapter dispatch', async () => {
    const outcome = await retryStepRunOnEngine(
      ungatedGraph,
      context,
      'step-run-external',
      'external'
    );

    expect(outcome.endedAs).toBe('failed');
    expect((outcome.error as Error).message).toContain('external');
    expect(executeStep).not.toHaveBeenCalled();
  });

  it('VT-19 — leaves an already-completed old step untouched on resumeData', async () => {
    const suspend = jest.fn();

    await expect(
      externalStep(ungatedGraph).execute({ resumeData: { stepId: 'external' }, suspend })
    ).resolves.toEqual({ stepId: 'external' });

    expect(beginStepRun).not.toHaveBeenCalled();
    expect(executeStep).not.toHaveBeenCalled();
    expect(failStepRunForHuman).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
  });

  it('VT-20 — executes a currently leaves-apex step when the pinned graph gates it', async () => {
    const suspend = jest.fn();

    await expect(externalStep(gatedGraph).execute({ suspend })).resolves.toEqual(
      expect.objectContaining({ stepId: 'external' }),
    );

    expect(executeStep).toHaveBeenCalledTimes(1);
    expect(executeStep).toHaveBeenCalledWith(expect.objectContaining({
      config: {
        skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        prompt: 'Review',
      },
    }));
    expect(failStepRunForHuman).not.toHaveBeenCalled();
    expect(completeStepRunIfOpen).toHaveBeenCalledWith({
      stepRunId: 'step-run-external',
      output: { agentRunId: 'agent-1' },
    });
  });

  it('VT-21 — keeps every Mastra schema permissive and every Mastra import in the wrapper', () => {
    const runtimePath = path.resolve(
      __dirname,
      '../services/playbookEngine/runtime.ts'
    );
    const source = fs.readFileSync(runtimePath, 'utf8');

    for (const slot of ['inputSchema', 'resumeSchema', 'suspendSchema', 'outputSchema']) {
      expect(source).toMatch(new RegExp(`${slot}: z\\.any\\(\\)`));
    }
    expect(source.match(/'@mastra\/[^']+'/g)?.sort()).toEqual([
      "'@mastra/core'",
      "'@mastra/core/workflows'",
      "'@mastra/pg'",
    ]);
  });
});

describe('branch translation keeps arm successors', () => {
  const branched: PlaybookGraph = {
    nodes: [
      {
        id: 'choose',
        stepType: 'branch',
        config: {
          condition: { sourceStepId: 'choose', field: 'isReady', operator: 'eq', value: true },
          whenTrue: 'ready',
          whenFalse: 'revise',
        },
      },
      { id: 'ready', stepType: 'approval-gate', config: {} },
      { id: 'after-ready', stepType: 'notify', config: { title: 'Filed' } },
      { id: 'revise', stepType: 'notify', config: { title: 'Revise' } },
    ],
    edges: [
      { from: 'choose', to: 'ready', condition: 'ready' },
      { from: 'choose', to: 'revise', condition: 'revise' },
      { from: 'ready', to: 'after-ready' },
    ],
  };

  const leafArms: PlaybookGraph = {
    nodes: [
      {
        id: 'choose',
        stepType: 'branch',
        config: {
          condition: { sourceStepId: 'choose', field: 'isReady', operator: 'eq', value: true },
          whenTrue: 'ready',
          whenFalse: 'revise',
        },
      },
      { id: 'ready', stepType: 'approval-gate', config: {} },
      { id: 'revise', stepType: 'notify', config: { title: 'Revise' } },
    ],
    edges: [
      { from: 'choose', to: 'ready', condition: 'ready' },
      { from: 'choose', to: 'revise', condition: 'revise' },
    ],
  };

  it('registers steps after each branch target instead of stopping at the split', () => {
    const ids = translatedSteps(branched).map((step) => step.id);
    expect(ids).toEqual(expect.arrayContaining(['choose', 'ready', 'after-ready', 'revise']));
  });

  it('resumes a one-step arm by Apex node id so a parked gate after a split can wake', () => {
    expect(engineResumeStep(leafArms, 'run-1', 'ready')).toBe('ready');
    expect(engineResumeStep(leafArms, 'run-1', 'revise')).toBe('revise');
  });

  it('resumes nested arm successors with the Mastra path, not the node id alone', () => {
    expect(engineResumeStep(branched, 'run-1', 'ready')).toEqual([
      armWorkflowId('run-1', 'ready'),
      'ready',
    ]);
    expect(engineResumeStep(branched, 'run-1', 'after-ready')).toEqual([
      armWorkflowId('run-1', 'ready'),
      'after-ready',
    ]);
    expect(engineResumeStep(branched, 'run-1', 'revise')).toBe('revise');
  });
});

describe('parallel translation keeps every arm step and the join', () => {
  const parallel: PlaybookGraph = {
    nodes: [
      { id: 'split', stepType: 'notify', config: { title: 'Split' }, parallel: true },
      { id: 'left', stepType: 'notify', config: { title: 'Left' } },
      { id: 'left-2', stepType: 'notify', config: { title: 'Left 2' } },
      { id: 'right', stepType: 'notify', config: { title: 'Right' } },
      { id: 'join-1', stepType: 'join', config: { predecessors: ['left-2', 'right'], policy: 'all' } },
      { id: 'after', stepType: 'notify', config: { title: 'After' } },
    ],
    edges: [
      { from: 'split', to: 'left' },
      { from: 'split', to: 'right' },
      { from: 'left', to: 'left-2' },
      { from: 'left-2', to: 'join-1' },
      { from: 'right', to: 'join-1' },
      { from: 'join-1', to: 'after' },
    ],
  };

  it('registers the second step of an arm and the steps after the join', () => {
    const ids = translatedSteps(parallel).map((step) => step.id);
    expect(ids).toEqual(expect.arrayContaining(['split', 'left', 'left-2', 'right', 'join-1', 'after']));
  });

  it('resumes a nested arm step by its workflow path and the join by its node id', () => {
    expect(engineResumeStep(parallel, 'run-1', 'left-2')).toEqual([
      armWorkflowId('run-1', 'left'),
      'left-2',
    ]);
    expect(engineResumeStep(parallel, 'run-1', 'right')).toEqual([
      armWorkflowId('run-1', 'right'),
      'right',
    ]);
    expect(engineResumeStep(parallel, 'run-1', 'join-1')).toBe('join-1');
    expect(engineResumeStep(parallel, 'run-1', 'after')).toBe('after');
  });
});

describe('loop translation repeats the body', () => {
  const looped: PlaybookGraph = {
    nodes: [
      { id: 'loop', stepType: 'foreach', config: { items: ['a', 'b'], maxIterations: 2 } },
      { id: 'work', stepType: 'notify', config: { title: 'Work' } },
      { id: 'join-1', stepType: 'join', config: { predecessors: ['work'], policy: 'all' } },
      { id: 'after', stepType: 'notify', config: { title: 'After' } },
    ],
    edges: [
      { from: 'loop', to: 'work' },
      { from: 'work', to: 'join-1' },
      { from: 'join-1', to: 'after' },
    ],
  };

  it('registers one body step per allowed iteration and leaves the join outside', () => {
    const ids = translatedSteps(looped).map((step) => step.id);
    expect(ids).toEqual(['loop', 'work', 'work#1', 'join-1', 'after']);
  });

  it('resumes a later iteration by that iteration id', () => {
    expect(engineResumeStep(looped, 'run-1', 'work#1')).toBe('work#1');
  });

  it('finds the foreach that owns a body step', () => {
    expect(owningLoop(looped, 'work#1')).toEqual({ loopId: 'loop', kind: 'foreach', index: 1 });
    expect(owningLoop(looped, 'after')).toBeNull();
  });
});
