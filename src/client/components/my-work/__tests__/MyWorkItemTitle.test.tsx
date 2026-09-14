import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyWorkItemTitle } from '../MyWorkItemTitle';

jest.mock('../../../hooks/useDevWorkbench', () => ({
  useWorkItemCommentCount: jest.fn(),
}));

import { useWorkItemCommentCount } from '../../../hooks/useDevWorkbench';

const mockUseWorkItemCommentCount = useWorkItemCommentCount as jest.Mock;

function renderTitle(props: React.ComponentProps<typeof MyWorkItemTitle>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MyWorkItemTitle {...props} />
    </QueryClientProvider>,
  );
}

describe('MyWorkItemTitle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows title immediately and badge after count resolves (VT-08, VT-17)', async () => {
    mockUseWorkItemCommentCount.mockReturnValue({
      data: undefined,
      isError: false,
      error: null,
    });

    const { rerender } = renderTitle({
      title: 'Implement login',
      workItemId: 42,
      project: 'MaxView',
    });

    expect(screen.getByText('Implement login')).toBeInTheDocument();
    expect(screen.queryByTestId('comment-count-badge-42')).not.toBeInTheDocument();

    mockUseWorkItemCommentCount.mockReturnValue({
      data: { count: 3 },
      isError: false,
      error: null,
    });

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MyWorkItemTitle title="Implement login" workItemId={42} project="MaxView" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('comment-count-badge-42')).toHaveTextContent('3');
    });
  });

  it('renders title without badge when fetch fails (VT-07, VT-09)', () => {
    mockUseWorkItemCommentCount.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error('HTTP 500'),
    });

    renderTitle({ title: 'Fix crash', workItemId: 99, project: 'MaxView' });

    expect(screen.getByText('Fix crash')).toBeInTheDocument();
    expect(screen.queryByTestId('comment-count-badge-99')).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith('[CommentCountBadge]', {
      workItemId: 99,
      errorSummary: 'HTTP 500',
      feature: 'CommentCountBadge',
    });
  });

  it('skips fetch when workItemId is missing', () => {
    mockUseWorkItemCommentCount.mockReturnValue({
      data: undefined,
      isError: false,
      error: null,
    });

    renderTitle({ title: 'Local-only item', workItemId: null, project: 'MaxView' });

    expect(mockUseWorkItemCommentCount).toHaveBeenCalledWith(null, 'MaxView');
    expect(screen.getByText('Local-only item')).toBeInTheDocument();
  });
});
