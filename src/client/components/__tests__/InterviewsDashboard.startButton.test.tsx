import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InterviewsDashboard } from '../InterviewsDashboard';

// ── Module mocks ───────────────────────────────────────────────────────────────

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
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

jest.mock('../ConfirmDeleteModal', () => ({
  ConfirmDeleteModal: () => null,
}));

// ── Imports after mocks ────────────────────────────────────────────────────────

import { useAppShell } from '../../hooks/useAppShell';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeShell(overrides: Record<string, unknown> = {}) {
  return {
    can: jest.fn((key: string) => key === 'interviews:manage' || key === 'interviews:view'),
    isInAnyGroup: jest.fn(() => true),
    isSuperAdmin: false,
    isAdmin: false,
    userId: 'user-1',
    selectedProject: 'TestProject',
    permissions: ['interviews:manage', 'interviews:view'],
    roles: ['member'],
    groups: ['BA'],
    permissionsLoaded: true,
    ...overrides,
  };
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <InterviewsDashboard />
    </MemoryRouter>,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('InterviewsDashboard — Start New Interview button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('user has interviews:manage AND is in an allowed group', () => {
    beforeEach(() => {
      (useAppShell as jest.Mock).mockReturnValue(
        makeShell({ isInAnyGroup: jest.fn(() => true) }),
      );
    });

    it('renders the button', () => {
      renderDashboard();
      expect(screen.getByRole('button', { name: /start new interview/i })).toBeInTheDocument();
    });

    it('is enabled', () => {
      renderDashboard();
      expect(screen.getByRole('button', { name: /start new interview/i })).not.toBeDisabled();
    });

    it('does not have an unauthorised tooltip', () => {
      renderDashboard();
      const btn = screen.getByRole('button', { name: /start new interview/i });
      expect(btn.closest('[title]')).toBeNull();
    });

    it('navigates to /backlog/interview/new on click', () => {
      renderDashboard();
      screen.getByRole('button', { name: /start new interview/i }).click();
      expect(mockNavigate).toHaveBeenCalledWith('/backlog/interview/new');
    });
  });

  describe('platform admin (super admin) without group membership', () => {
    beforeEach(() => {
      (useAppShell as jest.Mock).mockReturnValue(
        makeShell({
          isSuperAdmin: true,
          isAdmin: true,
          isInAnyGroup: jest.fn(() => true),
          groups: [],
          roles: ['admin'],
        }),
      );
    });

    it('enables the start button', () => {
      renderDashboard();
      expect(screen.getByRole('button', { name: /start new interview/i })).not.toBeDisabled();
    });
  });

  describe('user has interviews:manage but is NOT in an allowed group', () => {
    beforeEach(() => {
      (useAppShell as jest.Mock).mockReturnValue(
        makeShell({ isInAnyGroup: jest.fn(() => false) }),
      );
    });

    it('still renders the button', () => {
      renderDashboard();
      expect(screen.getByRole('button', { name: /start new interview/i })).toBeInTheDocument();
    });

    it('is disabled', () => {
      renderDashboard();
      expect(screen.getByRole('button', { name: /start new interview/i })).toBeDisabled();
    });

    it('wrapper has a tooltip mentioning the required groups', () => {
      renderDashboard();
      const btn = screen.getByRole('button', { name: /start new interview/i });
      const wrapper = btn.closest('[title]') as HTMLElement;
      expect(wrapper).not.toBeNull();
      expect(wrapper.title).toMatch(/BA.*Manager.*Product-Owner/i);
    });

    it('does not navigate on click', () => {
      renderDashboard();
      screen.getByRole('button', { name: /start new interview/i }).click();
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('user does NOT have interviews:manage', () => {
    beforeEach(() => {
      (useAppShell as jest.Mock).mockReturnValue(
        makeShell({
          can: jest.fn(() => false),
          isInAnyGroup: jest.fn(() => true),
          permissions: [],
        }),
      );
    });

    it('does not render the button at all', () => {
      renderDashboard();
      expect(screen.queryByRole('button', { name: /start new interview/i })).toBeNull();
    });
  });

  describe('empty-state hint text', () => {
    it('shows "Start one above." when user can start interviews', () => {
      (useAppShell as jest.Mock).mockReturnValue(
        makeShell({ isInAnyGroup: jest.fn(() => true) }),
      );
      renderDashboard();
      expect(screen.getByText(/start one above/i)).toBeInTheDocument();
    });

    it('omits "Start one above." when user lacks group membership', () => {
      (useAppShell as jest.Mock).mockReturnValue(
        makeShell({ isInAnyGroup: jest.fn(() => false) }),
      );
      renderDashboard();
      expect(screen.queryByText(/start one above/i)).toBeNull();
    });
  });
});
