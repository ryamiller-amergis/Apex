/**
 * FEAT-004 — walkthroughAiDraftService unit tests (PBI-003 / PBI-004 matrix).
 */

import {
  clearWalkthroughAiTelemetry,
  generateProposal,
  getWalkthroughAiTelemetry,
  listPublicWalkthroughAssetPaths,
  parseGeneratedWalkthroughProposal,
  redoProposalUnit,
  setWalkthroughAiProviderForTests,
  validateProposalUnit,
} from '../services/walkthroughAiDraftService';
import { WalkthroughAiError } from '../../shared/types/walkthroughAiDraft';
import { listWalkthroughAnchors, type WalkthroughAnchorRegistryEntry } from '../../shared/walkthroughAnchors';
import { listAuthoringAnchorEntries } from '../services/walkthroughAnchorRegistryService';

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(async () => ({
    developmentModel: 'test-model',
  })),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(async () => 'test-model'),
}));

/** Authoring allow-list includes a DB-only key that is not a DOM marker. */
const AUTHORING_CATALOG = [
  {
    key: 'user-menu-trigger',
    testId: 'user-menu-trigger',
    label: 'User menu',
    targetRoute: '/home',
    allowedPlacements: ['bottom', 'left', 'right', 'top'] as const,
  },
  {
    key: 'db-only-settings-cta',
    testId: 'db-only-settings-cta',
    label: 'DB-only Settings CTA',
    targetRoute: '/profile',
    allowedPlacements: ['bottom', 'top'] as const,
  },
];

jest.mock('../services/walkthroughAnchorRegistryService', () => ({
  listAuthoringAnchorEntries: jest.fn(async () => [
    {
      key: 'user-menu-trigger',
      testId: 'user-menu-trigger',
      label: 'User menu',
      targetRoute: '/home',
      allowedPlacements: ['bottom', 'left', 'right', 'top'],
    },
    {
      key: 'db-only-settings-cta',
      testId: 'db-only-settings-cta',
      label: 'DB-only Settings CTA',
      targetRoute: '/profile',
      allowedPlacements: ['bottom', 'top'],
    },
  ]),
  listCatalogRecordsForResolution: jest.fn(async () => []),
  getAnchorByKey: jest.fn(async () => null),
}));

const mockedListAuthoring = listAuthoringAnchorEntries as jest.MockedFunction<
  typeof listAuthoringAnchorEntries
>;

