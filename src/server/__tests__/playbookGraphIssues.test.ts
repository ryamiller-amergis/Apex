/**
 * `collectGraphIssues` reports every problem in a graph, each on the step or connection it belongs
 * to. Publish stops at the first problem; this is what an author fixing a draft reads instead.
 */
jest.mock('../db/drizzle', () => ({ db: {} }));

import type { PlaybookGraph } from '../../shared/types/playbook';
import {
  PlaybookGuardViolationError,
  assertGraphWithinGuards,
  collectGraphIssues,
} from '../services/playbookGuardService';

const SKILL_PATH = '.cursor/skills/app-knowledge/SKILL.md';

const VALID: PlaybookGraph = {
  nodes: [
    {
      id: 'a',
      stepType: 'cursor-agent',
      title: 'Do the work',
      config: { skillPath: SKILL_PATH, prompt: 'Do the work.', mcpProfile: 'repository-read-only' },
    },
    { id: 'b', stepType: 'notify', title: 'Say it is done', config: { title: 'Done' } },
  ],
  edges: [{ from: 'a', to: 'b' }],
};

describe('collectGraphIssues', () => {
  it('reports nothing for a graph publish would accept', () => {
    expect(collectGraphIssues(VALID)).toEqual([]);
  });

  it('asks for a title on a work step but not on a flow step', () => {
    const graph: PlaybookGraph = {
      nodes: [
        { ...VALID.nodes[0], title: '  ' },
        { id: 'b', stepType: 'join', config: {} },
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const titleIssues = collectGraphIssues(graph).filter((issue) => issue.message.includes('title'));
    expect(titleIssues).toEqual([{ kind: 'graph', nodeId: 'a', message: 'Give step "a" a title.' }]);
  });

  it('keeps going after the first problem and names the step each one is on', () => {
    const issues = collectGraphIssues({
      nodes: [
        { id: 'mystery', stepType: 'not-a-step' },
        { id: 'announce', stepType: 'notify', config: {} },
      ],
      edges: [],
    });

    expect(issues.map((issue) => issue.nodeId)).toEqual(expect.arrayContaining(['mystery', 'announce']));
    expect(issues.every((issue) => issue.kind === 'graph')).toBe(true);
  });

  it('puts a branch that reads a missing step on the branch', () => {
    const issues = collectGraphIssues({
      nodes: [
        {
          id: 'ingest',
          stepType: 'ingest-artifact',
          config: { documentType: 'design_doc', documentId: 'd', validationThreadId: 't' },
        },
        {
          id: 'branch-1',
          stepType: 'branch',
          config: {
            condition: { sourceStepId: 'approval-1', field: 'decision', operator: 'eq', value: 'approved' },
            whenTrue: 'ingest',
            whenFalse: 'ingest',
          },
        },
      ],
      edges: [{ from: 'ingest', to: 'branch-1' }],
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        nodeId: 'branch-1',
        kind: 'branch',
        message: expect.stringContaining('"approval-1.decision"'),
      }),
    );
  });

  it('checks a connector like any other step', () => {
    const issues = collectGraphIssues({
      nodes: [{ id: 'link', stepType: 'connector', config: { integration: 'slack', operation: 'send' } }],
      edges: [],
    });

    expect(issues).toContainEqual(expect.objectContaining({ nodeId: 'link', kind: 'graph' }));
  });

  it('marks a connection that ends at a missing step on that connection', () => {
    const issues = collectGraphIssues({
      nodes: [{ id: 'b', stepType: 'notify', config: { title: 'Done' } }],
      edges: [{ from: 'b', to: 'ghost' }],
    });

    expect(issues).toContainEqual(
      expect.objectContaining({ nodeId: 'b', edge: { from: 'b', to: 'ghost' } }),
    );
  });

  it('flags an agent step that is not read-only as a capability problem', () => {
    const issues = collectGraphIssues({
      nodes: [
        { id: 'a', stepType: 'cursor-agent', config: { skillPath: SKILL_PATH, prompt: 'Go.', mcpProfile: 'ado-skills' } },
      ],
      edges: [],
    });

    expect(issues).toContainEqual(expect.objectContaining({ nodeId: 'a', kind: 'capability' }));
  });

  it('names each step in a loop and in a step with too many inbound paths', () => {
    const issues = collectGraphIssues({
      nodes: [
        { id: 'x', stepType: 'notify', config: { title: 'x' } },
        { id: 'y', stepType: 'notify', config: { title: 'y' } },
      ],
      edges: [
        { from: 'x', to: 'y' },
        { from: 'y', to: 'x' },
      ],
    });

    expect(issues.map((issue) => issue.message).join('\n')).toMatch(/loop/);
  });
});

describe('publish guard', () => {
  it('refuses a connection to a step that is not in the graph, and says which', () => {
    const graph: PlaybookGraph = {
      nodes: [{ id: 'b', stepType: 'notify', config: { title: 'Done' } }],
      edges: [{ from: 'b', to: 'ghost' }],
    };

    let thrown: unknown;
    try {
      assertGraphWithinGuards(graph);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PlaybookGuardViolationError);
    expect((thrown as PlaybookGuardViolationError).nodeId).toBe('b');
    expect((thrown as PlaybookGuardViolationError).edge).toEqual({ from: 'b', to: 'ghost' });
  });
});
