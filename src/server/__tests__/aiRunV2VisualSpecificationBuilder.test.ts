import { isAiRunV2VisualSpecification } from '../../shared/types/aiRunV2VisualSpec';
import { buildPrototypeVisualSpecification } from '../services/aiRunV2/visualSpecificationBuilder';

const base = {
  prototypeId: 'prototype-1',
  promptInputs: { featureTitle: 'Standup summary' },
  sourceFiles: [{ path: '/src/components/A.tsx', content: 'a' }],
  colorTokens: { primary: '#000' },
  navItems: [{ label: 'Home', route: '/' }],
  model: { modelId: 'anthropic.claude' },
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
    expect(spec.promptInputs.featureTitle).toBe('Standup summary');
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
