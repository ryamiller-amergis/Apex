import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  type AiRunV2VisualSpecification,
} from '../../../shared/types/aiRunV2VisualSpec';
import {
  buildUiLabContextSection,
  buildUiLabPrompt,
} from '../../services/aiRunsV2Worker/uiLabPromptBuilder';

const spec: AiRunV2VisualSpecification = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'design-1',
  subjectKind: 'ui-lab-screen',
  promptInputs: {
    userPrompt: 'A queue of pending timecard approvals',
    targetRoute: '/timecards',
    designSystemName: 'MaxView',
    skillMarkdown: '# UI Lab\n\nUse 8px spacing.',
    existingPageContext: 'export const Timecards = () => null;',
  },
  designSystem: {
    catalog: {
      routes: [{ path: '/timecards', title: 'Timecards' }],
      tokensCss: ':root { --primary: #123456; }',
      componentNames: ['DataGrid'],
      componentDescriptions: { DataGrid: 'Sortable table' },
      uiKnowledgeBase: 'Screens are described here.',
    },
    screenInventory: [
      { route: '/documents', purpose: 'Manage documents' },
      { route: '/timecards', purpose: 'Approve timecards', userTypes: ['Supervisor'] },
    ],
    colorTokens: 'primary.main: #123456',
  },
  designReference: { navItems: [{ label: 'Home', route: '/' }] },
  model: { modelId: 'anthropic.claude', maxTokens: 16_000, timeoutMs: 600_000 },
  usage: { feature: 'ui-lab' },
  outputPath: 'design.html',
};

const apexSpec: AiRunV2VisualSpecification = {
  ...spec,
  promptInputs: {
    ...spec.promptInputs,
    designSystemName: 'APEX',
    componentIndex: '- AppHeader\n- NotificationBell',
  },
  designSystem: { ...spec.designSystem, colorTokens: '--apex-primary: #323695' },
};

describe('uiLabPromptBuilder', () => {
  it('renders the resolved skill markdown rather than fetching a bundle', () => {
    const section = buildUiLabContextSection(spec);

    expect(section).toContain('## UI Lab Design System Standards');
    expect(section).toContain('Use 8px spacing.');
  });

  it('uses the MaxView catalog and palette when the project is not APEX', () => {
    const section = buildUiLabContextSection(spec);

    expect(section).toContain('## MaxView Color Tokens');
    expect(section).toContain('primary.main: #123456');
    expect(section).toContain('## MaxView Design System Catalog');
    expect(section).toContain('### Existing screens — detailed descriptions');
    expect(section).toContain('### CSS custom properties (design tokens)');
    expect(section).toContain('- **DataGrid**: Sortable table');
  });

  it('uses the APEX palette and component index for the APEX project', () => {
    const section = buildUiLabContextSection(apexSpec);

    expect(section).toContain('## APEX Color Tokens');
    expect(section).toContain('--apex-primary: #323695');
    expect(section).toContain('## APEX Component Index');
    expect(section).toContain('- NotificationBell');
    expect(section).not.toContain('## MaxView Design System Catalog');
  });

  it('orders the screen inventory so the target route survives the 30-row cap', () => {
    const section = buildUiLabContextSection(spec);
    const inventory = section.slice(section.indexOf('## Screen Inventory'));

    expect(inventory.indexOf('/timecards')).toBeLessThan(
      inventory.indexOf('/documents'),
    );
    expect(section).toContain('- **/timecards** — Approve timecards (Supervisor)');
  });

  it('includes the existing page source the worker could not have fetched', () => {
    const section = buildUiLabContextSection(spec);

    expect(section).toContain('## Existing page source — extend this (ground truth)');
    expect(section).toContain('export const Timecards = () => null;');
    expect(section).toContain('the real source of the page at `/timecards`');
  });

  it('leaves out the existing page source when nothing is being extended', () => {
    const section = buildUiLabContextSection({
      ...spec,
      promptInputs: { ...spec.promptInputs, targetRoute: null, existingPageContext: '' },
    });

    expect(section).not.toContain('## Existing page source');
  });

  it('frames the task with the caller prompt and the target route', () => {
    const prompt = buildUiLabPrompt(spec);

    expect(prompt).toContain(
      'You are an expert UI/UX designer and front-end engineer specializing in the MaxView design system.',
    );
    expect(prompt).toContain('A queue of pending timecard approvals');
    expect(prompt).toContain('The UI should be designed for the route: `/timecards`.');
  });

  it('tells the model it is a standalone screen when there is no target route', () => {
    const prompt = buildUiLabPrompt({
      ...spec,
      promptInputs: { ...spec.promptInputs, targetRoute: null },
    });

    expect(prompt).toContain(
      'This is a standalone new UI — design an appropriate layout and navigation shell.',
    );
  });

  it('keeps the four state markers the canvas and the editor depend on', () => {
    const prompt = buildUiLabPrompt(spec);

    expect(prompt).toContain('<!-- STATE:DEFAULT:START -->');
    expect(prompt).toContain('<!-- STATE:EMPTY:START -->');
    expect(prompt).toContain('<!-- STATE:ERROR:START -->');
    expect(prompt).toContain('<!-- STATE:LOADING:START -->');
    expect(prompt).toContain(
      'Output ONLY the complete HTML — no markdown fences, no explanation, no preamble.',
    );
  });

  it('swaps the font rule for APEX, which ships its own stack', () => {
    expect(buildUiLabPrompt(spec)).toContain(
      'https://fonts.googleapis.com/css2?family=Roboto',
    );
    expect(buildUiLabPrompt(apexSpec)).toContain(
      'Use the system font stack defined by the APEX design system',
    );
  });

  /**
   * `uiLabBedrockService` joins `PageRoute` objects straight into the prompt,
   * so this section has always read `[object Object]`. Carried across rather
   * than fixed, because a transport move must not change what the model sees.
   */
  it('carries the route list exactly as the in-process prompt emits it', () => {
    const section = buildUiLabContextSection(spec);

    expect(section).toContain('### Application routes\n\n[object Object]');
  });
});
