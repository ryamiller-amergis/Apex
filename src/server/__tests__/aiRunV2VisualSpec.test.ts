import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  isAiRunV2VisualSpecification,
  type DesignPrototypeVisualSpecification,
} from '../../shared/types/aiRunV2VisualSpec';

const spec: DesignPrototypeVisualSpecification = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype',
  prototypePrompt: { branch: 'maxview' },
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
    sourceFiles: [],
    omittedSourcePaths: [],
  },
  designSystem: { catalog: { routes: [] }, colorTokens: {} },
  designReference: {
    navItems: [{ label: 'Home', route: '/' }],
    images: [],
  },
  model: { modelId: 'anthropic.claude', maxTokens: 8000, timeoutMs: 600_000 },
  usage: { feature: 'design-prototype', project: 'Apex' },
  outputPath: 'prototype.html',
};

const projectSpec: DesignPrototypeVisualSpecification = {
  ...spec,
  prototypePrompt: {
    branch: 'project-design-system',
    appName: 'Apex',
    designSystemMarkdown: '## Apex tokens',
    extendMode: false,
  },
};

/** Drops one field from the project branch, which the typed shape forbids. */
function projectPromptWithout(field: string): Record<string, unknown> {
  const prompt: Record<string, unknown> = { ...projectSpec.prototypePrompt };
  delete prompt[field];
  return prompt;
}

/** Drops one model field, which the typed shape no longer lets a caller do. */
function modelWithout(field: 'maxTokens' | 'timeoutMs'): Record<string, unknown> {
  const model: Record<string, unknown> = { ...spec.model };
  delete model[field];
  return model;
}

describe('visual execution specification', () => {
  it('accepts a fully resolved specification', () => {
    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
  });

  it('rejects an unknown specification version', () => {
    expect(
      isAiRunV2VisualSpecification({ ...spec, specVersion: 99 }),
    ).toBe(false);
  });

  it('requires a subject the artifact can be applied to', () => {
    expect(isAiRunV2VisualSpecification({ ...spec, subjectId: '' })).toBe(false);
    expect(
      isAiRunV2VisualSpecification({ ...spec, subjectKind: 'design-doc' }),
    ).toBe(false);
  });

  it('requires a model and a usage attribution the worker cannot invent', () => {
    expect(
      isAiRunV2VisualSpecification({ ...spec, model: { modelId: '' } }),
    ).toBe(false);
    expect(
      isAiRunV2VisualSpecification({ ...spec, usage: { feature: '' } }),
    ).toBe(false);
  });

  /**
   * A worker holds no policy: with no database and no App Service
   * environment it cannot resolve a ceiling or a timeout, and a default of
   * its own would silently disagree with the in-process path. Refusing the
   * run is the only honest answer, and it happens before the model call.
   */
  it('refuses a specification that carries no token ceiling or no timeout', () => {
    expect(
      isAiRunV2VisualSpecification({ ...spec, model: modelWithout('maxTokens') }),
    ).toBe(false);
    expect(
      isAiRunV2VisualSpecification({ ...spec, model: modelWithout('timeoutMs') }),
    ).toBe(false);
  });

  it('refuses a ceiling or timeout that is not a positive number', () => {
    for (const value of [0, -1, '32000', Number.NaN]) {
      expect(
        isAiRunV2VisualSpecification({ ...spec, model: { ...spec.model, maxTokens: value } }),
      ).toBe(false);
      expect(
        isAiRunV2VisualSpecification({ ...spec, model: { ...spec.model, timeoutMs: value } }),
      ).toBe(false);
    }
  });

  /** UI Lab sets one from project settings; the prototype lane sends none. */
  it('accepts an optional temperature and refuses one that is not a number', () => {
    expect(
      isAiRunV2VisualSpecification({ ...spec, model: { ...spec.model, temperature: 0.2 } }),
    ).toBe(true);
    expect(
      isAiRunV2VisualSpecification({ ...spec, model: { ...spec.model, temperature: '0.2' } }),
    ).toBe(false);
  });

  it('requires resolved navigation rather than a promise to fetch it', () => {
    expect(
      isAiRunV2VisualSpecification({ ...spec, designReference: {} }),
    ).toBe(false);
  });

  it('requires an explicit ordered image list rather than defaulting a missing one', () => {
    expect(
      isAiRunV2VisualSpecification({
        ...spec,
        designReference: { navItems: spec.designReference.navItems },
      }),
    ).toBe(false);
  });

  it('refuses malformed image blocks and image blocks in the wrong order', () => {
    const figma = {
      kind: 'design-reference',
      base64: 'QUJD',
      mediaType: 'image/png',
    };
    const page = {
      kind: 'existing-page',
      base64: 'REVG',
      mediaType: 'image/jpeg',
    };

    expect(
      isAiRunV2VisualSpecification({
        ...spec,
        designReference: { ...spec.designReference, images: [{ ...figma, base64: '' }] },
      }),
    ).toBe(false);
    expect(
      isAiRunV2VisualSpecification({
        ...spec,
        designReference: { ...spec.designReference, images: [{ ...figma, mediaType: 'text/plain' }] },
      }),
    ).toBe(false);
    expect(
      isAiRunV2VisualSpecification({
        ...spec,
        promptInputs: {
          ...spec.promptInputs,
          extendMode: true,
          targetRoute: '/timecards',
        },
        designReference: { ...spec.designReference, images: [page, figma] },
      }),
    ).toBe(false);
  });

  it('requires every resolved prototype prompt input', () => {
    for (const field of [
      'featureName',
      'featureDescription',
      'planSection',
      'pbiSection',
      'scopingSection',
      'extendMode',
      'targetRoute',
      'existingPageContext',
      'targetScreenHint',
      'pageScreenshotHint',
      'sourceFiles',
      'omittedSourcePaths',
    ]) {
      const promptInputs = { ...spec.promptInputs } as Record<string, unknown>;
      delete promptInputs[field];
      expect(
        isAiRunV2VisualSpecification({ ...spec, promptInputs }),
      ).toBe(false);
    }
  });

  it('requires EXTEND context to name a route and carry source or a page image', () => {
    const extend = {
      ...spec,
      promptInputs: {
        ...spec.promptInputs,
        extendMode: true,
        targetRoute: '/timecards',
        existingPageContext: 'export const Timecards = () => null;',
      },
    };
    expect(isAiRunV2VisualSpecification(extend)).toBe(true);
    expect(
      isAiRunV2VisualSpecification({
        ...extend,
        promptInputs: {
          ...extend.promptInputs,
          targetRoute: null,
        },
      }),
    ).toBe(false);
    expect(
      isAiRunV2VisualSpecification({
        ...extend,
        promptInputs: {
          ...extend.promptInputs,
          existingPageContext: '',
        },
      }),
    ).toBe(false);
  });

  it('requires an output path so the owning service can find the artifact', () => {
    expect(isAiRunV2VisualSpecification({ ...spec, outputPath: '' })).toBe(
      false,
    );
  });
});

