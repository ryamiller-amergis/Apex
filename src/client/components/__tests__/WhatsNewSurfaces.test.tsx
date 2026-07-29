/**
 * TBI-010 — Whats New presentation helpers (VT-12, VT-13, DoD-3).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../../hooks/useChangelog', () => ({
  useChangelog: (enabled: boolean) => {
    if (!enabled) {
      return { data: undefined, isLoading: false, isError: false, isFetched: false };
    }
    return {
      data: {
        currentVersion: '2.0.1',
        entries: [
          { version: '2.0.1', date: '2026-07-02', title: 'Newest', changes: [{ type: 'feature', description: 'A' }] },
          { version: '2.0.0', date: '2026-07-01', title: 'Also new', changes: [] },
          { version: '1.9.0', date: '2026-06-01', title: 'Seen', changes: [] },
        ],
      },
      isLoading: false,
      isError: false,
      isFetched: true,
    };
  },
}));

import { Changelog } from '../Changelog';
import { WhatsNewIndicator } from '../WhatsNewIndicator';

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(QueryClientProvider, { client }, ui),
  );
}

describe('WhatsNewIndicator', () => {
  it('DoD-0: renders avatar and menu testids only when unread', () => {
    const { rerender } = render(
      <WhatsNewIndicator unread={false} placement="avatar" />,
    );
    expect(screen.queryByTestId('whats-new-avatar-indicator')).toBeNull();

    rerender(<WhatsNewIndicator unread placement="avatar" announce />);
    expect(screen.getByTestId('whats-new-avatar-indicator')).toBeInTheDocument();
    expect(screen.getByText('A new Apex release is available')).toBeInTheDocument();

    rerender(<WhatsNewIndicator unread placement="menu" />);
    expect(screen.getByTestId('whats-new-menu-indicator')).toBeInTheDocument();
  });
});

describe('Changelog modal content', () => {
  it('VT-12 / AC-4: places New since last visit divider before first unseen release', () => {
    renderWithClient(
      <Changelog
        isOpen
        onClose={jest.fn()}
        onMarkAsRead={jest.fn()}
        showOnLogin
        onToggleShowOnLogin={jest.fn()}
        lastSeenVersion="1.9.0"
      />,
    );

    expect(screen.getByTestId('whats-new-modal')).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-unseen-divider')).toHaveTextContent('New since last visit');
    expect(screen.getByTestId('whats-new-auto-toggle')).toBeInTheDocument();
  });

  it('VT-13 / AC-1: manual unavailable shows benign message', () => {
    renderWithClient(
      <Changelog
        isOpen
        onClose={jest.fn()}
        onMarkAsRead={jest.fn()}
        showOnLogin
        onToggleShowOnLogin={jest.fn()}
        manualUnavailable
      />,
    );

    expect(screen.getByTestId('whats-new-manual-unavailable')).toHaveTextContent(
      'Release notes are temporarily unavailable',
    );
  });

  it('DoD-3 / AC-5: dialog exposes accessible semantics', () => {
    renderWithClient(
      <Changelog
        isOpen
        onClose={jest.fn()}
        onMarkAsRead={jest.fn()}
        showOnLogin
        onToggleShowOnLogin={jest.fn()}
        lastSeenVersion="1.9.0"
      />,
    );

    const dialog = screen.getByTestId('whats-new-modal');
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: /Close What's New/i })).toBeInTheDocument();
  });
});
