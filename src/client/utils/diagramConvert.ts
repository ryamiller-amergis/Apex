type BindEndpoint = {
  id?: string;
  type?: string;
};

/**
 * Normalizes AI-generated Excalidraw skeletons before convertToExcalidrawElements.
 * Point-based arrows and edge labels fight bound rectangles and produce clipped or
 * floating text; bound endpoints let Excalidraw attach arrows to shape edges.
 */
export function normalizeDiagramElementsForConvert(elements: unknown[]): unknown[] {
  return elements.map((element) => {
    if (!element || typeof element !== 'object') {
      return element;
    }
    const el = element as Record<string, unknown>;
    if (el.type !== 'arrow') {
      return element;
    }

    const { points: _points, width: _width, height: _height, label: _label, ...rest } = el;
    return {
      ...rest,
      start: normalizeBindEndpoint(el.start),
      end: normalizeBindEndpoint(el.end),
    };
  });
}

function normalizeBindEndpoint(endpoint: unknown): BindEndpoint | undefined {
  if (!endpoint || typeof endpoint !== 'object') {
    return undefined;
  }
  const value = endpoint as BindEndpoint;
  if (typeof value.id !== 'string') {
    return value;
  }
  return {
    ...value,
    type: value.type ?? 'rectangle',
  };
}

export function convertDiagramElements(
  convertToExcalidrawElements: (
    skeleton: unknown[] | null,
    opts?: { regenerateIds: boolean },
  ) => unknown[],
  elements: unknown[],
): unknown[] {
  if (!elements.length) {
    return [];
  }
  return convertToExcalidrawElements(
    normalizeDiagramElementsForConvert(elements) as never[],
    { regenerateIds: false },
  );
}
