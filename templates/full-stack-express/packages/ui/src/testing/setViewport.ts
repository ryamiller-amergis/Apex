type Listener = (event: MediaQueryListEvent) => void;

interface ViewportPreferences {
  prefersDark?: boolean;
}

function evaluate(
  query: string,
  width: number,
  preferences: ViewportPreferences
): boolean {
  const conditions = query
    .replace(/^@media\s*/i, '')
    .split(/\s+and\s+/i)
    .map((part) => part.trim().replace(/^\(|\)$/g, ''));
  return conditions.every((condition) => {
    const [rawFeature = '', rawValue = ''] = condition.split(':');
    const feature = rawFeature.trim();
    const value = rawValue.trim();
    if (feature === 'min-width') {
      return width >= Number.parseFloat(value);
    }
    if (feature === 'max-width') {
      return width <= Number.parseFloat(value);
    }
    if (feature === 'prefers-color-scheme') {
      return (value === 'dark') === Boolean(preferences.prefersDark);
    }
    return false;
  });
}

/**
 * Test helper: sets `window.innerWidth` and replaces `window.matchMedia` with
 * an evaluator for `min-width`, `max-width`, and `prefers-color-scheme`.
 */
export function setViewport(
  width: number,
  preferences: ViewportPreferences = {}
): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const listeners = new Set<Listener>();
      return {
        matches: evaluate(query, width, preferences),
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: Listener) => {
          listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: Listener) => {
          listeners.delete(listener);
        },
        addListener: (listener: Listener) => {
          listeners.add(listener);
        },
        removeListener: (listener: Listener) => {
          listeners.delete(listener);
        },
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    },
  });
}
