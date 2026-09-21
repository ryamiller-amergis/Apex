import type { RepoReader } from '../../shared/types/repoReader';
import { isAiRunV2VisualSpecification } from '../../shared/types/aiRunV2VisualSpec';
import { createPrototypeSpecificationAssembler } from '../services/aiRunV2/prototypeSpecificationAssembler';

function reader(files: Record<string, string>): RepoReader {
  return {
    identity: {
      provider: 'ado',
      project: 'Apex',
      repo: 'AI-Pilot',
      sha: 'a'.repeat(40),
    },
    readFile: async (path: string) => {
      const found = files[path];
      if (found === undefined) throw new Error(`missing ${path}`);
      return found;
    },
    listDir: async () => [],
    searchCode: async () => [],
  } as unknown as RepoReader;
}

const designContext = {
  catalog: { routes: [{ path: '/standups', title: 'Standups' }], componentNames: [] },
  screenInventory: [],
  colorTokens: 'primary.main: #123456',
  navItems: [{ label: 'Home', route: '/' }],
};

const promptInputs = {
  featureName: 'Standup summary',
  featureDescription: 'Summarize the ceremony',
  planSection: '',
  pbiSection: '- PBI-1',
  scopingSection: '',
};

describe('prototypeSpecificationAssembler', () => {
  it('reads the requested source and produces a valid specification', async () => {
    const assembler = createPrototypeSpecificationAssembler({
      reader: reader({ '/src/components/Board.tsx': 'export const Board = 1;' }),
      loadDesignContext: async () => designContext,
    });

    const spec = await assembler.assemble({
      prototypeId: 'prototype-1',
      promptInputs,
      sourcePaths: ['/src/components/Board.tsx'],
      model: { modelId: 'anthropic.claude' },
      usage: { feature: 'design-prototype', project: 'Apex' },
    });

    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
    expect(spec.promptInputs.sourceFiles).toEqual([
      { path: '/src/components/Board.tsx', content: 'export const Board = 1;' },
    ]);
    expect(spec.designSystem.colorTokens).toBe('primary.main: #123456');
  });

  it('records the paths the budget could not fit', async () => {
    const assembler = createPrototypeSpecificationAssembler({
      reader: reader({ '/a.tsx': 'x'.repeat(80), '/b.tsx': 'y'.repeat(80) }),
      loadDesignContext: async () => designContext,
      budgetBytes: 100,
    });

    const spec = await assembler.assemble({
      prototypeId: 'prototype-1',
      promptInputs,
      sourcePaths: ['/a.tsx', '/b.tsx'],
      model: { modelId: 'anthropic.claude' },
      usage: { feature: 'design-prototype' },
    });

    expect(spec.promptInputs.omittedSourcePaths).toEqual(['/b.tsx']);
  });

  it('still produces a usable specification when no source is requested', async () => {
    const assembler = createPrototypeSpecificationAssembler({
      reader: reader({}),
      loadDesignContext: async () => designContext,
    });

    const spec = await assembler.assemble({
      prototypeId: 'prototype-1',
      promptInputs,
      sourcePaths: [],
      model: { modelId: 'anthropic.claude' },
      usage: { feature: 'design-prototype' },
    });

    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
    expect(spec.promptInputs.sourceFiles).toEqual([]);
  });
});
