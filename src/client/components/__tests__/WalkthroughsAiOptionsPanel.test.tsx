import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalkthroughsAiOptionsPanel } from '../WalkthroughsAiOptionsPanel';
import { WalkthroughsAiOptionsProvider } from '../../contexts/WalkthroughsAiOptionsContext';
import { defaultWalkthroughAiOptionsRecord } from '../../../shared/types/walkthroughAiOptions';
import { AGENT_MODELS } from '../../config/models';

const mockSave = jest.fn();

jest.mock('../../hooks/useWalkthroughAiOptions', () => ({
  useWalkthroughAiOptionsQuery: () => ({
    data: defaultWalkthroughAiOptionsRecord('2026-07-30T12:00:00.000Z'),
    isLoading: false,
    isError: false,
    error: null,
  }),
  useSaveWalkthroughAiOptions: () => ({
    mutateAsync: mockSave,
    isPending: false,
  }),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => ({
    data: [
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
      { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    ],
    isLoading: false,
    isError: false,
  }),
  useProjectSkillConfig: () => ({
    data: {
      skillRepo: 'Apex',
      skillBranch: 'main',
      skillProvider: 'github',
    },
    isLoading: false,
  }),
}));

jest.mock('../../hooks/useChatThreads', () => ({
  useSkillRepos: () => ({
    data: [{ id: 'repo-1', name: 'Apex', defaultBranch: 'main' }],
    isLoading: false,
  }),
  useSkillList: () => ({
    data: [
      {
        id: 'skill-1',
        name: 'Custom tagging',
        description: 'Custom',
        path: '.cursor/skills/custom-tag/SKILL.md',
      },
    ],
    isLoading: false,
  }),
}));

function renderOptions() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WalkthroughsAiOptionsProvider>
        <WalkthroughsAiOptionsPanel />
      </WalkthroughsAiOptionsProvider>
    </QueryClientProvider>,
  );
}

describe('WalkthroughsAiOptionsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSave.mockResolvedValue({
      ...defaultWalkthroughAiOptionsRecord('2026-07-30T15:00:00.000Z'),
      walkthroughGenerationModel: 'gpt-5.5',
      anchorSmartTaggingModel: 'claude-sonnet-4-6',
      updatedBy: 'user-1',
      updatedByDisplayName: 'Ryan Miller',
      updatedAt: '2026-07-30T15:00:00.000Z',
    });
  });

  it('exposes agent model selects and who/when meta', async () => {
    const user = userEvent.setup();
    renderOptions();

    expect(screen.getByTestId('walkthroughs-ai-options-meta')).toHaveTextContent(/System/i);
    expect(screen.getByTestId('walkthroughs-ai-options-save')).toBeDisabled();

    const generationModel = screen.getByTestId(
      'walkthroughs-ai-options-generation-model',
    ) as HTMLSelectElement;
    const smartTaggingModel = screen.getByTestId(
      'walkthroughs-ai-options-smart-tagging-model',
    ) as HTMLSelectElement;

    await user.selectOptions(generationModel, 'gpt-5.5');
    await user.selectOptions(smartTaggingModel, 'claude-sonnet-4-6');

    expect(screen.getByTestId('walkthroughs-ai-options-save')).toBeEnabled();
    expect(screen.getByTestId('walkthroughs-ai-options-meta')).toHaveTextContent(
      /Unsaved changes/i,
    );

    await user.click(screen.getByTestId('walkthroughs-ai-options-save'));

    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith({
        walkthroughGenerationSkillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
        walkthroughGenerationModel: 'gpt-5.5',
        anchorSmartTaggingSkillPath:
          '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        anchorSmartTaggingModel: 'claude-sonnet-4-6',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('walkthroughs-ai-options-meta')).toHaveTextContent(
        /Ryan Miller/i,
      );
    });
    expect(AGENT_MODELS.length).toBeGreaterThan(0);
  });
});
