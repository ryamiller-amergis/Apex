import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InterviewsDashboard } from '../InterviewsDashboard';
import type { DesignDocSummary } from '../../../shared/types/interview';
import type { DesignPrototypeSummary } from '../../../shared/types/designPrototype';

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}));

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useInterviews', () => ({
  useInterviewList: jest.fn(() => ({ data: [], isLoading: false })),
  usePrdList: jest.fn(() => ({ data: [], isLoading: false })),
  useDesignDocList: jest.fn(() => ({ data: [], isLoading: false })),
  useDeleteInterview: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDeletePrd: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
  useDeleteDesignDoc: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

jest.mock('../../hooks/useDesignPrototypes', () => ({
  useDesignPrototypeList: jest.fn(() => ({ data: [], isLoading: false })),
  useDeletePrototype: jest.fn(() => ({ mutate: jest.fn(), isPending: false })),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: jest.fn(() => ({
    data: { prototypeStageEnabled: true },
    isLoading: false,
  })),
}));

jest.mock('../ConfirmDeleteModal', () => ({
  ConfirmDeleteModal: () => null,
}));

import { useAppShell } from '../../hooks/useAppShell';
import { useDesignDocList } from '../../hooks/useInterviews';
import { useDesignPrototypeList } from '../../hooks/useDesignPrototypes';

function makeDoc(overrides: Partial<DesignDocSummary> = {}): DesignDocSummary {
  return {
    id: 'dd-1',
    prdId: 'prd-1',
    prdTitle: 'Agent Home delivery pipeline entry',
    project: 'Apex',
    chatThreadId: null,
    authorId: 'user-1',
    title: 'Agent Home delivery pipeline entry',
    status: 'approved',
    createdAt: '2026-08-21T00:00:00Z',
    updatedAt: '2026-08-21T00:00:00Z',
    ...overrides,
  };
}

function makeProto(overrides: Partial<DesignPrototypeSummary> = {}): DesignPrototypeSummary {
  return {
    id: 'proto-1',
    prdId: 'prd-1',
    prdTitle: 'Agent Home delivery pipeline entry',
    featureName: 'Pipeline strip',
    featureIndex: 0,
    authorId: 'user-1',
    status: 'approved',
    mockVersion: 1,
    createdAt: '2026-08-21T00:00:00Z',
    updatedAt: '2026-08-21T00:00:00Z',
    ...overrides,
  };
}

function renderDashboard(path = '/') {
  (useAppShell as jest.Mock).mockReturnValue({
    can: jest.fn((key: string) => key === 'interviews:manage' || key === 'interviews:view'),
    isInAnyGroup: jest.fn(() => true),
    isSuperAdmin: false,
    isAdmin: false,
    userId: 'user-1',
    selectedProject: 'Apex',
    permissions: ['interviews:manage', 'interviews:view'],
    roles: ['member'],
    groups: ['BA'],
    permissionsLoaded: true,
  });

  return render(
    <MemoryRouter initialEntries={[path]}>
      <InterviewsDashboard />
    </MemoryRouter>,
  );
}

function seedCalendarWriteup() {
  (useDesignDocList as jest.Mock).mockReturnValue({
    data: [
      makeDoc(),
      makeDoc({
        id: 'dd-2',
        prdId: 'prd-cal',
        prdTitle: 'Calendar widget on home screen',
        title: 'Calendar feature 1',
        status: 'pending_review',
        featureIndex: 0,
      }),
      makeDoc({
        id: 'dd-3',
        prdId: 'prd-cal',
        prdTitle: 'Calendar widget on home screen',
        title: 'Calendar feature 2',
        status: 'pending_review',
        featureIndex: 1,
      }),
    ],
    isLoading: false,
  });
  (useDesignPrototypeList as jest.Mock).mockReturnValue({
    data: [
      makeProto(),
      makeProto({
        id: 'proto-2',
        prdId: 'prd-cal',
        prdTitle: 'Calendar widget on home screen',
        featureName: 'Calendar widget',
        featureIndex: 0,
        status: 'approved',
      }),
      makeProto({
        id: 'proto-3',
        prdId: 'prd-cal',
        prdTitle: 'Calendar widget on home screen',
        featureName: 'Calendar detail',
        featureIndex: 1,
        status: 'pending_review',
      }),
    ],
    isLoading: false,
  });
}

describe('InterviewsDashboard design grouping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('groups design docs and prototypes under one expandable PRD row', () => {
    seedCalendarWriteup();
    renderDashboard('/backlog?tab=designs');

    expect(screen.getByTestId('tab-designs')).toBeInTheDocument();
    expect(screen.getAllByTestId('design-prd-group')).toHaveLength(2);
    expect(screen.getByText('Calendar widget on home screen')).toBeInTheDocument();
    expect(screen.getByText('2 docs · 2 prototypes')).toBeInTheDocument();
    expect(screen.queryByText('Calendar feature 1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('design-prd-group-toggle-prd-cal'));

    expect(screen.getByText('Calendar feature 1')).toBeInTheDocument();
    expect(screen.getByText('Calendar feature 2')).toBeInTheDocument();
    expect(screen.getByText('Calendar widget')).toBeInTheDocument();
    expect(screen.getByText('Calendar detail')).toBeInTheDocument();
    expect(screen.getAllByTestId('design-doc-card')).toHaveLength(2);
    expect(screen.getAllByTestId('design-prototype-card')).toHaveLength(2);
  });

  it('opens the Designs tab from the legacy design-docs URL', () => {
    seedCalendarWriteup();
    renderDashboard('/backlog?tab=design-docs');
    expect(screen.getAllByTestId('design-prd-group')).toHaveLength(2);
  });

  it('opens the Designs tab from the legacy design-prototypes URL', () => {
    seedCalendarWriteup();
    renderDashboard('/backlog?tab=design-prototypes');
    expect(screen.getAllByTestId('design-prd-group')).toHaveLength(2);
  });

  it('auto-expands when only one PRD has designs', () => {
    (useDesignDocList as jest.Mock).mockReturnValue({
      data: [makeDoc({ title: 'Only doc' })],
      isLoading: false,
    });
    (useDesignPrototypeList as jest.Mock).mockReturnValue({
      data: [makeProto({ featureName: 'Only proto' })],
      isLoading: false,
    });

    renderDashboard('/backlog?tab=designs');

    expect(screen.getByText('Only doc')).toBeInTheDocument();
    expect(screen.getByText('Only proto')).toBeInTheDocument();
  });
});
