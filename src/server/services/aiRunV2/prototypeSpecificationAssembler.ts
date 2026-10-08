/**
 * Composes everything a prototype run needs into one immutable specification.
 *
 * This is the boundary where App Service stops and the worker begins: the
 * repository read, the context budget, and the design-system lookups all
 * happen here, because a worker has no checkout, no repository credentials,
 * and no database.
 */
import type { RepoReader } from '../../../shared/types/repoReader';
import type {
  DesignPrototypeVisualSpecification,
  PrototypePromptSelection,
  VisualImageBlock,
  VisualModelSettings,
  VisualNavItem,
  VisualUsageAttribution,
} from '../../../shared/types/aiRunV2VisualSpec';
import {
  applyDesignContextBudget,
  DEFAULT_DESIGN_CONTEXT_BUDGET_BYTES,
} from '../designContext/designContextBudget';
import { createRepoDesignContextReader } from '../designContext/repoDesignContextReader';
import { rankSourcePaths } from '../designContext/sourceRelevance';
import {
  buildPrototypeVisualSpecification,
} from './visualSpecificationBuilder';

/**
 * The screenshot rides alongside the source rather than through it: the byte
 * budget decides how much repository source fits, and an image counted
 * against it would push real source out of the prompt.
 */
export type PrototypeDesignContext = Readonly<{
  catalog: unknown;
  screenInventory: unknown;
  colorTokens: unknown;
  navItems: ReadonlyArray<VisualNavItem>;
  /** Shared reference blocks, before any per-route EXTEND screenshot. */
  images: ReadonlyArray<VisualImageBlock>;
}>;

export type AssemblePrototypeSpecificationInput = Readonly<{
  prototypeId: string;
  /**
   * Which prompt the worker builds. Resolved per prototype because the
   * project branch carries web references searched for this feature alone.
   */
  prototypePrompt: PrototypePromptSelection;
  promptInputs: Record<string, unknown>;
  sourcePaths: ReadonlyArray<string>;
  sourceRelevanceText: string;
  /** Per-feature blocks appended after the shared design reference. */
  images: ReadonlyArray<VisualImageBlock>;
  model: VisualModelSettings;
  usage: VisualUsageAttribution;
}>;

export type PrototypeSpecificationAssembler = {
  assemble(
    input: AssemblePrototypeSpecificationInput,
  ): Promise<DesignPrototypeVisualSpecification>;
};

export type PrototypeSourceContext = Readonly<{
  sourceFiles: ReadonlyArray<{ path: string; content: string }>;
  omittedSourcePaths: ReadonlyArray<string>;
}>;

export async function resolvePrototypeSourceContext(input: {
  reader?: RepoReader;
  sourcePaths: ReadonlyArray<string>;
  sourceRelevanceText: string;
  budgetBytes?: number;
}): Promise<PrototypeSourceContext> {
  const rankedPaths = rankSourcePaths(
    input.sourcePaths,
    input.sourceRelevanceText,
  );
  const read = input.reader
    ? await createRepoDesignContextReader({
        reader: input.reader,
      }).readComponents(rankedPaths)
    : [];
  const budgeted = applyDesignContextBudget(
    read,
    input.budgetBytes ?? DEFAULT_DESIGN_CONTEXT_BUDGET_BYTES,
  );
  const included = new Set(
    budgeted.included.map((file) => file.path.replace(/\\/g, '/')),
  );
  return {
    sourceFiles: budgeted.included,
    // Includes both unreadable candidates and readable files over budget.
    omittedSourcePaths: rankedPaths.filter((path) => !included.has(path)),
  };
}

export function createPrototypeSpecificationAssembler(deps: {
  /**
   * Omitted when no grounded mirror is reachable on this instance. The
   * specification is still complete — the catalog, palette, and navigation
   * come from the database and bundled assets — it just carries no source.
   */
  reader?: RepoReader;
  loadDesignContext: (
    input: AssemblePrototypeSpecificationInput,
  ) => Promise<PrototypeDesignContext>;
  budgetBytes?: number;
}): PrototypeSpecificationAssembler {
  const budgetBytes = deps.budgetBytes ?? DEFAULT_DESIGN_CONTEXT_BUDGET_BYTES;

  return {
    async assemble(input) {
      const [context, source] = await Promise.all([
        deps.loadDesignContext(input),
        resolvePrototypeSourceContext({
          reader: deps.reader,
          sourcePaths: input.sourcePaths,
          sourceRelevanceText: input.sourceRelevanceText,
          budgetBytes,
        }),
      ]);

      return buildPrototypeVisualSpecification({
        prototypeId: input.prototypeId,
        prototypePrompt: input.prototypePrompt,
        promptInputs: input.promptInputs,
        sourceFiles: source.sourceFiles,
        omittedSourcePaths: source.omittedSourcePaths,
        catalog: context.catalog,
        screenInventory: context.screenInventory,
        colorTokens: context.colorTokens,
        navItems: context.navItems,
        images: [...context.images, ...input.images],
        model: input.model,
        usage: input.usage,
      });
    },
  };
}
