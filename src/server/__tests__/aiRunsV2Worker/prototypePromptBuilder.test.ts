import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  type AiRunV2VisualSpecification,
} from '../../../shared/types/aiRunV2VisualSpec';
import { buildPrototypeContextSection } from '../../services/aiRunsV2Worker/prototypePromptBuilder';

const spec: AiRunV2VisualSpecification = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype',
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
  model: { modelId: 'anthropic.claude' },
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

  it('falls back to the specification navigation when the catalog has no routes', () => {
    const section = buildPrototypeContextSection({
      ...spec,
      designSystem: { ...spec.designSystem, catalog: { routes: [], componentNames: [] } },
    });

    expect(section).toContain('- `/` — Home');
  });
});
