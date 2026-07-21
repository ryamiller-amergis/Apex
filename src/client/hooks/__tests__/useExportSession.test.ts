/**
 * Unit tests for useExportSession hook utility functions.
 * Covers: AC-2 (.pdf extension), BR-008 (default filename format)
 */

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  generateDefaultFilename,
  ensurePdfExtension,
  useExportSession,
} from '../useExportSession';

describe('generateDefaultFilename', () => {
  // BR-008: default filename follows merged-document-YYYYMMDD-HHMM.pdf format
  it('BR-008: generates filename in merged-document-YYYYMMDD-HHMM.pdf format', () => {
    const result = generateDefaultFilename();
    expect(result).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });
});

describe('ensurePdfExtension', () => {
  // AC-2: appends .pdf if missing
  it('AC-2: appends .pdf to filename without extension', () => {
    expect(ensurePdfExtension('my-report')).toBe('my-report.pdf');
  });

  it('AC-2: preserves .pdf when already present', () => {
    expect(ensurePdfExtension('my-report.pdf')).toBe('my-report.pdf');
  });

  it('AC-2: case-insensitive .PDF detection', () => {
    expect(ensurePdfExtension('my-report.PDF')).toBe('my-report.PDF');
  });

  it('falls back to default for empty string', () => {
    expect(ensurePdfExtension('')).toMatch(/^merged-document-\d{8}-\d{4}\.pdf$/);
  });

  it('trims whitespace before checking', () => {
    expect(ensurePdfExtension('  my-doc  ')).toBe('my-doc.pdf');
  });
});

describe('useExportSession queued workflow', () => {
  it('enqueues, polls completion, then downloads the authenticated result', async () => {
    const originalFetch = global.fetch;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jobId: 'job-1',
          status: 'queued',
          queuePosition: 1,
          statusUrl: '/api/pdf/jobs/job-1',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'job-1',
          sessionId: 'session-1',
          jobType: 'export',
          originalName: 'report.pdf',
          status: 'completed',
          resultUrl: '/api/pdf/jobs/job-1/result',
          createdAt: new Date().toISOString(),
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['%PDF-test'], { type: 'application/pdf' }),
        headers: new Headers({ 'Content-Disposition': 'attachment; filename="report.pdf"' }),
      } as Response);
    global.fetch = fetchMock;
    URL.createObjectURL = jest.fn().mockReturnValue('blob:test');
    URL.revokeObjectURL = jest.fn();
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useExportSession(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        sessionId: 'session-1',
        filename: 'report',
      });
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/pdf/sessions/session-1/export',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/pdf/jobs/job-1',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/pdf/jobs/job-1/result',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();

    global.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    click.mockRestore();
  });
});
