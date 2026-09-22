import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  type AiRunV2VisualSpecification,
} from '../../../shared/types/aiRunV2VisualSpec';
import {
  buildPrototypeContextSection,
  buildPrototypePrompt,
} from '../../services/aiRunsV2Worker/prototypePromptBuilder';

const spec: AiRunV2VisualSpecification = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype',
  prototypePrompt: { branch: 'maxview' },
  promptInputs: {
    sourceFiles: [
      { path: '/src/components/Board.tsx', content: 'export const Board = 1;' },
    ],
    omittedSourcePaths: ['/src/components/Huge.tsx'],
  },
  designSystem: {
    catalog: {
      routes: [{ path: '/standups', title: 'Standups' }],
      componentNames: ['Board'],
      componentDescriptions: { Board: 'Sprint board' },
      routeLayoutHints: { '/standups': 'table' },
      uiKnowledgeBase: 'Screens are described here.',
    },
    screenInventory: [
      { route: '/standups', purpose: 'Run the ceremony', userTypes: ['Scrum master'], states: 'empty, loaded' },
    ],
    colorTokens: 'primary.main: #123456',
  },
  designReference: { navItems: [{ label: 'Home', route: '/' }] },
  model: { modelId: 'anthropic.claude', maxTokens: 32_000, timeoutMs: 720_000 },
  usage: { feature: 'design-prototype' },
  outputPath: 'prototype.html',
};

describe('prototypePromptBuilder', () => {
  it('renders the catalog section from the specification, not a live fetch', () => {
    const section = buildPrototypeContextSection(spec);

    expect(section).toContain('## MaxView Application Context');
    expect(section).toContain('### Existing screens — detailed descriptions');
    expect(section).toContain('Screens are described here.');
    expect(section).toContain('- `/standups` — Standups *(layout: table)*');
    expect(section).toContain('- `Board` — Sprint board');
  });

  it('keeps the palette instruction wording the live prompt uses', () => {
    const section = buildPrototypeContextSection(spec);

    expect(section).toContain('### MaxView Design Tokens — colors (REQUIRED)');
    expect(section).toContain('NEVER invent hex or rgba values not listed here.');
    expect(section).toContain('primary.main: #123456');
  });

  it('renders the screen inventory with its personas and states', () => {
    const section = buildPrototypeContextSection(spec);

    expect(section).toContain(
      '- `/standups` — Run the ceremony [users: Scrum master] [states: empty, loaded]',
    );
  });

  it('includes repository source the worker could not have fetched itself', () => {
    const section = buildPrototypeContextSection(spec);

    expect(section).toContain('/src/components/Board.tsx');
    expect(section).toContain('export const Board = 1;');
  });

  it('says which source files the budget left out rather than hiding the gap', () => {
    const section = buildPrototypeContextSection(spec);

    expect(section).toContain('/src/components/Huge.tsx');
  });

  it('frames the feature and carries the sections resolved upstream', () => {
    const prompt = buildPrototypePrompt({
      ...spec,
      promptInputs: {
        ...spec.promptInputs,
        featureName: 'Standup summary',
        featureDescription: 'Summarize the ceremony',
        planSection: '## Design plan\n\nUse a table.\n\n',
        pbiSection: '- PBI-1: show the summary',
        scopingSection: '### Scope\n\nOne panel only.\n',
      },
    });

    expect(prompt).toContain(
      'You are a senior UI/UX designer generating a high-fidelity HTML prototype for a MaxView application feature.',
    );
    expect(prompt).toContain('**Feature:** Standup summary');
    expect(prompt).toContain('**Description:** Summarize the ceremony');
    expect(prompt).toContain('## Design plan');
    expect(prompt).toContain('- PBI-1: show the summary');
    expect(prompt).toContain('One panel only.');
  });

  it('keeps the output rules that make the result parseable', () => {
    const prompt = buildPrototypePrompt(spec);

    expect(prompt).toContain('<!-- STATE:default:START -->');
    expect(prompt).toContain('<!-- STATE:error:START -->');
    expect(prompt).toContain('<!-- NEW_FEATURE:START -->');
    expect(prompt).toContain(
      'Return ONLY the complete HTML document. No markdown fences, no explanation — just the raw HTML starting with <!DOCTYPE html>.',
    );
  });

  it('keeps the strict colour and icon rules that stop invented values', () => {
    const prompt = buildPrototypePrompt(spec);

    expect(prompt).toContain(
      '**NEVER invent, approximate, or sample** any hex/rgba value that is not listed in those tokens.',
    );
    expect(prompt).toContain('### Icons and images rule — NO emojis, NO external images');
  });

  it('omits the description line when the feature has none', () => {
    const prompt = buildPrototypePrompt({
      ...spec,
      promptInputs: { ...spec.promptInputs, featureName: 'Standup summary' },
    });

    expect(prompt).not.toContain('**Description:**');
  });

  it('falls back to the specification navigation when the catalog has no routes', () => {
    const section = buildPrototypeContextSection({
      ...spec,
      designSystem: { ...spec.designSystem, catalog: { routes: [], componentNames: [] } },
    });

    expect(section).toContain('- `/` — Home');
  });
});
