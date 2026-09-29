import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReleaseView from '../ReleaseView';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    isInAnyGroup: () => true,
    permissionsLoaded: true,
    can: () => true,
  }),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: () => true,
  useFeatureFlags: () => ({ flags: { 'release-cab-request': true }, isLoading: false }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useProjectSkillConfig: () => ({
    data: { id: 's1', skillRepo: 'MaxView', skillBranch: 'main', skillProvider: 'ado' },
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillList: () => ({
    data: [{ name: 'cab-release', path: '.cursor/skills/cab-release/SKILL.md' }],
  }),
  useStartChat: () => ({ mutateAsync: jest.fn().mockResolvedValue({ threadId: 't1' }), isPending: false }),
}));

jest.mock('../../hooks/useAgentChatSession', () => ({
  useAgentChatSession: () => ({
    messages: [],
    visibleMessages: [],
    streamingText: '',
    isRunning: false,
    isSending: false,
    showTypingIndicator: false,
    send: jest.fn(),
    cancel: jest.fn(),
  }),
}));

jest.mock('../CabReleaseAssistantPanel', () => ({
  CabReleaseAssistantPanel: ({ open, targetVersion }: { open: boolean; targetVersion: string }) =>
    open ? <div data-testid="cab-release-assistant-panel">CAB {targetVersion}</div> : null,
}));

const createWrapper = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

global.fetch = jest.fn();

const okResponse = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => data,
  });

describe('ReleaseView - Create CAB request', () => {
  const mockEpics = [
    {
      id: 100,
      title: 'Release 2026.12.0',
      version: '2026.12.0',
      status: 'In Progress',
      progress: 50,
      completedItems: 5,
      totalItems: 10,
    },
    {
      id: 101,
      title: 'Release 2026.13.0',
      version: '2026.13.0',
      status: 'In Progress',
      progress: 10,
      completedItems: 1,
      totalItems: 10,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/releases/epics')) return okResponse(mockEpics);
      if (url.includes('/related-items')) return okResponse([{ id: 53247, title: 'Item' }]);
      if (url.startsWith('/api/releases?')) return okResponse([]);
      return okResponse([]);
    });
  });

  it('opens the confirmation modal from Actions and starts the panel on confirm', async () => {
    const user = userEvent.setup();
    render(
      <ReleaseView workItems={[]} project="MaxView" areaPath="MaxView" />,
      { wrapper: createWrapper() },
    );

    const menus = await screen.findAllByTitle('Actions');
    await user.click(menus[1]);
    await user.click(screen.getByTestId('release-create-cab-101'));

    expect(screen.getByTestId('create-cab-request-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('create-cab-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('cab-release-assistant-panel')).toHaveTextContent('CAB 2026.13.0');
    });
  });
});
