import { renderHook, act } from '@testing-library/react';
import { useBreakpoint } from '../useBreakpoint';

// ── matchMedia mock helpers ─────────────────────────────────────────────────────

type ChangeHandler = (e: { matches: boolean }) => void;

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  addListener: jest.Mock;
  removeListener: jest.Mock;
  onchange: null;
  dispatchEvent: jest.Mock;
}

const listeners = new Map<string, ChangeHandler>();

function createMockMql(query: string, matches: boolean): MockMediaQueryList {
  return {
    matches,
    media: query,
    addEventListener: jest.fn((event: string, handler: ChangeHandler) => {
      if (event === 'change') listeners.set(query, handler);
    }),
    removeEventListener: jest.fn((event: string, handler: ChangeHandler) => {
      if (event === 'change' && listeners.get(query) === handler) {
        listeners.delete(query);
      }
    }),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  };
}

function setupMatchMedia(mobileMatches: boolean, tabletMatches: boolean) {
  listeners.clear();

  window.matchMedia = jest.fn((query: string) => {
    if (query === '(max-width: 768px)') {
      return createMockMql(query, mobileMatches) as unknown as MediaQueryList;
    }
    if (query === '(min-width: 769px) and (max-width: 1024px)') {
      return createMockMql(query, tabletMatches) as unknown as MediaQueryList;
    }
    return createMockMql(query, false) as unknown as MediaQueryList;
  });
}

function fireMediaChange(query: string, matches: boolean) {
  const handler = listeners.get(query);
  if (handler) handler({ matches });
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('useBreakpoint', () => {
  afterEach(() => {
    listeners.clear();
    jest.restoreAllMocks();
  });

  it('returns isMobile: true when width <= 768px', () => {
    setupMatchMedia(true, false);

    const { result } = renderHook(() => useBreakpoint());

    expect(result.current.isMobile).toBe(true);
    expect(result.current.isTablet).toBe(false);
    expect(result.current.isDesktop).toBe(false);
  });

  it('returns isTablet: true when width is 769-1024px', () => {
    setupMatchMedia(false, true);

    const { result } = renderHook(() => useBreakpoint());

    expect(result.current.isMobile).toBe(false);
    expect(result.current.isTablet).toBe(true);
    expect(result.current.isDesktop).toBe(false);
  });

  it('returns isDesktop: true when width > 1024px', () => {
    setupMatchMedia(false, false);

    const { result } = renderHook(() => useBreakpoint());

    expect(result.current.isMobile).toBe(false);
    expect(result.current.isTablet).toBe(false);
    expect(result.current.isDesktop).toBe(true);
  });

  it('responds to mobile media query change events', () => {
    setupMatchMedia(false, false);

    const { result } = renderHook(() => useBreakpoint());

    expect(result.current.isDesktop).toBe(true);

    act(() => {
      fireMediaChange('(max-width: 768px)', true);
    });

    expect(result.current.isMobile).toBe(true);
    expect(result.current.isDesktop).toBe(false);
  });

  it('responds to tablet media query change events', () => {
    setupMatchMedia(false, false);

    const { result } = renderHook(() => useBreakpoint());

    expect(result.current.isDesktop).toBe(true);

    act(() => {
      fireMediaChange('(min-width: 769px) and (max-width: 1024px)', true);
    });

    expect(result.current.isTablet).toBe(true);
    expect(result.current.isDesktop).toBe(false);
  });

  it('cleans up event listeners on unmount', () => {
    setupMatchMedia(false, false);

    const { unmount } = renderHook(() => useBreakpoint());

    // matchMedia is called in useState initializers (indices 0,1) and useEffect (indices 2,3).
    // addEventListener is called on the useEffect instances.
    const matchMediaCalls = (window.matchMedia as jest.Mock).mock.results;
    const mobileQuery = matchMediaCalls[2].value as MockMediaQueryList;
    const tabletQuery = matchMediaCalls[3].value as MockMediaQueryList;

    expect(mobileQuery.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(tabletQuery.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    unmount();

    expect(mobileQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(tabletQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('uses addEventListener, not the deprecated addListener', () => {
    setupMatchMedia(false, false);

    renderHook(() => useBreakpoint());

    const matchMediaCalls = (window.matchMedia as jest.Mock).mock.results;
    const mobileQuery = matchMediaCalls[2].value as MockMediaQueryList;
    const tabletQuery = matchMediaCalls[3].value as MockMediaQueryList;

    expect(mobileQuery.addEventListener).toHaveBeenCalled();
    expect(tabletQuery.addEventListener).toHaveBeenCalled();
    expect(mobileQuery.addListener).not.toHaveBeenCalled();
    expect(tabletQuery.addListener).not.toHaveBeenCalled();
  });
});
