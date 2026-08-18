import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DevWorkbenchView } from '../DevWorkbenchView';

const mockNavigate = jest.fn();
const mockStartMutateAsync = jest.fn();
const mockCloseMutateAsync = jest.fn();
const mockCompleteMutateAsync = jest.fn();
const mockStartLocalMutateAsync = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useDevWorkbench', () => ({
  useAssignedWorkItems: jest.fn(),
  useActiveSessions: jest.fn(),
  useStartDevSession: jest.fn(),
  useCloseDevSession: jest.fn(),
  useCompleteFeature: jest.fn(),
  useStartLocalFeature: jest.fn(),
}));

jest.mock('../../hooks/useApexBacklog', () => ({
  useApexBacklogFeatures: jest.fn(),
}));

jest.mock('../../hooks/useProjectMenuConfig', () => ({
  useProjectMenuConfig: jest.fn(),
}));

jest.mock('../../hooks/useApexWorkItems', () => ({
  useAssignedBoardItems: jest.fn(),
}));

jest.mock('../StartLocalDevModal', () => ({
  __esModule: true,
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="start-local-modal">
      <button type="button" onClick={onClose}>Close Local Modal</button>
    </div>
  ),
}));

jest.mock('../FeatureContextModal', () => ({
  __esModule: true,
  default: ({ feature, onClose }: { feature: { featureId: string }; onClose: () => void }) => (
    <div data-testid="feature-context-modal">
      <span>Context for {feature.featureId}</span>
      <button type="button" onClick={onClose}>Close Context</button>
    </div>
  ),
}));

import { useAppShell } from '../../hooks/useAppShell';
import {
  useAssignedWorkItems,
  useActiveSessions,
  useStartDevSession,
  useCloseDevSession,
  useCompleteFeature,
  useStartLocalFeature,
} from '../../hooks/useDevWorkbench';
import { useApexBacklogFeatures } from '../../hooks/useApexBacklog';
import { useProjectMenuConfig } from '../../hooks/useProjectMenuConfig';
import { useAssignedBoardItems } from '../../hooks/useApexWorkItems';
import type { ActiveDevSession, ApexBacklogGroup } from '../../../shared/types/devWorkbench';

const workItems = [
  {
    id: 42,
    title: 'Implement login',
    workItemType: 'Feature',
    state: 'In Progress',
    assignedTo: 'jane@example.com',
    project: 'MaxView',
    tags: 'apex; wave-1',
  },
  {
    id: 99,
    title: 'Fix crash',
    workItemType: 'Bug',
    state: 'New',
    assignedTo: 'jane@example.com',
    project: 'MaxView',
  },
];

function renderView() {
  return render(
    <MemoryRouter>
      <DevWorkbenchView />
    </MemoryRouter>,
  );
}

