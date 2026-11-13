import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';
import { WorkItem } from '../../types/workitem';

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

const okResponse = (data: any) =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
  });

const installFetchMock = (options: {
  epics?: any;
  relatedItems?: any;
  epicChildren?: any;
  featureChildren?: any;
}) => {
  const epics = options.epics ?? [];
  const relatedItems = options.relatedItems ?? [];
  const epicChildren = options.epicChildren ?? [];
  const featureChildren = options.featureChildren ?? [];

  (global.fetch as jest.Mock).mockImplementation((input: any) => {
    const url = typeof input === 'string' ? input : String(input);

    if (url.startsWith('/api/releases/epics')) return okResponse(epics);
    if (url.match(/\/api\/releases\/\d+\/related-items/)) return okResponse(relatedItems);
    if (url.match(/\/api\/epics\/\d+\/children/)) return okResponse(epicChildren);
    if (url.match(/\/api\/features\/\d+\/children/)) return okResponse(featureChildren);

    return okResponse([]);
  });
};

describe('ReleaseView - UAT Ready Highlighting', () => {
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

  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
  });

  it('should highlight Epic card when it has children in UAT Ready for Test state', async () => {
    const mockRelatedItems: WorkItem[] = [
      {
        id: 456,
        title: 'Epic A',
        state: 'In Progress',
        workItemType: 'Epic',
        assignedTo: 'John Doe',
        targetDate: '2026-03-01',
        tags: '',
        changedDate: '2026-02-01',
        createdDate: '2026-01-01',
        areaPath: mockAreaPath,
        iterationPath: 'Sprint 1',
      },
    ];

    const mockEpicChildren: WorkItem[] = [
      {
        id: 789,
        title: 'Feature in UAT',
        state: 'UAT - Ready For Test',
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

    installFetchMock({
      epics: mockEpics,
      relatedItems: mockRelatedItems,
      epicChildren: mockEpicChildren,
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() },
    );

    await screen.findByText('Epic A');
    await waitFor(() => {
      expect(screen.getByTestId('release-item-123-456')).toHaveClass('has-uat-ready');
    }, { timeout: 3000 });
  });

  it('should highlight Feature card when it has PBIs in UAT Ready for Test state', async () => {
    const mockRelatedItems: WorkItem[] = [
      {
        id: 456,
        title: 'Feature B',
        state: 'In Progress',
        workItemType: 'Feature',
        assignedTo: 'John Doe',
        targetDate: '2026-03-01',
        tags: '',
        changedDate: '2026-02-01',
        createdDate: '2026-01-01',
        areaPath: mockAreaPath,
        iterationPath: 'Sprint 1',
      },
    ];

    const mockFeatureChildren: WorkItem[] = [
      {
        id: 789,
        title: 'PBI in UAT',
        state: 'UAT - Ready For Test',
        workItemType: 'Product Backlog Item',
        assignedTo: 'Jane Smith',
        targetDate: '2026-03-15',
        tags: '',
        changedDate: '2026-02-05',
        createdDate: '2026-01-15',
        areaPath: mockAreaPath,
        iterationPath: 'Sprint 2',
      },
    ];

    installFetchMock({
      epics: mockEpics,
      relatedItems: mockRelatedItems,
      featureChildren: mockFeatureChildren,
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() },
    );

    await screen.findByText('Feature B');
    await waitFor(() => {
      expect(screen.getByTestId('release-item-123-456')).toHaveClass('has-uat-ready');
    }, { timeout: 3000 });
  });

  it('should not highlight card when children are not in UAT Ready for Test state', async () => {
    const mockRelatedItems: WorkItem[] = [
      {
        id: 456,
        title: 'Feature C',
        state: 'In Progress',
        workItemType: 'Feature',
        assignedTo: 'John Doe',
        targetDate: '2026-03-01',
        tags: '',
        changedDate: '2026-02-01',
        createdDate: '2026-01-01',
        areaPath: mockAreaPath,
        iterationPath: 'Sprint 1',
      },
    ];

    const mockFeatureChildren: WorkItem[] = [
      {
        id: 789,
        title: 'PBI in Progress',
        state: 'In Progress',
        workItemType: 'Product Backlog Item',
        assignedTo: 'Jane Smith',
        targetDate: '2026-03-15',
        tags: '',
        changedDate: '2026-02-05',
        createdDate: '2026-01-15',
        areaPath: mockAreaPath,
        iterationPath: 'Sprint 2',
      },
    ];

    installFetchMock({
      epics: mockEpics,
      relatedItems: mockRelatedItems,
      featureChildren: mockFeatureChildren,
    });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() },
    );

    await screen.findByText('Feature C');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByTestId('release-item-123-456')).not.toHaveClass('has-uat-ready');
  });

  it('should not highlight non-Epic/Feature work items', async () => {
    const mockRelatedItems: WorkItem[] = [
      {
        id: 456,
        title: 'Task A',
        state: 'In Progress',
        workItemType: 'Task',
        assignedTo: 'John Doe',
        targetDate: '2026-03-01',
        tags: '',
        changedDate: '2026-02-01',
        createdDate: '2026-01-01',
        areaPath: mockAreaPath,
        iterationPath: 'Sprint 1',
      },
    ];

    installFetchMock({
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
      { wrapper: createWrapper() },
    );

    await screen.findByText('Task A');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.getByTestId('release-item-123-456')).not.toHaveClass('has-uat-ready');
  });
});
