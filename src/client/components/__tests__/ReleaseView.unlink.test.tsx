import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';
import { WorkItem } from '../../types/workitem';

// Mock useAppShell so the component does not pull in the real hook chain
// (useWorkItems → config/env), which reads `import.meta.env` and cannot be
// evaluated under ts-jest's CommonJS transform.
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: () => true,
    permissionsLoaded: true,
  }),
}));

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

global.fetch = jest.fn();

type MockFetchOptions = {
  releases?: any;
  epics?: any;
  relatedItems?: any;
  relatedItemsAfterUnlink?: any;
  epicsAfterUnlink?: any;
  unlinkOk?: boolean;
  unlinkBody?: any;
};

const okResponse = (data: any) =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
  });

const errorResponse = (data: any, status = 500) =>
  Promise.resolve({
    ok: false,
    status,
    statusText: 'Error',
    json: async () => data,
  });

const installFetchMock = (options: MockFetchOptions) => {
  const releases = options.releases ?? [];
  const epics = options.epics ?? [];
  const relatedItems = options.relatedItems ?? [];
  const relatedItemsAfterUnlink = options.relatedItemsAfterUnlink ?? relatedItems;
  const epicsAfterUnlink = options.epicsAfterUnlink ?? epics;
  const unlinkOk = options.unlinkOk ?? true;
  const unlinkBody = options.unlinkBody ?? { success: true, unlinkedCount: 1 };

  let epicsCallCount = 0;
  let relatedItemsCallCount = 0;

  (global.fetch as jest.Mock).mockImplementation((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();

    if (url.startsWith('/api/releases/epics')) {
      const body = epicsCallCount++ === 0 ? epics : epicsAfterUnlink;
      return okResponse(body);
    }

    if (url.startsWith('/api/releases?')) {
      return okResponse(releases);
    }

    if (url.match(/\/api\/releases\/\d+\/related-items/)) {
      const body = relatedItemsCallCount++ === 0 ? relatedItems : relatedItemsAfterUnlink;
      return okResponse(body);
    }

    if (url.match(/\/api\/releases\/\d+\/unlink-related/) && method === 'POST') {
      return unlinkOk ? okResponse(unlinkBody) : errorResponse(unlinkBody, 500);
    }

    // Default for any other endpoint
    return okResponse([]);
  });
};

