import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  isAiRunV2VisualSpecification,
  type AiRunV2VisualSpecification,
} from '../../shared/types/aiRunV2VisualSpec';

const spec: AiRunV2VisualSpecification = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype',
  promptInputs: { featureTitle: 'Standup summary' },
  designSystem: { catalog: { routes: [] }, colorTokens: {} },
  designReference: { navItems: [{ label: 'Home', route: '/' }] },
  model: { modelId: 'anthropic.claude', maxTokens: 8000, timeoutMs: 600_000 },
  usage: { feature: 'design-prototype', project: 'Apex' },
  outputPath: 'prototype.html',
};

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

  it('requires an output path so the owning service can find the artifact', () => {
    expect(isAiRunV2VisualSpecification({ ...spec, outputPath: '' })).toBe(
      false,
    );
  });
});
