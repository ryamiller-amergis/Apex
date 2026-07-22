/**
 * Unit tests for ExportPanel component.
 * Covers: AC-0 (export triggers download), AC-1 (loading indicator),
 *         AC-2 (custom filename), AC-3 (error toast with retry),
 *         BR-008 (default filename), NFR-a11y (ARIA attributes),
 *         empty-session (disabled button)
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ExportPanel } from '../ExportPanel';

// ── Mocks ──────────────────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderPanel(nonDeletedPageCount = 10) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ExportPanel
        sessionId="session-123"
        nonDeletedPageCount={nonDeletedPageCount}
        filenameOverride=""
        automaticFilename="source.pdf"
        isFilenameAutomatic={true}
        onFilenameOverrideChange={jest.fn()}
      />
    </QueryClientProvider>
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockMutate = jest.fn();
  mockMutationState = {
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
  };
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ExportPanel', () => {
  // AC-0: export triggers download via mutation
  it('AC-0: calls mutate with only sessionId when Export is clicked with no override', async () => {
    renderPanel();

    const exportButton = screen.getByTestId('pdf-export-button');
    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });
    expect(mockMutate).toHaveBeenCalledWith({
      sessionId: 'session-123',
    });
  });

  // AC-1: loading indicator during export
  it('AC-1: shows loading spinner and Exporting text when isPending', () => {
    mockMutationState.isPending = true;
    renderPanel();

    expect(screen.getByTestId('pdf-export-loading')).toBeInTheDocument();
    expect(screen.getByText(/Exporting/)).toBeInTheDocument();
  });

  // AC-1: export button is disabled during export
  it('AC-1: disables export button and filename input during export', () => {
    mockMutationState.isPending = true;
    renderPanel();

    expect(screen.getByTestId('pdf-export-button')).toBeDisabled();
    expect(screen.getByTestId('pdf-export-filename-input')).toBeDisabled();
  });

  // AC-2: custom filename passed to mutate
  it('AC-2: passes custom filename to mutate when user changes input', async () => {
    const onFilenameOverrideChange = jest.fn();
    const queryClient = createQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={10}
          filenameOverride="my-custom-report.pdf"
          automaticFilename="source.pdf"
          isFilenameAutomatic={false}
          onFilenameOverrideChange={onFilenameOverrideChange}
        />
      </QueryClientProvider>
    );

    const input = screen.getByTestId('pdf-export-filename-input');
    fireEvent.change(input, { target: { value: 'my-custom-report-2.pdf' } });
    expect(onFilenameOverrideChange).toHaveBeenCalledWith(
      'my-custom-report-2.pdf'
    );

    const exportButton = screen.getByTestId('pdf-export-button');
    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith({
        sessionId: 'session-123',
        filename: 'my-custom-report.pdf',
      });
    });
  });

  // AC-3: error toast with retry on server error
  it('AC-3: shows error toast when isError is true', () => {
    mockMutationState.isError = true;
    mockMutationState.error = Object.assign(
      new Error('PDF assembly failed. Please retry.'),
      { code: 'EXPORT_FAILED' }
    );
    renderPanel();

    expect(screen.getByTestId('pdf-export-error-toast')).toBeInTheDocument();
    expect(
      screen.getByText('PDF assembly failed. Please retry.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('pdf-export-retry-button')).toBeInTheDocument();
  });

  // AC-3: retry button calls mutate again
  it('AC-3: retry button triggers export again', async () => {
    mockMutationState.isError = true;
    mockMutationState.error = Object.assign(new Error('Export failed'), {
      code: 'EXPORT_FAILED',
    });
    renderPanel();

    const retryButton = screen.getByTestId('pdf-export-retry-button');
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });
  });

  it('shows automatic filename as the input value in automatic mode', () => {
    renderPanel();

    const input = screen.getByTestId(
      'pdf-export-filename-input'
    ) as HTMLInputElement;
    expect(input.value).toBe('source.pdf');
    expect(input).toHaveAttribute('data-filename-mode', 'automatic');
  });

  it('keeps long automatic filenames bound to the value contract', () => {
    const queryClient = createQueryClient();
    const longAutomaticName =
      'very-long-source-name-that-should-wrap-safely-inside-the-export-panel-without-overflowing-combined.pdf';

    render(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={5}
          filenameOverride=""
          automaticFilename={longAutomaticName}
          isFilenameAutomatic={true}
          onFilenameOverrideChange={jest.fn()}
        />
      </QueryClientProvider>
    );

    const input = screen.getByTestId(
      'pdf-export-filename-input'
    ) as HTMLInputElement;
    expect(input.value).toBe(longAutomaticName);
    expect(input).toHaveAttribute('data-filename-mode', 'automatic');
  });

  it('shows override value and mode when isFilenameAutomatic is false', () => {
    const queryClient = createQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={5}
          filenameOverride="user-typed.pdf"
          automaticFilename="source.pdf"
          isFilenameAutomatic={false}
          onFilenameOverrideChange={jest.fn()}
        />
      </QueryClientProvider>
    );

    const input = screen.getByTestId(
      'pdf-export-filename-input'
    ) as HTMLInputElement;
    expect(input.value).toBe('user-typed.pdf');
    expect(input).toHaveAttribute('data-filename-mode', 'override');
  });

  it('does not send filename to server in automatic mode', async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('pdf-export-button'));
    await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(1));
    expect(mockMutate).toHaveBeenCalledWith({ sessionId: 'session-123' });
  });

  // NFR-a11y: ARIA attributes on export button
  it('NFR-a11y: export button has aria-busy=true during export', () => {
    mockMutationState.isPending = true;
    renderPanel();

    const button = screen.getByTestId('pdf-export-button');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-label', 'Exporting document');
  });

  it('NFR-a11y: export button has correct aria-label when ready', () => {
    renderPanel();

    const button = screen.getByTestId('pdf-export-button');
    expect(button).toHaveAttribute('aria-label', 'Export PDF');
  });

  it('NFR-a11y: error toast has role=alert', () => {
    mockMutationState.isError = true;
    mockMutationState.error = Object.assign(new Error('fail'), {
      code: 'EXPORT_FAILED',
    });
    renderPanel();

    expect(screen.getByTestId('pdf-export-error-toast')).toHaveAttribute(
      'role',
      'alert'
    );
  });

  // Empty session: button disabled
  it('empty-session: Export button is disabled when nonDeletedPageCount is 0', () => {
    renderPanel(0);

    const button = screen.getByTestId('pdf-export-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Add pages to export');
  });

  // Ready state: button enabled
  it('Export button is enabled when session has pages', () => {
    renderPanel(5);

    const button = screen.getByTestId('pdf-export-button');
    expect(button).not.toBeDisabled();
  });

  // Panel renders with correct test IDs
  it('renders all expected data-testid elements', () => {
    renderPanel();

    expect(screen.getByTestId('pdf-export-panel')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-export-filename-input')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-export-button')).toBeInTheDocument();
  });

  // Filename input has associated label
  it('NFR-a11y: filename input has associated label', () => {
    renderPanel();

    const input = screen.getByTestId('pdf-export-filename-input');
    expect(input).toHaveAttribute('id', 'pdf-export-filename');
    expect(screen.getByLabelText('Filename')).toBe(input);
  });

  it('awaits onBeforeExport before calling mutate', async () => {
    let resolveBefore!: () => void;
    const onBeforeExport = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveBefore = resolve;
        })
    );
    const queryClient = createQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={5}
          filenameOverride=""
          automaticFilename="source.pdf"
          onFilenameOverrideChange={jest.fn()}
          onBeforeExport={onBeforeExport}
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByTestId('pdf-export-button'));

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
    const onBeforeExport = jest
      .fn()
      .mockRejectedValue(new Error('Save failed'));
    const queryClient = createQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={5}
          filenameOverride=""
          automaticFilename="source.pdf"
          onFilenameOverrideChange={jest.fn()}
          onBeforeExport={onBeforeExport}
        />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByTestId('pdf-export-button'));

    expect(
      await screen.findByTestId('pdf-export-error-toast')
    ).toHaveTextContent('Save failed');
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('calls onExportComplete once when export succeeds', () => {
    mockMutationState.isSuccess = true;
    const onExportComplete = jest.fn();
    const queryClient = createQueryClient();

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={5}
          filenameOverride=""
          automaticFilename="source.pdf"
          onFilenameOverrideChange={jest.fn()}
          onExportComplete={onExportComplete}
        />
      </QueryClientProvider>
    );

    expect(onExportComplete).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={5}
          filenameOverride=""
          automaticFilename="source.pdf"
          onFilenameOverrideChange={jest.fn()}
          onExportComplete={() => onExportComplete()}
        />
      </QueryClientProvider>
    );

    expect(onExportComplete).toHaveBeenCalledTimes(1);
  });

  it('uses the controlled override when provided', async () => {
    const queryClient = createQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ExportPanel
          sessionId="session-123"
          nonDeletedPageCount={5}
          filenameOverride="controlled-name.pdf"
          automaticFilename="source.pdf"
          isFilenameAutomatic={false}
          onFilenameOverrideChange={jest.fn()}
        />
      </QueryClientProvider>
    );

    const input = screen.getByTestId(
      'pdf-export-filename-input'
    ) as HTMLInputElement;
    expect(input.value).toBe('controlled-name.pdf');

    fireEvent.click(screen.getByTestId('pdf-export-button'));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith({
        sessionId: 'session-123',
        filename: 'controlled-name.pdf',
      });
    });
  });
});