describe('DevWorkbenchView', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (useAppShell as jest.Mock).mockReturnValue({ selectedProject: 'MaxView', isSuperAdmin: false });
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: workItems,
      isLoading: false,
      error: null,
    });
    (useActiveSessions as jest.Mock).mockReturnValue({ data: [] });
    (useStartDevSession as jest.Mock).mockReturnValue({
      mutateAsync: mockStartMutateAsync,
      error: null,
    });
    (useCloseDevSession as jest.Mock).mockReturnValue({
      mutateAsync: mockCloseMutateAsync,
    });
    (useCompleteFeature as jest.Mock).mockReturnValue({
      mutateAsync: mockCompleteMutateAsync,
      error: null,
    });
    (useStartLocalFeature as jest.Mock).mockReturnValue({
      mutateAsync: mockStartLocalMutateAsync,
      isPending: false,
      error: null,
    });
    (useApexBacklogFeatures as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
    (useProjectMenuConfig as jest.Mock).mockReturnValue({
      enabledViews: [],
      isLoading: false,
    });
    (useAssignedBoardItems as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
  });

  it('renders the My Work header and assigned work items', () => {
    renderView();

    expect(screen.getByRole('heading', { name: 'My Work' })).toBeInTheDocument();
    expect(screen.getByText('Implement login')).toBeInTheDocument();
    expect(screen.getByText('Fix crash')).toBeInTheDocument();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Feature')).toBeInTheDocument();
  });

  it('shows a loading state while work items are loading', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    renderView();

    expect(screen.getByText(/loading assigned work items/i)).toBeInTheDocument();
  });

  it('shows an error state when work items fail to load', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Network error'),
    });

    renderView();

    expect(screen.getByText(/failed to load work items/i)).toBeInTheDocument();
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });

  it('shows an empty state when no work items are assigned', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    renderView();

    expect(screen.getByText(/no active work items assigned to you/i)).toBeInTheDocument();
  });

  it('starts a development session and navigates to the session view', async () => {
    mockStartMutateAsync.mockResolvedValue({ sessionId: 'session-1' });

    renderView();
    fireEvent.click(screen.getAllByRole('button', { name: /start development/i })[0]);

    await waitFor(() => {
      expect(mockStartMutateAsync).toHaveBeenCalledWith({ workItemId: 42, project: 'MaxView' });
      expect(mockNavigate).toHaveBeenCalledWith('/my-work/session/session-1');
    });
  });

  it('disables Start Development for work items not in an allowed state', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{
        id: 7, title: 'In review', workItemType: 'Feature',
        state: 'In Pull Request', assignedTo: 'jane@example.com', project: 'MaxView', tags: 'apex',
      }],
      isLoading: false,
      error: null,
    });

    renderView();

    expect(screen.getByRole('button', { name: /start development/i })).toBeDisabled();
  });

  it('enables Start Development for an APEX Feature in an allowed state (Committed)', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{
        id: 8, title: 'Ready to code', workItemType: 'Feature',
        state: 'Committed', assignedTo: 'jane@example.com', project: 'MaxView', tags: 'apex; wave-2',
      }],
      isLoading: false,
      error: null,
    });

    renderView();

    expect(screen.getByRole('button', { name: /start development/i })).not.toBeDisabled();
  });

  it('disables Start Development for a Feature without the apex tag (non-admin)', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{
        id: 9, title: 'Legacy feature', workItemType: 'Feature',
        state: 'Committed', assignedTo: 'jane@example.com', project: 'MaxView', tags: 'wave-1',
      }],
      isLoading: false,
      error: null,
    });

    renderView();

    const btn = screen.getByRole('button', { name: /start development/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringMatching(/APEX-generated Features/i));
  });

  it('disables Start Development for a PBI even when tagged apex and startable (non-admin)', () => {
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{
        id: 10, title: 'A PBI', workItemType: 'Product Backlog Item',
        state: 'Committed', assignedTo: 'jane@example.com', project: 'MaxView', tags: 'apex',
      }],
      isLoading: false,
      error: null,
    });

    renderView();

    const btn = screen.getByRole('button', { name: /start development/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringMatching(/only available on Features/i));
  });

  it('enables Start Development on any type for super admins (Bug in an allowed state)', () => {
    (useAppShell as jest.Mock).mockReturnValue({ selectedProject: 'MaxView', isSuperAdmin: true });
    (useAssignedWorkItems as jest.Mock).mockReturnValue({
      data: [{
        id: 11, title: 'Admin bug', workItemType: 'Bug',
        state: 'Active', assignedTo: 'jane@example.com', project: 'MaxView',
      }],
      isLoading: false,
      error: null,
    });

    renderView();

    expect(screen.getByRole('button', { name: /start development/i })).not.toBeDisabled();
  });

  it('shows resume and close actions for work items with an active session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 42,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/42',
          createdAt: '2026-06-01T00:00:00Z',
        },
      ],
    });

    renderView();

    expect(screen.getByText('Active Session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume session/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /resume session/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/my-work/session/session-1');
  });

  it('closes an active session when Close Session is clicked', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 42,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/42',
          createdAt: '2026-06-01T00:00:00Z',
        },
      ],
    });
    mockCloseMutateAsync.mockResolvedValue({ ok: true });

    renderView();
    fireEvent.click(screen.getByRole('button', { name: /close session/i }));

    await waitFor(() => {
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-1');
    });
  });
});

