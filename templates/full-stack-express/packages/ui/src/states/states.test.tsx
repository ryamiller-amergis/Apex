import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppThemeProvider } from '../theme/AppThemeProvider.js';
import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { LoadingState } from './LoadingState.js';

function renderThemed(ui: React.ReactElement) {
  return render(<AppThemeProvider>{ui}</AppThemeProvider>);
}

describe('LoadingState', () => {
  it('VT-13 PBI-018 AC-3 is announced as a status with visible text', () => {
    renderThemed(<LoadingState />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading');
    expect(status).toHaveAttribute('data-testid', 'loading-state');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('VT-13 accepts a label and an inline variant', () => {
    renderThemed(<LoadingState label="Loading profile" variant="inline" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading profile');
  });
});

describe('EmptyState', () => {
  it('VT-13 PBI-018 AC-3 is announced as a status with its title and description', () => {
    renderThemed(
      <EmptyState title="No items yet" description="Add one to get started." />
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('No items yet');
    expect(status).toHaveTextContent('Add one to get started.');
    expect(status).toHaveAttribute('data-testid', 'empty-state');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('VT-13 renders an optional keyboard-operable action', async () => {
    const onClick = vi.fn();
    renderThemed(
      <EmptyState
        title="No items yet"
        action={{ label: 'Add item', onClick }}
      />
    );
    const action = screen.getByRole('button', { name: 'Add item' });
    expect(action).toHaveAttribute('data-testid', 'empty-state-action');
    action.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorState', () => {
  it('VT-13 PBI-018 AC-1 is an alert with the default title and no retry by default', () => {
    renderThemed(<ErrorState />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveAttribute('data-testid', 'error-state');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('VT-13 calls onRetry once per Enter and once per Space', async () => {
    const onRetry = vi.fn();
    renderThemed(
      <ErrorState message="We could not load your profile." onRetry={onRetry} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We could not load your profile.'
    );
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toHaveAttribute('data-testid', 'error-state-retry');

    retry.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(' ');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('VT-13 accepts a custom title and retry label', () => {
    renderThemed(
      <ErrorState title="Not saved" retryLabel="Save again" onRetry={vi.fn()} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Not saved');
    expect(
      screen.getByRole('button', { name: 'Save again' })
    ).toBeInTheDocument();
  });
});
