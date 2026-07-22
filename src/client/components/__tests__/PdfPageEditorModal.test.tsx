import { render, screen, fireEvent } from '@testing-library/react';
import type { OverlayTextBox } from '../../../shared/types/pdf';
import { PdfPageEditorModal } from '../PdfPageEditorModal';

jest.mock('../PdfInlinePreview', () => ({
  PdfInlinePreview: () => <div data-testid="mock-inline-preview" />,
}));

const defaultOverlayProps = {
  pageId: 'page-1',
  overlays: [],
  selectedOverlayId: null,
  textToolActive: false,
  editorMode: 'add' as const,
  createLimitMessage: null,
  announcement: '',
  canUndo: false,
  canRedo: false,
  saveStatus: 'idle' as const,
  readOnly: false,
  onCreateAt: jest.fn().mockReturnValue(null),
  onSetReplacementDraft: jest.fn(),
  onExitReplacementMode: jest.fn(),
  onSelectOverlay: jest.fn(),
  onDeleteSelectedOverlay: jest.fn(),
  onRemoveSelectedNativeText: jest.fn(),
  onUndoOverlay: jest.fn(),
  onRedoOverlay: jest.fn(),
  onBeginOverlayTextEdit: jest.fn(),
  onUpdateOverlayText: jest.fn(),
  onCommitOverlayTextEdit: jest.fn().mockReturnValue(false),
  onBeginGeometryEdit: jest.fn().mockReturnValue(false),
  onUpdateOverlayGeometry: jest.fn(),
  onCommitGeometryEdit: jest.fn(),
  onNudgeSelectedOverlay: jest.fn(),
  onBringOverlayForward: jest.fn(),
  onSendOverlayBackward: jest.fn(),
};

const replacementOverlay: OverlayTextBox = {
  id: 'replacement-draft:text-item-1',
  pageId: 'page-1',
  x: 10,
  y: 20,
  width: 12,
  height: 3,
  text: 'Sales Assistant',
  fontFamily: 'Times-Roman',
  fontSize: 10,
  bold: false,
  italic: false,
  color: '#000000',
  horizontalAlign: 'left',
  verticalAlign: 'top',
  opacity: 100,
  rotation: 90,
  listStyle: 'none',
  linkUrl: null,
  linkDisplayText: null,
  zIndex: 1,
  kind: 'replace',
  backgroundColor: '#FFFFFF',
  coverActive: false,
};