const apexBacklogGroups: ApexBacklogGroup[] = [
  {
    prdId: 'prd-1',
    prdTitle: 'PDF Assembly',
    epics: [
      {
        epicTitle: 'Core Platform',
        features: [
          {
            featureId: 'FEAT-001',
            featureTitle: 'Menu & Navigation',
            featurePriority: 'Must',
            epicTitle: 'Core Platform',
            prdId: 'prd-1',
            prdTitle: 'PDF Assembly',
            dependsOn: [],
            itemCount: 3,
            pbiCount: 2,
            tbiCount: 1,
          },
          {
            featureId: 'FEAT-002',
            featureTitle: 'Document Upload',
            featurePriority: 'Must',
            epicTitle: 'Core Platform',
            prdId: 'prd-1',
            prdTitle: 'PDF Assembly',
            dependsOn: ['FEAT-001'],
            itemCount: 5,
            pbiCount: 3,
            tbiCount: 2,
          },
        ],
      },
    ],
  },
];

function expandPrdAndEpic() {
  fireEvent.click(screen.getByRole('button', { name: /PDF Assembly/i }));
  fireEvent.click(screen.getByRole('button', { name: /Core Platform/i }));
}

function mockApexWorkbenchHooks(project = 'Apex') {
  (useAppShell as jest.Mock).mockReturnValue({
    selectedProject: project,
    usesBoardWorkItems: project.toLowerCase() === 'apex',
  });
  (useProjectMenuConfig as jest.Mock).mockReturnValue({
    enabledViews: [],
    isLoading: false,
  });
  (useAssignedBoardItems as jest.Mock).mockReturnValue({
    data: [],
    isLoading: false,
    error: null,
  });
  (useAssignedWorkItems as jest.Mock).mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
  });
  (useActiveSessions as jest.Mock).mockReturnValue({ data: [] });
  (useStartDevSession as jest.Mock).mockReturnValue({
    mutateAsync: mockStartMutateAsync,
    error: null,
  });
  (useCloseDevSession as jest.Mock).mockReturnValue({
    mutateAsync: mockCloseMutateAsync,
  });
  (useCompleteFeature as jest.Mock).mockReturnValue({
    mutateAsync: mockCompleteMutateAsync,
    error: null,
  });
  (useStartLocalFeature as jest.Mock).mockReturnValue({
    mutateAsync: mockStartLocalMutateAsync,
    isPending: false,
    error: null,
  });
  (useApexBacklogFeatures as jest.Mock).mockReturnValue({
    data: apexBacklogGroups,
    isLoading: false,
    error: null,
  });
}

