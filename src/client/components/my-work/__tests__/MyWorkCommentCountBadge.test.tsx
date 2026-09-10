import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyWorkCommentCountBadge } from '../MyWorkCommentCountBadge';

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('MyWorkCommentCountBadge', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows badge after async count resolves', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ count: 3 }),
    }) as jest.Mock;

    renderWithQuery(<MyWorkCommentCountBadge workItemId={42} project="MaxView" />);

    await waitFor(() => {
      expect(screen.getByTestId('comment-count-badge-42')).toHaveTextContent('3');
    });
  });

  it('renders row title area without badge while count is pending', () => {
    global.fetch = jest.fn().mockReturnValue(new Promise(() => {})) as jest.Mock;

    renderWithQuery(<MyWorkCommentCountBadge workItemId={42} project="MaxView" />);

    expect(screen.queryByTestId('comment-count-badge-42')).not.toBeInTheDocument();
  });

  it('omits badge and logs warning when fetch fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Service unavailable' }),
    }) as jest.Mock;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    renderWithQuery(<MyWorkCommentCountBadge workItemId={42} project="MaxView" />);

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        '[CommentCountBadge] My Work row comment count fetch failed',
        expect.objectContaining({
          workItemId: 42,
          feature: 'CommentCountBadge',
        }),
      );
    });

    expect(screen.queryByTestId('comment-count-badge-42')).not.toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('omits badge when API returns null count', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ count: null }),
    }) as jest.Mock;

    renderWithQuery(<MyWorkCommentCountBadge workItemId={42} project="MaxView" />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(screen.queryByTestId('comment-count-badge-42')).not.toBeInTheDocument();
  });
});
