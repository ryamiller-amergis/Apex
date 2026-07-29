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