describe('PdfPageEditorModal', () => {
  it('invokes onDiscardDraft before closing when Done is clicked', () => {
    const order: string[] = [];
    const onClose = jest.fn(() => order.push('close'));
    const onDiscardDraft = jest.fn(() => order.push('discard'));

    render(
      <PdfPageEditorModal
        isOpen={true}
        sessionId="sess-1"
        fileId="file-1"
        sourcePageIndex={0}
        rotation={0}
        sourceFileName="test.pdf"
        originalPageNumber={1}
        overlay={defaultOverlayProps}
        selectedOverlay={null}
        onToggleTextTool={jest.fn()}
        onToggleReplacementTool={jest.fn()}
        onFormattingChange={jest.fn()}
        onValidationChange={jest.fn()}
        onClose={onClose}
        onDiscardDraft={onDiscardDraft}
      />
    );

    fireEvent.click(screen.getByTestId('page-editor-done'));
    expect(onDiscardDraft).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['discard', 'close']);
  });

  it('invokes onDiscardDraft before closing on Escape', () => {
    const order: string[] = [];
    const onClose = jest.fn(() => order.push('close'));
    const onDiscardDraft = jest.fn(() => order.push('discard'));
    render(
      <PdfPageEditorModal
        isOpen={true}
        sessionId="sess-1"
        fileId="file-1"
        sourcePageIndex={0}
        rotation={0}
        sourceFileName="test.pdf"
        originalPageNumber={1}
        overlay={defaultOverlayProps}
        selectedOverlay={null}
        onToggleTextTool={jest.fn()}
        onToggleReplacementTool={jest.fn()}
        onFormattingChange={jest.fn()}
        onValidationChange={jest.fn()}
        onClose={onClose}
        onDiscardDraft={onDiscardDraft}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(order).toEqual(['discard', 'close']);
  });

  it('does not re-steal focus when draft prop updates after modal is already open', () => {
    const { rerender } = render(
      <PdfPageEditorModal
        isOpen={true}
        sessionId="sess-1"
        fileId="file-1"
        sourcePageIndex={0}
        rotation={0}
        sourceFileName="test.pdf"
        originalPageNumber={1}
        overlay={defaultOverlayProps}
        selectedOverlay={null}
        onToggleTextTool={jest.fn()}
        onToggleReplacementTool={jest.fn()}
        onFormattingChange={jest.fn()}
        onValidationChange={jest.fn()}
        onClose={jest.fn()}
      />
    );

    expect(screen.getByTestId('page-editor-done')).toHaveFocus();

    const draftData = {
      item: {
        id: 'text-item-1',
        text: 'May 2017',
        geometry: { x: 10, y: 50, width: 8, height: 2 },
        fontFamily: 'Times-Roman' as const,
        fontSize: 10,
        bold: false,
        italic: false,
        rotation: 0,
      },
      text: 'May 2017',
      fontFamily: 'Times-Roman' as const,
      fontSize: 10,
      bold: false,
      italic: false,
      color: '#000000',
      backgroundColor: '#FFFFFF',
      rotation: 0,
    };
    rerender(
      <PdfPageEditorModal
        isOpen={true}
        sessionId="sess-1"
        fileId="file-1"
        sourcePageIndex={0}
        rotation={0}
        sourceFileName="test.pdf"
        originalPageNumber={1}
        overlay={{ ...defaultOverlayProps, editorMode: 'replace' }}
        selectedOverlay={replacementOverlay}
        replacementDraft={draftData}
        onToggleTextTool={jest.fn()}
        onToggleReplacementTool={jest.fn()}
        onFormattingChange={jest.fn()}
        onReplacementTextChange={jest.fn()}
        onValidationChange={jest.fn()}
        onClose={jest.fn()}
      />
    );

    const textarea = screen.getByLabelText('Replacement text');
    expect(textarea).toHaveValue('Sales Assistant');
    expect(textarea).toHaveFocus();
  });

  it('prefills replacement textarea with draft text and autofocuses', () => {
    const draftData = {
      item: {
        id: 'text-item-1',
        text: 'Sales Assistant',
        geometry: { x: 10, y: 20, width: 12, height: 3 },
        fontFamily: 'Times-Roman' as const,
        fontSize: 10,
        bold: false,
        italic: false,
        rotation: 90,
      },
      text: 'Sales Assistant',
      fontFamily: 'Times-Roman' as const,
      fontSize: 10,
      bold: false,
      italic: false,
      color: '#000000',
      backgroundColor: '#FFFFFF',
      rotation: 90,
    };
    render(
      <PdfPageEditorModal
        isOpen={true}
        sessionId="sess-1"
        fileId="file-1"
        sourcePageIndex={0}
        rotation={0}
        sourceFileName="test.pdf"
        originalPageNumber={1}
        overlay={{ ...defaultOverlayProps, editorMode: 'replace' }}
        selectedOverlay={replacementOverlay}
        replacementDraft={draftData}
        onToggleTextTool={jest.fn()}
        onToggleReplacementTool={jest.fn()}
        onFormattingChange={jest.fn()}
        onReplacementTextChange={jest.fn()}
        onValidationChange={jest.fn()}
        onClose={jest.fn()}
      />
    );

    const textarea = screen.getByLabelText('Replacement text');
    expect(textarea).toHaveValue('Sales Assistant');
    expect(textarea).toHaveFocus();
  });

  it('routes multiline panel edits through onReplacementTextChange', () => {
    const onReplacementTextFocus = jest.fn();
    const onReplacementTextChange = jest.fn();
    const onReplacementTextBlur = jest.fn();
    render(
      <PdfPageEditorModal
        isOpen={true}
        sessionId="sess-1"
        fileId="file-1"
        sourcePageIndex={0}
        rotation={0}
        sourceFileName="test.pdf"
        originalPageNumber={1}
        overlay={defaultOverlayProps}
        selectedOverlay={{ ...replacementOverlay, coverActive: true }}
        onToggleTextTool={jest.fn()}
        onToggleReplacementTool={jest.fn()}
        onFormattingChange={jest.fn()}
        onReplacementTextFocus={onReplacementTextFocus}
        onReplacementTextChange={onReplacementTextChange}
        onReplacementTextBlur={onReplacementTextBlur}
        onValidationChange={jest.fn()}
        onClose={jest.fn()}
      />
    );

    const textarea = screen.getByLabelText('Replacement text');
    fireEvent.focus(textarea);
    fireEvent.change(textarea, {
      target: { value: 'Sales\nManager' },
    });
    fireEvent.blur(textarea);

    expect(onReplacementTextFocus).toHaveBeenCalledTimes(1);
    expect(onReplacementTextChange).toHaveBeenCalledWith('Sales\nManager');
    expect(onReplacementTextBlur).toHaveBeenCalledTimes(1);
  });
});
