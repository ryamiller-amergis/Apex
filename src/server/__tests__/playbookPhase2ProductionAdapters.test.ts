import type { PlaybookGraph } from '../../shared/types/playbook';
import {
  CURSOR_AGENT_DEADLINE_MS,
  getStepTypeDescriptor,
  resolveDeadlineMs,
} from '../services/playbookSteps/registry';
import {
  evaluateBranchCondition,
  validateBranchCondition,
} from '../services/playbookSteps/branchConditionEvaluator';

describe('Phase 2 production adapter contracts', () => {
  it('keeps the derived cursor default and accepts an explicit shorter deadline', () => {
    expect(CURSOR_AGENT_DEADLINE_MS).toBe(5_000 * 720);
    expect(resolveDeadlineMs('cursor-agent')).toBe(CURSOR_AGENT_DEADLINE_MS);
    expect(resolveDeadlineMs('cursor-agent', 20 * 60 * 1000)).toBe(20 * 60 * 1000);
  });

  it('registers ingest-artifact and branch with their production classifications', () => {
    expect(getStepTypeDescriptor('ingest-artifact')).toMatchObject({
      canSuspend: false,
      sideEffect: 'writes-apex',
      requiredPermissions: ['design-docs:review', 'prds:review'],
    });
    expect(getStepTypeDescriptor('branch')).toMatchObject({
      canSuspend: false,
      sideEffect: 'read',
      requiredPermissions: ['playbooks:view'],
    });
  });

  it('validates and evaluates a named prior output field through one evaluator', () => {
    const graph: PlaybookGraph = {
      nodes: [
        { id: 'ingest', stepType: 'ingest-artifact', config: {
          documentType: 'design_doc',
          documentId: 'a',
          validationThreadId: 't',
          scorecard: {},
        } },
        { id: 'choose', stepType: 'branch', config: {
          condition: {
            sourceStepId: 'ingest',
            field: 'isReady',
            operator: 'eq',
            value: true,
          },
          whenTrue: 'ready',
          whenFalse: 'revise',
        } },
        { id: 'ready', stepType: 'notify', config: { title: 'Ready' } },
        { id: 'revise', stepType: 'notify', config: { title: 'Revise' } },
      ],
      edges: [
        { from: 'ingest', to: 'choose' },
        { from: 'choose', to: 'ready', condition: 'ready' },
        { from: 'choose', to: 'revise', condition: 'revise' },
      ],
    };

    expect(() => validateBranchCondition(graph, graph.nodes[1])).not.toThrow();
    expect(evaluateBranchCondition(
      (graph.nodes[1].config as any).condition,
      { ingest: { isReady: true } },
    )).toBe(true);

    (graph.nodes[1].config as any).condition.field = 'undeclared';
    expect(() => validateBranchCondition(graph, graph.nodes[1])).toThrow(
      /choose.*ingest.*undeclared/s,
    );
  });
});
