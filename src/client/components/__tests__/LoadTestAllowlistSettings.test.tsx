/**
 * Client tests for LoadTestAllowlistSettings — FEAT-005 / PBI-006
 *
 * AC-0: Admin can submit staging entry and see it in the table
 * AC-1: Prod refusal error surfaces as alert text (allowlist unchanged)
 * NFR a11y: fields have labels and testids used by keyboard/e2e flows
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoadTestAllowlistSettings } from '../LoadTestAllowlistSettings';

const PROJECT = 'project-a';

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LoadTestAllowlistSettings selectedProject={PROJECT} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('LoadTestAllowlistSettings (PBI-006)', () => {
  it('AC-0: labeled form fields and empty state for authors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    }) as unknown as typeof fetch;

    renderPage();

    expect(screen.getByTestId('load-test-allowlist-page')).toBeInTheDocument();
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^environment$/i)).toBeInTheDocument();
    expect(screen.getByTestId('load-test-allowlist-reachable')).toBeInTheDocument();
    expect(screen.getByTestId('load-test-allowlist-submit')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByText(/no allowed targets yet/i),
      ).toBeInTheDocument();
    });
  });

  it('AC-0: submitting staging entry lists the new row', async () => {
    const user = userEvent.setup();
    const created = {
      id: 't1',
      projectId: PROJECT,
      baseUrl: 'https://api.staging.example.internal',
      environmentLabel: 'staging',
      isReachable: true,
      isActive: true,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      createdBy: 'admin',
      updatedBy: 'admin',
    };

    let listed: unknown[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/load-test-targets') && (!init || !init.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: listed }),
        };
      }
      if (init?.method === 'POST') {
        listed = [created];
        return {
          ok: true,
          status: 201,
          json: async () => ({ item: created }),
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() => screen.getByText(/no allowed targets yet/i));

    await user.type(
      screen.getByTestId('load-test-allowlist-base-url'),
      'https://api.staging.example.internal',
    );
    await user.type(screen.getByTestId('load-test-allowlist-environment'), 'staging');
    await user.click(screen.getByTestId('load-test-allowlist-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('load-test-allowlist-table')).toBeInTheDocument();
      expect(screen.getByText('https://api.staging.example.internal')).toBeInTheDocument();
      expect(screen.getByText('staging')).toBeInTheDocument();
    });
  });

  it('AC-1: prod refusal shows error alert and leaves empty list', async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || !init.method || init.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: 'Environment label "prod" appears to be production and is refused.',
          code: 'LOAD_TEST_TARGET_PROD_REFUSED',
        }),
      };
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() => screen.getByText(/no allowed targets yet/i));

    await user.type(screen.getByTestId('load-test-allowlist-base-url'), 'https://api.staging.example.com');
    await user.type(screen.getByTestId('load-test-allowlist-environment'), 'prod');
    await user.click(screen.getByTestId('load-test-allowlist-submit'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/production/i);
    });
    expect(screen.queryByTestId('load-test-allowlist-table')).not.toBeInTheDocument();
  });
});
