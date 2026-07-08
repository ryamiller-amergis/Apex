import { renderHook, act } from '@testing-library/react';
import type { PageManifestEntry } from '../../../shared/types/pdf';

const mockMutate = jest.fn();

jest.mock('../usePdfSession', () => ({
  useUpdateManifest: () => ({ mutate: mockMutate }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: jest.fn(),
  }),
}));

import { usePageManipulation } from '../usePageManipulation';

function makeEntry(
  pageId: string,
  overrides: Partial<PageManifestEntry> = {},
): PageManifestEntry {
  return {
    pageId,
    fileId: 'file-1',
    sourcePageIndex: 0,
    rotation: 0,
    deleted: false,
    ...overrides,
  };
}

describe('usePageManipulation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const sessionId = 'sess-1';

  // VT-01: reorder(4, 1) produces correct order [A,E,B,C,D]
  it('reorder moves a page from one visible index to another', () => {
    const manifest = ['A', 'B', 'C', 'D', 'E'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.reorder(4, 1);
    });

    const ids = result.current.visiblePages.map((p) => p.pageId);
    expect(ids).toEqual(['A', 'E', 'B', 'C', 'D']);
  });

  // VT-03: rotate single page increments by 90
  it('rotate increments rotation by 90 degrees', () => {
    const manifest = [makeEntry('p1', { rotation: 0 })];

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.rotate(new Set(['p1']));
    });

    expect(result.current.localManifest[0].rotation).toBe(90);
  });

  // VT-04: rotate at 270 wraps to 0
  it('rotate wraps from 270 back to 0', () => {
    const manifest = [makeEntry('p1', { rotation: 270 })];

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.rotate(new Set(['p1']));
    });

    expect(result.current.localManifest[0].rotation).toBe(0);
  });

  // VT-05: rotate 5 selected pages
  it('rotate applies to all selected pages', () => {
    const manifest = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.rotate(new Set(['p1', 'p2', 'p3', 'p4', 'p5']));
    });

    for (const entry of result.current.localManifest) {
      expect(entry.rotation).toBe(90);
    }
  });

  // VT-07: delete marks entries as deleted
  it('deletePages marks selected pages as deleted', () => {
    const manifest = ['p1', 'p2', 'p3'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.deletePages(new Set(['p2']));
    });

    expect(result.current.localManifest[1].deleted).toBe(true);
    expect(result.current.visiblePages).toHaveLength(2);
    expect(result.current.visiblePages.map((p) => p.pageId)).toEqual(['p1', 'p3']);
  });

  // VT-10: delete blocked when only 1 non-deleted page remains
  it('deletePages blocks when deletion would remove all pages', () => {
    const manifest = [makeEntry('p1')];

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    let deleteResult: { blocked: boolean; message?: string };
    act(() => {
      deleteResult = result.current.deletePages(new Set(['p1']));
    });

    expect(deleteResult!.blocked).toBe(true);
    expect(deleteResult!.message).toMatch(/at least one page/i);
    expect(result.current.localManifest[0].deleted).toBe(false);
  });

  it('undoDelete restores previously deleted pages', () => {
    const manifest = ['p1', 'p2', 'p3'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.deletePages(new Set(['p2']));
    });

    expect(result.current.visiblePages).toHaveLength(2);

    act(() => {
      result.current.undoDelete();
    });

    expect(result.current.visiblePages).toHaveLength(3);
    expect(result.current.undoState).toBeNull();
  });

  it('reorder is a no-op when fromIndex equals toIndex', () => {
    const manifest = ['A', 'B', 'C'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.reorder(1, 1);
    });

    const ids = result.current.visiblePages.map((p) => p.pageId);
    expect(ids).toEqual(['A', 'B', 'C']);
  });

  it('does not auto-sync after reorder', () => {
    const manifest = ['A', 'B'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.reorder(0, 1);
    });

    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('saveNow triggers mutate immediately', () => {
    const manifest = ['A', 'B'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.reorder(0, 1);
    });

    act(() => {
      result.current.saveNow();
    });

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({
      sessionId,
      manifest: expect.any(Array),
    });
  });

  it('hasUnsavedChanges is true after local modification', () => {
    const manifest = ['A', 'B'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    expect(result.current.hasUnsavedChanges).toBe(false);

    act(() => {
      result.current.rotate(new Set(['A']));
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
  });

  it('hasUnsavedChanges is false after saveNow', () => {
    const manifest = ['A', 'B'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    act(() => {
      result.current.rotate(new Set(['A']));
    });

    expect(result.current.hasUnsavedChanges).toBe(true);

    act(() => {
      result.current.saveNow();
    });

    expect(result.current.hasUnsavedChanges).toBe(false);
  });
});
