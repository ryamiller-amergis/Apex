import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: () => true,
    permissionsLoaded: true,
    can: () => true,
  }),
}));

describe('ReleaseView - Area-Path-Aware Release Creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? 'GET').toUpperCase();
      if (url.startsWith('/api/releases/epics')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url.includes('/api/projects/MaxView/area-paths')) {
        return Promise.resolve({
          ok: true,
          json: async () => ['MaxView', 'MaxView\\Desktop', 'MaxView\\Mobile'],
        });
      }
      if (url.includes('/api/releases/v2.4.0/tag') && method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, epicId: 777 }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as jest.Mock;
  });

  it('submits the chosen sub-areaPath to POST /api/releases/:version/tag', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ReleaseView workItems={[]} project="MaxView" areaPath="MaxView" />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByTestId('release-create'));
    const areaSelect = await screen.findByTestId('release-form-area-path');
    await user.selectOptions(areaSelect, 'MaxView\\Mobile');
    await user.type(screen.getByTestId('release-form-name'), 'v2.4.0');
    await user.type(screen.getByTestId('release-form-start-date'), '2026-11-01');
    await user.type(screen.getByTestId('release-form-target-date'), '2026-11-20');
    await user.type(screen.getByTestId('release-form-description'), 'Mobile release');
    await user.click(screen.getByTestId('release-form-save'));

    await waitFor(() => {
      const postCall = (global.fetch as jest.Mock).mock.calls.find(
        ([url, opts]: [RequestInfo | URL, RequestInit?]) =>
          String(url).includes('/api/releases/v2.4.0/tag') && opts?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall[1].body)).toMatchObject({
        project: 'MaxView',
        areaPath: 'MaxView\\Mobile',
        startDate: '2026-11-01',
        targetDate: '2026-11-20',
        description: 'Mobile release',
      });
    });
  });
});
