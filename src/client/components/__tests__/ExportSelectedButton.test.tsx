/**
 * Unit tests for ExportSelectedButton.
 * Covers: disabled state, shared filename, page indices, onBeforeExport, success callback.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExportSelectedButton } from '../ExportSelectedButton';

let mockMutate: jest.Mock;
let mockMutationState: {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: (Error & { code?: string }) | null;
};

jest.mock('../../hooks/useExportSession', () => ({
  useExportSession: () => ({
    mutate: mockMutate,
    ...mockMutationState,
  }),
}));

function renderButton(
  props: Partial<React.ComponentProps<typeof ExportSelectedButton>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ExportSelectedButton
        sessionId="session-123"
        selectedCount={props.selectedCount ?? 2}
        selectedPageIndices={props.selectedPageIndices ?? [2, 0]}
        filename={props.filename}
        onBeforeExport={props.onBeforeExport}
        onExportComplete={props.onExportComplete}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockMutate = jest.fn();
  mockMutationState = {
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  };
});

describe('ExportSelectedButton', () => {
  it('is disabled when nothing is selected', () => {
    renderButton({ selectedCount: 0, selectedPageIndices: [] });

    expect(screen.getByTestId('pdf-export-selected-btn')).toBeDisabled();
  });

  it('passes sorted page indices and shared filename to mutate', async () => {
    renderButton({
      selectedCount: 2,
      selectedPageIndices: [2, 0],
      filename: 'custom-export.pdf',
    });

    fireEvent.click(screen.getByTestId('pdf-export-selected-btn'));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith({
        sessionId: 'session-123',
        pages: [0, 2],
        filename: 'custom-export.pdf',
      });
    });
  });

  it('awaits onBeforeExport before calling mutate', async () => {
    let resolveBefore!: () => void;
    const onBeforeExport = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveBefore = resolve;
        }),
    );

    renderButton({ onBeforeExport });

    fireEvent.click(screen.getByTestId('pdf-export-selected-btn'));

    await waitFor(() => {
      expect(onBeforeExport).toHaveBeenCalledTimes(1);
    });
    expect(mockMutate).not.toHaveBeenCalled();

    resolveBefore();

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });
  });

  it('shows an error and skips mutate when onBeforeExport fails', async () => {
    const onBeforeExport = jest.fn().mockRejectedValue(new Error('Save failed'));

    renderButton({ onBeforeExport });

    fireEvent.click(screen.getByTestId('pdf-export-selected-btn'));

    expect(await screen.findByTestId('pdf-export-selected-error')).toHaveTextContent(
      'Save failed',
    );
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('calls onExportComplete when export succeeds', () => {
    mockMutationState.isSuccess = true;
    const onExportComplete = jest.fn();

    renderButton({ onExportComplete });

    expect(onExportComplete).toHaveBeenCalledTimes(1);
  });

  it('shows selection count badge when pages are selected', () => {
    renderButton({ selectedCount: 3, selectedPageIndices: [0, 1, 2] });

    expect(screen.getByTestId('pdf-selection-count')).toHaveTextContent('3');
  });
});
