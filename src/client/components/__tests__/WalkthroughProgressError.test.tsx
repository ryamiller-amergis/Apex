/**
 * FEAT-006 — WalkthroughProgressError custom modal (not window.alert)
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { WalkthroughProgressError } from '../WalkthroughProgressError';

describe('WalkthroughProgressError (FEAT-006 PBI-007 AC-1)', () => {
  it('renders a custom dialog with Retry and Close actions', () => {
    const onRetry = jest.fn();
    const onClose = jest.fn();
    render(
      <WalkthroughProgressError
        open
        onRetry={onRetry}
        onCloseWithoutAcknowledgement={onClose}
      />,
    );

    expect(screen.getByTestId('walkthrough-progress-error')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /Progress not saved/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('walkthrough-progress-retry'));
    expect(onRetry).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('walkthrough-progress-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not use window.alert', () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
    render(
      <WalkthroughProgressError
        open
        onRetry={jest.fn()}
        onCloseWithoutAcknowledgement={jest.fn()}
      />,
    );
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('required walkthrough failures only allow retry', () => {
    const onClose = jest.fn();
    render(
      <WalkthroughProgressError
        open
        onRetry={jest.fn()}
        onCloseWithoutAcknowledgement={onClose}
        allowCloseWithoutAcknowledgement={false}
      />,
    );

    expect(screen.queryByTestId('walkthrough-progress-close')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/required walkthrough/i);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
