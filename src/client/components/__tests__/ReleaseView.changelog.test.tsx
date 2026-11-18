import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-markdown-render">{children}</div>
  ),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: () => true,
    permissionsLoaded: true,
    can: () => true,
  }),
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

const okResponse = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
  });

describe('ReleaseView — Create Changelog action & modal', () => {
  const mockEpics = [
    {
      id: 101,
      version: 'MV 2027.01.13',
      status: 'In Progress',
      targetDate: '2027-01-13',
      progress: 75,
      completedItems: 3,
      totalItems: 4,
      greenItems: 3,
      amberItems: 1,
      redItems: 0,
      childItemsSummary: [
        { id: 501, state: 'Done', tags: 'Mobile' },
        { id: 502, state: 'Done', tags: 'Desktop' },
      ],
    },
  ];

  const sampleChangelogResponse = {
    epicId: 101,
    version: 'MV 2027.01.13',
    filename: 'mv-2027.01.13-changelog.md',
    markdown:
      '# MV 2027.01.13 — Release Notes\n\n**Target Date:** 2027-01-13 | **Platforms:** Desktop, Mobile\n\n## Desktop\n\n- **Tray Quick-Launch** — Open MaxView faster from the system tray.\n\n## Mobile\n\n- **Offline Inspections** — Capture field inspections offline and sync automatically.',
    itemCount: 2,
    leafItemCount: 4,
    platformsIncluded: ['Desktop', 'Mobile'],
    generatedAt: '2026-11-16T17:00:00.000Z',
    source: 'ai' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.startsWith('/api/releases/epics')) {
        return okResponse(mockEpics);
      }
      if (url.startsWith('/api/releases/platforms')) {
        return okResponse({
          project: 'MaxView',
          platforms: [
            {
              id: 'plat-desktop',
              project: 'MaxView',
              slug: 'desktop',
              name: 'Desktop',
              color: 'blue',
              sortOrder: 0,
              createdAt: '2026-11-16T00:00:00.000Z',
            },
            {
              id: 'plat-mobile',
              project: 'MaxView',
              slug: 'mobile',
              name: 'Mobile',
              color: 'purple',
              sortOrder: 1,
              createdAt: '2026-11-16T00:01:00.000Z',
            },
          ],
          epicPlatformIds: {},
          workItemPlatformIds: {},
        });
      }
      if (url === '/api/releases/101/changelog' && method === 'POST') {
        return okResponse(sampleChangelogResponse);
      }
      return okResponse([]);
    }) as unknown as typeof fetch;
  });

  it('generates a platform-aware executive Markdown changelog and downloads the .md file', async () => {
    const user = userEvent.setup();
    const createObjectUrlMock = jest.fn(() => 'blob:mock-changelog-url');
    const revokeObjectUrlMock = jest.fn();
    Object.defineProperty(window.URL, 'createObjectURL', {
      writable: true,
      value: createObjectUrlMock,
    });
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      writable: true,
      value: revokeObjectUrlMock,
    });
    const anchorClickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    render(<ReleaseView workItems={[]} project="MaxView" areaPath="MaxView" />, {
      wrapper: createWrapper(),
    });

    await screen.findByText('MV 2027.01.13');

    // Open Actions menu on epic 101 and click Create Changelog
    await user.click(screen.getByTestId('release-actions-101'));
    await user.click(screen.getByTestId('release-action-changelog-101'));

    // Modal opens and renders the generated changelog + metadata
    const modal = await screen.findByTestId('release-changelog-modal');
    expect(modal).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('release-changelog-preview')).toHaveTextContent(
        'Offline Inspections',
      );
    });
    expect(modal).toHaveTextContent('2 linked items (4 deliverables rolled up)');
    expect(modal).toHaveTextContent('mv-2027.01.13-changelog.md');

    // Switch to Edit Markdown tab and verify editable textarea
    await user.click(screen.getByTestId('release-changelog-tab-markdown'));
    const editor = screen.getByTestId('release-changelog-editor') as HTMLTextAreaElement;
    expect(editor.value).toContain('## Mobile');

    // Click Download .md and verify blob download triggers
    await user.click(screen.getByTestId('release-changelog-download'));
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith('blob:mock-changelog-url');

    anchorClickSpy.mockRestore();
  });
});
