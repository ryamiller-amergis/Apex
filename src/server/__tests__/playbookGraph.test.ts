import { playbookAuthorGraphsMatch } from '../../shared/utils/playbookGraph';
import type { PlaybookGraph } from '../../shared/types/playbook';

const draft: PlaybookGraph = {
  nodes: [{ id: 'ask', stepType: 'cursor-agent', config: { skillPath: 'skill.md' } }],
  edges: [],
};

it('ignores the contract version and frozen policy publish stamps onto a graph', () => {
  const published: PlaybookGraph = {
    nodes: [{
      id: 'ask',
      stepType: 'cursor-agent',
      stepTypeVersion: 1,
      agentPolicy: { schemaVersion: 1 } as PlaybookGraph['nodes'][number]['agentPolicy'],
      config: { skillPath: 'skill.md' },
    }],
    edges: [],
  };

  expect(playbookAuthorGraphsMatch(published, draft)).toBe(true);
});

it('still sees an author edit', () => {
  const edited: PlaybookGraph = {
    nodes: [{ id: 'ask', stepType: 'notify', config: { title: 'done' } }],
    edges: [],
  };

  expect(playbookAuthorGraphsMatch(edited, draft)).toBe(false);
});
