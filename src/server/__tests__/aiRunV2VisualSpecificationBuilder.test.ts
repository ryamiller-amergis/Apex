import { isAiRunV2VisualSpecification } from '../../shared/types/aiRunV2VisualSpec';
import {
  buildPrototypeVisualSpecification,
  buildUiLabVisualSpecification,
} from '../services/aiRunV2/visualSpecificationBuilder';
import {
  buildUiLabContextSection,
  buildUiLabPrompt,
} from '../services/aiRunsV2Worker/uiLabPromptBuilder';

const base = {
  prototypeId: 'prototype-1',
  prototypePrompt: { branch: 'maxview' } as const,
  promptInputs: {
    featureName: 'Standup summary',
    featureDescription: '',
    planSection: '',
    pbiSection: '### PBI 1: Show the summary',
    scopingSection: 'Only render the described feature.',
    extendMode: false,
    targetRoute: null,
    existingPageContext: '',
    targetScreenHint: '',
    pageScreenshotHint: '',
  },
  sourceFiles: [{ path: '/src/components/A.tsx', content: 'a' }],
  colorTokens: { primary: '#000' },
  navItems: [{ label: 'Home', route: '/' }],
  images: [],
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
  usage: { feature: 'design-prototype', project: 'Apex' },
};

describe('visualSpecificationBuilder', () => {
  it('produces a specification that validates and names its output file', () => {
    const spec = buildPrototypeVisualSpecification(base);

    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
    expect(spec.outputPath).toBe('prototype.html');
    expect(spec.subjectKind).toBe('design-prototype');
  });

  it('carries the repository source so the worker needs no checkout', () => {
    const spec = buildPrototypeVisualSpecification(base);

    expect(spec.promptInputs.sourceFiles).toEqual(base.sourceFiles);
    expect(spec.promptInputs.featureName).toBe('Standup summary');
  });

  it('carries the reference screenshot so the worker gets the same vision input', () => {
    const spec = buildPrototypeVisualSpecification({
      ...base,
      images: [
        {
          kind: 'design-reference',
          base64: 'QUJD',
          mediaType: 'image/png',
          width: 1024,
          height: 810,
        },
      ],
    });

    expect(spec.designReference).toEqual({
      navItems: base.navItems,
      images: [
        {
          kind: 'design-reference',
          base64: 'QUJD',
          mediaType: 'image/png',
          width: 1024,
          height: 810,
        },
      ],
    });
  });

  it('leaves the screenshot fields off when there is no reference', () => {
    expect(buildPrototypeVisualSpecification(base).designReference).toEqual({
      navItems: base.navItems,
      images: [],
    });
  });

  it('carries both EXTEND images in the order App Service resolved them', () => {
    const images = [
      {
        kind: 'design-reference' as const,
        base64: 'QUJD',
        mediaType: 'image/png' as const,
      },
      {
        kind: 'existing-page' as const,
        base64: 'REVG',
        mediaType: 'image/jpeg' as const,
      },
    ];

    expect(
      buildPrototypeVisualSpecification({ ...base, images }).designReference.images,
    ).toEqual(images);
  });

  it('records what the budget left out so the gap is visible downstream', () => {
    const spec = buildPrototypeVisualSpecification({
      ...base,
      omittedSourcePaths: ['/src/components/Huge.tsx'],
    });

    expect(spec.promptInputs.omittedSourcePaths).toEqual([
      '/src/components/Huge.tsx',
    ]);
  });
});

const uiLab = {
  designId: 'design-1',
  userPrompt: 'A timecard approval queue',
  targetRoute: '/timecards',
  designSystemName: 'MaxView' as const,
  skillMarkdown: '# UI Lab\n\nUse 8px spacing.',
  componentIndex: '',
  existingPageContext: 'export const Timecards = () => null;',
  catalog: { uiKnowledgeBase: 'Screens are described here.' },
  screenInventory: [{ route: '/timecards', purpose: 'Approve timecards' }],
  colorTokens: 'primary.main: #123456',
  navItems: [{ label: 'Home', route: '/' }],
  images: [],
  model: {
    modelId: 'anthropic.claude',
    region: 'us-east-1',
    maxTokens: 16_000,
    timeoutMs: 600_000,
    retry: {
      maxAttempts: 3,
      initialBackoffMs: 2_000,
      backoffMultiplier: 2,
      jitter: true,
    },
  },
  usage: { feature: 'ui-lab', project: 'Apex' },
};

describe('buildUiLabVisualSpecification', () => {
  it('produces a specification that validates and names its own subject kind', () => {
    const spec = buildUiLabVisualSpecification(uiLab);

    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
    expect(spec.subjectKind).toBe('ui-lab-screen');
    expect(spec.subjectId).toBe('design-1');
  });

  it('writes to its own artifact path so a prototype harvest cannot claim it', () => {
    expect(buildUiLabVisualSpecification(uiLab).outputPath).toBe('design.html');
    expect(buildPrototypeVisualSpecification(base).outputPath).toBe('prototype.html');
  });

  /**
   * The builder and the worker's prompt builder agree on key names or the
   * prompt silently loses a section. Assert against the built prompt rather
   * than the key names so a rename on either side fails here.
   */
  it('fills every input the worker prompt reads', () => {
    const spec = buildUiLabVisualSpecification(uiLab);
    const section = buildUiLabContextSection(spec);

    expect(section).toContain('Use 8px spacing.');
    expect(section).toContain('primary.main: #123456');
    expect(section).toContain('Screens are described here.');
    expect(section).toContain('- **/timecards** — Approve timecards');
    expect(section).toContain('export const Timecards = () => null;');
    expect(buildUiLabPrompt(spec)).toContain('A timecard approval queue');
  });

  it('carries the APEX component index only when APEX is the design system', () => {
    const spec = buildUiLabVisualSpecification({
      ...uiLab,
      designSystemName: 'APEX',
      componentIndex: '- AppHeader',
    });

    expect(buildUiLabContextSection(spec)).toContain('## APEX Component Index');
  });

  /**
   * `uiLabBedrockService` attaches the same Figma screenshot in process, so
   * the UI Lab half of the contract has to carry it for the same reason the
   * prototype half does.
   */
  it('carries the reference screenshot UI Lab attaches in process', () => {
    const spec = buildUiLabVisualSpecification({
      ...uiLab,
      images: [
        {
          kind: 'design-reference',
          base64: 'QUJD',
          mediaType: 'image/png',
        },
      ],
    });

    expect(spec.designReference).toEqual({
      navItems: uiLab.navItems,
      images: [
        {
          kind: 'design-reference',
          base64: 'QUJD',
          mediaType: 'image/png',
        },
      ],
    });
  });

  /**
   * UI Lab reads `ui_lab_bedrock_temperature` from project settings and sets
   * it in process, so the contract has to be able to express it — otherwise a
   * project that tuned its temperature gets the model default on the V2 lane
   * and nothing says so.
   */
  it('carries the temperature a project set', () => {
    const spec = buildUiLabVisualSpecification({
      ...uiLab,
      model: { ...uiLab.model, temperature: 0.2 },
    });

    expect(spec.model.temperature).toBe(0.2);
    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
  });

  it('leaves temperature off when the project set none', () => {
    expect(Object.keys(buildUiLabVisualSpecification(uiLab).model)).not.toContain(
      'temperature',
    );
  });

  it('accepts a design with no target route', () => {
    const spec = buildUiLabVisualSpecification({ ...uiLab, targetRoute: null });

    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
    expect(buildUiLabPrompt(spec)).toContain('This is a standalone new UI');
  });
});
