import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { RoadmapView } from '../RoadmapView';
import type { WorkItem } from '../../types/workitem';
import type { RoadmapWorkspaceResponse } from '../../../shared/types/roadmap';

const mockUpsertMutateAsync = jest.fn();
const mockCreateIdeaMutateAsync = jest.fn();
const mockUpdateIdeaMutateAsync = jest.fn();
const mockDeleteIdeaMutateAsync = jest.fn();
const mockPromoteIdeaMutateAsync = jest.fn();
const mockUpdateSettingsMutateAsync = jest.fn();
const mockUseProjectRoadmap = jest.fn();

jest.mock('../../hooks/useProjectRoadmap', () => ({
  useProjectRoadmap: (...args: unknown[]) => mockUseProjectRoadmap(...args),
  useUpsertRoadmapOverlay: () => ({
    mutateAsync: mockUpsertMutateAsync,
    isPending: false,
  }),
  useCreateRoadmapIdea: () => ({
    mutateAsync: mockCreateIdeaMutateAsync,
    isPending: false,
  }),
  useUpdateRoadmapIdea: () => ({
    mutateAsync: mockUpdateIdeaMutateAsync,
    isPending: false,
  }),
  useDeleteRoadmapIdea: () => ({
    mutateAsync: mockDeleteIdeaMutateAsync,
    isPending: false,
  }),
  usePromoteRoadmapIdea: () => ({
    mutateAsync: mockPromoteIdeaMutateAsync,
    isPending: false,
  }),
  useUpdateRoadmapSettings: () => ({
    mutateAsync: mockUpdateSettingsMutateAsync,
    isPending: false,
  }),
  useEpicChildrenMap: () => ({
    childrenByEpicId: new Map(),
    isLoadingAny: false,
  }),
}));

const sampleWorkItems: WorkItem[] = [
  {
    id: 101,
    title: 'Undated Timecard Compliance Epic',
    state: 'New',
    assignedTo: 'Jordan PO',
    workItemType: 'Epic',
    changedDate: '2026-11-10T00:00:00.000Z',
    createdDate: '2026-11-01T00:00:00.000Z',
    areaPath: 'MaxView',
    iterationPath: 'MaxView',
  },
  {
    id: 102,
    title: 'Dated Billing Engine Upgrade',
    state: 'In Progress',
    assignedTo: 'Casey Lead',
    targetDate: '2026-12-20',
    workItemType: 'Epic',
    changedDate: '2026-11-10T00:00:00.000Z',
    createdDate: '2026-10-15T00:00:00.000Z',
    areaPath: 'MaxView',
    iterationPath: 'MaxView',
  },
];