describe('ReleaseView - Unlink Item Functionality', () => {
  const mockWorkItems: WorkItem[] = [];
  const mockProject = 'TestProject';
  const mockAreaPath = 'TestArea';
  const mockOnSelectItem = jest.fn();

  const mockEpics = [
    {
      id: 123,
      title: 'Release 1.0',
      version: 'v1.0.0',
      status: 'In Progress',
      progress: 50,
      completedItems: 1,
      totalItems: 2,
    },
  ];

  const mockRelatedItems: WorkItem[] = [
    {
      id: 456,
      title: 'Feature A',
      state: 'Done',
      workItemType: 'Feature',
      assignedTo: 'John Doe',
      targetDate: '2026-03-01',
      tags: '',
      changedDate: '2026-02-01',
      createdDate: '2026-01-01',
      areaPath: mockAreaPath,
      iterationPath: 'Sprint 1',
    },
    {
      id: 789,
      title: 'Feature B',
      state: 'In Progress',
      workItemType: 'Feature',
      assignedTo: 'Jane Smith',
      targetDate: '2026-03-15',
      tags: '',
      changedDate: '2026-02-05',
      createdDate: '2026-01-15',
      areaPath: mockAreaPath,
      iterationPath: 'Sprint 2',
    },
  ];

  const mockRelatedItemsAfterUnlink: WorkItem[] = [
    {
      id: 789,
      title: 'Feature B',
      state: 'In Progress',
      workItemType: 'Feature',
      assignedTo: 'Jane Smith',
      targetDate: '2026-03-15',
      tags: '',
      changedDate: '2026-02-05',
      createdDate: '2026-01-15',
      areaPath: mockAreaPath,
      iterationPath: 'Sprint 2',
    },
  ];

  const mockEpicsAfterUnlink = [
    {
      id: 123,
      title: 'Release 1.0',
      version: 'v1.0.0',
      status: 'In Progress',
      progress: 50,
      completedItems: 1,
      totalItems: 1,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
    // Mock window.confirm to return true by default
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should render unlink button on hover', async () => {
    installFetchMock({
      releases: [],
      epics: mockEpics,
      relatedItems: mockRelatedItems,
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    // Wait for epics to load
    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    // Click to expand the row
    const expandButton = screen.getByTitle('Expand');
    fireEvent.click(expandButton);

    // Wait for related items to load
    await waitFor(() => {
      expect(screen.getByText('Feature A')).toBeInTheDocument();
    });

    // Find the unlink buttons (they should exist but be hidden via CSS)
    const unlinkButtons = screen.getAllByTitle('Unlink from release');
    expect(unlinkButtons).toHaveLength(2);
  });

  it('should successfully unlink item when unlink button is clicked', async () => {
    installFetchMock({
      releases: [],
      epics: mockEpics,
      relatedItems: mockRelatedItems,
      relatedItemsAfterUnlink: mockRelatedItemsAfterUnlink,
      epicsAfterUnlink: mockEpicsAfterUnlink,
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    // Wait for epics to load
    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    // Expand the row
    const expandButton = screen.getByTitle('Expand');
    fireEvent.click(expandButton);

    // Wait for related items to load
    await waitFor(() => {
      expect(screen.getByText('Feature A')).toBeInTheDocument();
    });

    // Click unlink button on first item
    const unlinkButtons = screen.getAllByTitle('Unlink from release');
    fireEvent.click(unlinkButtons[0]);

    // Verify confirm was called
    expect(global.confirm).toHaveBeenCalledWith(
      'Are you sure you want to unlink this item from the release?'
    );

    // Wait for API call to complete
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/releases/123/unlink-related'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"workItemIds":[456]'),
        })
      );
    });

    // Feature A should be removed from the list
    await waitFor(() => {
      expect(screen.queryByText('Feature A')).not.toBeInTheDocument();
    });

    // Feature B should still be there
    expect(screen.getByText('Feature B')).toBeInTheDocument();
  });

  it('should not unlink if user cancels confirmation', async () => {
    global.confirm = jest.fn(() => false);

    installFetchMock({
      releases: [],
      epics: mockEpics,
      relatedItems: mockRelatedItems,
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    // Wait for epics to load
    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    // Expand the row
    const expandButton = screen.getByTitle('Expand');
    fireEvent.click(expandButton);

    // Wait for related items to load
    await waitFor(() => {
      expect(screen.getByText('Feature A')).toBeInTheDocument();
    });

    // Click unlink button
    const unlinkButtons = screen.getAllByTitle('Unlink from release');
    fireEvent.click(unlinkButtons[0]);

    // Verify confirm was called but API was not
    expect(global.confirm).toHaveBeenCalled();

    // Wait a bit to ensure no API call was made
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify unlink API was never called
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/unlink-related'),
      expect.anything()
    );

    // Both items should still be present
    expect(screen.getByText('Feature A')).toBeInTheDocument();
    expect(screen.getByText('Feature B')).toBeInTheDocument();
  });

  it('should handle unlink errors gracefully', async () => {
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    installFetchMock({
      releases: [],
      epics: mockEpics,
      relatedItems: mockRelatedItems,
      unlinkOk: false,
      unlinkBody: { error: 'Failed to unlink work item' },
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    // Wait for epics to load
    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    // Expand the row
    const expandButton = screen.getByTitle('Expand');
    fireEvent.click(expandButton);

    // Wait for related items to load
    await waitFor(() => {
      expect(screen.getByText('Feature A')).toBeInTheDocument();
    });

    // Click unlink button
    const unlinkButtons = screen.getAllByTitle('Unlink from release');
    fireEvent.click(unlinkButtons[0]);

    // Wait for error handling
    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(
        expect.stringContaining('Failed to unlink item:')
      );
    });

    // Both items should still be present (unlink failed)
    expect(screen.getByText('Feature A')).toBeInTheDocument();
    expect(screen.getByText('Feature B')).toBeInTheDocument();

    consoleError.mockRestore();
    alertMock.mockRestore();
  });

  it('should not propagate click event to card when unlink button is clicked', async () => {
    installFetchMock({
      releases: [],
      epics: mockEpics,
      relatedItems: mockRelatedItems,
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    // Wait for epics to load
    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    // Expand the row
    const expandButton = screen.getByTitle('Expand');
    fireEvent.click(expandButton);

    // Wait for related items to load
    await waitFor(() => {
      expect(screen.getByText('Feature A')).toBeInTheDocument();
    });

    // Click unlink button (which should cancel confirmation)
    global.confirm = jest.fn(() => false);
    const unlinkButtons = screen.getAllByTitle('Unlink from release');
    fireEvent.click(unlinkButtons[0]);

    // Verify that onSelectItem was not called
    expect(mockOnSelectItem).not.toHaveBeenCalled();
  });
});
