type BindEndpoint = {
  id?: string;
  type?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isSkeletonLabel(value: unknown): boolean {
  return isRecord(value) && typeof value.text === 'string';
}

function isSkeletonBindEndpoint(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string';
}

/**
 * AI skeletons use `label` on shapes and `start`/`end` on arrows.
 * Persisted Excalidraw scenes use bound text elements and `points` / `startBinding`.
 */
function needsSkeletonConversion(elements: unknown[]): boolean {
  return elements.some((element) => {
    if (!isRecord(element)) {
      return false;
    }
    if (isSkeletonLabel(element.label)) {
      return true;
    }
    if (element.type !== 'arrow') {
      return false;
    }
    if (element.startBinding != null || element.endBinding != null) {
      return false;
    }
    return (
      isSkeletonBindEndpoint(element.start) ||
      isSkeletonBindEndpoint(element.end)
    );
  });
}

/**
 * Normalizes AI-generated Excalidraw skeletons before convertToExcalidrawElements.
 * Point-based arrows and edge labels fight bound rectangles and produce clipped or
 * floating text; bound endpoints let Excalidraw attach arrows to shape edges.
 */
export function normalizeDiagramElementsForConvert(
  elements: unknown[]
): unknown[] {
  return elements.map((element) => {
    if (!isRecord(element)) {
      return element;
    }
    const el = element;
    if (el.type !== 'arrow') {
      return element;
    }

    const {
      points: _points,
      width: _width,
      height: _height,
      label: _label,
      ...rest
    } = el;
    return {
      ...rest,
      start: normalizeBindEndpoint(el.start),
      end: normalizeBindEndpoint(el.end),
    };
  });
}

function normalizeBindEndpoint(endpoint: unknown): BindEndpoint | undefined {
  if (!isRecord(endpoint)) {
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
    opts?: { regenerateIds: boolean }
  ) => unknown[],
  elements: unknown[]
): unknown[] {
  if (!elements.length) {
    return [];
  }
  if (!needsSkeletonConversion(elements)) {
    return elements;
  }
  return convertToExcalidrawElements(
    normalizeDiagramElementsForConvert(elements) as never[],
    { regenerateIds: false }
  );
}
