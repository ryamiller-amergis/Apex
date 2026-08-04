import { fireEvent, render, screen } from '@testing-library/react';
import { OverlayConflictBanner } from '../OverlayConflictBanner';

describe('OverlayConflictBanner', () => {
  it('announces a resolved conflict and supports keyboard acknowledgement', () => {
    const onAcknowledge = jest.fn();
    render(
      <OverlayConflictBanner
        visible
        isReloading={false}
        errorMessage={null}
        onAcknowledge={onAcknowledge}
        onRetry={jest.fn()}
      />
    );

    expect(
      screen.getByTestId('pdf-tools-overlay-conflict-banner')
    ).toHaveAttribute('role', 'status');
    const button = screen.getByTestId(
      'pdf-tools-overlay-conflict-acknowledge'
    );
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('shows an alert and retry control when reload fails', () => {
    const onRetry = jest.fn();
    render(
      <OverlayConflictBanner
        visible
        isReloading={false}
        errorMessage="Network unavailable"
        onAcknowledge={jest.fn()}
        onRetry={onRetry}
      />
    );

    expect(
      screen.getByTestId('pdf-tools-overlay-conflict-banner')
    ).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByTestId('pdf-tools-overlay-conflict-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('stays hidden when there is no conflict', () => {
    render(
      <OverlayConflictBanner
        visible={false}
        isReloading={false}
        errorMessage={null}
        onAcknowledge={jest.fn()}
        onRetry={jest.fn()}
      />
    );

    expect(
      screen.queryByTestId('pdf-tools-overlay-conflict-banner')
    ).not.toBeInTheDocument();
  });
});
