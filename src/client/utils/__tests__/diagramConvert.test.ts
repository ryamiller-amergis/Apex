import { normalizeDiagramElementsForConvert } from '../diagramConvert';

describe('normalizeDiagramElementsForConvert', () => {
  it('strips point geometry and edge labels from arrows with bind endpoints', () => {
    const normalized = normalizeDiagramElementsForConvert([
      {
        type: 'rectangle',
        id: 'ai-node-a',
        x: 0,
        y: 0,
        label: { text: 'Alpha' },
      },
      {
        type: 'arrow',
        id: 'ai-arrow-0',
        x: 10,
        y: 10,
        width: 50,
        height: 20,
        points: [[0, 0], [50, 20]],
        label: { text: 'creates' },
        start: { id: 'ai-node-a' },
        end: { id: 'ai-node-b' },
        endArrowhead: 'arrow',
      },
    ]);

    const arrow = normalized[1] as {
      points?: unknown;
      width?: unknown;
      label?: unknown;
      start?: { id?: string; type?: string };
    };
    expect(arrow.points).toBeUndefined();
    expect(arrow.width).toBeUndefined();
    expect(arrow.label).toBeUndefined();
    expect(arrow.start).toEqual({ id: 'ai-node-a', type: 'rectangle' });
  });
});
