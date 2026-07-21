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
  epicsAfterDelete?: any;
  deleteOk?: boolean;
  deleteBody?: any;
  neverResolveDelete?: boolean;
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
  const epicsAfterDelete = options.epicsAfterDelete ?? epics;
  const deleteOk = options.deleteOk ?? true;
  const deleteBody = options.deleteBody ?? { success: true };

  let epicsCallCount = 0;

  (global.fetch as jest.Mock).mockImplementation((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();

    if (url.startsWith('/api/releases/epics')) {
      const body = epicsCallCount++ === 0 ? epics : epicsAfterDelete;
      return okResponse(body);
    }

    if (url.startsWith('/api/releases?')) {
      return okResponse(releases);
    }

    if (url.startsWith('/api/releases/') && method === 'DELETE') {
      if (options.neverResolveDelete) {
        return new Promise(() => {
          // Intentionally never resolve
        });
      }

      return deleteOk ? okResponse(deleteBody) : errorResponse(deleteBody, 404);
    }

    // Default for any other endpoint ReleaseView might call in the future
    return okResponse([]);
  });
};

describe('ReleaseView - Delete Epic Functionality', () => {
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
      completedItems: 5,
      totalItems: 10,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
  });

  it('should render delete button in action menu', async () => {
    installFetchMock({ releases: [], epics: mockEpics });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Actions'));
    expect(screen.getByText('🗑️ Delete')).toBeInTheDocument();
  });

  it('should open delete confirmation modal when delete is clicked', async () => {
    installFetchMock({ releases: [], epics: mockEpics });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('🗑️ Delete'));

    expect(screen.getByText('Confirm Delete Release Epic')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete this release epic/i)).toBeInTheDocument();
  });

  it('should successfully delete epic when confirmed', async () => {
    installFetchMock({ releases: [], epics: mockEpics, epicsAfterDelete: [] });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('🗑️ Delete'));
    fireEvent.click(screen.getByText('Delete Epic'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          `/api/releases/123?project=${encodeURIComponent(mockProject)}&areaPath=${encodeURIComponent(mockAreaPath)}`
        ),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('Confirm Delete Release Epic')).not.toBeInTheDocument();
    });
  });

  it('should close modal when cancel is clicked', async () => {
    installFetchMock({ releases: [], epics: mockEpics });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('🗑️ Delete'));
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('Confirm Delete Release Epic')).not.toBeInTheDocument();
    });
  });

  it('should alert on delete errors', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => undefined);

    installFetchMock({
      releases: [],
      epics: mockEpics,
      deleteOk: false,
      deleteBody: { error: 'Epic not found' },
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

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('🗑️ Delete'));
    fireEvent.click(screen.getByText('Delete Epic'));

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('Failed to delete epic:'));
    });

    consoleError.mockRestore();
    alertMock.mockRestore();
  });

  it('should disable confirm button while deleting', async () => {
    installFetchMock({ releases: [], epics: mockEpics, neverResolveDelete: true });

    render(
      <ReleaseView
        workItems={mockWorkItems}
        project={mockProject}
        areaPath={mockAreaPath}
        onSelectItem={mockOnSelectItem}
      />,
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Actions'));
    fireEvent.click(screen.getByText('🗑️ Delete'));
    fireEvent.click(screen.getByText('Delete Epic'));

    await waitFor(() => {
      const deletingButton = screen.getByText('Deleting...');
      expect(deletingButton).toBeDisabled();
    });
  });
});
