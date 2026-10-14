/**
 * Locks the prompt sections moved out of `bedrockService` so the extraction
 * stays behaviour-preserving. The worker reproduces these strings verbatim
 * from the specification, so any drift here changes generated prototypes.
 */
import {
  buildPrototypePbiSection,
  buildPrototypePlanSection,
  buildPrototypeScopingSection,
} from '../services/designContext/prototypePromptSections';

describe('buildPrototypePbiSection', () => {
  it('numbers each PBI and renders its criteria and persona behaviours', () => {
    const section = buildPrototypePbiSection([
      {
        title: 'Submit a timecard',
        description: 'A worker submits hours for the week.',
        acceptanceCriteria: 'Given hours, when submitted, then locked',
        userTypes: ['S', 'I'],
        personaBehaviors: [{ userTypes: ['E', 'CO'], behavior: 'opens the approval drawer' }],
      },
      { title: 'Withdraw a timecard' },
    ]);

    expect(section).toContain('### PBI 1: Submit a timecard');
    expect(section).toContain('**Applies to user types:** S, I');
    expect(section).toContain('**Acceptance Criteria:**\nGiven hours, when submitted, then locked');
    expect(section).toContain('- For user types E, CO: opens the approval drawer');
    expect(section).toContain('### PBI 2: Withdraw a timecard');
  });

  it('returns an empty string when the feature has no PBIs', () => {
    expect(buildPrototypePbiSection([])).toBe('');
  });
});

describe('buildPrototypeScopingSection', () => {
  it('forbids inventing content when the feature builds a new page', () => {
    const section = buildPrototypeScopingSection({ extendMode: false });

    expect(section).toContain('ONLY render what is described; NEVER invent content');
    expect(section).not.toContain('EXTEND an existing page');
  });

  it('makes the existing page authoritative when the feature extends one', () => {
    const section = buildPrototypeScopingSection({
      extendMode: true,
      targetRoute: '/timecards',
      pageScreenshot: { base64: 'aaaa', mediaType: 'image/png' },
      existingPageContext: 'export const Timecards = 1;',
      targetScreenHint: '\n\n**Existing page context from inventory:**',
      pageScreenshotHint: '',
    });

    expect(section).toContain('EXTEND an existing page; the EXISTING layout is FIXED ground truth');
    expect(section).toContain('**Existing page context from inventory:**');
    expect(section).toContain('**and the page screenshot (vision input)**');
    expect(section).toContain('## Existing Page Code (route: /timecards)');
    expect(section).toContain('export const Timecards = 1;');
  });
});

describe('buildPrototypePlanSection', () => {
  it('returns an empty string when the design plan decided nothing', () => {
    expect(buildPrototypePlanSection({ extendMode: false })).toBe('');
    expect(buildPrototypePlanSection({ plan: {}, extendMode: false })).toBe('');
  });

  it('renders the approved brief and its technical details', () => {
    const section = buildPrototypePlanSection({
      plan: {
        designBrief: 'Add an approval column to the timecard grid.',
        decision: 'update-page',
        layoutPattern: 'table',
        primaryComponents: ['DataGrid'],
        states: ['default', 'error'],
        notes: 'Keep the existing column order.',
      },
      extendMode: false,
      targetRoute: '/timecards',
    });

    expect(section).toContain('## Approved Design Brief (AUTHORITATIVE — follow exactly)');
    expect(section).toContain('Add an approval column to the timecard grid.');
    expect(section).toContain('- **Decision:** update-page (extend the existing page at `/timecards`)');
    expect(section).toContain('- **Layout pattern:** table');
    expect(section).toContain('- **Primary components to use:** DataGrid');
    expect(section).toContain('- **Reviewer notes (must honor):** Keep the existing column order.');
  });

  it('scopes the brief to the delta when the feature extends a page', () => {
    const section = buildPrototypePlanSection({
      plan: { designBrief: 'Add an approval column.' },
      extendMode: true,
    });

    expect(section).toContain('**Scope of this brief (EXTEND mode):**');
  });
});
