/**
 * FEAT-004 — WalkthroughAiDraftPanel client tests (PBI-003 / PBI-004).
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalkthroughAiDraftPanel } from '../WalkthroughAiDraftPanel';
import { buildProposalUnits } from '../../../shared/types/walkthroughAiDraft';

const mockGenerate = jest.fn();
const mockRedo = jest.fn();
const mockValidate = jest.fn();

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => ({
    data: [
      { id: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet' },
      { id: 'gpt-4o', displayName: 'GPT-4o' },
    ],
    isLoading: false,
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
        name: 'Custom generation',
        description: 'Custom walkthrough generation',
        path: '.cursor/skills/custom/SKILL.md',
      },
    ],
    isLoading: false,
  }),
}));

jest.mock('../../hooks/useWalkthroughAiDraft', () => ({
  useWalkthroughAiPolicyPresets: () => ({
    data: {
      defaultPreset: 'A',
      presets: [
        {
          id: 'A',
          label: 'Balanced (default)',
          description: '2k',
          maxIntentLength: 2000,
          maxRedoFeedbackLength: 1000,
          timeoutMs: 60000,
          retries: 0,
        },
        {
          id: 'B',
          label: 'Extended',
          description: '4k',
          maxIntentLength: 4000,
          maxRedoFeedbackLength: 2000,
          timeoutMs: 90000,
          retries: 1,
        },
        {
          id: 'C',
          label: 'Strict',
          description: '1k',
          maxIntentLength: 1000,
          maxRedoFeedbackLength: 500,
          timeoutMs: 30000,
          retries: 0,
        },
      ],
    },
    isLoading: false,
  }),
  useGenerateWalkthroughAiDraft: () => ({
    mutateAsync: mockGenerate,
    isPending: false,
    isError: false,
  }),
  useRedoWalkthroughAiUnit: () => ({
    mutateAsync: mockRedo,
    isPending: false,
  }),
  useValidateWalkthroughAiUnit: () => ({
    mutateAsync: mockValidate,
    isPending: false,
  }),
}));

function renderPanel(onMergeDraft = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WalkthroughAiDraftPanel
        projectId="Apex"
        currentDraft={{
          internalName: '',
          userTitle: '',
          whyItMatters: '',
          steps: [],
        }}
        onMergeDraft={onMergeDraft}
      />
    </QueryClientProvider>,
  );
}

describe('WalkthroughAiDraftPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('AC-0 — successful generation shows staged proposal review', async () => {
    const user = userEvent.setup();
    const fields = {
      internalName: 'n',
      userTitle: 'Title',
      whyItMatters: 'Why',
    };
    const steps = [
      {
        id: 's1',
        ordinal: 0,
        heading: 'Step One',
        bodyMarkdown: 'Body',
        imageCandidatePath: '/favicon.svg',
        imageUrl: '/favicon.svg',
      },
    ];
    mockGenerate.mockResolvedValue({
      proposal: {
        proposalId: 'p1',
        walkthroughFields: fields,
        steps,
        units: buildProposalUnits(fields, steps),
        generatedAt: new Date().toISOString(),
        generationContextVersion: 'v1',
        policyPreset: 'A',
      },
    });

    renderPanel();
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Introduce walkthroughs');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-proposal-review')).toBeInTheDocument();
    });
    expect(screen.getByTestId('walkthrough-proposal-fields')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-proposal-step-s1')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-ai-policy-preset')).toHaveValue('A');
  });

  it('AC-1 — generation failure shows status and no proposal review', async () => {
    const user = userEvent.setup();
    mockGenerate.mockRejectedValue(new Error('Walkthrough draft generation failed.'));
    renderPanel();
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Introduce walkthroughs');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));
    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-ai-status')).toHaveTextContent(/failed/i);
    });
    expect(screen.queryByTestId('walkthrough-proposal-review')).not.toBeInTheDocument();
  });

  it('PBI-004 AC-1 — redo failure keeps prior proposal visible', async () => {
    const user = userEvent.setup();
    const fields = { internalName: 'n', userTitle: 'Title', whyItMatters: 'Why' };
    const steps = [{ id: 's1', ordinal: 0, heading: 'Step One', bodyMarkdown: 'Body' }];
    mockGenerate.mockResolvedValue({
      proposal: {
        proposalId: 'p1',
        walkthroughFields: fields,
        steps,
        units: buildProposalUnits(fields, steps),
        generatedAt: new Date().toISOString(),
        generationContextVersion: 'v1',
        policyPreset: 'A',
      },
    });
    mockRedo.mockRejectedValue(new Error('Step redo failed. The previous proposal remains available.'));

    renderPanel();
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Introduce walkthroughs');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));
    await screen.findByTestId('walkthrough-proposal-step-s1');
    await user.click(screen.getByTestId('walkthrough-proposal-step-s1-redo'));

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-ai-status')).toHaveTextContent(/redo failed/i);
    });
    expect(screen.getByTestId('walkthrough-proposal-step-s1')).toBeInTheDocument();
    expect(screen.getByText('Step One')).toBeInTheDocument();
  });

  it('renders Cursor model and skill selectors', () => {
    renderPanel();
    expect(screen.getByTestId('walkthrough-ai-cursor-model')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-ai-skill-path')).toBeInTheDocument();
    const modelSelect = screen.getByTestId('walkthrough-ai-cursor-model') as HTMLSelectElement;
    expect(modelSelect.options.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('walkthrough-ai-skill-path')).toHaveValue(
      '.cursor/skills/walkthrough-generation/SKILL.md',
    );
    expect(screen.queryByText(/Bedrock/i)).not.toBeInTheDocument();
  });

  it('displays provenance after generation', async () => {
    const user = userEvent.setup();
    const fields = { internalName: 'n', userTitle: 'Title', whyItMatters: 'Why' };
    const steps = [{ id: 's1', ordinal: 0, heading: 'Step', bodyMarkdown: 'Body' }];
    mockGenerate.mockResolvedValue({
      proposal: {
        proposalId: 'p1',
        walkthroughFields: fields,
        steps,
        units: buildProposalUnits(fields, steps),
        generatedAt: '2026-07-29T00:00:00Z',
        generationContextVersion: 'v1',
        policyPreset: 'A',
        generationProvenance: {
          provider: 'cursor',
          model: 'claude-3-5-sonnet',
          skillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
          generatedAt: '2026-07-29T00:00:00Z',
          runId: 'run-123',
        },
      },
    });

    renderPanel();
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Generate');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));

    await waitFor(() => {
      expect(screen.getByTestId('walkthrough-ai-provenance')).toBeInTheDocument();
    });
    const provenance = screen.getByTestId('walkthrough-ai-provenance');
    expect(provenance).toHaveTextContent('Provider: cursor');
    expect(provenance).toHaveTextContent('Model: claude-3-5-sonnet');
    expect(provenance).toHaveTextContent('Skill: .cursor/skills/walkthrough-generation/SKILL.md');
  });

  it('passes model and skillPath overrides to generate', async () => {
    const user = userEvent.setup();
    const fields = { internalName: 'n', userTitle: 'T', whyItMatters: 'W' };
    mockGenerate.mockResolvedValue({
      proposal: {
        proposalId: 'p1',
        walkthroughFields: fields,
        steps: [],
        units: buildProposalUnits(fields, []),
        generatedAt: new Date().toISOString(),
        generationContextVersion: 'v1',
        policyPreset: 'A',
      },
    });

    renderPanel();
    await user.selectOptions(screen.getByTestId('walkthrough-ai-cursor-model'), 'gpt-4o');
    await user.selectOptions(
      screen.getByTestId('walkthrough-ai-skill-path'),
      '.cursor/skills/custom/SKILL.md',
    );
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Test');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));

    await waitFor(() => expect(mockGenerate).toHaveBeenCalled());
    const call = mockGenerate.mock.calls[0][0];
    expect(call.model).toBe('gpt-4o');
    expect(call.skillPath).toBe('.cursor/skills/custom/SKILL.md');
  });

  it('PBI-004 AC-0/AC-3 — accept fields and reject step then merge only accepted', async () => {
    const user = userEvent.setup();
    const onMerge = jest.fn();
    const fields = { internalName: 'n', userTitle: 'Title', whyItMatters: 'Why' };
    const steps = [
      { id: 's1', ordinal: 0, heading: 'Keep', bodyMarkdown: 'yes' },
      { id: 's2', ordinal: 1, heading: 'Drop', bodyMarkdown: 'no' },
    ];
    mockGenerate.mockResolvedValue({
      proposal: {
        proposalId: 'p1',
        walkthroughFields: fields,
        steps,
        units: buildProposalUnits(fields, steps),
        generatedAt: new Date().toISOString(),
        generationContextVersion: 'v1',
        policyPreset: 'A',
      },
    });
    mockValidate.mockImplementation(async ({ unit }: { unit: { unitId: string } }) => ({
      valid: true,
      normalizedUnit:
        unit.unitId === 'walkthrough-fields'
          ? { unitId: 'walkthrough-fields', kind: 'walkthrough-fields', value: fields }
          : {
              unitId: 'step-s1',
              kind: 'step',
              value: steps[0],
            },
    }));

    renderPanel(onMerge);
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Introduce walkthroughs');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));
    await screen.findByTestId('walkthrough-proposal-review');

    await user.click(screen.getByTestId('walkthrough-proposal-walkthrough-fields-accept'));
    await user.click(screen.getByTestId('walkthrough-proposal-step-s1-accept'));
    await user.click(screen.getByTestId('walkthrough-proposal-step-s2-reject'));
    await user.click(screen.getByTestId('walkthrough-ai-apply-accepted'));

    expect(onMerge).toHaveBeenCalled();
    const merged = onMerge.mock.calls[0][0];
    expect(merged.internalName).toBe('n');
    expect(merged.steps.map((s: { heading: string }) => s.heading)).toEqual(['Keep']);
  });
});
