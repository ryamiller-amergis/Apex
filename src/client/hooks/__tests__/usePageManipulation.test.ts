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

  // VT-10b: delete blocked when selecting ALL pages in a multi-page document
  it('deletePages blocks when all visible pages are selected for deletion', () => {
    const manifest = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    let deleteResult: { blocked: boolean; message?: string };
    act(() => {
      deleteResult = result.current.deletePages(new Set(['p1', 'p2', 'p3', 'p4', 'p5']));
    });

    expect(deleteResult!.blocked).toBe(true);
    expect(deleteResult!.message).toMatch(/at least one page/i);
    expect(result.current.visiblePages).toHaveLength(5);
    expect(result.current.localManifest.every((p) => !p.deleted)).toBe(true);
  });

  // VT-10c: delete allowed for all-but-one selection (regression check)
  it('deletePages succeeds when at least one page remains', () => {
    const manifest = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => makeEntry(id));

    const { result } = renderHook(() =>
      usePageManipulation({ sessionId, serverManifest: manifest }),
    );

    let deleteResult: { blocked: boolean; message?: string };
    act(() => {
      deleteResult = result.current.deletePages(new Set(['p1', 'p2', 'p3', 'p4']));
    });

    expect(deleteResult!.blocked).toBe(false);
    expect(result.current.visiblePages).toHaveLength(1);
    expect(result.current.visiblePages[0].pageId).toBe('p5');
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

  describe('reorderAndSync (drag-and-drop)', () => {
    // AC#1: drag page 5 to position 2 — page moves, positions update, syncs to server
    it('moves page from position 5 to position 2 and syncs to server', () => {
      const manifest = ['A', 'B', 'C', 'D', 'E'].map((id) => makeEntry(id));

      const { result } = renderHook(() =>
        usePageManipulation({ sessionId, serverManifest: manifest }),
      );

      act(() => {
        result.current.reorderAndSync(4, 1);
      });

      const ids = result.current.visiblePages.map((p) => p.pageId);
      expect(ids).toEqual(['A', 'E', 'B', 'C', 'D']);
      expect(mockMutate).toHaveBeenCalledTimes(1);
      expect(mockMutate).toHaveBeenCalledWith(
        { sessionId, manifest: expect.any(Array) },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      );
    });

    // AC#2: server sync fails — reverts to last synced state and shows error
    it('reverts to last synced state on server error', () => {
      const manifest = ['A', 'B', 'C', 'D', 'E'].map((id) => makeEntry(id));

      const { result } = renderHook(() =>
        usePageManipulation({ sessionId, serverManifest: manifest }),
      );

      act(() => {
        result.current.reorderAndSync(4, 1);
      });

      // UI is optimistically updated
      expect(result.current.visiblePages.map((p) => p.pageId)).toEqual(['A', 'E', 'B', 'C', 'D']);

      // Simulate server error via the onError callback
      const mutateCall = mockMutate.mock.calls[0];
      const options = mutateCall[1];
      act(() => {
        options.onError(new Error('Network error'));
      });

      // Should revert to original order
      const ids = result.current.visiblePages.map((p) => p.pageId);
      expect(ids).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(result.current.reorderSyncError).toMatch(/failed to save/i);
    });

    // AC#2: error dismissal clears the error
    it('dismissReorderSyncError clears the error message', () => {
      const manifest = ['A', 'B', 'C'].map((id) => makeEntry(id));

      const { result } = renderHook(() =>
        usePageManipulation({ sessionId, serverManifest: manifest }),
      );

      act(() => {
        result.current.reorderAndSync(0, 2);
      });

      const options = mockMutate.mock.calls[0][1];
      act(() => {
        options.onError(new Error('fail'));
      });

      expect(result.current.reorderSyncError).not.toBeNull();

      act(() => {
        result.current.dismissReorderSyncError();
      });

      expect(result.current.reorderSyncError).toBeNull();
    });

    // AC#3: single page — reorder is a no-op when from === to
    it('is a no-op when fromIndex equals toIndex (single page case)', () => {
      const manifest = [makeEntry('A')];

      const { result } = renderHook(() =>
        usePageManipulation({ sessionId, serverManifest: manifest }),
      );

      act(() => {
        result.current.reorderAndSync(0, 0);
      });

      expect(mockMutate).not.toHaveBeenCalled();
      expect(result.current.visiblePages.map((p) => p.pageId)).toEqual(['A']);
    });

    // AC#1: successful sync updates lastSynced
    it('updates lastSynced on success so refresh shows new order', () => {
      const manifest = ['A', 'B', 'C'].map((id) => makeEntry(id));

      const { result } = renderHook(() =>
        usePageManipulation({ sessionId, serverManifest: manifest }),
      );

      act(() => {
        result.current.reorderAndSync(2, 0);
      });

      const options = mockMutate.mock.calls[0][1];
      act(() => {
        options.onSuccess();
      });

      // After success, hasUnsavedChanges should be false
      expect(result.current.hasUnsavedChanges).toBe(false);
    });

    // AC#4: refresh shows last synced order (serverManifest update resets local)
    it('resets to serverManifest on prop change (simulates refresh)', () => {
      const manifest = ['A', 'B', 'C'].map((id) => makeEntry(id));

      const { result, rerender } = renderHook(
        ({ serverManifest }) => usePageManipulation({ sessionId, serverManifest }),
        { initialProps: { serverManifest: manifest } },
      );

      act(() => {
        result.current.reorder(0, 2);
      });

      expect(result.current.visiblePages.map((p) => p.pageId)).toEqual(['B', 'C', 'A']);

      // Simulate refresh — server returns the synced order
      const refreshedManifest = ['C', 'A', 'B'].map((id) => makeEntry(id));
      rerender({ serverManifest: refreshedManifest });

      expect(result.current.visiblePages.map((p) => p.pageId)).toEqual(['C', 'A', 'B']);
    });
  });
});
