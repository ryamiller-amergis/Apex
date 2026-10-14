import { flowToGraph, graphToFlow, positionsAfterDrag, syncBranchEdges } from '../playbookCanvasGraph';
import type { PlaybookGraph } from '../../../shared/types/playbook';

const graph: PlaybookGraph = {
  nodes: [
    { id: 'branch-1', stepType: 'branch', config: { whenTrue: 'notify-1', whenFalse: 'notify-2' } },
    { id: 'notify-1', stepType: 'notify' },
    { id: 'notify-2', stepType: 'notify' },
  ],
  edges: [
    { from: 'branch-1', to: 'notify-1' },
    { from: 'branch-1', to: 'notify-2' },
  ],
};

describe('positions after a drag', () => {
  const node = (id: string, x: number, y: number) => ({
    id,
    type: 'playbookStep',
    position: { x, y },
    data: { stepType: 'notify', label: id, config: {} },
  });

  it('keeps siblings when only the dropped node is reported', () => {
    expect(positionsAfterDrag(
      [node('a', 10, 20), node('b', 400, 20)],
      [node('a', 80, 90)],
    )).toEqual({
      a: { x: 80, y: 90 },
      b: { x: 400, y: 20 },
    });
  });
});

describe('playbook canvas branch edges', () => {
  it('stamps continuation names onto edges when the branch picker targets them', () => {
    const flow = graphToFlow(graph, {}, {});
    const saved = flowToGraph(flow.nodes, flow.edges);

    expect(saved.edges).toEqual([
      { from: 'branch-1', to: 'notify-1', condition: 'notify-1' },
      { from: 'branch-1', to: 'notify-2', condition: 'notify-2' },
    ]);
  });

  it('creates the two outbound edges from the picker when none have been drawn', () => {
    const next = syncBranchEdges({ ...graph, edges: [] });

    expect(next.edges).toEqual([
      { from: 'branch-1', to: 'notify-1', condition: 'notify-1' },
      { from: 'branch-1', to: 'notify-2', condition: 'notify-2' },
    ]);
  });

  it('keeps edges that do not leave the branch', () => {
    const next = syncBranchEdges({
      ...graph,
      edges: [{ from: 'notify-1', to: 'notify-2', condition: 'kept' }],
    });

    expect(next.edges).toEqual([
      { from: 'notify-1', to: 'notify-2', condition: 'kept' },
      { from: 'branch-1', to: 'notify-1', condition: 'notify-1' },
      { from: 'branch-1', to: 'notify-2', condition: 'notify-2' },
    ]);
  });
});
