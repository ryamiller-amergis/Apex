import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StandupSummaryView } from '../StandupSummaryView';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

jest.mock('remark-gfm', () => () => undefined);

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: () => false,
  }),
}));

const mockSession = {
  id: 'session-1',
  sessionDate: '2026-06-30',
  status: 'completed',
  summaryMarkdown: '## Team update\nAll good.',
  config: { project: 'MaxView', areaPath: 'MaxView\\Team' },
  participants: [
    {
      id: 'p1',
      userId: 'user-1',
      status: 'submitted',
      structuredUpdate: {
        yesterday: 'Shipped feature',
        today: 'Code review',
        blockers: 'None',
      },
      submittedAt: '2026-06-30T10:00:00Z',
    },
  ],
  followups: [
    {
      id: 'f1',
      title: 'Follow up with QA',
      description: 'Confirm test plan',
      status: 'open',
      participantUserIds: ['user-1'],
    },
  ],
};

function renderWithSession(sessionId: string | null) {
  const path = sessionId ? `/standup-summary?session=${sessionId}` : '/standup-summary';
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/standup-summary" element={<StandupSummaryView />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('StandupSummaryView', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('shows loading then session summary when fetch succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => mockSession,
    } as Response);

    renderWithSession('session-1');

    expect(screen.getByText('Loading session...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Standup Summary')).toBeInTheDocument();
    });

    expect(screen.getByText(/All good\./)).toBeInTheDocument();
    expect(screen.getByText('Follow up with QA')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith('/api/standup/sessions/session-1');
  });

  it('shows not found when fetch returns empty session', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => null,
    } as Response);

    renderWithSession('missing-session');

    await waitFor(() => {
      expect(screen.getByText('Session not found.')).toBeInTheDocument();
    });
  });
});
