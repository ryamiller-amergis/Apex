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
      model: { modelId: 'anthropic.claude', maxTokens: 32_000, timeoutMs: 720_000 },
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
      model: { modelId: 'anthropic.claude', maxTokens: 32_000, timeoutMs: 720_000 },
      usage: { feature: 'design-prototype' },
    });

    expect(spec.promptInputs.omittedSourcePaths).toEqual(['/b.tsx']);
  });

  it('carries the Figma reference screenshot the worker cannot fetch', async () => {
    const assembler = createPrototypeSpecificationAssembler({
      reader: reader({}),
      loadDesignContext: async () => ({
        ...designContext,
        screenshotBase64: 'QUJD',
        screenshotMediaType: 'image/png',
        screenshotWidth: 1024,
        screenshotHeight: 810,
      }),
    });

    const spec = await assembler.assemble({
      prototypeId: 'prototype-1',
      promptInputs,
      sourcePaths: [],
      model: { modelId: 'anthropic.claude', maxTokens: 32_000, timeoutMs: 720_000 },
      usage: { feature: 'design-prototype' },
    });

    expect(spec.designReference).toEqual({
      navItems: designContext.navItems,
      screenshotBase64: 'QUJD',
      screenshotMediaType: 'image/png',
      screenshotWidth: 1024,
      screenshotHeight: 810,
    });
  });

  /**
   * The byte budget exists to decide how much repository source fits. The
   * screenshot is a separate channel and must not push source out of the
   * prompt, nor be dropped by a budget that was never sized for it.
   */
  it('does not spend the source byte budget on the reference screenshot', async () => {
    const assembler = createPrototypeSpecificationAssembler({
      reader: reader({ '/a.tsx': 'x'.repeat(80), '/b.tsx': 'y'.repeat(80) }),
      loadDesignContext: async () => ({
        ...designContext,
        screenshotBase64: 'z'.repeat(5_000),
      }),
      budgetBytes: 100,
    });

    const spec = await assembler.assemble({
      prototypeId: 'prototype-1',
      promptInputs,
      sourcePaths: ['/a.tsx', '/b.tsx'],
      model: { modelId: 'anthropic.claude', maxTokens: 32_000, timeoutMs: 720_000 },
      usage: { feature: 'design-prototype' },
    });

    expect(spec.promptInputs.sourceFiles).toEqual([
      { path: '/a.tsx', content: 'x'.repeat(80) },
    ]);
    expect(spec.promptInputs.omittedSourcePaths).toEqual(['/b.tsx']);
    expect(spec.designReference.screenshotBase64).toHaveLength(5_000);
  });

  it('omits the screenshot fields when there is no reference to send', async () => {
    const assembler = createPrototypeSpecificationAssembler({
      reader: reader({}),
      loadDesignContext: async () => designContext,
    });

    const spec = await assembler.assemble({
      prototypeId: 'prototype-1',
      promptInputs,
      sourcePaths: [],
      model: { modelId: 'anthropic.claude', maxTokens: 32_000, timeoutMs: 720_000 },
      usage: { feature: 'design-prototype' },
    });

    expect(spec.designReference).toEqual({ navItems: designContext.navItems });
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
      model: { modelId: 'anthropic.claude', maxTokens: 32_000, timeoutMs: 720_000 },
      usage: { feature: 'design-prototype' },
    });

    expect(isAiRunV2VisualSpecification(spec)).toBe(true);
    expect(spec.promptInputs.sourceFiles).toEqual([]);
  });
});
