/**
 * FEAT-004 / TBI-007 / PBI-007 — SharedAvatar unit tests.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedAvatar } from '../SharedAvatar';
import { deriveInitials } from '../../../shared/types/profile';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function mockImageOk(bytes: number[] = [1, 2, 3]) {
  const buffer = new Uint8Array(bytes).buffer;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => buffer,
  }) as jest.Mock;
}

function mockInitials204() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as jest.Mock;
}

function mockFetchError(status: number) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as jest.Mock;
}

describe('SharedAvatar — TBI-007 DoD-0 / PBI-007', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn().mockReturnValue('blob:avatar-a'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
  });

  it('DoD-0 / AC-0: renders uploaded image when resolver returns bytes', async () => {
    mockImageOk();
    renderWithClient(
      <SharedAvatar oid="oid-a" displayName="Ada Lovelace" avatarVersion="v1" />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-image-oid-a')).toBeInTheDocument()
    );
    expect(screen.getByAltText('Avatar for Ada Lovelace')).toHaveAttribute(
      'src',
      'blob:avatar-a'
    );
  });

  it('DoD-0 / AC-2: Graph bytes (same resolver URL) render as image', async () => {
    mockImageOk([9, 9]);
    renderWithClient(
      <SharedAvatar oid="oid-graph" displayName="Grace Hopper" avatarVersion="0" />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-image-oid-graph')).toBeInTheDocument()
    );
  });

  it('DoD-0 / AC-2: 204 falls back to first/last-token initials', async () => {
    mockInitials204();
    renderWithClient(
      <SharedAvatar oid="oid-b" displayName="Alan Turing" avatarVersion={null} />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-initials-oid-b')).toHaveTextContent(
        deriveInitials('Alan Turing')
      )
    );
    expect(screen.queryByTestId('shared-avatar-image-oid-b')).not.toBeInTheDocument();
  });

  it('AC-2: single-token name uses up to two characters', async () => {
    mockInitials204();
    renderWithClient(<SharedAvatar oid="oid-c" displayName="Cher" />);

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-initials-oid-c')).toHaveTextContent(
        deriveInitials('Cher')
      )
    );
  });

  it('AC-2: missing name falls back via deriveInitials', async () => {
    mockInitials204();
    renderWithClient(<SharedAvatar oid="oid-d" displayName="   " />);

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-initials-oid-d')).toHaveTextContent(
        deriveInitials('   ')
      )
    );
  });

  it('AC-1 / VT-02: fetch failure shows initials, not a broken image', async () => {
    mockFetchError(500);
    renderWithClient(
      <SharedAvatar oid="oid-fail" displayName="Broken User" avatarVersion="v9" />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-initials-oid-fail')).toBeInTheDocument()
    );
    expect(screen.queryByTestId('shared-avatar-image-oid-fail')).not.toBeInTheDocument();
  });

  it('AC-3 / VT-04: 401 falls back to initials without Blob storage URL', async () => {
    mockFetchError(401);
    renderWithClient(
      <SharedAvatar oid="oid-unauth" displayName="Secret User" avatarVersion="v1" />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-initials-oid-unauth')).toBeInTheDocument()
    );
    const callUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(callUrl).toMatch(/^\/api\/profile\/avatar\//);
    expect(callUrl).not.toMatch(/blob\.core\.windows\.net/i);
  });

  it('VT-08: revokes object URL on unmount', async () => {
    mockImageOk();
    const { unmount } = renderWithClient(
      <SharedAvatar oid="oid-a" displayName="Ada Lovelace" avatarVersion="v1" />
    );

    await waitFor(() =>
      expect(screen.getByTestId('shared-avatar-image-oid-a')).toBeInTheDocument()
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar-a');
  });
});
