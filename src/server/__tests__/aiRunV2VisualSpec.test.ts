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
  model: { modelId: 'anthropic.claude', maxTokens: 8000 },
  usage: { feature: 'design-prototype', project: 'Apex' },
  outputPath: 'prototype.html',
};

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