function makeWorkspace(
  overrides: Partial<RoadmapWorkspaceResponse> = {},
): RoadmapWorkspaceResponse {
  return {
    settings: {
      project: 'MaxView',
      syncDatesToAdo: false,
      updatedBy: 'system',
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    overlays: [
      {
        id: 'ov-102',
        project: 'MaxView',
        workItemId: 102,
        workItemType: 'Epic',
        horizon: 'now',
        plannedStartDate: '2026-11-01',
        plannedTargetDate: '2026-12-29',
        baselineTargetDate: '2026-12-15',
        confidence: 'high',
        notes: 'Slipped due to EDI scope',
        sortOrder: 0,
        updatedBy: 'u1',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-12T00:00:00.000Z',
      },
    ],
    ideas: [
      {
        id: 'idea-99',
        project: 'MaxView',
        title: 'AI Shift Swap Recommender',
        ownerLabel: 'Morgan BA',
        horizon: 'next',
        effortSize: 'M',
        confidence: 'medium',
        releaseLabel: 'Q1 Mobile',
        notes: 'Early discovery concept',
        plannedStartDate: null,
        plannedTargetDate: null,
        baselineTargetDate: null,
        promotedFeatureRequestId: null,
        promotedAdoWorkItemId: null,
        promotedAt: null,
        archived: false,
        sortOrder: 0,
        createdBy: 'u1',
        updatedBy: 'u1',
        createdAt: '2026-11-12T00:00:00.000Z',
        updatedAt: '2026-11-12T00:00:00.000Z',
      },
    ],
    events: [
      {
        id: 'ev-1',
        project: 'MaxView',
        workItemId: 102,
        adhocIdeaId: null,
        itemTitle: 'Dated Billing Engine Upgrade',
        itemOrigin: 'ado',
        eventKind: 'date_changed',
        fromHorizon: null,
        toHorizon: null,
        oldTargetDate: '2026-12-15',
        newTargetDate: '2026-12-29',
        deltaDays: 14,
        reason: 'Scope Expansion',
        note: 'Added clearinghouse rules',
        syncedToAdo: false,
        actorId: 'u1',
        actorName: 'Taylor PO',
        createdAt: '2026-11-12T15:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('RoadmapView Living Roadmap Workbench', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseProjectRoadmap.mockReturnValue({
      data: makeWorkspace(),
      isLoading: false,
      isError: false,
    });
    mockUpsertMutateAsync.mockResolvedValue({
      overlay: {},
      events: [],
      syncedToAdo: false,
    });
    mockCreateIdeaMutateAsync.mockResolvedValue({
      idea: { id: 'idea-new', title: 'New Idea' },
      events: [],
    });
  });

  it('renders Horizon Board by default including undated ADO Epics and Ad-hoc Sandbox Ideas', () => {
    render(
      <RoadmapView
        workItems={sampleWorkItems}
        project="MaxView"
        areaPath="MaxView"
      />,
    );

    const unplannedCol = screen.getByTestId('roadmap-horizon-col-unplanned');
    expect(
      within(unplannedCol).getByText('Undated Timecard Compliance Epic'),
    ).toBeInTheDocument();

    const nowCol = screen.getByTestId('roadmap-horizon-col-now');
    expect(
      within(nowCol).getByText('Dated Billing Engine Upgrade'),
    ).toBeInTheDocument();
    expect(within(nowCol).getByText('+14d')).toBeInTheDocument();

    const nextCol = screen.getByTestId('roadmap-horizon-col-next');
    expect(
      within(nextCol).getByText('AI Shift Swap Recommender'),
    ).toBeInTheDocument();

    // Toggle Show Ad-hoc Ideas hides draft ideas cleanly
    fireEvent.click(screen.getByTestId('roadmap-toggle-adhoc'));
    expect(
      screen.queryByText('AI Shift Swap Recommender'),
    ).not.toBeInTheDocument();
  });

  it('switches to Living Timeline with Baseline Ghosts and Unscheduled Backlog Tray', () => {
    render(
      <RoadmapView
        workItems={sampleWorkItems}
        project="MaxView"
        areaPath="MaxView"
      />,
    );

    fireEvent.click(screen.getByTestId('roadmap-mode-timeline'));

    expect(screen.getByTestId('roadmap-baseline-ghost')).toBeInTheDocument();
    const tray = screen.getByTestId('roadmap-unscheduled-tray');
    expect(
      within(tray).getByText('Undated Timecard Compliance Epic'),
    ).toBeInTheDocument();
    expect(
      within(tray).getByText('AI Shift Swap Recommender'),
    ).toBeInTheDocument();
  });

  it('renders Planning Sheet and Drift & History Ledger accurately', () => {
    render(
      <RoadmapView
        workItems={sampleWorkItems}
        project="MaxView"
        areaPath="MaxView"
      />,
    );

    fireEvent.click(screen.getByTestId('roadmap-mode-sheet'));
    const sheetTable = screen.getByTestId('roadmap-sheet-table');
    expect(
      within(sheetTable).getByText('Undated Timecard Compliance Epic'),
    ).toBeInTheDocument();
    expect(
      within(sheetTable).getByText('AI Shift Swap Recommender'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('roadmap-mode-history'));
    const historyTable = screen.getByTestId('roadmap-history-table');
    expect(
      within(historyTable).getByText('Scope Expansion'),
    ).toBeInTheDocument();
    expect(
      within(historyTable).getByText('Added clearinghouse rules'),
    ).toBeInTheDocument();
  });

  it('opens Inspector for an undated Epic, shifts target date, and saves overlay with reason', async () => {
    render(
      <RoadmapView
        workItems={sampleWorkItems}
        project="MaxView"
        areaPath="MaxView"
      />,
    );

    fireEvent.click(screen.getByText('Undated Timecard Compliance Epic'));

    const inspector = screen.getByTestId('roadmap-inspector');
    expect(inspector).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('roadmap-inspector-horizon'), {
      target: { value: 'now' },
    });
    fireEvent.change(screen.getByTestId('roadmap-inspector-target-date'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.click(screen.getByTestId('roadmap-shift-plus-2w'));
    expect(screen.getByTestId('roadmap-inspector-target-date')).toHaveValue(
      '2026-12-15',
    );

    fireEvent.change(screen.getByTestId('roadmap-inspector-reason'), {
      target: { value: 'Scope Expansion' },
    });
    fireEvent.change(screen.getByTestId('roadmap-inspector-note'), {
      target: { value: 'Added nurse overtime rules' },
    });

    fireEvent.click(screen.getByTestId('roadmap-inspector-save'));

    await waitFor(() =>
      expect(mockUpsertMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          workItemId: 101,
          horizon: 'now',
          plannedTargetDate: '2026-12-15',
          reason: 'Scope Expansion',
          note: 'Added nurse overtime rules',
        }),
      ),
    );
  });

  it('opens New Ad-hoc Idea modal and submits a sandbox idea to PostgreSQL', async () => {
    render(
      <RoadmapView
        workItems={sampleWorkItems}
        project="MaxView"
        areaPath="MaxView"
      />,
    );

    fireEvent.click(screen.getByTestId('roadmap-new-idea-btn'));
    fireEvent.change(screen.getByTestId('roadmap-idea-title-input'), {
      target: { value: 'Prior Auth Auto-Triage' },
    });
    fireEvent.change(screen.getByTestId('roadmap-idea-owner-input'), {
      target: { value: 'Sarah BA' },
    });
    fireEvent.change(screen.getByTestId('roadmap-idea-horizon-select'), {
      target: { value: 'now' },
    });
    fireEvent.click(screen.getByTestId('roadmap-create-idea-submit'));

    await waitFor(() =>
      expect(mockCreateIdeaMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Prior Auth Auto-Triage',
          ownerLabel: 'Sarah BA',
          horizon: 'now',
        }),
      ),
    );
  });
});
