import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  type DesignPrototypeVisualSpecification,
  type ProjectPrototypePrompt,
} from '../../../shared/types/aiRunV2VisualSpec';
import {
  buildProjectPrototypePrompt,
  buildPrototypeContextSection,
  buildPrototypePrompt,
} from '../../services/aiRunsV2Worker/prototypePromptBuilder';

const spec: DesignPrototypeVisualSpecification = {
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
      componentDetailCoverage: {
        source: 'ado-api',
        includedPaths: ['/src/components/Board.tsx'],
        omittedPaths: ['/src/components/Huge.tsx'],
        usedBytes: 100,
        budgetBytes: 400_000,
      },
    },
    screenInventory: [
      { route: '/standups', purpose: 'Run the ceremony', userTypes: ['Scrum master'], states: 'empty, loaded' },
    ],
    colorTokens: 'primary.main: #123456',
  },
  designReference: { navItems: [{ label: 'Home', route: '/' }], images: [] },
  model: {
    modelId: 'anthropic.claude',
    region: 'us-east-1',
    maxTokens: 32_000,
    timeoutMs: 720_000,
    retry: {
      maxAttempts: 5,
      initialBackoffMs: 2_000,
      backoffMultiplier: 2,
      jitter: true,
    },
  },
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

  it('says which catalog component sources were omitted', () => {
    const section = buildPrototypeContextSection(spec);

    expect(section).toContain('Component source coverage is partial');
    expect(section).toContain('/src/components/Huge.tsx');
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

  it('renders the omission report when zero source files were included', () => {
    const section = buildPrototypeContextSection({
      ...spec,
      promptInputs: {
        ...spec.promptInputs,
        sourceFiles: [],
        omittedSourcePaths: [
          '/src/components/ApprovalMissing.tsx',
          '/src/components/ApprovalPanel.tsx',
        ],
      },
    });

    expect(section).toContain('Repository source for the affected surface');
    expect(section).toContain('No repository source files were included');
    expect(section).toContain('/src/components/ApprovalMissing.tsx');
    expect(section).toContain('/src/components/ApprovalPanel.tsx');
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

/**
 * The other half of the lane. `bedrockService` takes this branch whenever a
 * project resolves its own design system, and the two prompts share almost no
 * text — so a worker that answered with the MaxView prompt would produce a
 * finished-looking prototype against the wrong design system.
 */
const projectBranch: ProjectPrototypePrompt = {
  branch: 'project-design-system',
  appName: 'Apex',
  designSystemMarkdown: '## Apex tokens\n\n:root { --apex-primary: #4f46e5; }',
  extendMode: false,
};

const projectSpec: DesignPrototypeVisualSpecification = {
  ...spec,
  prototypePrompt: projectBranch,
  promptInputs: {
    featureName: 'Standup summary',
    featureDescription: 'Summarize the ceremony',
    planSection: '## Design plan\n\nUse a table.\n\n',
    pbiSection: '### PBI 1: Show the summary',
    scopingSection: '### CRITICAL SCOPING RULE — ONLY render what is described\n',
  },
};

describe('buildProjectPrototypePrompt', () => {
  it('opens on the project prompt and names the application throughout', () => {
    const prompt = buildProjectPrototypePrompt(projectSpec, projectBranch);

    expect(prompt.split('\n')[0]).toBe(
      'You are a world-class product designer generating a **market-quality, production-ready** HTML prototype for a feature of the **Apex** application. This prototype should look like something a Series A SaaS startup would actually ship — not a wireframe, not a developer mockup. Reference companies like Linear, Loom, Vercel, Retool, or Rippling for the quality bar.',
    );
    expect(prompt).toContain('## Apex Design System (AUTHORITATIVE — sole design and color source)');
    expect(prompt).toContain(
      '### Design token usage — STRICT (the Apex Design System above is the ONLY color and style source)',
    );
  });

  it('carries the design system the project resolved, not a bundled one', () => {
    const prompt = buildProjectPrototypePrompt(projectSpec, projectBranch);

    expect(prompt).toContain(':root { --apex-primary: #4f46e5; }');
  });

  /** The MaxView catalog, palette, sidebar, and Figma reference are all absent. */
  it('sends none of the MaxView context the other branch is built around', () => {
    const prompt = buildProjectPrototypePrompt(projectSpec, projectBranch);

    expect(prompt).not.toContain('## MaxView Application Context');
    expect(prompt).not.toContain('MaxView Design Tokens');
    expect(prompt).not.toContain('MaxView left sidebar nav');
    expect(prompt).not.toContain('reference screenshot');
  });

  it('frames the feature and carries the sections resolved upstream', () => {
    const prompt = buildProjectPrototypePrompt(projectSpec, projectBranch);

    expect(prompt).toContain('**Feature:** Standup summary');
    expect(prompt).toContain('**Description:** Summarize the ceremony');
    expect(prompt).toContain('## Design plan');
    expect(prompt).toContain('### PBI 1: Show the summary');
    expect(prompt).toContain('### CRITICAL SCOPING RULE — ONLY render what is described');
  });

  it('omits the description line when the feature has none', () => {
    const prompt = buildProjectPrototypePrompt(
      { ...projectSpec, promptInputs: { featureName: 'Standup summary' } },
      projectBranch,
    );

    expect(prompt).not.toContain('**Description:**');
  });

  it('asks for the four states the project branch renders, not the MaxView two', () => {
    const prompt = buildProjectPrototypePrompt(projectSpec, projectBranch);

    expect(prompt).toContain('<!-- STATE:DEFAULT:START -->');
    expect(prompt).toContain('<!-- STATE:EMPTY:START -->');
    expect(prompt).toContain('<!-- STATE:ERROR:START -->');
    expect(prompt).toContain('<!-- STATE:LOADING:START -->');
  });

  it('leaves out the web reference section when the project sent none', () => {
    const prompt = buildProjectPrototypePrompt(projectSpec, projectBranch);

    expect(prompt).not.toContain('Modern Design References');
  });

  it('includes web references as inspiration subordinate to the design system', () => {
    const withReferences: ProjectPrototypePrompt = {
      ...projectBranch,
      webReferences: '- Linear uses a two-pane inbox.',
    };

    const prompt = buildProjectPrototypePrompt(
      { ...projectSpec, prototypePrompt: withReferences },
      withReferences,
    );

    expect(prompt).toContain('## Modern Design References (live web — inspiration only)');
    expect(prompt).toContain('- Linear uses a two-pane inbox.');
    expect(prompt).toContain('**subordinate to the Design System**');
  });

  /**
   * EXTEND reproduces an existing page, and the in-process prompt drops the
   * annotation block there because the scoping rule already carries it.
   */
  it('drops the annotation block in EXTEND mode and keeps it otherwise', () => {
    const annotation = '### Visual annotation of the new feature — PRECISE SCOPING';
    const extend: ProjectPrototypePrompt = { ...projectBranch, extendMode: true };

    expect(buildProjectPrototypePrompt(projectSpec, projectBranch)).toContain(annotation);
    expect(
      buildProjectPrototypePrompt({ ...projectSpec, prototypePrompt: extend }, extend),
    ).not.toContain(annotation);
  });

  it('keeps the output rule that makes the result parseable', () => {
    const prompt = buildProjectPrototypePrompt(projectSpec, projectBranch);

    expect(prompt).toContain(
      'Return ONLY the complete HTML document. No markdown fences, no explanation — just the raw HTML starting with <!DOCTYPE html>.',
    );
  });
});
