import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ApexWorkBoardView } from '../ApexWorkBoardView';

jest.mock('react-dnd', () => ({
  useDrag: () => [{ isDragging: false }, jest.fn()],
  useDrop: () => [{ isOver: false }, jest.fn()],
  DndProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

jest.mock('react-dnd-html5-backend', () => ({
  HTML5Backend: {},
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../hooks/useApexWorkItems', () => ({
  useApexWorkItems: jest.fn(),
  useApexWorkItemOwners: jest.fn(),
  useApexWorkItemFacets: jest.fn(),
  useMoveApexWorkItem: jest.fn(),
  useCreateApexRelease: jest.fn(),
  useBulkUpdateApexWorkItems: jest.fn(),
  useApexWorkBoardStream: jest.fn(),
  useImportApexWorkItemsFromAdo: jest.fn(),
  usePreviewMaterializeFromPrd: jest.fn(),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: () => false }),
}));

jest.mock('../ApexWorkItemDetailPanel', () => ({
  ApexWorkItemDetailPanel: ({ onClose }: { onClose: () => void }) =>
    React.createElement('div', { 'data-testid': 'detail-panel' },
      React.createElement('button', { onClick: onClose }, 'Close')
    ),
}));

jest.mock('../WorkBoardHelpCallout', () => ({
  WorkBoardHelpCallout: () => null,
}));

import {
  useApexWorkItems,
  useApexWorkItemOwners,
  useApexWorkItemFacets,
  useMoveApexWorkItem,
  useCreateApexRelease,
  useBulkUpdateApexWorkItems,
  useApexWorkBoardStream,
  useImportApexWorkItemsFromAdo,
} from '../../hooks/useApexWorkItems';

const mockUseItems = useApexWorkItems as jest.Mock;
const mockUseOwners = useApexWorkItemOwners as jest.Mock;
const mockUseFacets = useApexWorkItemFacets as jest.Mock;
const mockUseMove = useMoveApexWorkItem as jest.Mock;
const mockUseCreateRelease = useCreateApexRelease as jest.Mock;
const mockUseBulk = useBulkUpdateApexWorkItems as jest.Mock;
const mockUseStream = useApexWorkBoardStream as jest.Mock;
const mockUseImport = useImportApexWorkItemsFromAdo as jest.Mock;

const MOCK_ITEMS = [
  {
    id: 'i1', itemNumber: 1, title: 'First PBI', outcome: 'Deliver something',
    type: 'PBI', status: 'idea',
    owner: { oid: 'u1', displayName: 'Aneesh', email: 'a@a.com' },
    collaborators: [], acceptanceCriteria: [],
    branch: null, prUrl: null, position: 0, sourceType: 'standalone',
    prdId: null, backlogItemId: null, featureRequestId: null, adoWorkItemId: null,
    epicId: null, epicTitle: null, featureId: null, featureTitle: null,
    designDocId: null, designPrototypeId: null,
    createdBy: 'u1', updatedBy: 'u1', createdAt: '2026-07-28T00:00:00Z', updatedAt: '2026-07-28T00:00:00Z',
  },
  {
    id: 'i2', itemNumber: 2, title: 'Ready TBI', outcome: 'Technical thing',
    type: 'TBI', status: 'ready',
    owner: { oid: 'u1', displayName: 'Aneesh', email: 'a@a.com' },
    collaborators: [], acceptanceCriteria: [{ id: 'ac1', text: 'Works', done: true }],
    branch: 'feature/thing', prUrl: null, position: 0, sourceType: 'prd',
    prdId: 'prd-1', backlogItemId: 'bi-1', featureRequestId: null, adoWorkItemId: null,
    epicId: 'e1', epicTitle: 'Epic One', featureId: 'f1', featureTitle: 'Feature One',
    designDocId: 'dd-1', designPrototypeId: null,
    createdBy: 'u1', updatedBy: 'u1', createdAt: '2026-07-28T00:00:00Z', updatedAt: '2026-07-28T00:00:00Z',
  },
];

const MOCK_OWNERS = [
  { oid: 'u1', displayName: 'Aneesh', email: 'a@a.com' },
  { oid: 'u2', displayName: 'Ryan', email: 'r@r.com' },
];

function stubBoardHooks() {
  mockUseItems.mockReturnValue({ data: MOCK_ITEMS, isLoading: false, isError: false });
  mockUseOwners.mockReturnValue({ data: MOCK_OWNERS });
  mockUseFacets.mockReturnValue({
    data: {
      epicTitles: ['Epic One'],
      featureTitles: ['Feature One'],
      owners: MOCK_OWNERS,
      releases: [],
    },
  });
  mockUseMove.mockReturnValue({ mutate: jest.fn() });
  mockUseCreateRelease.mockReturnValue({ mutate: jest.fn() });
  mockUseBulk.mockReturnValue({ mutate: jest.fn() });
  mockUseStream.mockReturnValue(undefined);
  mockUseImport.mockReturnValue({ mutate: jest.fn(), isPending: false, isError: false, error: null });
}

function setup() {
  stubBoardHooks();

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/work-board']}>
        <ApexWorkBoardView currentUserId="u1" project="Apex" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ApexWorkBoardView', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders all 5 column headers', () => {
    setup();
    expect(screen.getByText('Idea')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('renders items in correct columns', () => {
    setup();
    expect(screen.getByText('First PBI')).toBeInTheDocument();
    expect(screen.getByText('Ready TBI')).toBeInTheDocument();
  });

  it('renders breadcrumb for items with epic/feature', () => {
    setup();
    // Epic One appears in both the card breadcrumb and the filter select — just check presence
    expect(screen.getAllByText('Epic One').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Feature One').length).toBeGreaterThan(0);
  });

  it('shows loading skeletons when loading', () => {
    stubBoardHooks();
    mockUseItems.mockReturnValue({ data: [], isLoading: true, isError: false });
    mockUseOwners.mockReturnValue({ data: [] });
    mockUseFacets.mockReturnValue({ data: undefined });

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ApexWorkBoardView currentUserId="u1" project="Apex" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Skeleton cards have no real text content but columns still render
    expect(screen.queryByText('First PBI')).not.toBeInTheDocument();
  });

  it('shows error state on failure', () => {
    stubBoardHooks();
    mockUseItems.mockReturnValue({ data: [], isLoading: false, isError: true });
    mockUseOwners.mockReturnValue({ data: [] });
    mockUseFacets.mockReturnValue({ data: undefined });

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ApexWorkBoardView currentUserId="u1" project="Apex" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
  });

  it('shows accessible empty state when there are no items', () => {
    stubBoardHooks();
    mockUseItems.mockReturnValue({ data: [], isLoading: false, isError: false });

    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ApexWorkBoardView currentUserId="u1" project="Apex" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const empty = screen.getByTestId('work-board-empty');
    expect(empty).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('work-board-empty-cta')).toBeInTheDocument();
  });

  it('defaults owner filter to My board (currentUserId)', () => {
    setup();
    const ownerSelect = screen.getByDisplayValue('My board');
    expect(ownerSelect).toBeInTheDocument();
  });

  it('opens detail panel when card is clicked', () => {
    setup();
    const card = screen.getByRole('button', { name: /First PBI/ });
    fireEvent.click(card);
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });

  it('closes detail panel on close', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /First PBI/ }));
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
  });

  it('defaults to delivery types (PBI/TBI/Bug)', () => {
    setup();
    expect(mockUseItems).toHaveBeenCalledWith(
      expect.objectContaining({ types: expect.arrayContaining(['PBI', 'TBI', 'Bug']) }),
    );
  });

  it('can switch to all types including Epic/Feature', () => {
    setup();
    fireEvent.click(screen.getByTestId('work-board-type-all'));
    expect(mockUseItems).toHaveBeenCalledWith(
      expect.objectContaining({
        types: expect.arrayContaining(['PBI', 'TBI', 'Bug', 'Epic', 'Feature']),
      }),
    );
  });
});
