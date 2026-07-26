/**
 * PBI-003 / TBI-005 — Jump to matching message (focus + highlight)
 *
 * Matrix coverage:
 * - AC-0: scroll + brief highlight then clear
 * - AC-1: missing message → no highlight
 * - AC-2 / AC-3: no focus id → no highlight
 */
import { render, screen, act } from '@testing-library/react';
import { useState } from 'react';
import {
  FOCUS_MESSAGE_HIGHLIGHT_MS,
  useFocusChatMessage,
} from '../useFocusChatMessage';

function FocusHarness({
  focusMessageId,
  messageIds,
}: {
  focusMessageId?: string | null;
  messageIds: string[];
}) {
  const highlightedId = useFocusChatMessage(focusMessageId, messageIds);
  return (
    <div>
      {messageIds.map((id) => (
        <div
          key={id}
          data-message-id={id}
          data-testid={highlightedId === id ? 'chat-message-highlighted' : `msg-${id}`}
          className={highlightedId === id ? 'messageHighlighted' : undefined}
        >
          Message {id}
        </div>
      ))}
      <span data-testid="highlighted-id">{highlightedId ?? ''}</span>
    </div>
  );
}

describe('useFocusChatMessage (PBI-003)', () => {
  let scrollSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    scrollSpy = jest
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    scrollSpy.mockRestore();
    jest.useRealTimers();
  });

  it('AC-0: scrolls to matched message, sets highlight, then clears after ~2s', () => {
    render(
      <FocusHarness focusMessageId="msg-1" messageIds={['msg-0', 'msg-1', 'msg-2']} />,
    );

    expect(scrollSpy).toHaveBeenCalled();
    expect(screen.getByTestId('chat-message-highlighted')).toBeInTheDocument();
    expect(screen.getByTestId('highlighted-id')).toHaveTextContent('msg-1');

    act(() => {
      jest.advanceTimersByTime(FOCUS_MESSAGE_HIGHLIGHT_MS);
    });

    expect(screen.queryByTestId('chat-message-highlighted')).not.toBeInTheDocument();
    expect(screen.getByTestId('highlighted-id')).toHaveTextContent('');
  });

  it('AC-1: missing message id applies no highlight and does not throw', () => {
    render(
      <FocusHarness focusMessageId="msg-gone" messageIds={['msg-1', 'msg-2']} />,
    );

    expect(screen.queryByTestId('chat-message-highlighted')).not.toBeInTheDocument();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('AC-2 / AC-3: no focusMessageId means no scroll or highlight', () => {
    render(<FocusHarness focusMessageId={undefined} messageIds={['msg-1']} />);

    expect(screen.queryByTestId('chat-message-highlighted')).not.toBeInTheDocument();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('defers until messageIds become available (late mount)', () => {
    function DeferredHarness() {
      const [ids, setIds] = useState<string[]>([]);
      const highlightedId = useFocusChatMessage('msg-late', ids);
      return (
        <div>
          <button type="button" onClick={() => setIds(['msg-late'])}>
            load
          </button>
          {ids.map((id) => (
            <div
              key={id}
              data-message-id={id}
              data-testid={highlightedId === id ? 'chat-message-highlighted' : `msg-${id}`}
            />
          ))}
        </div>
      );
    }

    render(<DeferredHarness />);
    expect(screen.queryByTestId('chat-message-highlighted')).not.toBeInTheDocument();

    act(() => {
      screen.getByRole('button', { name: 'load' }).click();
    });

    expect(scrollSpy).toHaveBeenCalled();
    expect(screen.getByTestId('chat-message-highlighted')).toBeInTheDocument();
  });
});
