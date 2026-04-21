import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BacklogView from '../BacklogView';
import type { BacklogDocument } from '../../types/workitem';

// Suppress console.error noise from React Query retries during error tests
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  (console.error as jest.Mock).mockRestore();
});

// ---------------------------------------------------------------------------
// Mock BacklogDetailsPanel so it doesn't need its heavy dependencies
// ---------------------------------------------------------------------------
jest.mock('../BacklogDetailsPanel', () => ({
  BacklogDetailsPanel: ({ node, onClose }: { node: { title: string }; onClose: () => void }) => (
    <div data-testid="details-panel">
      <span data-testid="panel-title">{node.title}</span>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

const mockFetch = (data: unknown, ok = true, status = 200) => {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    json: jest.fn().mockResolvedValue(data),
  } as unknown as Response);
};

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------
const makeDoc = (overrides: Partial<BacklogDocument> = {}): BacklogDocument => ({
  id: 1,
  title: 'Sprint 1 Requirements',
  path: '/requirement-drafts/sprint-1',
  document: {
    epics: [
      {
        id: 'epic-1',
        workItemType: 'Epic',
        title: 'User Authentication',
        status: 'Draft',
        priority: 'High',
        confidence: '80%',
      },
    ],
    features: [
      {
        id: 'feat-1',
        parentId: 'epic-1',
        workItemType: 'Feature',
        title: 'OAuth Login',
        status: 'Approved',
        priority: 'High',
      },
    ],
    pbis: [
      {
        id: 'pbi-1',
        parentId: 'feat-1',
        workItemType: 'PBI',
        title: 'Implement Google OAuth',
        status: 'Draft',
        priority: 'Medium',
      },
    ],
  },
  ...overrides,
});

const makeSecondDoc = (): BacklogDocument => ({
  id: 2,
  title: 'Sprint 2 Requirements',
  path: '/requirement-drafts/sprint-2',
  document: {
    epics: [
      {
        id: 'epic-2',
        workItemType: 'Epic',
        title: 'Reporting Module',
        status: 'Draft',
        priority: 'Medium',
      },
    ],
    features: [],
    pbis: [],
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BacklogView', () => {
  const defaultProps = { project: 'MyProject', areaPath: 'MyProject\\Team' };

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------
  describe('loading state', () => {
    it('shows a loading spinner while fetching', () => {
      // Never resolves during this test
      global.fetch = jest.fn().mockReturnValue(new Promise(() => {}));

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      expect(screen.getByText(/loading draft backlog documents/i)).toBeInTheDocument();
      expect(document.querySelector('.backlog-spinner')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------
  describe('error state', () => {
    it('shows an error message when the fetch fails', async () => {
      mockFetch({ error: 'Server Error' }, false, 500);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() =>
        expect(screen.getByText(/failed to load backlog drafts/i)).toBeInTheDocument()
      );
    });

    it('shows a retry button on error', async () => {
      mockFetch({}, false, 500);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());
    });

    it('re-fetches when retry is clicked', async () => {
      mockFetch({}, false, 500);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());

      // Now make fetch succeed on retry
      mockFetch([makeDoc()]);
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------
  describe('empty state', () => {
    it('shows an empty state message when no documents are returned', async () => {
      mockFetch([]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() =>
        expect(screen.getByText(/no draft backlog documents found/i)).toBeInTheDocument()
      );
    });

    it('shows the hint about requirement-drafts wiki path', async () => {
      mockFetch([]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() =>
        expect(screen.getByText(/\/requirement-drafts/i)).toBeInTheDocument()
      );
    });

    it('shows the Backlog heading and Refresh button in empty state', async () => {
      mockFetch([]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument());
      expect(screen.getByRole('heading', { name: /backlog/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Populated state – tree rendering
  // -------------------------------------------------------------------------
  describe('tree rendering', () => {
    it('renders the Backlog heading and subtitle', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByRole('heading', { name: /backlog/i })).toBeInTheDocument());
      expect(screen.getByText(/draft requirements/i)).toBeInTheDocument();
    });

    it('renders epic titles', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());
    });

    it('renders type chips for visible nodes', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());
      expect(screen.getByText('Epic')).toBeInTheDocument();
    });

    it('renders status badge for an epic', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => {
        // There may be multiple status badges; find one matching Draft
        const badges = screen.getAllByText('Draft');
        expect(badges.length).toBeGreaterThan(0);
      });
    });

    it('renders count chips with correct totals', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('1 Epic')).toBeInTheDocument();
        expect(screen.getByText('1 Feature')).toBeInTheDocument();
        expect(screen.getByText('1 PBI')).toBeInTheDocument();
      });
    });

    it('uses plural form for counts > 1', async () => {
      const doc = makeDoc();
      doc.document.epics.push({
        id: 'epic-extra',
        workItemType: 'Epic',
        title: 'Second Epic',
        status: 'Draft',
      });

      mockFetch([doc]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('2 Epics')).toBeInTheDocument());
    });

    it('does NOT render features/PBIs before the epic is expanded', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      expect(screen.queryByText('OAuth Login')).not.toBeInTheDocument();
      expect(screen.queryByText('Implement Google OAuth')).not.toBeInTheDocument();
    });

    it('does not show doc section headers when there is only one document', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      expect(screen.queryByText('Sprint 1 Requirements')).not.toBeInTheDocument();
    });

    it('shows section headers when there are multiple documents', async () => {
      mockFetch([makeDoc(), makeSecondDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.getByText('Sprint 1 Requirements')).toBeInTheDocument();
        expect(screen.getByText('Sprint 2 Requirements')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Expand / Collapse
  // -------------------------------------------------------------------------
  describe('expand and collapse', () => {
    it('expands an epic to reveal its features when chevron is clicked', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      const chevron = document.querySelector('.tree-chevron-visible') as HTMLElement;
      fireEvent.click(chevron);

      expect(screen.getByText('OAuth Login')).toBeInTheDocument();
    });

    it('collapses an already-expanded epic when chevron is clicked again', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      const chevron = document.querySelector('.tree-chevron-visible') as HTMLElement;
      fireEvent.click(chevron);
      expect(screen.getByText('OAuth Login')).toBeInTheDocument();

      fireEvent.click(chevron);
      expect(screen.queryByText('OAuth Login')).not.toBeInTheDocument();
    });

    it('expands all nodes when "Expand All" is clicked', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /expand all/i }));

      expect(screen.getByText('OAuth Login')).toBeInTheDocument();
      expect(screen.getByText('Implement Google OAuth')).toBeInTheDocument();
    });

    it('collapses all nodes when "Collapse All" is clicked', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      // Expand first, then collapse
      fireEvent.click(screen.getByRole('button', { name: /expand all/i }));
      expect(screen.getByText('OAuth Login')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /collapse all/i }));
      expect(screen.queryByText('OAuth Login')).not.toBeInTheDocument();
    });

    it('shows the PBI after expanding both the epic and the feature', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /expand all/i }));

      expect(screen.getByText('Implement Google OAuth')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Node selection and details panel
  // -------------------------------------------------------------------------
  describe('node selection', () => {
    it('opens the details panel when an epic row is clicked', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      fireEvent.click(screen.getByText('User Authentication'));

      expect(screen.getByTestId('details-panel')).toBeInTheDocument();
      expect(screen.getByTestId('panel-title')).toHaveTextContent('User Authentication');
    });

    it('marks the clicked row as selected', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      const row = screen.getByText('User Authentication').closest('.tree-row');
      fireEvent.click(row as HTMLElement);

      expect(row).toHaveClass('tree-row-selected');
    });

    it('closes the details panel when onClose is triggered', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());
      fireEvent.click(screen.getByText('User Authentication'));
      expect(screen.getByTestId('details-panel')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(screen.queryByTestId('details-panel')).not.toBeInTheDocument();
    });

    it('opens the details panel for a feature row', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      // Expand epic first
      fireEvent.click(screen.getByRole('button', { name: /expand all/i }));
      expect(screen.getByText('OAuth Login')).toBeInTheDocument();

      fireEvent.click(screen.getByText('OAuth Login'));
      expect(screen.getByTestId('panel-title')).toHaveTextContent('OAuth Login');
    });

    it('opens the details panel for a PBI row', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /expand all/i }));

      fireEvent.click(screen.getByText('Implement Google OAuth'));
      expect(screen.getByTestId('panel-title')).toHaveTextContent('Implement Google OAuth');
    });

    it('activates selection via keyboard Enter key', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      const row = screen.getByText('User Authentication').closest('.tree-row') as HTMLElement;
      fireEvent.keyDown(row, { key: 'Enter' });

      expect(screen.getByTestId('details-panel')).toBeInTheDocument();
    });

    it('activates selection via keyboard Space key', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      const row = screen.getByText('User Authentication').closest('.tree-row') as HTMLElement;
      fireEvent.keyDown(row, { key: ' ' });

      expect(screen.getByTestId('details-panel')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Refresh button
  // -------------------------------------------------------------------------
  describe('refresh button', () => {
    it('triggers a re-fetch when Refresh is clicked in populated state', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      const fetchBefore = (global.fetch as jest.Mock).mock.calls.length;

      fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

      await waitFor(() =>
        expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(fetchBefore)
      );
    });
  });

  // -------------------------------------------------------------------------
  // API call correctness
  // -------------------------------------------------------------------------
  describe('API call', () => {
    it('calls the correct endpoint with project and areaPath query params', async () => {
      mockFetch([]);

      render(<BacklogView project="Contoso" areaPath="Contoso\\Backend" />, {
        wrapper: createWrapper(),
      });

      await waitFor(() =>
        expect(screen.getByText(/no draft backlog documents found/i)).toBeInTheDocument()
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('project=Contoso'),
        expect.any(Object)
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('areaPath=Contoso'),
        expect.any(Object)
      );
    });
  });

  // -------------------------------------------------------------------------
  // Chevron interaction does not propagate to row selection
  // -------------------------------------------------------------------------
  describe('chevron click isolation', () => {
    it('does not open the details panel when only the chevron is clicked', async () => {
      mockFetch([makeDoc()]);

      render(<BacklogView {...defaultProps} />, { wrapper: createWrapper() });

      await waitFor(() => expect(screen.getByText('User Authentication')).toBeInTheDocument());

      const chevron = document.querySelector('.tree-chevron-visible') as HTMLElement;
      fireEvent.click(chevron);

      // Features should expand but no panel should appear
      expect(screen.getByText('OAuth Login')).toBeInTheDocument();
      expect(screen.queryByTestId('details-panel')).not.toBeInTheDocument();
    });
  });
});
