import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BrainstormHandoffPreviewModal } from '../BrainstormHandoffPreviewModal';
import { useConfirmHandoff, usePreviewHandoff } from '../../hooks/useBrainstormActions';
import type { BrainstormHandoffPreviewDto } from '../../../shared/types/brainstormArtifact';

jest.mock('../../hooks/useBrainstormActions', () => ({
  usePreviewHandoff: jest.fn(),
  useConfirmHandoff: jest.fn(),
}));

const previewHook = usePreviewHandoff as jest.Mock;
const confirmHook = useConfirmHandoff as jest.Mock;

const previewData: BrainstormHandoffPreviewDto = {
  handoffId: 'h-1',
  idempotencyKey: 'key-1',
  state: 'previewed',
  actionId: 'create-adr',
  artifactVersion: 7,
  target: { module: 'adr', label: 'ADR' },
  summary: [{ label: 'Title', value: 'Use OIDC' }, { label: 'Status', value: 'Proposed' }],
  sections: ['Context', 'Considered Options', 'Decision Outcome', 'Consequences'],
  notes: ['You will be the only reviewer until you add others.'],
  contentSha256: 'abc',
};

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setOpen(true)} {...{ 'data-testid': 'trigger' }}>Preview</button>
      {open && (
        <BrainstormHandoffPreviewModal
          project="Apex"
          sessionId="s-1"
          actionId="create-adr"
          actionLabel="Create an ADR"
          expectedVersion={7}
          onClose={() => setOpen(false)}
        />
      )}
    </MemoryRouter>
  );
}

function openModal() {
  render(<Harness />);
  const trigger = screen.getByTestId('trigger');
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('BrainstormHandoffPreviewModal (VT-41)', () => {
  const requestPreview = jest.fn();
  const confirm = jest.fn();

  beforeEach(() => {
    requestPreview.mockClear();
    confirm.mockClear();
    previewHook.mockReturnValue({ mutate: requestPreview, data: previewData, isPending: false, isIdle: false, isError: false });
    confirmHook.mockReturnValue({ mutate: confirm, data: undefined, isPending: false, isError: false });
  });

  it('is a modal dialog that previews the expected version on open', () => {
    openModal();
    const dialog = screen.getByRole('dialog', { name: 'Create an ADR' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    expect(requestPreview).toHaveBeenCalledWith({ actionId: 'create-adr', expectedVersion: 7 });
    expect(dialog).toHaveTextContent('Proposed');
    expect(dialog).toHaveTextContent('Decision Outcome');
  });

  it('traps Tab and Shift+Tab inside the dialog', () => {
    openModal();
    const cancel = screen.getByTestId('brainstorm-handoff-cancel');
    const confirmButton = screen.getByTestId('brainstorm-handoff-confirm');

    confirmButton.focus();
    fireEvent.keyDown(confirmButton, { key: 'Tab' });
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(confirmButton).toHaveFocus();
  });

  it('Escape closes the dialog and returns focus to the trigger', () => {
    const trigger = openModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('Confirm and Cancel work from the keyboard; Confirm sends the preview', () => {
    openModal();
    const confirmButton = screen.getByTestId('brainstorm-handoff-confirm');
    expect(confirmButton.tagName).toBe('BUTTON');
    expect(screen.getByTestId('brainstorm-handoff-cancel').tagName).toBe('BUTTON');
    fireEvent.click(confirmButton);
    expect(confirm).toHaveBeenCalledWith(previewData);
  });

  it('announces the created record with a link', () => {
    confirmHook.mockReturnValue({
      mutate: confirm,
      data: { handoffId: 'h-1', state: 'completed', resultRef: { module: 'adr', id: 'adr-9', link: '/adr/adr-9' }, replayed: false },
      isPending: false,
      isError: false,
    });
    openModal();

    const link = screen.getByTestId('brainstorm-handoff-result-link');
    expect(link).toHaveAttribute('href', '/adr/adr-9');
    expect(link.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByTestId('brainstorm-handoff-confirm')).not.toBeInTheDocument();
  });

  it('shows the refusal reasons when the preview is refused', () => {
    const { BrainstormApiError } = jest.requireActual('../../hooks/useBrainstormSessions');
    previewHook.mockReturnValue({
      mutate: requestPreview,
      data: undefined,
      isPending: false,
      isIdle: false,
      isError: true,
      error: new BrainstormApiError(409, 'unavailable', {
        code: 'ACTION_UNAVAILABLE',
        reasons: [{ code: 'MISSING_INFORMATION', text: 'Add a Decision Outcome section.' }],
      }),
    });
    openModal();
    expect(screen.getByRole('alert')).toHaveTextContent('Add a Decision Outcome section.');
    expect(screen.getByTestId('brainstorm-handoff-confirm')).toBeDisabled();
  });
});