describe('walkthroughAiDraftService (FEAT-004)', () => {
  beforeEach(() => {
    clearWalkthroughAiTelemetry();
    setWalkthroughAiProviderForTests(null);
    mockedListAuthoring.mockResolvedValue(AUTHORING_CATALOG as WalkthroughAnchorRegistryEntry[]);
  });

  afterEach(() => {
    setWalkthroughAiProviderForTests(null);
  });

  it('AC-0 — generateProposal returns one staged proposal matching Walkthrough draft shape', async () => {
    const anchor = AUTHORING_CATALOG[0];
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
              route: anchor.targetRoute,
              imageUrl: image,
              imageAlt: image ? 'Apex product logo' : null,
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

    expect(mockedListAuthoring).toHaveBeenCalled();
    expect(proposal.proposalId).toBeTruthy();
    expect(proposal.walkthroughFields.internalName).toBe('ai-intro');
    expect(proposal.steps).toHaveLength(1);
    expect(proposal.steps[0].route).toBe(anchor.targetRoute);
    expect(proposal.steps[0].imageAlt).toBe(image ? 'Apex product logo' : null);
    expect(proposal.units[0].kind).toBe('walkthrough-fields');
    expect(proposal.units[1].kind).toBe('step');
    expect(proposal.policyPreset).toBe('A');
  });

  it('Phase 6 — generateProposal accepts DB authoring keys that are not DOM markers', async () => {
    const dbOnly = AUTHORING_CATALOG[1];
    expect(listWalkthroughAnchors().some((a) => a.key === dbOnly.key)).toBe(false);

    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () =>
        JSON.stringify({
          internalName: 'db-catalog',
          userTitle: 'Catalog tour',
          whyItMatters: 'Uses DB allow-list',
          steps: [
            {
              heading: 'Settings CTA',
              bodyMarkdown: 'Click settings',
              route: dbOnly.targetRoute,
              imageUrl: null,
              imageAlt: null,
              anchorKey: dbOnly.key,
              anchorPlacement: dbOnly.allowedPlacements[0],
            },
          ],
        }),
    });

    const proposal = await generateProposal({
      projectId: 'Apex',
      intent: 'Tour the settings CTA from the catalog',
      policyPreset: 'A',
    });

    expect(proposal.steps[0].anchor).toMatchObject({
      key: dbOnly.key,
      targetRoute: dbOnly.targetRoute,
      placement: dbOnly.allowedPlacements[0],
    });
  });

  it('Phase 6 — parseGeneratedWalkthroughProposal rejects catalog-only keys when falling back to DOM markers', () => {
    const dbOnly = AUTHORING_CATALOG[1];
    const assets = listPublicWalkthroughAssetPaths();
    const raw = JSON.stringify({
      internalName: 'x',
      userTitle: 'y',
      whyItMatters: 'z',
      steps: [
        {
          heading: 'Step',
          bodyMarkdown: 'body',
          route: dbOnly.targetRoute,
          anchorKey: dbOnly.key,
          anchorPlacement: dbOnly.allowedPlacements[0],
        },
      ],
    });

    // Default 4th-arg fallback is DOM markers only — catalog-only keys must be stripped.
    const { proposal: withoutCatalog, registryRejectionCount } = parseGeneratedWalkthroughProposal(
      raw,
      'A',
      assets,
    );
    expect(withoutCatalog.steps[0].anchor).toBeNull();
    expect(registryRejectionCount).toBeGreaterThanOrEqual(1);

    // Explicit authoring catalog accepts the same key.
    const { proposal: withCatalog } = parseGeneratedWalkthroughProposal(
      raw,
      'A',
      assets,
      AUTHORING_CATALOG,
    );
    expect(withCatalog.steps[0].anchor).toMatchObject({ key: dbOnly.key });
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
              route: '/profile/edit',
              imageUrl: 'https://evil.example/x.png',
              imageAlt: 'Untrusted image',
              ctaRoute: '/settings/privacy',
              anchorKey: 'not-a-real-anchor',
            },
          ],
        }),
    });

    const proposal = await generateProposal({ projectId: 'Apex', intent: 'Intent text' });
    expect(proposal.steps[0].anchor).toBeNull();
    expect(proposal.steps[0].route).toBeNull();
    expect(proposal.steps[0].imageUrl).toBeNull();
    expect(proposal.steps[0].imageAlt).toBeNull();
    expect(proposal.steps[0].ctaRoute).toBeNull();
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

  it('PBI-004 AC-0/AC-2 — validateProposalUnit omits image until confirmed', async () => {
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

    const withoutConfirm = await validateProposalUnit({
      projectId: 'Apex',
      unit,
      imageConfirmed: false,
    });
    expect(withoutConfirm.normalizedUnit.kind).toBe('step');
    if (withoutConfirm.normalizedUnit.kind === 'step') {
      expect(withoutConfirm.normalizedUnit.value.imageUrl).toBeNull();
    }

    const withConfirm = await validateProposalUnit({
      projectId: 'Apex',
      unit,
      imageConfirmed: true,
    });
    if (withConfirm.normalizedUnit.kind === 'step') {
      expect(withConfirm.normalizedUnit.value.imageUrl).toBe(image);
    }
  });

  it('VT-09 — stale registry key yields REGISTRY_VALUE_STALE', async () => {
    await expect(
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
      }),
    ).rejects.toMatchObject({ code: 'REGISTRY_VALUE_STALE' });
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
