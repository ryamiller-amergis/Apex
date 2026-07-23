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

function makeNativeItem(text: string) {
  return {
    id: 'text-item-0',
    text,
    geometry: { x: 10, y: 20, width: 12, height: 3 },
    fontFamily: 'Helvetica' as const,
    fontSize: 10,
    bold: false,
    italic: false,
    rotation: 0,
    color: '#000000',
    backgroundColor: '#FFFFFF',
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

  it('commits replacement geometry and re-sampled cover as one undoable edit', () => {
    const replacement = makeOverlay(1, {
      kind: 'replace',
      backgroundColor: '#FFFFFF',
      width: 12,
      height: 3,
      color: '#17365D',
    });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [replacement] })
    );

    act(() => result.current.selectOverlay(replacement.id));
    act(() => {
      expect(result.current.beginGeometryEdit(replacement.id)).toBe(true);
      result.current.updateSelectedGeometry({
        x: 10,
        y: 10,
        width: 30,
        height: 15,
      });
      expect(result.current.commitGeometryEdit('resize', '#E8F0F8')).toBe(true);
    });

    expect(result.current.selectedOverlay).toMatchObject({
      width: 30,
      height: 15,
      backgroundColor: '#E8F0F8',
      color: '#17365D',
    });
    expect(result.current.isDirty).toBe(true);

    act(() => result.current.undo());
    expect(result.current.selectedOverlay).toMatchObject({
      width: 12,
      height: 3,
      backgroundColor: '#FFFFFF',
      color: '#17365D',
    });
  });

  it('keeps the previous cover when resize sampling fails', () => {
    const replacement = makeOverlay(1, {
      kind: 'replace',
      backgroundColor: '#FFFFFF',
      width: 12,
      height: 3,
      color: '#17365D',
    });
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [replacement] })
    );

    act(() => result.current.selectOverlay(replacement.id));
    act(() => {
      expect(result.current.beginGeometryEdit(replacement.id)).toBe(true);
      result.current.updateSelectedGeometry({
        x: 10,
        y: 10,
        width: 30,
        height: 15,
      });
      expect(result.current.commitGeometryEdit('resize')).toBe(true);
    });

    expect(result.current.selectedOverlay).toMatchObject({
      width: 30,
      height: 15,
      backgroundColor: '#FFFFFF',
      color: '#17365D',
    });
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

  it('copies inferred and sampled style into a local replacement draft', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => result.current.setEditorMode('replace'));
    act(() => {
      result.current.setReplacementDraft({
        id: 'text-item-0',
        text: 'Styled source',
        geometry: { x: 10, y: 20, width: 12, height: 3 },
        fontFamily: 'Times-Roman',
        fontSize: 17,
        bold: true,
        italic: true,
        rotation: -15,
        color: '#17365D',
        backgroundColor: '#F2EDE6',
      });
    });

    expect(result.current.replacementDraft).toMatchObject({
      text: 'Styled source',
      fontFamily: 'Times-Roman',
      fontSize: 17,
      bold: true,
      italic: true,
      rotation: -15,
      color: '#17365D',
      backgroundColor: '#F2EDE6',
    });
    expect(result.current.overlays).toEqual([]);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.canUndo).toBe(false);
  });

  it('keeps metadata fallback independent from color fallback values', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );

    act(() => result.current.setEditorMode('replace'));
    act(() => {
      result.current.setReplacementDraft({
        id: 'text-item-1',
        text: 'Monospace metadata',
        geometry: { x: 10, y: 20, width: 12, height: 2 },
        fontFamily: 'Courier',
        fontSize: 12,
        bold: false,
        italic: false,
        rotation: 0,
        color: '#000000',
        backgroundColor: '#FFFFFF',
      });
    });

    expect(result.current.replacementDraft).toMatchObject({
      fontFamily: 'Courier',
      color: '#000000',
      backgroundColor: '#FFFFFF',
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

  it('removeSelectedNativeText activates a local draft as cover-only', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );
    act(() => result.current.setEditorMode('replace'));
    act(() => {
      result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
    });
    act(() => {
      result.current.removeSelectedNativeText();
    });
    expect(result.current.selectedOverlay?.coverActive).toBe(true);
  });

  it('updateSelectedFormatting activates a local draft with the mutation', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );
    act(() => result.current.setEditorMode('replace'));
    act(() => {
      result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
    });
    expect(result.current.overlays).toEqual([]);
    act(() => {
      result.current.updateSelectedFormatting({ bold: true });
    });
    expect(result.current.selectedOverlay).toMatchObject({
      text: 'Sales Assistant',
      bold: true,
      coverActive: true,
    });
  });

  it('undo after formatting activation removes the replacement', () => {
    const { result } = renderHook(() =>
      useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
    );
    act(() => result.current.setEditorMode('replace'));
    act(() => {
      result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
    });
    act(() => {
      result.current.updateSelectedFormatting({ italic: true });
    });
    expect(result.current.selectedOverlay?.coverActive).toBe(true);
    act(() => {
      result.current.undo();
    });
    expect(result.current.overlays).toEqual([]);
  });

  describe('replacement draft workflow', () => {
    beforeEach(() => {
      jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        font: '',
        measureText: (value: string) => ({ width: value.length * 8 }),
      } as unknown as CanvasRenderingContext2D);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('native selection creates a draft separate from overlays and isDirty', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('May 2017'));
      });

      expect(result.current.replacementDraft).not.toBeNull();
      expect(result.current.replacementDraft!.text).toBe('May 2017');
      expect(result.current.overlays).toHaveLength(0);
      expect(result.current.isDirty).toBe(false);
      expect(result.current.canUndo).toBe(false);
    });

    it('selecting another native text replaces the previous draft', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('May 2017'));
      });
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });

      expect(result.current.replacementDraft!.text).toBe('Sales Assistant');
      expect(result.current.overlays).toHaveLength(0);
      expect(result.current.isDirty).toBe(false);
    });

    it('discardReplacementDraft clears draft without affecting overlays', () => {
      const existing = makeOverlay(1);
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('May 2017'));
      });
      act(() => {
        result.current.discardReplacementDraft();
      });

      expect(result.current.replacementDraft).toBeNull();
      expect(result.current.overlays).toHaveLength(1);
      expect(result.current.isDirty).toBe(false);
    });

    it('first text change activates exactly once into overlays', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        result.current.activateReplacementDraft('New replacement');
      });

      expect(result.current.replacementDraft).toBeNull();
      expect(result.current.overlays).toHaveLength(1);
      expect(result.current.overlays[0]).toMatchObject({
        kind: 'replace',
        text: 'New replacement',
        coverActive: true,
      });
      expect(result.current.isDirty).toBe(true);
      expect(result.current.canUndo).toBe(true);
      expect(result.current.selectedOverlayId).toBe(
        result.current.overlays[0].id
      );
    });

    it('first panel typing session produces one undo that removes the overlay', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        expect(result.current.beginReplacementTextEdit()).toBe(true);
        expect(result.current.updateReplacementText('S')).toBe(true);
      });
      act(() => {
        expect(result.current.updateReplacementText('Sales Manager')).toBe(
          true
        );
        expect(result.current.commitReplacementTextEdit()).toBe(true);
      });

      expect(result.current.overlays).toHaveLength(1);
      expect(result.current.overlays[0].text).toBe('Sales Manager');
      act(() => expect(result.current.undo()).toBe(true));
      expect(result.current.overlays).toEqual([]);
    });

    it('later panel edit undo restores the prior active overlay text', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        result.current.updateReplacementText('Sales Manager');
        result.current.commitReplacementTextEdit();
      });
      act(() => {
        expect(result.current.beginReplacementTextEdit()).toBe(true);
        expect(result.current.updateReplacementText('Sales Director')).toBe(
          true
        );
        expect(result.current.commitReplacementTextEdit()).toBe(true);
      });

      expect(result.current.overlays[0].text).toBe('Sales Director');
      act(() => expect(result.current.undo()).toBe(true));
      expect(result.current.overlays[0].text).toBe('Sales Manager');
    });

    it('first activation auto-fits geometry when page metrics provided', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft({
          ...makeNativeItem('A'),
          replacementBounds: { xMin: 8, xMax: 40, yMax: 40 },
        });
      });
      act(() => {
        result.current.updateReplacementText(
          'A much longer replacement text that should grow the box',
          200,
          200,
          1
        );
      });

      const overlay = result.current.overlays[0];
      expect(overlay.width).toBeGreaterThan(12);
      expect(overlay.text).toBe(
        'A much longer replacement text that should grow the box'
      );
      expect(overlay.replacementCover).toEqual({
        x: 10,
        y: 20,
        width: 12,
        height: 3,
      });
      expect(overlay.replacementBounds).toEqual({
        xMin: 8,
        xMax: 40,
        yMax: 40,
      });
      expect(overlay.x + overlay.width).toBeLessThanOrEqual(40);
    });

    it('subsequent panel edits auto-fit without adding overlays', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('A'));
      });
      act(() => {
        result.current.updateReplacementText('Longer text', 200, 200, 1);
      });
      const widthAfterFirst = result.current.overlays[0].width;
      act(() => {
        result.current.updateReplacementText(
          'Even much longer multi-word replacement',
          200,
          200,
          1
        );
      });

      expect(result.current.overlays).toHaveLength(1);
      expect(result.current.overlays[0].width).toBeGreaterThanOrEqual(
        widthAfterFirst
      );
    });

    it('repairs an oversized persisted replacement during a panel edit', () => {
      const oversized = makeOverlay(1, {
        kind: 'replace',
        text: 'Old replacement',
        width: 45,
        height: 30,
        backgroundColor: '#FFFFFF',
        coverActive: true,
      });
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [oversized] })
      );

      act(() => result.current.selectOverlay(oversized.id));
      act(() => expect(result.current.beginReplacementTextEdit()).toBe(true));
      act(() => {
        expect(
          result.current.updateReplacementText(
            'Regression tests: 16 client and 19 server passed.',
            600,
            800,
            1
          )
        ).toBe(true);
      });

      expect(result.current.overlays[0].height).toBeLessThan(30);
    });

    it('multiline text grows height via auto-fit', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('A'));
      });
      act(() => {
        result.current.updateReplacementText(
          'Line1\nLine2\nLine3',
          200,
          200,
          1
        );
      });

      const overlay = result.current.overlays[0];
      expect(overlay.height).toBeGreaterThan(3);
    });

    it('auto-fit never shrinks below original geometry', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        result.current.updateReplacementText('A', 200, 200, 1);
      });

      const overlay = result.current.overlays[0];
      expect(overlay.width).toBeGreaterThanOrEqual(12);
      expect(overlay.height).toBeGreaterThanOrEqual(3);
    });

    it('undo restores prior text and geometry together', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('A'));
      });
      act(() => {
        result.current.updateReplacementText('Short', 200, 200, 1);
        result.current.commitReplacementTextEdit();
      });
      const { width: w1, text: t1 } = result.current.overlays[0];
      act(() => {
        result.current.beginReplacementTextEdit();
        result.current.updateReplacementText(
          'Much much longer text here',
          200,
          200,
          1
        );
        result.current.commitReplacementTextEdit();
      });
      expect(result.current.overlays[0].width).toBeGreaterThan(w1);
      act(() => result.current.undo());
      expect(result.current.overlays[0].text).toBe(t1);
      expect(result.current.overlays[0].width).toBe(w1);
    });

    it('formatting mutation activates the draft with current style', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        result.current.activateReplacementDraft('Sales Assistant');
      });

      expect(result.current.overlays).toHaveLength(1);
      expect(result.current.overlays[0].coverActive).toBe(true);
      expect(result.current.isDirty).toBe(true);
    });

    it('remove text activates as cover-only immediately', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        result.current.activateReplacementDraft('');
      });

      expect(result.current.replacementDraft).toBeNull();
      expect(result.current.overlays).toHaveLength(1);
      expect(result.current.overlays[0]).toMatchObject({
        kind: 'replace',
        text: '',
        coverActive: true,
      });
      expect(result.current.isDirty).toBe(true);
    });

    it('first undo after activation removes the replacement entirely', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        result.current.activateReplacementDraft('Edited text');
      });
      expect(result.current.overlays).toHaveLength(1);

      act(() => {
        result.current.undo();
      });
      expect(result.current.overlays).toHaveLength(0);
      expect(result.current.isDirty).toBe(true);
    });

    it('active replacement edits remain autosavable via overlays', () => {
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('Sales Assistant'));
      });
      act(() => {
        result.current.activateReplacementDraft('First edit');
      });
      const id = result.current.overlays[0].id;
      act(() => {
        result.current.beginTextEdit(id);
        result.current.updateSelectedText('Second edit');
        result.current.commitTextEdit();
      });

      expect(result.current.overlays[0].text).toBe('Second edit');
      expect(result.current.isDirty).toBe(true);
    });

    it('unchanged close/discard leaves overlays untouched', () => {
      const existing = makeOverlay(1);
      const { result } = renderHook(() =>
        useOverlayEditor({ pageId: 'page-1', initialOverlays: [existing] })
      );
      act(() => result.current.setEditorMode('replace'));
      act(() => {
        result.current.setReplacementDraft(makeNativeItem('May 2017'));
      });
      act(() => {
        result.current.discardReplacementDraft();
      });

      expect(result.current.overlays).toEqual([existing]);
      expect(result.current.isDirty).toBe(false);
    });
  });
});
