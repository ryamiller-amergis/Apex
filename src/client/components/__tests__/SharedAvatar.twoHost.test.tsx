/**
 * FEAT-004 / PBI-007 AC-0 / TBI-007 DoD-2 — two independent host fixtures
 * share one QueryClient and render the same identity without duplicating
 * resolution logic (VT-01).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedAvatar } from '../SharedAvatar';
import { ProfileCardTrigger } from '../ProfileCardTrigger';
import type { ProfileCardResponse } from '../../../shared/types/profile';
import { buildAvatarResolverUrl } from '../../../shared/types/profile';

const OID = 'oid-colleague';
const VERSION = '2026-07-28T00:00:00.000Z';

const card: ProfileCardResponse = {
  userOid: OID,
  displayName: 'Shared Colleague',
  bio: 'Org-wide bio',
  avatar: { userOid: OID, version: VERSION },
};

function HostA() {
  return (
    <section data-testid="host-a">
      <h1>Host A</h1>
      <SharedAvatar oid={OID} displayName="Shared Colleague" avatarVersion={VERSION} />
      <ProfileCardTrigger
        oid={OID}
        displayName="Shared Colleague"
        avatarVersion={VERSION}
      >
        Open card A
      </ProfileCardTrigger>
      <button type="button" data-testid="host-a-action">
        Host A action
      </button>
    </section>
  );
}

function HostB() {
  return (
    <section data-testid="host-b">
      <h1>Host B</h1>
      <SharedAvatar oid={OID} displayName="Shared Colleague" avatarVersion={VERSION} />
      <ProfileCardTrigger
        oid={OID}
        displayName="Shared Colleague"
        avatarVersion={VERSION}
      >
        Open card B
      </ProfileCardTrigger>
      <button type="button" data-testid="host-b-action">
        Host B action
      </button>
    </section>
  );
}

describe('SharedAvatar two-host integration — PBI-007 AC-0 / TBI-007 DoD-2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn().mockReturnValue('blob:shared-colleague'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });

    global.fetch = jest.fn().mockImplementation((url: string) => {
      const path = String(url);
      if (path.includes('/card')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => card,
          text: async () => JSON.stringify(card),
          headers: { get: () => 'application/json' },
        });
      }
      if (path.startsWith('/api/profile/avatar/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => new Uint8Array([7, 7, 7]).buffer,
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not found' }),
        text: async () => '{"error":"not found"}',
        headers: { get: () => null },
      });
    }) as jest.Mock;
  });

  it('AC-0 / VT-01 / DoD-2: identical uploaded avatar in both hosts; card matches', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <HostA />
        <HostB />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getAllByTestId(`shared-avatar-image-${OID}`)).toHaveLength(2);
    });

    const images = screen.getAllByTestId(`shared-avatar-image-${OID}`);
    expect(images[0]).toHaveAttribute('src', 'blob:shared-colleague');
    expect(images[1]).toHaveAttribute('src', 'blob:shared-colleague');

    const avatarCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
      String(url).startsWith('/api/profile/avatar/')
    );
    expect(avatarCalls).toHaveLength(1);
    expect(avatarCalls[0][0]).toBe(buildAvatarResolverUrl(OID, VERSION));
    expect(String(avatarCalls[0][0])).not.toMatch(/blob\.core\.windows\.net/i);

    fireEvent.click(within(screen.getByTestId('host-a')).getByTestId(`profile-card-trigger-${OID}`));
    await waitFor(() =>
      expect(screen.getByTestId(`profile-card-${OID}`)).toBeInTheDocument()
    );
    expect(screen.getByRole('heading', { name: 'Shared Colleague' })).toBeInTheDocument();
    expect(screen.getByText('Org-wide bio')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`profile-card-close-${OID}`));
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    );

    fireEvent.click(within(screen.getByTestId('host-b')).getByTestId(`profile-card-trigger-${OID}`));
    await waitFor(() =>
      expect(screen.getByTestId(`profile-card-${OID}`)).toBeInTheDocument()
    );
    expect(screen.getByText('Org-wide bio')).toBeInTheDocument();

    // Parent hosts remain interactive
    fireEvent.click(screen.getByTestId('host-a-action'));
    fireEvent.click(screen.getByTestId('host-b-action'));
    expect(screen.getByTestId('host-a-action')).toBeInTheDocument();
    expect(screen.getByTestId('host-b-action')).toBeInTheDocument();
  });
});