describe('filterApexBacklogByStatus', () => {
  const { filterApexBacklogByStatus, filterApexBacklogBySearch } = jest.requireActual('../DevWorkbenchView') as typeof import('../DevWorkbenchView');

  it('returns all groups for the All filter', () => {
    const result = filterApexBacklogByStatus(apexBacklogGroups, [], 'all');
    expect(result).toHaveLength(1);
    expect(result[0].epics[0].features).toHaveLength(2);
  });

  it('keeps only Ready features for the Ready filter', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'completed',
        prUrl: null,
        createdAt: '2026-07-01T00:00:00Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    const result = filterApexBacklogByStatus(apexBacklogGroups, sessions, 'ready');
    expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-002']);
  });

  it('keeps only Complete features for the Complete filter', () => {
    const sessions: ActiveDevSession[] = [
      {
        id: 's1',
        workItemId: null,
        chatThreadId: null,
        branchName: null,
        status: 'completed',
        prUrl: null,
        createdAt: '2026-07-01T00:00:00Z',
        prdId: 'prd-1',
        featureId: 'FEAT-001',
      },
    ];
    const result = filterApexBacklogByStatus(apexBacklogGroups, sessions, 'complete');
    expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-001']);
  });

  it('treats locallyCompleted keys as Complete before sessions refetch', () => {
    const result = filterApexBacklogByStatus(
      apexBacklogGroups,
      [],
      'complete',
      new Set(['prd-1:FEAT-001']),
    );
    expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-001']);
  });

  it('returns an empty list when nothing matches', () => {
    const result = filterApexBacklogByStatus(apexBacklogGroups, [], 'in_progress');
    expect(result).toEqual([]);
  });

  describe('filterApexBacklogBySearch', () => {
    it('returns all groups when the query is blank', () => {
      expect(filterApexBacklogBySearch(apexBacklogGroups, '  ')).toEqual(apexBacklogGroups);
    });

    it('matches PRD titles and keeps all nested features', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'pdf');
      expect(result).toHaveLength(1);
      expect(result[0].prdTitle).toBe('PDF Assembly');
      expect(result[0].epics[0].features).toHaveLength(2);
    });

    it('matches Epic titles and keeps features under that epic', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'core platform');
      expect(result[0].epics).toHaveLength(1);
      expect(result[0].epics[0].features).toHaveLength(2);
    });

    it('matches Feature titles and keeps only those features', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'navigation');
      expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-001']);
    });

    it('matches feature ids case-insensitively', () => {
      const result = filterApexBacklogBySearch(apexBacklogGroups, 'feat-002');
      expect(result[0].epics[0].features.map((f) => f.featureId)).toEqual(['FEAT-002']);
    });

    it('returns an empty list when nothing matches', () => {
      expect(filterApexBacklogBySearch(apexBacklogGroups, 'zzzz-no-match')).toEqual([]);
    });
  });
});

