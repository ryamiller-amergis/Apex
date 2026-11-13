import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';
import { WorkItem } from '../../types/workitem';

let mockIsInAnyGroup = jest.fn(() => true);
let mockPermissionsLoaded = true;

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: mockIsInAnyGroup,
    permissionsLoaded: mockPermissionsLoaded,
  }),
}));

const createWrapper = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
};

global.fetch = jest.fn();

const RENAMABLE_EPIC = {
  id: 11,
  version: 'v1.0',
  status: 'New',
  progress: 0,
  completedItems: 0,
  totalItems: 0,
  greenItems: 0,
  amberItems: 0,
  redItems: 0,
  startDate: '',
  targetDate: '',
  description: '',
};

const LOCKED_EPIC = { ...RENAMABLE_EPIC, id: 22, version: 'v2.0', status: 'Done' };

function setupFetch(options: {
  renameOk?: boolean;
  renameError?: string;
  renameStatus?: number;
}) {
  (global.fetch as jest.Mock).mockImplementation((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/releases/epics')) {
      return Promise.resolve({ ok: true, json: async () => [RENAMABLE_EPIC, LOCKED_EPIC] });
    }
    if (url.includes('/rename') && method === 'PATCH') {
      const status = options.renameStatus ?? (options.renameOk !== false ? 200 : 409);
      return Promise.resolve({
        ok: options.renameOk !== false,
        status,
        json: async () =>
          options.renameOk !== false
            ? { success: true, oldName: 'v1.0', newName: 'v1.1' }
            : { error: options.renameError ?? 'Error' },
      });
    }
    return Promise.resolve({ ok: true, json: async () => [] });
  });
}

const mockWorkItems: WorkItem[] = [];
const defaultProps = { workItems: mockWorkItems, project: 'Proj', areaPath: 'Area' };

describe('ReleaseView – inline rename', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsInAnyGroup = jest.fn(() => true);
    mockPermissionsLoaded = true;
  });

  it('shows edit pencil on renamable-status releases for BA users', async () => {
    setupFetch({ renameOk: true });
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('release-rename-11')).toBeInTheDocument());
    expect(screen.getAllByText('✎').length).toBeGreaterThan(0);
  });

  it('does NOT show edit pencil on locked-status (Done) releases', async () => {
    setupFetch({ renameOk: true });
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByTestId('release-scope-filter-all'));
    fireEvent.click(await screen.findByTestId('release-card-22'));

    const doneHeader = await screen.findByTestId('release-rename-22');
    expect(doneHeader).toHaveTextContent('v2.0');
    expect(doneHeader).not.toHaveAttribute('title', 'Click to rename');
    expect(screen.queryByText('✎')).not.toBeInTheDocument();
  });

  it('does NOT show edit pencil for non-BA users', async () => {
    mockIsInAnyGroup = jest.fn(() => false);
    setupFetch({ renameOk: true });
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByTestId('release-rename-11')).toBeInTheDocument());
    expect(screen.queryByText('✎')).not.toBeInTheDocument();
  });

  it('activates inline input when clicking a renamable version', async () => {
    setupFetch({ renameOk: true });
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByTestId('release-rename-11'));

    const input = screen.getByTestId('release-rename-input-11') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe('v1.0');
  });

  it('cancels inline edit on Escape', async () => {
    setupFetch({ renameOk: true });
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByTestId('release-rename-11'));
    const input = screen.getByTestId('release-rename-input-11');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('release-rename-input-11')).not.toBeInTheDocument();
    expect(screen.getByTestId('release-rename-11')).toHaveTextContent('v1.0');
  });

  it('submits rename on Enter and calls PATCH /rename', async () => {
    setupFetch({ renameOk: true });
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByTestId('release-rename-11'));

    const input = screen.getByTestId('release-rename-input-11');
    fireEvent.change(input, { target: { value: 'v1.1' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const fetchCalls = (global.fetch as jest.Mock).mock.calls;
      const renameCall = fetchCalls.find(([url, opts]: any) =>
        String(url).includes('/rename') && opts?.method === 'PATCH',
      );
      expect(renameCall).toBeDefined();
      const body = JSON.parse(renameCall[1].body);
      expect(body.newName).toBe('v1.1');
    });
  });

  it('shows an error message when the API returns a 409', async () => {
    setupFetch({ renameOk: false, renameError: 'A release named "v1.1" already exists', renameStatus: 409 });
    render(<ReleaseView {...defaultProps} />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByTestId('release-rename-11'));

    const input = screen.getByTestId('release-rename-input-11');
    fireEvent.change(input, { target: { value: 'v1.1' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('release-rename-error-11')).toHaveTextContent('A release named "v1.1" already exists');
    });
  });
});
