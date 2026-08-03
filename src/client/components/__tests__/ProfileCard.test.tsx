/**
 * FEAT-004 / TBI-007 / PBI-007 — ProfileCard + ProfileCardTrigger tests.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfileCard } from '../ProfileCard';
import { ProfileCardTrigger } from '../ProfileCardTrigger';
import type { ProfileCardResponse } from '../../../shared/types/profile';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>),
  };
}

const card: ProfileCardResponse = {
  userOid: 'oid-b',
  displayName: 'Colleague User',
  bio: 'Hello world',
  avatar: { userOid: 'oid-b', version: 'v1' },
};

function mockCardOk(data: ProfileCardResponse = card) {
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (String(url).includes('/card')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => data,
        text: async () => JSON.stringify(data),
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => new ArrayBuffer(0),
      });
    }
    // Avatar bytes → initials fallback for speed in card tests
    return Promise.resolve({
      ok: true,
      status: 204,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
  }) as jest.Mock;
}

function mockCardError(status: number) {
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (String(url).includes('/card')) {
      return Promise.resolve({
        ok: false,
        status,
        json: async () => ({ error: 'denied' }),
        text: async () => JSON.stringify({ error: 'denied' }),
        headers: { get: () => 'application/json' },
      });
    }
    return Promise.resolve({
      ok: false,
      status,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
  }) as jest.Mock;
}

describe('ProfileCard — TBI-007 DoD-1 / PBI-007', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DoD-1 / AC-0: shows read-only name, avatar, and plain-text bio', async () => {
    mockCardOk();
    renderWithClient(<ProfileCard oid="oid-b" displayNameHint="Colleague User" />);

    await waitFor(() =>
      expect(screen.getByTestId('profile-card-oid-b')).toBeInTheDocument()
    );
    expect(screen.getByRole('heading', { name: 'Colleague User' })).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.queryByText(/@|edit|theme/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('VT-05: HTML-like bio and URLs render as literal text nodes', async () => {
    mockCardOk({
      ...card,
      bio: '<img src=x onerror=alert(1)> https://evil.example',
    });
    renderWithClient(<ProfileCard oid="oid-b" />);

    await waitFor(() =>
      expect(screen.getByTestId('profile-card-oid-b')).toBeInTheDocument()
    );
    expect(
      screen.getByText('<img src=x onerror=alert(1)> https://evil.example')
    ).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="evil"]')).toBeNull();
  });

  it('DoD-1: empty bio shows contained empty copy', async () => {
    mockCardOk({ ...card, bio: null });
    renderWithClient(<ProfileCard oid="oid-b" />);

    await waitFor(() =>
      expect(screen.getByText('No bio provided')).toBeInTheDocument()
    );
  });

  it('AC-1 / VT-02: retrieval failure shows contained unavailable state', async () => {
    mockCardError(500);
    renderWithClient(<ProfileCard oid="oid-b" />);

    await waitFor(() =>
      expect(screen.getByTestId('profile-card-unavailable-oid-b')).toHaveTextContent(
        'Profile details are unavailable'
      )
    );
  });

  it('AC-3 / VT-04: 401 shows unavailable without private email fields', async () => {
    mockCardError(401);
    renderWithClient(<ProfileCard oid="oid-b" />);

    await waitFor(() =>
      expect(screen.getByTestId('profile-card-unavailable-oid-b')).toBeInTheDocument()
    );
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });
});

describe('ProfileCardTrigger — TBI-007 DoD-1 / VT-06', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCardOk();
  });

  it('DoD-1 / VT-06: opens dialog on click and restores focus on Escape', async () => {
    renderWithClient(
      <ProfileCardTrigger oid="oid-b" displayName="Colleague User" avatarVersion="v1" />
    );

    const trigger = screen.getByTestId('profile-card-trigger-oid-b');
    trigger.focus();
    fireEvent.click(trigger);

    await waitFor(() =>
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    );
    expect(screen.getByTestId('profile-card-close-oid-b')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    );
    expect(trigger).toHaveFocus();
  });

  it('VT-06: Close button dismisses the card', async () => {
    renderWithClient(
      <ProfileCardTrigger oid="oid-b" displayName="Colleague User" />
    );

    fireEvent.click(screen.getByTestId('profile-card-trigger-oid-b'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('profile-card-close-oid-b'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    );
  });

  it('AC-1: parent host remains functional when card fails', async () => {
    mockCardError(500);
    renderWithClient(
      <div>
        <button type="button" data-testid="host-action">
          Host action
        </button>
        <ProfileCardTrigger oid="oid-b" displayName="Colleague User" />
      </div>
    );

    fireEvent.click(screen.getByTestId('profile-card-trigger-oid-b'));
    await waitFor(() =>
      expect(screen.getByTestId('profile-card-unavailable-oid-b')).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId('host-action'));
    expect(screen.getByTestId('host-action')).toBeInTheDocument();
  });
});