/**
 * The prototype lane has two prompts and they share almost no text. Choosing
 * between them needs the project's own design-system skill, which lives in
 * the project's repository — so App Service chooses and the specification
 * carries the answer. A worker that guessed would answer a project that has
 * its own design system with the MaxView prompt: finished-looking output
 * against the wrong design system, with nothing to flag it.
 */
describe('the prototype prompt branch', () => {
  it('accepts either branch when it is fully resolved', () => {
    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
    expect(isAiRunV2VisualSpecification(projectSpec)).toBe(true);
  });

  it('refuses a prototype run that does not say which prompt to build', () => {
    const { prototypePrompt, ...withoutBranch } = spec;
    expect(prototypePrompt).toBeDefined();
    expect(isAiRunV2VisualSpecification(withoutBranch)).toBe(false);
  });

  it('refuses a branch name the worker has no prompt for', () => {
    expect(
      isAiRunV2VisualSpecification({ ...spec, prototypePrompt: { branch: 'figma' } }),
    ).toBe(false);
  });

  it('refuses a project branch missing the design system it is named for', () => {
    for (const field of ['appName', 'designSystemMarkdown', 'extendMode']) {
      expect(
        isAiRunV2VisualSpecification({
          ...spec,
          prototypePrompt: projectPromptWithout(field),
        }),
      ).toBe(false);
    }
  });

  it('refuses an empty design system rather than prompting against nothing', () => {
    expect(
      isAiRunV2VisualSpecification({
        ...spec,
        prototypePrompt: { ...projectSpec.prototypePrompt, designSystemMarkdown: '   ' },
      }),
    ).toBe(false);
  });

  /** Absent whenever the project left web references off, which is the default. */
  it('accepts optional web references and refuses a non-string', () => {
    expect(
      isAiRunV2VisualSpecification({
        ...spec,
        prototypePrompt: { ...projectSpec.prototypePrompt, webReferences: '## Linear' },
      }),
    ).toBe(true);
    expect(
      isAiRunV2VisualSpecification({
        ...spec,
        prototypePrompt: { ...projectSpec.prototypePrompt, webReferences: 12 },
      }),
    ).toBe(false);
  });

  /** UI Lab has one prompt, so it carries no branch and must not need one. */
  it('does not ask a ui-lab-screen run for a prototype branch', () => {
    const { prototypePrompt, ...base } = spec;
    expect(prototypePrompt).toBeDefined();
    expect(
      isAiRunV2VisualSpecification({
        ...base,
        subjectKind: 'ui-lab-screen',
        promptInputs: {
          userPrompt: 'A timecard approval queue',
          targetRoute: null,
          designSystemName: 'APEX',
          skillMarkdown: '# UI Lab',
          componentIndex: '- AppHeader',
          existingPageContext: '',
        },
        outputPath: 'design.html',
      }),
    ).toBe(true);
  });
});