describe('DevWorkbenchView — Apex backlog (Mark Complete)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApexWorkbenchHooks();
  });

  it('uses the app-native PRD backlog for Amego instead of ADO work items', () => {
    mockApexWorkbenchHooks('Amego');

    renderView();

    expect(useAssignedWorkItems).toHaveBeenCalledWith(null);
    expect(useApexBacklogFeatures).toHaveBeenCalledWith('Amego');
    expect(screen.getByText('PDF Assembly')).toBeInTheDocument();
    expect(screen.queryByText('Implement login')).not.toBeInTheDocument();
  });

  it('defaults PRD and Epic sections to collapsed', () => {
    renderView();

    expect(screen.getByText('PDF Assembly')).toBeInTheDocument();
    expect(screen.queryByText('Menu & Navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PDF Assembly/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('searches by feature title and expands matching sections', () => {
    renderView();

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds, epics, and features/i }), {
      target: { value: 'Upload' },
    });

    expect(screen.getByText('Document Upload')).toBeInTheDocument();
    expect(screen.queryByText('Menu & Navigation')).not.toBeInTheDocument();
  });

  it('searches by PRD title and shows nested features', () => {
    renderView();

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds, epics, and features/i }), {
      target: { value: 'PDF Assembly' },
    });

    expect(screen.getByText('Menu & Navigation')).toBeInTheDocument();
    expect(screen.getByText('Document Upload')).toBeInTheDocument();
  });

  it('shows an empty search message when nothing matches', () => {
    renderView();

    fireEvent.change(screen.getByRole('searchbox', { name: /search prds, epics, and features/i }), {
      target: { value: 'no-such-item' },
    });

    expect(screen.getByText(/no prds, epics, or features match this search/i)).toBeInTheDocument();
  });

  it('renders status filter pills matching the interviews toolbar layout', () => {
    renderView();

    const toolbar = screen.getByRole('toolbar', { name: /filter features by status/i });
    expect(toolbar).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /^All$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(within(toolbar).getByRole('button', { name: /^Ready$/i })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /^In Progress$/i })).toBeInTheDocument();
    expect(within(toolbar).getByRole('button', { name: /^Complete$/i })).toBeInTheDocument();
  });

  it('filters the backlog when a status pill is selected', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    const toolbar = screen.getByRole('toolbar', { name: /filter features by status/i });
    fireEvent.click(within(toolbar).getByRole('button', { name: /^Complete/i }));
    expandPrdAndEpic();

    expect(screen.getByText('Menu & Navigation')).toBeInTheDocument();
    expect(screen.queryByText('Document Upload')).not.toBeInTheDocument();
  });

  it('shows an empty state when the filter matches nothing', () => {
    renderView();
    const toolbar = screen.getByRole('toolbar', { name: /filter features by status/i });
    fireEvent.click(within(toolbar).getByRole('button', { name: /^Complete/i }));
    expect(screen.getByText(/no features match this filter/i)).toBeInTheDocument();
  });

  it('renders features with Mark Complete buttons after expanding', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getByText('Menu & Navigation')).toBeInTheDocument();
    expect(screen.getByText('Document Upload')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /mark complete/i })).toHaveLength(2);
  });

  it('shows Ready badge for features with no unmet dependencies', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('Ready').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Blocked badge for features with unmet dependencies', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getByText('Blocked by FEAT-001')).toBeInTheDocument();
  });

  it('calls completeFeature with the correct prdId and featureId', async () => {
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-new' });

    renderView();
    expandPrdAndEpic();
    const completeButtons = screen.getAllByRole('button', { name: /mark complete/i });
    fireEvent.click(completeButtons[0]);

    await waitFor(() => {
      expect(mockCompleteMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        project: 'Apex',
      });
    });
  });

  it('hides Start Local Development immediately after Mark Complete', async () => {
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-new' });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByRole('button', { name: /start local development/i })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /mark complete/i })[0]);

    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument();
    });
    // Completed feature no longer offers Start Local; remaining Ready feature still does
    expect(screen.getAllByRole('button', { name: /start local development/i })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /view context/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('completes only the selected feature and rolls parents up from all children', async () => {
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-new' });

    renderView();
    expandPrdAndEpic();
    fireEvent.click(screen.getAllByRole('button', { name: /mark complete/i })[0]);

    await waitFor(() => {
      expect(screen.getByTestId('my-work-feature-status-FEAT-001')).toHaveTextContent('Complete');
    });
    expect(screen.getByTestId('my-work-feature-status-FEAT-002')).toHaveTextContent('Ready');
    expect(screen.getByTestId('my-work-prd-status-prd-1')).toHaveTextContent('In Progress');
    expect(screen.getByTestId('my-work-epic-status-prd-1-0')).toHaveTextContent('In Progress');
    expect(screen.getAllByText('Done')).toHaveLength(1);
  });

  it('hides Start Local Development when a feature already has a completed session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getByText('Done')).toBeInTheDocument();
    // FEAT-002 still Ready — only one Start Local remains
    expect(screen.getAllByRole('button', { name: /start local development/i })).toHaveLength(1);
  });

  it('shows Complete badge and Done label when a feature has a completed session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('Complete').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('unblocks dependent features when all dependencies are completed', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.queryByText('Blocked by FEAT-001')).not.toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
  });

  it('rolls Ready status up to Epic and PRD when all features are Ready', () => {
    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('Ready').length).toBeGreaterThanOrEqual(3);
  });

  it('rolls In Progress up to Epic and PRD when any feature is In Progress', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/x',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(3);
  });

  it('marks In Progress via Start Local Development', async () => {
    mockStartLocalMutateAsync.mockResolvedValue({ ok: true, sessionId: 'local-1', status: 'in_progress' });

    renderView();
    expandPrdAndEpic();
    fireEvent.click(screen.getAllByRole('button', { name: /start local development/i })[0]);

    await waitFor(() => {
      expect(mockStartLocalMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        project: 'Apex',
      });
    });
  });

  it('allows Mark Complete while a feature is In Progress', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-1',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/x',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });
    mockCompleteMutateAsync.mockResolvedValue({ ok: true, sessionId: 'session-1' });

    renderView();
    expandPrdAndEpic();
    const completeButtons = screen.getAllByRole('button', { name: /mark complete/i });
    fireEvent.click(completeButtons[0]);

    await waitFor(() => {
      expect(mockCompleteMutateAsync).toHaveBeenCalledWith({
        prdId: 'prd-1',
        featureId: 'FEAT-001',
        project: 'Apex',
      });
    });
  });

  it('shows View Context on every feature including Complete and opens the modal', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-completed-1',
          workItemId: 0,
          status: 'completed',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    const viewButtons = screen.getAllByRole('button', { name: /view context/i });
    expect(viewButtons.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();

    fireEvent.click(viewButtons[0]);
    expect(screen.getByTestId('feature-context-modal')).toBeInTheDocument();
    expect(screen.getByText(/Context for FEAT-/i)).toBeInTheDocument();
  });

  it('shows Clear Progress for cloud and local in-progress sessions and never Resume/Close Session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-cloud',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/x',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-local',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: null,
          branchName: null,
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-002',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByRole('button', { name: /clear progress/i })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /resume session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Start Development$/i })).not.toBeInTheDocument();
  });
});

