/**
 * Unit tests for useExportSession hook utility functions.
 * Covers: AC-2 (.pdf extension), BR-008 (default filename format)
 */

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as exportSessionModule from '../useExportSession';
import { ensurePdfExtension, useExportSession } from '../useExportSession';

describe('ensurePdfExtension', () => {
  it('does not expose the retired client default filename helper', () => {
    expect('generateDefaultFilename' in exportSessionModule).toBe(false);
  });

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

  it('returns an empty string for empty input', () => {
    expect(ensurePdfExtension('')).toBe('');
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
    const originalCreateElement = document.createElement.bind(document);
    const createdAnchors: HTMLAnchorElement[] = [];
    const fetchMock = jest
      .fn()
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
          originalName: '',
          status: 'completed',
          resultFilename: 'source-combined.pdf',
          resultUrl: '/api/pdf/jobs/job-1/result',
          createdAt: new Date().toISOString(),
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['%PDF-test'], { type: 'application/pdf' }),
        headers: new Headers({
          'Content-Disposition': 'attachment; filename="server-derived.pdf"',
        }),
      } as Response);
    global.fetch = fetchMock;
    URL.createObjectURL = jest.fn().mockReturnValue('blob:test');
    URL.revokeObjectURL = jest.fn();
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    jest.spyOn(document, 'createElement').mockImplementation(((
      tagName: string
    ) => {
      const element = originalCreateElement(tagName);
      if (tagName === 'a') {
        createdAnchors.push(element as HTMLAnchorElement);
      }
      return element;
    }) as typeof document.createElement);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children
      );
    const { result } = renderHook(() => useExportSession(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        sessionId: 'session-1',
      });
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({});
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/pdf/sessions/session-1/export',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/pdf/jobs/job-1',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/pdf/jobs/job-1/result',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(createdAnchors[createdAnchors.length - 1]?.download).toBe(
      'server-derived.pdf'
    );

    global.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    click.mockRestore();
    jest.restoreAllMocks();
  });

  it('sends an explicit filename override and selected pages', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jobId: 'job-2',
          status: 'queued',
          queuePosition: 1,
          statusUrl: '/api/pdf/jobs/job-2',
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'job-2',
          sessionId: 'session-1',
          jobType: 'export',
          originalName: 'custom.pdf',
          status: 'completed',
          resultFilename: 'custom.pdf',
          resultUrl: '/api/pdf/jobs/job-2/result',
          createdAt: new Date().toISOString(),
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(['%PDF-test'], { type: 'application/pdf' }),
        headers: new Headers({
          'Content-Disposition': 'attachment; filename="custom.pdf"',
        }),
      } as Response);
    global.fetch = fetchMock;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn().mockReturnValue('blob:test');
    URL.revokeObjectURL = jest.fn();
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children
      );
    const { result } = renderHook(() => useExportSession(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        sessionId: 'session-1',
        filename: 'custom',
        pages: [0, 2],
      });
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      filename: 'custom.pdf',
      pages: [0, 2],
    });

    global.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    click.mockRestore();
  });
});
