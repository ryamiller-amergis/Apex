/**
 * Single-step AI generation for adding one step to an existing Walkthrough.
 * Direct-provider flow — mirrors the redo/validate single-unit path.
 */

import {
  clearWalkthroughAiTelemetry,
  generateStepProposal,
  getWalkthroughAiTelemetry,
  parseGeneratedStepUnit,
  setWalkthroughAiProviderForTests,
} from '../services/walkthroughAiDraftService';
import { WalkthroughAiError } from '../../shared/types/walkthroughAiDraft';
import { type WalkthroughAnchorRegistryEntry } from '../../shared/walkthroughAnchors';
import { listAuthoringAnchorEntries } from '../services/walkthroughAnchorRegistryService';

jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(async () => ({ developmentModel: 'test-model' })),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(async () => 'test-model'),
}));

const AUTHORING_CATALOG = [
  {
    key: 'user-menu-trigger',
    testId: 'user-menu-trigger',
    label: 'User menu',
    targetRoute: '/home',
    allowedPlacements: ['bottom', 'left', 'right', 'top'] as const,
    smartTags: ['navigation', 'menu'],
    openerAnchorKeys: [] as const,
    sourceLocations: [{ filePath: 'src/client/components/UserMenu.tsx', line: 20 }],
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
  ]),
  listCatalogRecordsForResolution: jest.fn(async () => []),
  getAnchorByKey: jest.fn(async () => null),
}));

const mockedListAuthoring = listAuthoringAnchorEntries as jest.MockedFunction<
  typeof listAuthoringAnchorEntries
>;

describe('generateStepProposal (single-step AI)', () => {
  beforeEach(() => {
    clearWalkthroughAiTelemetry();
    setWalkthroughAiProviderForTests(null);
    mockedListAuthoring.mockResolvedValue(AUTHORING_CATALOG as WalkthroughAnchorRegistryEntry[]);
  });

  afterEach(() => {
    setWalkthroughAiProviderForTests(null);
  });

  it('returns exactly one reviewable step unit with a validated anchor', async () => {
    const anchor = AUTHORING_CATALOG[0];
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async (prompt) => {
        expect(prompt).toContain('"testId":"user-menu-trigger"');
        expect(prompt).toContain('"sourceLocations"');
        expect(prompt).toContain('hidden modal/menu/tab targets');
        return JSON.stringify({
          heading: 'Open the user menu',
          bodyMarkdown: 'Click your avatar to open the menu.',
          anchorKey: anchor.key,
          anchorPlacement: anchor.allowedPlacements[0],
        });
      },
    });

    const unit = await generateStepProposal({
      projectId: 'Apex',
      intent: 'Show where the user menu lives',
      policyPreset: 'A',
      existingDraft: { internalName: 'tour', userTitle: 'Tour', whyItMatters: '', steps: [] },
    });

    expect(unit.kind).toBe('step');
    if (unit.kind !== 'step') throw new Error('expected step unit');
    expect(unit.value.heading).toBe('Open the user menu');
    expect(unit.value.anchor?.key).toBe('user-menu-trigger');
    expect(unit.value.anchor?.targetRoute).toBe('/home');
    expect(unit.unitId).toBe(`step-${unit.value.id}`);

    const telemetry = getWalkthroughAiTelemetry();
    expect(telemetry.some((e) => e.outcome === 'success' && e.unitKind === 'step')).toBe(true);
  });

  it('drops an unregistered anchor instead of leaking it into the step', async () => {
    setWalkthroughAiProviderForTests({
      generateStructuredJson: async () =>
        JSON.stringify({
          heading: 'Bad anchor step',
          bodyMarkdown: 'Body',
          anchorKey: 'not-a-real-anchor',
          anchorPlacement: 'bottom',
        }),
    });

    const unit = await generateStepProposal({
      projectId: 'Apex',
      intent: 'Add a step referencing a missing anchor',
    });

    if (unit.kind !== 'step') throw new Error('expected step unit');
    expect(unit.value.anchor).toBeNull();
  });

  it('rejects an empty intent', async () => {
    await expect(
      generateStepProposal({ projectId: 'Apex', intent: '   ' }),
    ).rejects.toBeInstanceOf(WalkthroughAiError);
  });

  it('parseGeneratedStepUnit accepts a bare step object and normalizes the route', () => {
    const { unit } = parseGeneratedStepUnit(
      JSON.stringify({ heading: 'H', bodyMarkdown: 'B', route: '/home', anchorKey: 'user-menu-trigger', anchorPlacement: 'bottom' }),
      [],
      AUTHORING_CATALOG as WalkthroughAnchorRegistryEntry[],
    );
    if (unit.kind !== 'step') throw new Error('expected step unit');
    expect(unit.value.route).toBe('/home');
    expect(unit.value.ordinal).toBe(0);
  });
});