describe('DevWorkbenchView — session-to-feature matching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApexWorkbenchHooks();
  });

  it('prefers active session over closed session for the same feature', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-old-closed',
          workItemId: 0,
          status: 'closed',
          chatThreadId: null,
          branchName: 'feature/apex-feat-001-old',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-active',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-2',
          branchName: 'feature/apex-feat-001-new',
          prUrl: null,
          createdAt: '2026-07-05T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume session/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear progress/i })).toBeInTheDocument();
  });

  it('closing feature 001 does not affect feature 002 session', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-feat-001',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/apex-feat-001',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-feat-002',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-2',
          branchName: 'feature/apex-feat-002',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-002',
        },
      ],
    });
    mockCloseMutateAsync.mockResolvedValue({ ok: true });

    renderView();
    expandPrdAndEpic();

    const inProgressBadges = screen.getAllByText('In Progress');
    expect(inProgressBadges.length).toBeGreaterThanOrEqual(2);

    const clearButtons = screen.getAllByRole('button', { name: /clear progress/i });
    fireEvent.click(clearButtons[0]);

    await waitFor(() => {
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-feat-001');
      expect(mockCloseMutateAsync).not.toHaveBeenCalledWith('session-feat-002');
    });
  });

  it('does not cross-reference sessions between different features', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-feat-002',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-2',
          branchName: 'feature/apex-feat-002',
          prUrl: null,
          createdAt: '2026-07-02T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-002',
        },
        {
          id: 'session-feat-001',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/apex-feat-001',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    const inProgressBadges = screen.getAllByText('In Progress');
    expect(inProgressBadges.length).toBeGreaterThanOrEqual(2);

    const clearButtons = screen.getAllByRole('button', { name: /clear progress/i });
    expect(clearButtons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /resume session/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close session/i })).not.toBeInTheDocument();
  });

  it('shows In Progress with In PR note for a feature with a pushed session', () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-feat-001',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-1',
          branchName: 'feature/apex-feat-001',
          prUrl: 'https://dev.azure.com/org/project/_git/repo/pullrequest/123',
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('In PR')).toBeInTheDocument();
  });

  it('with multiple sessions per feature, active session wins over older closed one regardless of array order', async () => {
    (useActiveSessions as jest.Mock).mockReturnValue({
      data: [
        {
          id: 'session-new-active',
          workItemId: 0,
          status: 'in_progress',
          chatThreadId: 'thread-new',
          branchName: 'feature/apex-feat-001-retry',
          prUrl: null,
          createdAt: '2026-07-05T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
        {
          id: 'session-old-closed',
          workItemId: 0,
          status: 'closed',
          chatThreadId: null,
          branchName: 'feature/apex-feat-001-first',
          prUrl: null,
          createdAt: '2026-07-01T00:00:00Z',
          prdId: 'prd-1',
          featureId: 'FEAT-001',
        },
      ],
    });
    mockCloseMutateAsync.mockResolvedValue({ ok: true });

    renderView();
    expandPrdAndEpic();

    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);

    const clearButton = screen.getByRole('button', { name: /clear progress/i });
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(mockCloseMutateAsync).toHaveBeenCalledWith('session-new-active');
    });
  });
});
