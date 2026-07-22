import { act, renderHook } from '@testing-library/react';
import type { OverlayTextBox } from '../../../shared/types/pdf';
import { useOverlayEditor } from '../useOverlayEditor';
import { MAX_SESSION_OVERLAYS } from '../overlayGeometry';

function makeOverlay(
  index: number,
  overrides: Partial<OverlayTextBox> = {}
): OverlayTextBox {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    pageId: 'page-1',
    x: 10,
    y: 10,
    width: 30,
    height: 10,
    text: `Box ${index}`,
    fontFamily: 'Helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    color: '#000000',
    horizontalAlign: 'left',
    verticalAlign: 'top',
    opacity: 100,
    rotation: 0,
    listStyle: 'none',
    zIndex: index,
    ...overrides,
  };
}

describe('useOverlayEditor', () => {
  // VT-01
  it('creates a default box at click percent when Text tool is active', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => {
      result.current.setTextToolActive(true);
    });

    let created: OverlayTextBox | null = null;
    act(() => {
      created = result.current.createAt(40, 40);
    });

    expect(created).not.toBeNull();
    expect(result.current.overlays).toHaveLength(1);
    expect(result.current.overlays[0]).toMatchObject({
      pageId: 'page-1',
      text: 'Text',
      width: 30,
      height: 10,
      x: 40,
      y: 40,
      fontFamily: 'Helvetica',
      fontSize: 10,
      zIndex: 1,
    });
    expect(result.current.selectedOverlayId).toBe(
      result.current.overlays[0].id
    );
    expect(result.current.isDirty).toBe(true);
  });

  // VT-02
  it('blocks create at the 50-box session limit', () => {
    const initial = Array.from({ length: MAX_SESSION_OVERLAYS }, (_, i) =>
      makeOverlay(i + 1)
    );
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: initial })
    );

    act(() => {
      result.current.setTextToolActive(true);
    });

    act(() => {
      expect(result.current.createAt(20, 20)).toBeNull();
    });

    expect(result.current.overlays).toHaveLength(MAX_SESSION_OVERLAYS);
    expect(result.current.createLimitMessage).toMatch(/50 text boxes/i);
  });

  // VT-03
  it('clamps a default box created near the page edge', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => {
      result.current.setTextToolActive(true);
    });

    act(() => {
      result.current.createAt(98, 98);
    });

    const box = result.current.overlays[0];
    expect(box.x + box.width).toBeLessThanOrEqual(100);
    expect(box.y + box.height).toBeLessThanOrEqual(100);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
  });

  // VT-04
  it('does not create when Text tool is inactive', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => {
      expect(result.current.createAt(50, 50)).toBeNull();
    });

    expect(result.current.overlays).toHaveLength(0);
    expect(result.current.isDirty).toBe(false);
  });

  // VT-05
  it('deletes the selected box and records undo', () => {
    const existing = makeOverlay(1);
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => {
      result.current.selectOverlay(existing.id);
    });

    act(() => {
      expect(result.current.deleteSelected()).toBe(true);
    });

    expect(result.current.overlays).toHaveLength(0);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.selectedOverlayId).toBeNull();
  });

  // VT-06
  it('no-ops delete when nothing is selected', () => {
    const existing = makeOverlay(1);
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => {
      expect(result.current.deleteSelected()).toBe(false);
    });

    expect(result.current.overlays).toHaveLength(1);
    expect(result.current.createLimitMessage).toBeNull();
  });

  // VT-07
  it('clears pageIdsWithOverlays when the last box on a page is deleted', () => {
    const existing = makeOverlay(1, { pageId: 'page-1' });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    expect(result.current.pageIdsWithOverlays.has('page-1')).toBe(true);

    act(() => {
      result.current.selectOverlay(existing.id);
      result.current.deleteSelected();
    });

    expect(result.current.pageIdsWithOverlays.has('page-1')).toBe(false);
  });

  // VT-08
  it('undo restores a deleted box with prior content and style', () => {
    const existing = makeOverlay(1, {
      text: 'Keep me',
      color: '#FF0000',
      bold: true,
    });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => {
      result.current.selectOverlay(existing.id);
      result.current.deleteSelected();
    });

    act(() => {
      expect(result.current.undo()).toBe(true);
    });

    expect(result.current.overlays).toHaveLength(1);
    expect(result.current.overlays[0]).toMatchObject({
      id: existing.id,
      text: 'Keep me',
      color: '#FF0000',
      bold: true,
    });
  });

  it('assigns top z-index for the page on create', () => {
    const initial = [
      makeOverlay(1, { zIndex: 3 }),
      makeOverlay(2, { zIndex: 7, pageId: 'page-2' }),
    ];
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: initial })
    );

    act(() => {
      result.current.setTextToolActive(true);
      result.current.createAt(10, 10);
    });

    const created = result.current.overlays.find((o) => o.text === 'Text');
    expect(created?.zIndex).toBe(4);
  });

  it('commits one undo step for a completed move', () => {
    const existing = makeOverlay(1, { x: 20, y: 20 });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => result.current.selectOverlay(existing.id));
    act(() => {
      expect(result.current.beginGeometryEdit(existing.id)).toBe(true);
      result.current.updateSelectedGeometry({
        x: 35,
        y: 25,
        width: 30,
        height: 10,
      });
      expect(result.current.commitGeometryEdit('move')).toBe(true);
    });

    expect(result.current.overlays[0]).toMatchObject({ x: 35, y: 25 });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.isDirty).toBe(true);

    act(() => result.current.undo());
    expect(result.current.overlays[0]).toMatchObject({ x: 20, y: 20 });
  });

  it('nudges by the requested step and clamps on-page', () => {
    const existing = makeOverlay(1, { x: 69, width: 30 });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => {
      result.current.selectOverlay(existing.id);
      result.current.nudgeSelected(5, 0);
    });

    expect(result.current.overlays[0].x).toBe(70);
  });

  it('swaps adjacent z-order on the active page and preserves other pages', () => {
    const low = makeOverlay(1, { zIndex: 1 });
    const middle = makeOverlay(2, { zIndex: 2 });
    const high = makeOverlay(3, { zIndex: 3 });
    const otherPage = makeOverlay(4, { pageId: 'page-2', zIndex: 2 });
    const { result } = renderHook(() =>
      useOverlayEditor({
        pageId: 'page-1',
        initialOverlays: [low, middle, high, otherPage],
      })
    );

    act(() => {
      result.current.selectOverlay(middle.id);
      expect(result.current.sendSelectedBackward()).toBe(true);
    });

    expect(
      result.current.overlays.find((o) => o.id === middle.id)?.zIndex
    ).toBe(1);
    expect(result.current.overlays.find((o) => o.id === low.id)?.zIndex).toBe(
      2
    );
    expect(
      result.current.overlays.find((o) => o.id === otherPage.id)?.zIndex
    ).toBe(2);
  });

  it('no-ops bring forward when the selected box is already top-most', () => {
    const existing = makeOverlay(1, { zIndex: 5 });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => {
      result.current.selectOverlay(existing.id);
      expect(result.current.bringSelectedForward()).toBe(false);
    });

    expect(result.current.overlays[0].zIndex).toBe(5);
    expect(result.current.announcement).toBe('Already on top');
  });

  it('updates selected formatting and marks overlays dirty', () => {
    const existing = makeOverlay(1);
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => {
      result.current.selectOverlay(existing.id);
      expect(
        result.current.updateSelectedFormatting({
          fontFamily: 'Times-Roman',
          fontSize: 24,
          bold: true,
          color: '#FF0000',
          horizontalAlign: 'center',
        })
      ).toBe(true);
    });

    expect(result.current.selectedOverlay).toMatchObject({
      fontFamily: 'Times-Roman',
      fontSize: 24,
      bold: true,
      color: '#FF0000',
      horizontalAlign: 'center',
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.canUndo).toBe(true);
  });

  it('updates text during edit and records one undo step on commit', () => {
    const existing = makeOverlay(1, { text: 'Original' });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
    );

    act(() => {
      result.current.selectOverlay(existing.id);
      expect(result.current.beginTextEdit(existing.id)).toBe(true);
      expect(result.current.updateSelectedText('First draft')).toBe(true);
      expect(result.current.updateSelectedText('Final text')).toBe(true);
    });

    expect(result.current.selectedOverlay?.text).toBe('Final text');
    expect(result.current.isDirty).toBe(true);
    expect(result.current.canUndo).toBe(false);

    act(() => expect(result.current.commitTextEdit()).toBe(true));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.announcement).toBe('Editing finished');

    act(() => expect(result.current.undo()).toBe(true));
    expect(result.current.selectedOverlay?.text).toBe('Original');
  });

  it('undoes move then add, and redoes both operations', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => {
      result.current.setTextToolActive(true);
      result.current.createAt(10, 10);
    });
    const createdId = result.current.overlays[0].id;
    act(() => {
      result.current.selectOverlay(createdId);
      result.current.beginGeometryEdit(createdId);
      result.current.updateSelectedGeometry({
        x: 40,
        y: 30,
        width: 30,
        height: 10,
      });
      result.current.commitGeometryEdit('move');
    });

    act(() => expect(result.current.undo()).toBe(true));
    expect(result.current.overlays[0]).toMatchObject({ x: 10, y: 10 });
    act(() => expect(result.current.undo()).toBe(true));
    expect(result.current.overlays).toEqual([]);
    expect(result.current.canRedo).toBe(true);

    act(() => expect(result.current.redo()).toBe(true));
    expect(result.current.overlays[0]).toMatchObject({ x: 10, y: 10 });
    act(() => expect(result.current.redo()).toBe(true));
    expect(result.current.overlays[0]).toMatchObject({ x: 40, y: 30 });
    expect(result.current.canRedo).toBe(false);
  });

  it('silently no-ops empty undo and redo stacks', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => {
      expect(result.current.undo()).toBe(false);
      expect(result.current.redo()).toBe(false);
    });

    expect(result.current.overlays).toEqual([]);
    expect(result.current.announcement).toBe('');
  });

  it('clears redo after a new forward edit', () => {
    const first = makeOverlay(1);
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [first] })
    );

    act(() => {
      result.current.selectOverlay(first.id);
      result.current.updateSelectedFormatting({ bold: true });
      result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.updateSelectedFormatting({ italic: true }));
    expect(result.current.canRedo).toBe(false);
    act(() => expect(result.current.redo()).toBe(false));
  });

  it('caps undo history at 50 completed operations', () => {
    const first = makeOverlay(1, { x: 0, width: 30 });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [first] })
    );
    act(() => result.current.selectOverlay(first.id));

    for (let index = 0; index < 51; index += 1) {
      act(() => {
        result.current.nudgeSelected(1, 0);
      });
    }

    let undoCount = 0;
    for (let index = 0; index < 51; index += 1) {
      act(() => {
        if (result.current.undo()) undoCount += 1;
      });
    }
    expect(undoCount).toBe(50);
    expect(result.current.overlays[0].x).toBe(1);
  });

  it('clears history when the Assembly Session changes', () => {
    const first = makeOverlay(1);
    const { result, rerender } = renderHook(
      ({ historyKey, overlays }) =>
        useOverlayEditor({
          pageId: 'page-1',
          initialOverlays: overlays,
          historyKey,
        }),
      {
        initialProps: {
          historyKey: 'session-1',
          overlays: [first],
        },
      }
    );
    act(() => {
      result.current.selectOverlay(first.id);
      result.current.updateSelectedFormatting({ bold: true });
    });
    expect(result.current.canUndo).toBe(true);

    rerender({ historyKey: 'session-2', overlays: [] });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('adopts authoritative overlays and clears local history after a conflict', () => {
    const local = makeOverlay(1);
    const server = makeOverlay(2, { text: 'Saved in another tab' });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [local] })
    );
    act(() => {
      result.current.selectOverlay(local.id);
      result.current.updateSelectedFormatting({ bold: true });
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.isDirty).toBe(true);

    act(() => result.current.replaceFromServer([server]));

    expect(result.current.overlays).toEqual([server]);
    expect(result.current.selectedOverlayId).toBeNull();
    expect(result.current.isDirty).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undo()).toBe(false);
  });

  it('creates one replacement overlay from one selected PDF text item', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => result.current.setEditorMode('replace'));
    act(() => {
      result.current.createReplacement({
        text: 'Individual item',
        geometry: { x: 10, y: 20, width: 12, height: 2 },
        fontSize: 12,
        rotation: 0,
      });
    });

    expect(result.current.overlays).toHaveLength(1);
    expect(result.current.selectedOverlay).toMatchObject({
      text: 'Individual item',
      kind: 'replace',
      backgroundColor: '#FFFFFF',
      verticalAlign: 'top',
      x: 10,
      y: 20,
      width: 12,
      height: 2,
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.canUndo).toBe(true);
  });

  it('uses a sampled background color when provided for replacements', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => result.current.setEditorMode('replace'));
    act(() => {
      result.current.createReplacement({
        text: 'Tinted',
        geometry: { x: 10, y: 20, width: 12, height: 2 },
        fontSize: 12,
        rotation: 0,
        backgroundColor: '#F2EDE6',
      });
    });

    expect(result.current.selectedOverlay).toMatchObject({
      kind: 'replace',
      backgroundColor: '#F2EDE6',
      verticalAlign: 'top',
    });
  });

  it('keeps add and replacement tools mutually exclusive', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => result.current.setTextToolActive(true));
    act(() => result.current.setEditorMode('replace'));
    expect(result.current.textToolActive).toBe(false);
    expect(result.current.editorMode).toBe('replace');

    act(() => result.current.setTextToolActive(true));
    expect(result.current.textToolActive).toBe(true);
    expect(result.current.editorMode).toBe('add');
  });

  it('removes original PDF text by retaining an empty replacement cover', () => {
    const replacement = makeOverlay(1, {
      kind: 'replace',
      backgroundColor: '#FFFFFF',
      text: 'Original PDF text',
    });
    const { result } = renderHook(() =>
      useOverlayEditor({
        pageId: 'page-1',
        initialOverlays: [replacement],
      })
    );

    act(() => result.current.selectOverlay(replacement.id));
    act(() => expect(result.current.removeSelectedNativeText()).toBe(true));

    expect(result.current.selectedOverlay).toMatchObject({
      id: replacement.id,
      kind: 'replace',
      backgroundColor: '#FFFFFF',
      text: '',
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.canUndo).toBe(true);
  });
});
