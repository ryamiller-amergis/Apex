import { fireEvent, render, screen } from '@testing-library/react';
import type { OverlayTextBox } from '../../../shared/types/pdf';
import { OverlayTextLayer } from '../OverlayTextLayer';
import { ManipulationToolbar } from '../ManipulationToolbar';

const baseOverlay: OverlayTextBox = {
  id: '00000000-0000-4000-8000-000000000001',
  pageId: 'page-1',
  x: 10,
  y: 20,
  width: 30,
  height: 10,
  text: 'Text',
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
  zIndex: 1,
};

describe('Overlay create/delete chrome', () => {
  it('creates a replacement from exactly one selected PDF.js text item', () => {
    const replacement = {
      ...baseOverlay,
      text: 'Existing word',
      kind: 'replace' as const,
      backgroundColor: '#FFFFFF',
    };
    const onCreateReplacement = jest.fn().mockReturnValue(replacement);
    const onExitReplacementMode = jest.fn();

    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[]}
          selectedOverlayId={null}
          textToolActive={false}
          replacementMode
          nativeTextItems={[
            {
              id: 'text-item-0',
              text: 'Existing word',
              geometry: { x: 10, y: 20, width: 12, height: 2 },
              fontSize: 12,
              rotation: 0,
            },
          ]}
          createLimitMessage={null}
          announcement=""
          canUndo={false}
          onCreateAt={jest.fn()}
          onCreateReplacement={onCreateReplacement}
          onExitReplacementMode={onExitReplacementMode}
          onSelect={jest.fn()}
          onDeleteSelected={jest.fn()}
          onUndo={jest.fn()}
          onBeginTextEdit={() => true}
        />
      </div>
    );

    fireEvent.click(screen.getByTestId('native-text-item'));

    expect(onCreateReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'text-item-0',
        text: 'Existing word',
      })
    );
    expect(onExitReplacementMode).toHaveBeenCalledTimes(1);
  });

  // VT-09
  it('opens page editing and places a box when Add text is active', () => {
    const onEditPage = jest.fn();
    const onCreateAt = jest.fn().mockReturnValue(baseOverlay);

    const { rerender } = render(
      <>
        <ManipulationToolbar
          selectedCount={0}
          onRotate={jest.fn()}
          onDelete={jest.fn()}
          onMoveUp={jest.fn()}
          onMoveDown={jest.fn()}
          canMoveUp={false}
          canMoveDown={false}
          totalPages={1}
          onEditPage={onEditPage}
        />
        <div style={{ position: 'relative', width: 200, height: 200 }}>
          <OverlayTextLayer
            pageId="page-1"
            overlays={[]}
            selectedOverlayId={null}
            textToolActive={false}
            createLimitMessage={null}
            announcement=""
            canUndo={false}
            onCreateAt={onCreateAt}
            onSelect={jest.fn()}
            onDeleteSelected={jest.fn()}
            onUndo={jest.fn()}
            onBeginTextEdit={() => true}
          />
        </div>
      </>
    );

    const editPage = screen.getByTestId('toolbar-edit-page');
    fireEvent.click(editPage);
    expect(onEditPage).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <ManipulationToolbar
          selectedCount={0}
          onRotate={jest.fn()}
          onDelete={jest.fn()}
          onMoveUp={jest.fn()}
          onMoveDown={jest.fn()}
          canMoveUp={false}
          canMoveDown={false}
          totalPages={1}
          onEditPage={onEditPage}
        />
        <div style={{ position: 'relative', width: 200, height: 200 }}>
          <OverlayTextLayer
            pageId="page-1"
            overlays={[baseOverlay]}
            selectedOverlayId={baseOverlay.id}
            textToolActive={true}
            createLimitMessage={null}
            announcement="Text box added"
            canUndo={true}
            onCreateAt={onCreateAt}
            onSelect={jest.fn()}
            onDeleteSelected={jest.fn()}
            onUndo={jest.fn()}
            onBeginTextEdit={() => true}
          />
        </div>
      </>
    );

    expect(screen.getByTestId('pdf-tools-overlay-box')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-tools-overlay-box')).toHaveAttribute(
      'data-overlay-id',
      baseOverlay.id
    );
    fireEvent.click(screen.getByTestId('pdf-tools-overlay-layer'), {
      clientX: 50,
      clientY: 50,
    });
    expect(onCreateAt).toHaveBeenCalled();
    expect(screen.getByTestId('pdf-tools-overlay-editing')).toHaveFocus();
  });

  // VT-10
  it('deletes the selected box via delete control and announces removal', () => {
    const onDeleteSelected = jest.fn();

    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[baseOverlay]}
          selectedOverlayId={baseOverlay.id}
          textToolActive={false}
          createLimitMessage={null}
          announcement="Text box deleted"
          canUndo={true}
          onCreateAt={jest.fn()}
          onSelect={jest.fn()}
          onDeleteSelected={onDeleteSelected}
          onUndo={jest.fn()}
        />
      </div>
    );

    fireEvent.click(screen.getByTestId('overlay-delete'));
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Text box deleted')).toBeInTheDocument();
  });

  it('does not create when Text tool is inactive and the layer is clicked', () => {
    const onCreateAt = jest.fn();

    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[]}
          selectedOverlayId={null}
          textToolActive={false}
          createLimitMessage={null}
          announcement=""
          canUndo={false}
          onCreateAt={onCreateAt}
          onSelect={jest.fn()}
          onDeleteSelected={jest.fn()}
          onUndo={jest.fn()}
        />
      </div>
    );

    fireEvent.click(screen.getByTestId('pdf-tools-overlay-layer'));
    expect(onCreateAt).not.toHaveBeenCalled();
  });

  it('renders resize and z-order controls for the selected box', () => {
    const onBringForward = jest.fn();
    const onSendBackward = jest.fn();
    const onNudgeSelected = jest.fn();
    const onUpdateGeometry = jest.fn();
    const onCommitGeometryEdit = jest.fn();

    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[baseOverlay]}
          selectedOverlayId={baseOverlay.id}
          textToolActive={false}
          createLimitMessage={null}
          announcement=""
          canUndo={false}
          onCreateAt={jest.fn()}
          onSelect={jest.fn()}
          onDeleteSelected={jest.fn()}
          onUndo={jest.fn()}
          onBeginGeometryEdit={() => true}
          onUpdateGeometry={onUpdateGeometry}
          onCommitGeometryEdit={onCommitGeometryEdit}
          onNudgeSelected={onNudgeSelected}
          onBringForward={onBringForward}
          onSendBackward={onSendBackward}
        />
      </div>
    );

    expect(
      screen.getAllByTestId('pdf-tools-overlay-resize-handle')
    ).toHaveLength(8);
    jest
      .spyOn(
        screen.getByTestId('pdf-tools-overlay-layer'),
        'getBoundingClientRect'
      )
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 200,
        bottom: 200,
        width: 200,
        height: 200,
        toJSON: () => ({}),
      });
    const eastHandle = screen
      .getAllByTestId('pdf-tools-overlay-resize-handle')
      .find((handle) => handle.getAttribute('data-handle') === 'e')!;
    fireEvent(
      eastHandle,
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 80,
        clientY: 60,
      })
    );
    fireEvent(
      eastHandle,
      new MouseEvent('pointermove', {
        bubbles: true,
        clientX: 100,
        clientY: 60,
      })
    );
    fireEvent(
      eastHandle,
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 100,
        clientY: 60,
      })
    );
    expect(onUpdateGeometry).toHaveBeenCalled();
    expect(onCommitGeometryEdit).toHaveBeenCalledWith('resize');

    fireEvent.click(screen.getByTestId('pdf-tools-overlay-bring-forward'));
    fireEvent.click(screen.getByTestId('pdf-tools-overlay-send-backward'));
    fireEvent.keyDown(screen.getByTestId('pdf-tools-overlay-box'), {
      key: 'ArrowRight',
      shiftKey: true,
    });

    expect(onBringForward).toHaveBeenCalledTimes(1);
    expect(onSendBackward).toHaveBeenCalledTimes(1);
    expect(onNudgeSelected).toHaveBeenCalledWith(5, 0);
  });

  it('supports redo shortcuts and announces an autosave failure', () => {
    const onRedo = jest.fn();
    const onRetrySave = jest.fn().mockResolvedValue(undefined);
    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[baseOverlay]}
          selectedOverlayId={baseOverlay.id}
          textToolActive={false}
          createLimitMessage={null}
          announcement=""
          canUndo={true}
          canRedo={true}
          saveStatus="error"
          saveErrorMessage="Network unavailable"
          onCreateAt={jest.fn()}
          onSelect={jest.fn()}
          onDeleteSelected={jest.fn()}
          onUndo={jest.fn()}
          onRedo={onRedo}
          onRetrySave={onRetrySave}
        />
      </div>
    );

    fireEvent.keyDown(screen.getByTestId('pdf-tools-overlay-box'), {
      key: 'y',
      ctrlKey: true,
    });
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('overlay-save-status')).toHaveTextContent(
      'Save failed — Network unavailable'
    );
    expect(screen.getByTestId('overlay-save-status')).toHaveAttribute(
      'aria-live',
      'assertive'
    );

    fireEvent.click(screen.getByTestId('overlay-save-retry'));
    expect(onRetrySave).toHaveBeenCalledTimes(1);
  });

  it('flushes pending overlays when a text box loses focus', () => {
    const onFlush = jest.fn().mockResolvedValue(undefined);
    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[baseOverlay]}
          selectedOverlayId={baseOverlay.id}
          textToolActive={false}
          createLimitMessage={null}
          announcement=""
          canUndo={false}
          onCreateAt={jest.fn()}
          onSelect={jest.fn()}
          onDeleteSelected={jest.fn()}
          onUndo={jest.fn()}
          onFlush={onFlush}
        />
      </div>
    );

    fireEvent.blur(screen.getByTestId('pdf-tools-overlay-box'));
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('orders boxes for keyboard reading order and selects a focused box', () => {
    const onSelect = jest.fn();
    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[
            { ...baseOverlay, id: 'right', x: 60, y: 30 },
            { ...baseOverlay, id: 'bottom', x: 5, y: 60 },
            { ...baseOverlay, id: 'left', x: 10, y: 30 },
          ]}
          selectedOverlayId={null}
          textToolActive={false}
          createLimitMessage={null}
          announcement=""
          canUndo={false}
          onCreateAt={jest.fn()}
          onSelect={onSelect}
          onDeleteSelected={jest.fn()}
          onUndo={jest.fn()}
        />
      </div>
    );

    const boxes = screen.getAllByTestId('pdf-tools-overlay-box');
    expect(boxes.map((box) => box.getAttribute('data-overlay-id'))).toEqual([
      'left',
      'right',
      'bottom',
    ]);

    fireEvent.focus(boxes[0]);
    expect(onSelect).toHaveBeenCalledWith('left');
  });

  it('enters and exits text edit mode without treating editing keys as box actions', () => {
    const onCommitTextEdit = jest.fn(() => true);
    const onUpdateText = jest.fn();
    const onNudgeSelected = jest.fn();
    const onDeleteSelected = jest.fn();
    render(
      <div style={{ position: 'relative', width: 200, height: 200 }}>
        <OverlayTextLayer
          pageId="page-1"
          overlays={[baseOverlay]}
          selectedOverlayId={baseOverlay.id}
          textToolActive={false}
          createLimitMessage={null}
          announcement="Editing text"
          canUndo={false}
          onCreateAt={jest.fn()}
          onSelect={jest.fn()}
          onDeleteSelected={onDeleteSelected}
          onUndo={jest.fn()}
          onBeginTextEdit={() => true}
          onUpdateText={onUpdateText}
          onCommitTextEdit={onCommitTextEdit}
          onNudgeSelected={onNudgeSelected}
        />
      </div>
    );

    fireEvent.keyDown(screen.getByTestId('pdf-tools-overlay-box'), {
      key: 'Enter',
    });
    const editor = screen.getByTestId('pdf-tools-overlay-editing');
    expect(editor).toHaveFocus();

    fireEvent.change(editor, { target: { value: 'Updated text' } });
    fireEvent.keyDown(editor, { key: 'ArrowLeft' });
    fireEvent.keyDown(editor, { key: 'Delete' });
    expect(onUpdateText).toHaveBeenCalledWith('Updated text');
    expect(onNudgeSelected).not.toHaveBeenCalled();
    expect(onDeleteSelected).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(onCommitTextEdit).toHaveBeenCalled();
    expect(
      screen.queryByTestId('pdf-tools-overlay-editing')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('pdf-tools-overlay-box')).toHaveAttribute(
      'aria-selected',
      'true'
    );

    fireEvent.click(screen.getByTestId('pdf-tools-overlay-edit-text'));
    expect(screen.getByTestId('pdf-tools-overlay-editing')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('pdf-tools-overlay-editing'), {
      key: 'Escape',
    });

    fireEvent.click(screen.getByTestId('pdf-tools-overlay-drag-surface'));
    expect(screen.getByTestId('pdf-tools-overlay-editing')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('pdf-tools-overlay-editing'), {
      key: 'Escape',
    });

    fireEvent.doubleClick(screen.getByTestId('pdf-tools-overlay-box'));
    expect(screen.getByTestId('pdf-tools-overlay-editing')).toHaveFocus();
  });

  it('does not delete when no box is focused or selected', () => {
    const onDeleteSelected = jest.fn();
    render(
      <OverlayTextLayer
        pageId="page-1"
        overlays={[baseOverlay]}
        selectedOverlayId={null}
        textToolActive={false}
        createLimitMessage={null}
        announcement=""
        canUndo={false}
        onCreateAt={jest.fn()}
        onSelect={jest.fn()}
        onDeleteSelected={onDeleteSelected}
        onUndo={jest.fn()}
      />
    );

    fireEvent.keyDown(screen.getByTestId('pdf-tools-overlay-layer'), {
      key: 'Delete',
    });
    expect(onDeleteSelected).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('pdf-tools-overlay-live-region')
    ).toBeEmptyDOMElement();
  });
});
