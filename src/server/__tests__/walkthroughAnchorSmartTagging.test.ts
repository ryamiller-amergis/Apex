/**
 * Phase 4 — walkthrough-anchor-smart-tagging skill output contracts.
 * Validates parser/validator against the skill JSON schema (Wave 1).
 * Async Cursor orchestration / DB merge are deferred to Wave 2.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
  SMART_TAG_COUNT_MAX,
  SMART_TAG_COUNT_MIN,
  WALKTHROUGH_ANCHOR_SMART_TAGGING_OUTPUT_RELATIVE_PATH,
  applyValidatedSmartTagSuggestions,
  parseWalkthroughAnchorSmartTaggingOutput,
  validateWalkthroughAnchorSmartTaggingResult,
} from '../../shared/types/walkthroughAnchorSmartTagging';

const SKILL_PATH = path.resolve(
  __dirname,
  '../../../.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md'
);

function validSuggestion(overrides: Record<string, unknown> = {}) {
  return {
    testId: 'profile-identity-section',
    anchorKey: 'profile-identity',
    suggestedLabel: 'Profile — Identity',
    suggestedRoute: '/profile',
    allowedPlacements: ['bottom', 'top'],
    smartTags: ['profile', 'identity', 'avatar', 'settings', 'section'],
    confidence: 0.86,
    rationale:
      'Component lives under ProfilePage.tsx on /profile; section heading and avatar controls are visible in source.',
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    suggestions: [validSuggestion()],
    ...overrides,
  };
}

describe('Walkthrough anchor smart-tagging skill contracts (Phase 4)', () => {
  it('ships the skill at the canonical path with schema + rubric cues', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
    const skill = fs.readFileSync(SKILL_PATH, 'utf8');
    expect(DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH).toBe(
      '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md'
    );
    expect(WALKTHROUGH_ANCHOR_SMART_TAGGING_OUTPUT_RELATIVE_PATH).toEqual([
      '.ai-pilot',
      'output',
      'walkthrough-anchor-smart-tagging.json',
    ]);
    expect(skill).toMatch(/walkthrough-anchor-smart-tagging\.json/);
    expect(skill).toMatch(/domain/i);
    expect(skill).toMatch(/action/i);
    expect(skill).toMatch(/UI element/i);
    expect(skill).toMatch(/workflow/i);
    expect(skill).toMatch(/audience/i);
    expect(skill).toMatch(/intent/i);
    expect(skill).toMatch(/3–8|3-8/);
    expect(skill).toMatch(/Evidence-first/i);
    expect(skill).toMatch(/state \/ signal|error/i);
    expect(skill).toMatch(/No invented behavior/i);
    expect(skill).toMatch(/confidence/i);
    expect(skill).toMatch(/rationale/i);
    expect(skill).toMatch(/accessiblePageModules/);
    // Ownership comes from pre-resolved evidence (or import tracing fallback);
    // do not infer from a shared component's filename alone.
    expect(skill).toMatch(/shared component/i);
    expect(skill).toMatch(/owningPageEntries|Pre-Resolved Candidate Evidence/);
    expect(skill).toMatch(/Do NOT browse|do not browse/i);
    expect(skill).toMatch(/Home\/Admin\/Profile|Home, Admin, and Profile/);
    expect(skill).toMatch(/exactly one entry for every input candidate/i);
    expect(skill).toMatch(/Do not evaluate placements/i);
    expect(skill).toMatch(/\["top", "right", "bottom", "left"\]/);
    expect(skill).toMatch(/never a bare array|Never write a bare array/i);
    expect(skill).toMatch(/Do not end the turn until/i);
  });

  it('accepts valid skill output (happy path)', () => {
    const raw = JSON.stringify(validPayload());
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(raw);
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0].smartTags).toHaveLength(5);
    expect(parsed.suggestions[0].suggestedRoute).toBe('/profile');
    expect(validateWalkthroughAnchorSmartTaggingResult(parsed)).toEqual([]);
  });

  it('normalizes the registry label alias emitted by an agent', () => {
    const suggestion = validSuggestion();
    const { suggestedLabel, ...withRegistryAlias } = suggestion;
    const payload = {
      suggestions: [{ ...withRegistryAlias, label: suggestedLabel }],
    };

    expect(validateWalkthroughAnchorSmartTaggingResult(payload)).toEqual([]);
    expect(
      parseWalkthroughAnchorSmartTaggingOutput(JSON.stringify(payload)).suggestions[0]
        .suggestedLabel
    ).toBe('Profile — Identity');
  });

  it('normalizes common root and suggestion field aliases', () => {
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify({
        results: [
          {
            testId: 'profile-save-button',
            key: 'profile-save-button',
            label: 'Save profile',
            route: '/profile',
            tags: ['Profile', 'Save Action', 'Button'],
            confidenceScore: '0.9',
            reason: 'Visible save control in ProfilePage.tsx.',
          },
        ],
      })
    );

    expect(parsed.suggestions[0]).toMatchObject({
      anchorKey: 'profile-save-button',
      suggestedLabel: 'Save profile',
      suggestedRoute: '/profile',
      confidence: 0.9,
      rationale: 'Visible save control in ProfilePage.tsx.',
    });
  });

  it('accepts null suggestedRoute and boundary confidence', () => {
    const raw = JSON.stringify(
      validPayload({
        suggestions: [
          validSuggestion({
            suggestedRoute: null,
            confidence: 0,
            smartTags: ['header', 'navigation', 'button'],
          }),
          validSuggestion({
            testId: 'user-menu-trigger',
            anchorKey: 'user-menu-trigger',
            confidence: 1,
            smartTags: Array.from(
              { length: SMART_TAG_COUNT_MAX },
              (_, i) => `tag-${i + 1}`
            ),
          }),
        ],
      })
    );
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(raw);
    expect(parsed.suggestions).toHaveLength(2);
    expect(validateWalkthroughAnchorSmartTaggingResult(parsed)).toEqual([]);
  });

  it('normalizes smart-tag casing, spaces, and underscores', () => {
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [
            validSuggestion({
              smartTags: ['profile', 'Bad_Tag', 'UI Element'],
            }),
          ],
        })
      )
    );

    expect(parsed.suggestions[0].smartTags).toEqual(
      expect.arrayContaining(['profile', 'bad-tag', 'ui-element'])
    );
    expect(validateWalkthroughAnchorSmartTaggingResult(parsed)).toEqual([]);
  });

  it(`normalizes smart tag counts into ${SMART_TAG_COUNT_MIN}–${SMART_TAG_COUNT_MAX}`, () => {
    const tooFew = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [validSuggestion({ smartTags: [] })],
        })
      )
    );
    const tooMany = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [
            validSuggestion({
              smartTags: Array.from({ length: 12 }, (_, i) => `tag-${i + 1}`),
            }),
          ],
        })
      )
    );

    expect(tooFew.suggestions[0].smartTags.length).toBeGreaterThanOrEqual(
      SMART_TAG_COUNT_MIN
    );
    expect(tooMany.suggestions[0].smartTags).toHaveLength(SMART_TAG_COUNT_MAX);
  });

  it('ignores unknown fields instead of applying them', () => {
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify({
        ...validPayload({
          suggestions: [{ ...validSuggestion(), madeUpField: 'nope' }],
        }),
        inventedTopLevel: true,
      })
    );

    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0]).not.toHaveProperty('madeUpField');
  });

  it.each([
    ['percentage number', 85, 0.85],
    ['numeric string', '0.73', 0.73],
    ['negative value', -0.1, 0],
    ['non-numeric value', 'high', 0.5],
  ])('normalizes %s confidence', (_case, emitted, expected) => {
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [validSuggestion({ confidence: emitted })],
        })
      )
    );
    expect(parsed.suggestions[0].confidence).toBe(expected);
  });

  it('normalizes an invalid route to null for manual review', () => {
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [
            validSuggestion({ suggestedRoute: '/not-a-real-route' }),
          ],
        })
      )
    );
    expect(parsed.suggestions[0].suggestedRoute).toBeNull();
  });

  it.each([
    ['unsupported tooltip term', ['tooltip']],
    ['partial placement list', ['bottom']],
    ['empty placement list', []],
    ['missing placement list', undefined],
  ])('normalizes %s to the deterministic placement policy', (_case, emitted) => {
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [validSuggestion({ allowedPlacements: emitted })],
        })
      )
    );

    expect(parsed.suggestions[0].allowedPlacements).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ]);
  });

  it('rejects invalid JSON, empty output, and missing candidate identity', () => {
    expect(() => parseWalkthroughAnchorSmartTaggingOutput('{')).toThrow(
      /JSON|INVALID_OUTPUT/i
    );
    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify({ suggestions: [] })
      )
    ).toThrow(/suggestions|EMPTY/i);
    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify({
          suggestions: [
            {
              suggestedLabel: 'No candidate identity',
            },
          ],
        })
      )
    ).toThrow(/testId|required|INVALID_/i);
  });

  it('fills review-safe defaults when optional agent fields are missing', () => {
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify({ suggestions: [{ testId: 'profile-save-button' }] })
    );

    expect(parsed.suggestions[0]).toMatchObject({
      testId: 'profile-save-button',
      anchorKey: 'profile-save-button',
      suggestedLabel: 'Profile Save Button',
      suggestedRoute: null,
      confidence: 0.5,
    });
    expect(parsed.suggestions[0].smartTags.length).toBeGreaterThanOrEqual(3);
    expect(parsed.suggestions[0].rationale).toMatch(/manual review/i);
  });

  it('recovers a bare suggestions array (common agent packaging mistake)', () => {
    const bare = [
      validSuggestion({
        testId: 'new-candidate',
        anchorKey: 'new-candidate',
        suggestedLabel: 'New candidate',
      }),
    ];
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(JSON.stringify(bare));
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0].testId).toBe('new-candidate');
    expect(validateWalkthroughAnchorSmartTaggingResult(bare)).toEqual([]);
  });

  it('strips markdown fences before parsing', () => {
    const fenced = `\`\`\`json\n${JSON.stringify(validPayload())}\n\`\`\``;
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(fenced);
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0].testId).toBe(
      validPayload().suggestions[0].testId
    );
  });

  it('pure merge helper applies validated suggestions onto pending rows only', () => {
    const result = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [
            validSuggestion({
              testId: 'new-candidate',
              anchorKey: 'new-candidate',
              suggestedLabel: 'New candidate',
              smartTags: ['profile', 'settings', 'section', 'edit'],
              confidence: 0.7,
              rationale: 'Found in ProfilePage.tsx near bio controls.',
            }),
            validSuggestion({
              testId: 'already-approved',
              anchorKey: 'already-approved',
              suggestedLabel: 'Should not apply',
              smartTags: ['profile', 'settings', 'section'],
              confidence: 0.9,
              rationale: 'Would be ignored because row is approved.',
            }),
          ],
        })
      )
    );

    const merged = applyValidatedSmartTagSuggestions(
      [
        {
          id: 'row-1',
          testId: 'new-candidate',
          anchorKey: 'new-candidate',
          label: 'Pending label',
          suggestedRoute: null,
          allowedPlacements: ['bottom'],
          smartTags: [],
          reviewStatus: 'pending',
          aiProvenance: null,
        },
        {
          id: 'row-2',
          testId: 'already-approved',
          anchorKey: 'already-approved',
          label: 'Approved label',
          suggestedRoute: '/profile',
          allowedPlacements: ['top'],
          smartTags: ['keep-me'],
          reviewStatus: 'approved',
          aiProvenance: null,
        },
        {
          id: 'row-3',
          testId: 'untagged',
          anchorKey: 'untagged',
          label: 'No suggestion',
          suggestedRoute: null,
          allowedPlacements: ['left'],
          smartTags: [],
          reviewStatus: 'pending',
          aiProvenance: null,
        },
      ],
      result,
      {
        provider: 'cursor',
        model: 'claude-sonnet-4',
        skillPath: DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
        generatedAt: '2026-07-30T04:00:00.000Z',
        threadId: 'thread-smart-tag-1',
        runId: null,
      }
    );

    expect(merged).toHaveLength(3);
    expect(merged[0].label).toBe('New candidate');
    expect(merged[0].suggestedRoute).toBe('/profile');
    expect(merged[0].smartTags).toEqual([
      'candidate',
      'profile',
      'settings',
      'section',
      'edit',
    ]);
    expect(merged[0].allowedPlacements).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ]);
    expect(merged[0].aiProvenance?.confidence).toBe(0.7);
    expect(merged[0].aiProvenance?.rationale).toMatch(/ProfilePage/);
    expect(merged[0].aiProvenance?.threadId).toBe('thread-smart-tag-1');

    // Approved rows are left untouched (Wave 1: suggestions only merge into pending).
    expect(merged[1].label).toBe('Approved label');
    expect(merged[1].smartTags).toEqual(['keep-me']);
    expect(merged[1].aiProvenance).toBeNull();

    expect(merged[2].label).toBe('No suggestion');
    expect(merged[2].aiProvenance).toBeNull();
  });

  it('merges evidence tokens from testId into smart tags (ado/error not dropped)', () => {
    const result = parseWalkthroughAnchorSmartTaggingOutput(
      JSON.stringify(
        validPayload({
          suggestions: [
            validSuggestion({
              testId: 'ado-create-error',
              anchorKey: 'ado-create-error',
              suggestedLabel: 'ADO create error banner',
              smartTags: [
                'backlog',
                'create',
                'modal',
                'troubleshoot',
                'review',
              ],
              confidence: 0.86,
              rationale:
                'Confirmed data-testid="ado-create-error" on the error banner in CreateAdoItemsModal.tsx.',
            }),
          ],
        })
      )
    );

    const merged = applyValidatedSmartTagSuggestions(
      [
        {
          id: 'row-ado',
          testId: 'ado-create-error',
          anchorKey: 'ado-create-error',
          label: 'Pending',
          suggestedRoute: null,
          allowedPlacements: ['bottom'],
          smartTags: [],
          reviewStatus: 'pending',
          aiProvenance: null,
        },
      ],
      result,
      {
        provider: 'cursor',
        model: 'claude-sonnet-4',
        skillPath: DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
        generatedAt: '2026-07-30T04:00:00.000Z',
        threadId: 'thread-smart-tag-ado',
        runId: null,
      }
    );

    expect(merged[0].smartTags).toEqual([
      'ado',
      'create',
      'error',
      'backlog',
      'modal',
      'troubleshoot',
      'review',
    ]);
  });
});
