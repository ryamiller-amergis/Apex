import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUploadPdfFiles } from '../usePdfSession';

class MockXMLHttpRequest {
  static latest: MockXMLHttpRequest;
  static responseStatus = 200;
  static responseBody: unknown = {
    files: [{
      fileId: 'file-1',
      originalName: 'large.pdf',
      status: 'success',
      pageCount: 50,
      sizeBytes: 1024,
    }],
  };

  readonly upload: {
    onprogress: ((event: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  } = {
    onprogress: null,
    onload: null,
  };

  status = MockXMLHttpRequest.responseStatus;
  responseText = JSON.stringify(MockXMLHttpRequest.responseBody);
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockXMLHttpRequest.latest = this;
  }

  open = jest.fn();
  setRequestHeader = jest.fn();

  send = jest.fn(() => {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: 40,
      total: 100,
    } as ProgressEvent);
    this.upload.onload?.();
    this.onload?.();
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

describe('useUploadPdfFiles progress', () => {
  const originalXMLHttpRequest = global.XMLHttpRequest;

  beforeEach(() => {
    localStorage.clear();
    MockXMLHttpRequest.responseStatus = 200;
    MockXMLHttpRequest.responseBody = {
      files: [{
        fileId: 'file-1',
        originalName: 'large.pdf',
        status: 'success',
        pageCount: 50,
        sizeBytes: 1024,
      }],
    };
    global.XMLHttpRequest =
      MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    localStorage.clear();
    global.XMLHttpRequest = originalXMLHttpRequest;
  });

  it('reports upload percentage and server-processing phases', async () => {
    localStorage.setItem('selectedProject', 'Apex');
    const onProgress = jest.fn();
    const { result } = renderHook(() => useUploadPdfFiles(), {
      wrapper: createWrapper(),
    });
    const file = new File(['%PDF-test'], 'large.pdf', {
      type: 'application/pdf',
    });

    await act(async () => {
      await result.current.mutateAsync({
        sessionId: 'session-1',
        files: [file],
        onProgress,
      });
    });

    expect(MockXMLHttpRequest.latest.open).toHaveBeenCalledWith(
      'POST',
      '/api/pdf/sessions/session-1/upload',
    );
    expect(MockXMLHttpRequest.latest.withCredentials).toBe(true);
    expect(MockXMLHttpRequest.latest.setRequestHeader).toHaveBeenCalledWith(
      'X-Apex-Project',
      'Apex',
    );
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      phase: 'uploading',
      percent: 0,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      phase: 'uploading',
      percent: 40,
    });
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      phase: 'processing',
      percent: 100,
    });
  });

  it('preserves the HTTP status for an expired-session response', async () => {
    MockXMLHttpRequest.responseStatus = 410;
    MockXMLHttpRequest.responseBody = { error: 'Session has expired' };
    const { result } = renderHook(() => useUploadPdfFiles(), {
      wrapper: createWrapper(),
    });
    const file = new File(['%PDF-test'], 'large.pdf', {
      type: 'application/pdf',
    });

    await expect(result.current.mutateAsync({
      sessionId: 'expired-session',
      files: [file],
    })).rejects.toMatchObject({
      message: 'Session has expired',
      status: 410,
    });
  });
});
