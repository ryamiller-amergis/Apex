/**
 * FEAT-004 — WalkthroughAiDraftPanel client tests (PBI-003 / PBI-004).
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WalkthroughAiDraftPanel } from '../WalkthroughAiDraftPanel';
import { buildProposalUnits } from '../../../shared/types/walkthroughAiDraft';
import {
  WalkthroughsAiOptionsProvider,
  type WalkthroughsAiOptions,
} from '../../contexts/WalkthroughsAiOptionsContext';

const mockGenerate = jest.fn();
const mockRedo = jest.fn();
const mockValidate = jest.fn();
const mockMatches = jest.fn();

jest.mock('../../hooks/useWalkthroughAiOptions', () => ({
  useWalkthroughAiOptionsQuery: () => ({
    data: null,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useSaveWalkthroughAiOptions: () => ({
    mutateAsync: jest.fn(),
    isPending: false,
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
  useWalkthroughAnchorMatches: () => ({
    mutateAsync: mockMatches,
    isPending: false,
  }),
}));

jest.mock('../../hooks/usePlatformAdminWalkthroughs', () => ({
  useWalkthroughAnchors: () => ({
    data: [
      {
        key: 'profile-bio',
        testId: 'profile-bio',
        label: 'Profile bio',
        targetRoute: '/profile',
        allowedPlacements: ['bottom'],
        smartTags: ['profile', 'bio'],
      },
      {
        key: 'design-module-add-btn',
        testId: 'design-module-add-btn',
        label: 'Design Module — Add module',
        targetRoute: '/design-module',
        allowedPlacements: ['right'],
        smartTags: ['design', 'module', 'add', 'button'],
      },
      {
        key: 'design-module-sidebar',
        testId: 'design-module-sidebar',
        label: 'Design Module — module sidebar',
        targetRoute: '/design-module',
        allowedPlacements: ['right'],
        smartTags: ['design', 'module', 'sidebar'],
      },
    ],
    isLoading: false,
  }),
}));

function renderPanel(
  onMergeDraft = jest.fn(),
  optionsInitial?: Partial<WalkthroughsAiOptions>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WalkthroughsAiOptionsProvider initial={optionsInitial}>
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
      </WalkthroughsAiOptionsProvider>
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

  it('shows Options hint for skill and model (configured on Options tab)', () => {
    renderPanel();
    expect(screen.getByTestId('walkthrough-ai-options-hint')).toBeInTheDocument();
    expect(screen.getByTestId('walkthrough-ai-options-hint')).toHaveTextContent(
      /Walkthroughs → Options/i,
    );
    expect(screen.queryByTestId('walkthrough-ai-cursor-model')).not.toBeInTheDocument();
    expect(screen.queryByTestId('walkthrough-ai-skill-path')).not.toBeInTheDocument();
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

  it('passes model and skillPath from Options context to generate', async () => {
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

    renderPanel(jest.fn(), {
      walkthroughGenerationModel: 'gpt-4o',
      walkthroughGenerationSkillPath: '.cursor/skills/custom/SKILL.md',
    });
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

  it('anchorless step renders centered with a route/tag-filtered anchor picker', async () => {
    const user = userEvent.setup();
    const fields = { internalName: 'n', userTitle: 'Title', whyItMatters: 'Why' };
    const steps = [
      {
        id: 's1',
        ordinal: 0,
        heading: 'Low match',
        bodyMarkdown: 'needs anchor',
        anchorMatch: {
          score: 0,
          belowThreshold: true,
          hasAnchor: false,
          routeCompatible: false,
          matchedTags: [],
        },
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
    // Ranked matches may be empty for a weak text query — the catalog still drives options.
    mockMatches.mockResolvedValue({ rankedCandidates: [], autoSelectThreshold: 0.72 });

    renderPanel();
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Find anchors');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));

    // Anchorless step renders as a centered step — no misleading low-confidence noise.
    await screen.findByTestId('walkthrough-proposal-step-s1-centered');
    expect(
      screen.queryByTestId('walkthrough-proposal-step-s1-anchor-low-confidence'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('walkthrough-proposal-step-s1-anchor-match'),
    ).not.toBeInTheDocument();
    // No "Use centered step" button when the step is already centered.
    expect(
      screen.queryByTestId('walkthrough-proposal-step-s1-use-centered'),
    ).not.toBeInTheDocument();

    // Open the picker; filter by route → tags → anchor.
    await user.click(screen.getByTestId('walkthrough-proposal-step-s1-choose-anchor'));
    await waitFor(() => expect(mockMatches).toHaveBeenCalled());
    expect(
      screen.getByTestId('walkthrough-proposal-step-s1-anchor-picker'),
    ).toBeInTheDocument();

    const routeFilter = screen.getByTestId(
      'walkthrough-proposal-step-s1-anchor-route-filter',
    );
    await user.selectOptions(routeFilter, '/design-module');

    // Route drives the available approved anchor tags.
    const tagFilter = await screen.findByTestId(
      'walkthrough-proposal-step-s1-anchor-tag-filter',
    );
    expect(tagFilter).toHaveTextContent('add');

    // Anchor options are scoped to the selected route.
    const anchorSelect = screen.getByTestId(
      'walkthrough-proposal-step-s1-anchor-select',
    ) as HTMLSelectElement;
    const optionText = Array.from(anchorSelect.options)
      .map((o) => o.textContent)
      .join(' ');
    expect(optionText).toContain('Design Module — Add module');
    expect(optionText).toContain('Design Module — module sidebar');
    expect(optionText).not.toContain('Profile bio');

    // Selecting an anchor applies it to the step.
    await user.selectOptions(anchorSelect, 'design-module-add-btn');
    expect(
      await screen.findByTestId('walkthrough-proposal-step-s1-anchor-selected'),
    ).toBeInTheDocument();
  });

  it('free-text search narrows the anchor picker across the whole catalog', async () => {
    const user = userEvent.setup();
    const fields = { internalName: 'n', userTitle: 'Title', whyItMatters: 'Why' };
    const steps = [
      {
        id: 's1',
        ordinal: 0,
        heading: 'Low match',
        bodyMarkdown: 'needs anchor',
        anchorMatch: {
          score: 0,
          belowThreshold: true,
          hasAnchor: false,
          routeCompatible: false,
          matchedTags: [],
        },
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
    mockMatches.mockResolvedValue({ rankedCandidates: [], autoSelectThreshold: 0.72 });

    renderPanel();
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Find anchors');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));
    await screen.findByTestId('walkthrough-proposal-step-s1-centered');

    await user.click(screen.getByTestId('walkthrough-proposal-step-s1-choose-anchor'));
    await waitFor(() => expect(mockMatches).toHaveBeenCalled());

    const search = screen.getByTestId('walkthrough-proposal-step-s1-anchor-search');
    // "sidebar" only matches the design-module sidebar anchor across all routes.
    await user.type(search, 'sidebar');

    const anchorSelect = screen.getByTestId(
      'walkthrough-proposal-step-s1-anchor-select',
    ) as HTMLSelectElement;
    const optionText = Array.from(anchorSelect.options)
      .map((o) => o.textContent)
      .join(' ');
    expect(optionText).toContain('Design Module — module sidebar');
    expect(optionText).not.toContain('Design Module — Add module');
    expect(optionText).not.toContain('Profile bio');
  });

  it('trusts an AI-selected anchor on accept (does not strip to centered)', async () => {
    const user = userEvent.setup();
    const fields = { internalName: 'n', userTitle: 'Title', whyItMatters: 'Why' };
    const steps = [
      {
        id: 's1',
        ordinal: 0,
        heading: 'Open Design Module',
        bodyMarkdown: 'From the sidebar, go to Build → Design Module',
        route: '/design-module',
        anchor: {
          key: 'design-module-add-btn',
          targetRoute: '/design-module',
          placement: 'right' as const,
        },
        // A low heuristic score is no longer treated as low confidence.
        anchorMatch: {
          score: 0.1,
          belowThreshold: false,
          hasAnchor: true,
          routeCompatible: true,
          matchedTags: [],
        },
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
    mockValidate.mockImplementation(async ({ unit }: { unit: { value: { anchor: unknown } } }) => ({
      valid: true,
      normalizedUnit: unit,
    }));

    renderPanel();
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Design Module walkthrough');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));

    await screen.findByTestId('walkthrough-proposal-step-s1-anchor-selected');
    expect(
      screen.queryByTestId('walkthrough-proposal-step-s1-anchor-low-confidence'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId('walkthrough-proposal-step-s1-accept'));
    await waitFor(() => expect(mockValidate).toHaveBeenCalled());
    const acceptedUnit = mockValidate.mock.calls[mockValidate.mock.calls.length - 1][0].unit;
    expect(acceptedUnit.value.anchor?.key).toBe('design-module-add-btn');
  });

  it('Use centered step clears the selected anchor', async () => {
    const user = userEvent.setup();
    const fields = { internalName: 'n', userTitle: 'Title', whyItMatters: 'Why' };
    const steps = [
      {
        id: 's1',
        ordinal: 0,
        heading: 'Open Design Module',
        bodyMarkdown: 'From the sidebar, go to Build → Design Module',
        route: '/design-module',
        anchor: {
          key: 'design-module-add-btn',
          targetRoute: '/design-module',
          placement: 'right' as const,
        },
        anchorMatch: {
          score: 0.1,
          belowThreshold: false,
          hasAnchor: true,
          routeCompatible: true,
          matchedTags: [],
        },
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
    await user.type(screen.getByTestId('walkthrough-ai-intent'), 'Design Module walkthrough');
    await user.click(screen.getByTestId('walkthrough-ai-generate'));
    await screen.findByTestId('walkthrough-proposal-step-s1-anchor-selected');

    await user.click(screen.getByTestId('walkthrough-proposal-step-s1-use-centered'));
    expect(
      await screen.findByTestId('walkthrough-proposal-step-s1-centered'),
    ).toHaveTextContent(/Centered step/i);
  });
});
