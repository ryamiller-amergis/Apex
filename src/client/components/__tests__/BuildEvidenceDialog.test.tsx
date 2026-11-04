/**
 * PBI-023 AC-0, AC-1, AC-3 / VT-31, VT-33.
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BuildEvidenceDialog } from '../BuildEvidenceDialog';

const BUILD_ID = 'b1';
const clients: QueryClient[] = [];

function renderDialog(
  props: Partial<React.ComponentProps<typeof BuildEvidenceDialog>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  clients.push(queryClient);
  const onClose = props.onClose ?? jest.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      {/* data-testid-exempt */}
      <BuildEvidenceDialog
        project="Apex"
        buildId={BUILD_ID}
        target={{
          rowId: 'row-ac2',
          requirementId: 'AC-2',
          slot: 'red',
          commit: 'abcdef1234567',
          command: 'npx jest src/ac2.test.ts',
          exitCode: 1,
          recordedAt: '2026-11-03T10:00:00Z',
        }}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe('BuildEvidenceDialog', () => {
  it('VT-31 PBI-023 AC-1: shows loading state first, then 404 not-available message, and closes via Close button', async () => {
    const user = userEvent.setup();
    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { onClose } = renderDialog();
    const loading = screen.getByTestId('build-evidence-loading');
    expect(loading).toHaveTextContent('Loading evidence…');
    expect(loading).toHaveAttribute('aria-busy', 'true');

    resolveFetch({
      ok: false,
      status: 404,
      text: () => Promise.resolve(JSON.stringify({ error: 'Not found', code: 'BUILD_EVIDENCE_NOT_AVAILABLE' })),
    });

    expect(await screen.findByTestId('build-evidence-unavailable')).toHaveTextContent(
      'This evidence is no longer available. Evidence is kept for 90 days after a build ends.',
    );

    await user.click(screen.getByTestId('build-evidence-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('VT-33 PBI-023 AC-3: shows no-access message on 403 and retryable error message on 500', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve(JSON.stringify({ error: 'Forbidden', code: 'BUILD_FORBIDDEN' })),
    });

    const { unmount } = renderDialog();
    expect(await screen.findByTestId('build-evidence-forbidden')).toHaveTextContent(
      'You do not have access to this evidence.',
    );
    expect(screen.queryByTestId('build-evidence-content')).not.toBeInTheDocument();
    unmount();

    // 500 error followed by 200 on retry
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve(JSON.stringify({ error: 'Failed' })),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('FAIL test output'),
      });

    renderDialog();
    expect(await screen.findByTestId('build-evidence-error')).toHaveTextContent(
      'We could not load this evidence. Try again.',
    );
    await user.click(screen.getByTestId('build-evidence-retry'));
    await waitFor(() =>
      expect(screen.getByTestId('build-evidence-content')).toHaveTextContent('FAIL test output'),
    );
  });
});
