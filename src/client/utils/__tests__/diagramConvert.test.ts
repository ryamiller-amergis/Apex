import {
  convertDiagramElements,
  normalizeDiagramElementsForConvert,
} from '../diagramConvert';

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
        points: [
          [0, 0],
          [50, 20],
        ],
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

describe('convertDiagramElements', () => {
  const convert = jest.fn((skeleton: unknown[] | null) => skeleton ?? []);

  beforeEach(() => {
    convert.mockClear();
  });

  it('leaves persisted live arrows unchanged so saved scenes keep path and bindings', () => {
    const liveArrow = {
      type: 'arrow',
      id: 'arrow-1',
      x: 10,
      y: 20,
      width: 80,
      height: 40,
      points: [
        [0, 0],
        [80, 40],
      ],
      startBinding: { elementId: 'rect-a', focus: 0, gap: 1 },
      endBinding: { elementId: 'rect-b', focus: 0, gap: 1 },
    };
    const elements = [
      { type: 'rectangle', id: 'rect-a', x: 0, y: 0, seed: 1 },
      liveArrow,
    ];

    const result = convertDiagramElements(convert, elements);

    expect(convert).not.toHaveBeenCalled();
    expect(result).toBe(elements);
    expect(result[1]).toEqual(liveArrow);
  });

  it('still converts AI skeleton arrows via normalize + convertToExcalidrawElements', () => {
    const skeleton = [
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
        points: [
          [0, 0],
          [50, 20],
        ],
        start: { id: 'ai-node-a' },
        end: { id: 'ai-node-b' },
      },
    ];

    convertDiagramElements(convert, skeleton);

    expect(convert).toHaveBeenCalledTimes(1);
    const passed = convert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(passed[1].points).toBeUndefined();
    expect(passed[1].start).toEqual({ id: 'ai-node-a', type: 'rectangle' });
  });
});
