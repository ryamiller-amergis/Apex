import { render, screen } from '@testing-library/react';
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

describe('InterviewsDashboard uniform cards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders every design doc as a card, including multi-doc write-ups', () => {
    (useDesignDocList as jest.Mock).mockReturnValue({
      data: [
        makeDoc(),
        makeDoc({
          id: 'dd-2',
          prdId: 'prd-cal',
          prdTitle: 'Calendar widget on home screen',
          title: 'Calendar feature 1',
          status: 'pending_review',
        }),
        makeDoc({
          id: 'dd-3',
          prdId: 'prd-cal',
          prdTitle: 'Calendar widget on home screen',
          title: 'Calendar feature 2',
          status: 'pending_review',
        }),
      ],
      isLoading: false,
    });

    renderDashboard('/backlog?tab=design-docs');

    expect(screen.queryByTestId('design-doc-group')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('design-doc-card')).toHaveLength(3);
    expect(screen.getByText('Agent Home delivery pipeline entry')).toBeInTheDocument();
    expect(screen.getByText('Calendar feature 1')).toBeInTheDocument();
    expect(screen.getByText('Calendar feature 2')).toBeInTheDocument();
  });

  it('renders every prototype as a card, including multi-prototype write-ups', () => {
    (useDesignPrototypeList as jest.Mock).mockReturnValue({
      data: [
        makeProto(),
        makeProto({
          id: 'proto-2',
          prdId: 'prd-todo',
          prdTitle: 'To do list on users profile page',
          featureName: 'Todo list',
          featureIndex: 0,
          status: 'pending_review',
        }),
        makeProto({
          id: 'proto-3',
          prdId: 'prd-todo',
          prdTitle: 'To do list on users profile page',
          featureName: 'Todo detail',
          featureIndex: 1,
          status: 'pending_review',
        }),
      ],
      isLoading: false,
    });

    renderDashboard('/backlog?tab=design-prototypes');

    expect(screen.queryByTestId('design-prototype-group')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('design-prototype-card')).toHaveLength(3);
    expect(screen.getByText('Pipeline strip')).toBeInTheDocument();
    expect(screen.getByText('Todo list')).toBeInTheDocument();
    expect(screen.getByText('Todo detail')).toBeInTheDocument();
  });
});
