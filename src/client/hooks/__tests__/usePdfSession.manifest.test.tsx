import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OverlayTextBox, PdfSession } from '../../../shared/types/pdf';
import { useUpdateManifest } from '../usePdfSession';

const overlay: OverlayTextBox = {
  id: '00000000-0000-4000-8000-000000000001',
  pageId: 'page-1',
  x: 10,
  y: 20,
  width: 30,
  height: 10,
  text: 'Remaining overlay',
  fontFamily: 'Helvetica',
  fontSize: 14,
  bold: false,
  italic: false,
  color: '#000000',
  horizontalAlign: 'left',
  verticalAlign: 'top',
  opacity: 100,
  rotation: 0,
  listStyle: 'none',
  zIndex: 1,
};

describe('useUpdateManifest', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('applies server-cleaned overlays to the session cache immediately', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const sessionId = 'session-1';
    const userId = 'user-1';
    const session = {
      id: sessionId,
      userId,
      status: 'active',
      pageManifest: [],
      textOverlays: [{ ...overlay, pageId: 'removed-page' }],
      fileMetadata: [],
      conversionJobs: [],
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z',
      expiresAt: '2026-07-21T16:00:00.000Z',
    } satisfies PdfSession;
    queryClient.setQueryData(['pdf-session', userId, sessionId], session);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pageCount: 1,
        updatedAt: '2026-07-21T12:01:00.000Z',
        textOverlays: [overlay],
      }),
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateManifest(userId), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ sessionId, manifest: [] });
    });

    expect(
      queryClient.getQueryData<PdfSession>(['pdf-session', userId, sessionId])
        ?.textOverlays
    ).toEqual([overlay]);
  });
});
