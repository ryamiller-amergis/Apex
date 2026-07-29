/**
 * FEAT-004 — walkthroughAiDraftService unit tests (PBI-003 / PBI-004 matrix).
 */

import {
  clearWalkthroughAiTelemetry,
  generateProposal,
  getWalkthroughAiTelemetry,
  listPublicWalkthroughAssetPaths,
  redoProposalUnit,
  setWalkthroughAiProviderForTests,
  validateProposalUnit,
} from '../services/walkthroughAiDraftService';
import { WalkthroughAiError } from '../../shared/types/walkthroughAiDraft';
import { listWalkthroughAnchors } from '../../shared/walkthroughAnchors';

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(async () => ({
    designPlanBedrockModelId: 'test-model',
    designPlanBedrockMaxTokens: 2048,
  })),
}));

describe('walkthroughAiDraftService (FEAT-004)', () => {
  beforeEach(() => {
    clearWalkthroughAiTelemetry();
    setWalkthroughAiProviderForTests(null);
  });

  afterEach(() => {
    setWalkthroughAiProviderForTests(null);
  });

  it('AC-0 — generateProposal returns one staged proposal matching Walkthrough draft shape', async () => {
    const anchor = listWalkthroughAnchors()[0];
    const assets = listPublicWalkthroughAssetPaths();
    const image = assets[0] ?? null;
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () =>
        JSON.stringify({
          internalName: 'ai-intro',
          userTitle: 'Meet Walkthroughs',
          whyItMatters: 'Learn the feature',
          steps: [
            {
              heading: 'Open Help',
              bodyMarkdown: 'Click Help',
              imageUrl: image,
              anchorKey: anchor.key,
              anchorPlacement: anchor.allowedPlacements[0],
            },
          ],
        }),
    });

    const proposal = await generateProposal({
      projectId: 'Apex',
      intent: 'Introduce walkthroughs to new users',
      policyPreset: 'A',
    });

    expect(proposal.proposalId).toBeTruthy();
    expect(proposal.walkthroughFields.internalName).toBe('ai-intro');
    expect(proposal.steps).toHaveLength(1);
    expect(proposal.units[0].kind).toBe('walkthrough-fields');
    expect(proposal.units[1].kind).toBe('step');
    expect(proposal.policyPreset).toBe('A');
  });

  it('AC-1 — provider failure yields AI_GENERATION_FAILED and no partial proposal', async () => {
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () => {
        throw new Error('Bedrock request timed out after 60s');
      },
    });

    await expect(
      generateProposal({ projectId: 'Apex', intent: 'Introduce feature' }),
    ).rejects.toMatchObject({ code: 'AI_GENERATION_FAILED' });
  });

  it('AC-2 / BR-016 — unregistered anchors and non-allow-listed images are stripped', async () => {
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () =>
        JSON.stringify({
          internalName: 'n',
          userTitle: 't',
          whyItMatters: 'w',
          steps: [
            {
              heading: 'Bad assets',
              bodyMarkdown: 'body',
              imageUrl: 'https://evil.example/x.png',
              anchorKey: 'not-a-real-anchor',
            },
          ],
        }),
    });

    const proposal = await generateProposal({ projectId: 'Apex', intent: 'Intent text' });
    expect(proposal.steps[0].anchor).toBeNull();
    expect(proposal.steps[0].imageUrl).toBeNull();
    const tel = getWalkthroughAiTelemetry().find((e) => e.event === 'walkthrough_ai_generation');
    expect(tel?.registryRejectionCount).toBeGreaterThanOrEqual(2);
  });

  it('AC-1 malformed JSON — AI_OUTPUT_INVALID', async () => {
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () => 'not-json',
    });
    await expect(
      generateProposal({ projectId: 'Apex', intent: 'Intent' }),
    ).rejects.toBeInstanceOf(WalkthroughAiError);
  });

  it('policy preset C enforces shorter intent (INTENT_INVALID)', async () => {
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () => '{}',
    });
    const longIntent = 'x'.repeat(1001);
    await expect(
      generateProposal({ projectId: 'Apex', intent: longIntent, policyPreset: 'C' }),
    ).rejects.toMatchObject({ code: 'INTENT_INVALID' });
  });

  it('PBI-004 AC-1 — redo failure leaves caller to retain prior unit (throws AI_REDO_FAILED)', async () => {
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () => {
        throw new Error('provider down');
      },
    });
    await expect(
      redoProposalUnit({
        projectId: 'Apex',
        proposalId: 'p1',
        generationContextVersion: 'v1',
        unit: {
          unitId: 'step-1',
          kind: 'step',
          value: {
            id: '1',
            ordinal: 0,
            heading: 'Prior',
            bodyMarkdown: 'kept',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'AI_REDO_FAILED' });
  });

  it('PBI-004 AC-0/AC-2 — validateProposalUnit omits image until confirmed', () => {
    const assets = listPublicWalkthroughAssetPaths();
    const image = assets[0];
    expect(image).toBeTruthy();

    const unit = {
      unitId: 'step-1',
      kind: 'step' as const,
      value: {
        id: '1',
        ordinal: 0,
        heading: 'With image',
        bodyMarkdown: 'body',
        imageUrl: image,
        imageCandidatePath: image,
        anchor: null,
      },
      imageCandidatePath: image!,
    };

    const withoutConfirm = validateProposalUnit({
      projectId: 'Apex',
      unit,
      imageConfirmed: false,
    });
    expect(withoutConfirm.normalizedUnit.kind).toBe('step');
    if (withoutConfirm.normalizedUnit.kind === 'step') {
      expect(withoutConfirm.normalizedUnit.value.imageUrl).toBeNull();
    }

    const withConfirm = validateProposalUnit({
      projectId: 'Apex',
      unit,
      imageConfirmed: true,
    });
    if (withConfirm.normalizedUnit.kind === 'step') {
      expect(withConfirm.normalizedUnit.value.imageUrl).toBe(image);
    }
  });

  it('VT-09 — stale registry key yields REGISTRY_VALUE_STALE', () => {
    try {
      validateProposalUnit({
        projectId: 'Apex',
        imageConfirmed: false,
        unit: {
          unitId: 'step-1',
          kind: 'step',
          value: {
            id: '1',
            ordinal: 0,
            heading: 'Stale',
            bodyMarkdown: 'body',
            anchor: {
              key: 'missing-key',
              targetRoute: '/home',
              placement: 'bottom',
            },
          },
        },
      });
      throw new Error('expected REGISTRY_VALUE_STALE');
    } catch (err) {
      expect(err).toBeInstanceOf(WalkthroughAiError);
      expect((err as WalkthroughAiError).code).toBe('REGISTRY_VALUE_STALE');
    }
  });

  it('VT-11 — telemetry never includes intent / markdown markers', async () => {
    const marker = 'SECRET_INTENT_MARKER_XYZ';
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () => {
        throw new Error('fail');
      },
    });
    await expect(
      generateProposal({ projectId: 'Apex', intent: marker }),
    ).rejects.toBeTruthy();
    const serialized = JSON.stringify(getWalkthroughAiTelemetry());
    expect(serialized).not.toContain(marker);
  });
});
