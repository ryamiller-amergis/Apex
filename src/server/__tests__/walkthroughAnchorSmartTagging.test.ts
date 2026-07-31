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
  type WalkthroughAnchorSmartTagSuggestion,
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
    expect(skill).toMatch(/common component/i);
    expect(skill).toMatch(/Home\/Admin\/Profile|Home, Admin, and Profile/);
    expect(skill).toMatch(/exactly one entry for every input candidate/i);
    expect(skill).toMatch(/Do not evaluate placements/i);
    expect(skill).toMatch(/\["top", "right", "bottom", "left"\]/);
  });

  it('accepts valid skill output (happy path)', () => {
    const raw = JSON.stringify(validPayload());
    const parsed = parseWalkthroughAnchorSmartTaggingOutput(raw);
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0].smartTags).toHaveLength(5);
    expect(parsed.suggestions[0].suggestedRoute).toBe('/profile');
    expect(validateWalkthroughAnchorSmartTaggingResult(parsed)).toEqual([]);
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

  it('rejects non-kebab-case / invalid smart tags', () => {
    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [
              validSuggestion({
                smartTags: ['profile', 'Bad_Tag', 'settings'],
              }),
            ],
          })
        )
      )
    ).toThrow(/smart\s*tags?|INVALID_SMART_TAGS/i);

    const errors = validateWalkthroughAnchorSmartTaggingResult({
      suggestions: [
        {
          ...validSuggestion(),
          smartTags: ['OK Tag', 'profile'],
        } as unknown as WalkthroughAnchorSmartTagSuggestion,
      ],
    });
    expect(errors.some((e) => e.code === 'INVALID_SMART_TAGS')).toBe(true);
  });

  it(`rejects smart tag counts outside ${SMART_TAG_COUNT_MIN}–${SMART_TAG_COUNT_MAX}`, () => {
    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [
              validSuggestion({
                smartTags: ['a', 'b'],
              }),
            ],
          })
        )
      )
    ).toThrow(/3|8|tag count|INVALID_SMART_TAGS/i);

    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [
              validSuggestion({
                smartTags: Array.from({ length: 9 }, (_, i) => `tag-${i + 1}`),
              }),
            ],
          })
        )
      )
    ).toThrow(/3|8|tag count|INVALID_SMART_TAGS/i);
  });

  it('rejects invented / unknown fields', () => {
    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify({
          ...validPayload(),
          inventedTopLevel: true,
        })
      )
    ).toThrow(/unknown|invented|UNEXPECTED_FIELD/i);

    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [
              {
                ...validSuggestion(),
                madeUpField: 'nope',
              },
            ],
          })
        )
      )
    ).toThrow(/unknown|invented|UNEXPECTED_FIELD/i);
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [validSuggestion({ confidence: 1.01 })],
          })
        )
      )
    ).toThrow(/confidence|INVALID_CONFIDENCE/i);

    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [validSuggestion({ confidence: -0.1 })],
          })
        )
      )
    ).toThrow(/confidence|INVALID_CONFIDENCE/i);

    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [validSuggestion({ confidence: 'high' })],
          })
        )
      )
    ).toThrow(/confidence|INVALID_CONFIDENCE/i);
  });

  it('rejects invalid routes and placements', () => {
    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [
              validSuggestion({ suggestedRoute: '/not-a-real-route' }),
            ],
          })
        )
      )
    ).toThrow(/route|INVALID_ROUTE/i);

    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [
              validSuggestion({ allowedPlacements: ['bottom', 'diagonal'] }),
            ],
          })
        )
      )
    ).toThrow(/placement|INVALID_PLACEMENTS/i);

    expect(() =>
      parseWalkthroughAnchorSmartTaggingOutput(
        JSON.stringify(
          validPayload({
            suggestions: [validSuggestion({ allowedPlacements: [] })],
          })
        )
      )
    ).toThrow(/placement|INVALID_PLACEMENTS/i);
  });

  it('rejects invalid JSON and missing required suggestion fields', () => {
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
              testId: 'x',
              // missing remaining required fields
            },
          ],
        })
      )
    ).toThrow(/required|INVALID_/i);
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
