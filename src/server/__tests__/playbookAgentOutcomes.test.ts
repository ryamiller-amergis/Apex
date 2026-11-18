jest.mock('../db/drizzle', () => ({ db: {} }));

import type { PlaybookGraph, PlaybookGraphNode } from '../../shared/types/playbook';
import { extractOutcome, promptWithOutcomes } from '../services/playbookSteps/agentOutcome';
import {
  evaluateBranchCondition,
  validateBranchCondition,
} from '../services/playbookSteps/branchConditionEvaluator';
import { getStepTypeDescriptor } from '../services/playbookSteps/registry';

describe('agent outcomes', () => {
  it('asks for an outcome line only when the step lists outcomes', () => {
    expect(promptWithOutcomes('Fix it.', undefined)).toBe('Fix it.');
    expect(promptWithOutcomes('Fix it.', ['fixed', 'needs info'])).toContain(
      'OUTCOME: <one of: fixed | needs info>',
    );
  });

  it('reads the last outcome line and removes it from the reply', () => {
    expect(extractOutcome('The cache key was stale.\n\n**OUTCOME:** Needs info.')).toEqual({
      outcome: 'needs info',
      text: 'The cache key was stale.',
    });
    expect(extractOutcome('No outcome here.')).toEqual({ text: 'No outcome here.' });
  });

  it('only accepts two to eight different, lowercase outcomes', () => {
    const { inputSchema } = getStepTypeDescriptor('cursor-agent');
    const parse = (outcomes: unknown) => inputSchema.safeParse({ prompt: 'p', outcomes }).success;
    expect(parse(['fixed', 'no issue'])).toBe(true);
    expect(parse(['fixed'])).toBe(false);
    expect(parse(['fixed', 'fixed'])).toBe(false);
    expect(parse(['Fixed', 'no issue'])).toBe(false);
  });
});

describe('branch tests', () => {
  const outputs = { agent: { output: 'The Cache key was stale', outcome: 'fixed', pr: null } };

  it('matches text that contains the words, ignoring capitals', () => {
    expect(evaluateBranchCondition(
      { sourceStepId: 'agent', field: 'output', operator: 'contains', value: 'cache KEY' },
      outputs,
    )).toBe(true);
  });

  it('tells a value apart from an empty one', () => {
    expect(evaluateBranchCondition({ sourceStepId: 'agent', field: 'outcome', operator: 'exists' }, outputs)).toBe(true);
    expect(evaluateBranchCondition({ sourceStepId: 'agent', field: 'pr', operator: 'missing' }, outputs)).toBe(true);
    expect(evaluateBranchCondition({ sourceStepId: 'agent', field: 'nothing', operator: 'exists' }, outputs)).toBe(false);
  });
});

describe('publishing a branch on an agent outcome', () => {
  function graph(agentConfig: Record<string, unknown>, value: unknown): { graph: PlaybookGraph; branch: PlaybookGraphNode } {
    const branch: PlaybookGraphNode = {
      id: 'route',
      stepType: 'branch',
      config: {
        condition: { sourceStepId: 'agent', field: 'outcome', operator: 'eq', value },
        whenTrue: 'yes',
        whenFalse: 'no',
      },
    };
    return {
      branch,
      graph: {
        nodes: [
          { id: 'agent', stepType: 'cursor-agent', config: { prompt: 'p', ...agentConfig } },
          branch,
          { id: 'yes', stepType: 'notify', config: { title: 'Yes' } },
          { id: 'no', stepType: 'notify', config: { title: 'No' } },
        ],
        edges: [
          { from: 'agent', to: 'route' },
          { from: 'route', to: 'yes', condition: 'yes' },
          { from: 'route', to: 'no', condition: 'no' },
        ],
      },
    };
  }

  it('accepts an outcome the agent step lists', () => {
    const { graph: g, branch } = graph({ outcomes: ['fixed', 'no issue'] }, 'fixed');
    expect(() => validateBranchCondition(g, branch)).not.toThrow();
  });

  it('refuses an outcome the agent step does not list', () => {
    const { graph: g, branch } = graph({ outcomes: ['fixed', 'no issue'] }, 'wontfix');
    expect(() => validateBranchCondition(g, branch)).toThrow(/not one of that step's outcomes/);
  });

  it('refuses a branch on outcome when the agent step lists none', () => {
    const { graph: g, branch } = graph({}, 'fixed');
    expect(() => validateBranchCondition(g, branch)).toThrow(/lists no outcomes/);
  });
});
