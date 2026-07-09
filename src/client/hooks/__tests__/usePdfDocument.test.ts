import { act, renderHook, waitFor } from '@testing-library/react';

// ── Mock pdfjs-dist ────────────────────────────────────────────────────────────

const mockDocumentProxy = {
  numPages: 5,
  destroy: jest.fn(),
  getPage: jest.fn(),
};

const mockGetDocument = jest.fn();

jest.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

// ── Mock PdfWorkerContext ──────────────────────────────────────────────────────

const mockContextGetDocument = jest.fn();

jest.mock('../../contexts/PdfWorkerContext', () => ({
  usePdfWorker: () => ({
    getDocument: mockContextGetDocument,
  }),
}));

import { usePdfDocument } from '../usePdfDocument';

describe('usePdfDocument', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextGetDocument.mockResolvedValue(mockDocumentProxy);
  });

  it('returns null document when fileUrl is null', () => {
    const { result } = renderHook(() => usePdfDocument(null));

    expect(result.current.document).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('loads document when fileUrl is provided', async () => {
    const { result } = renderHook(() => usePdfDocument('/api/pdf/files/abc'));

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.document).toBe(mockDocumentProxy);
    expect(result.current.error).toBeNull();
    expect(mockContextGetDocument).toHaveBeenCalledWith('/api/pdf/files/abc');
  });

  it('sets error on failure', async () => {
    jest.useFakeTimers();
    mockContextGetDocument.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => usePdfDocument('/api/pdf/files/bad'));

    // Hook retries twice (MAX_RETRIES=2) with 1s delay before surfacing the error
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.document).toBeNull();
    expect(result.current.error).toBe('Network error');
    expect(mockContextGetDocument).toHaveBeenCalledTimes(3);

    jest.useRealTimers();
  });

  it('reloads when fileUrl changes', async () => {
    const doc1 = { ...mockDocumentProxy, numPages: 3 };
    const doc2 = { ...mockDocumentProxy, numPages: 7 };
    mockContextGetDocument
      .mockResolvedValueOnce(doc1)
      .mockResolvedValueOnce(doc2);

    const { result, rerender } = renderHook(
      ({ url }: { url: string | null }) => usePdfDocument(url),
      { initialProps: { url: '/file/1' } },
    );

    await waitFor(() => {
      expect(result.current.document).toBe(doc1);
    });

    rerender({ url: '/file/2' });

    await waitFor(() => {
      expect(result.current.document).toBe(doc2);
    });
  });
});
