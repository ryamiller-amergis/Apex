/**
 * Assembles the immutable specification a visual worker executes from.
 *
 * Runs on App Service, where the repository reader and design tokens are
 * reachable. Everything the prompt needs is resolved here and frozen, so a
 * redelivered command rebuilds an identical prompt.
 */
import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  type AiRunV2VisualSpecification,
  type VisualModelSettings,
  type VisualNavItem,
  type VisualUsageAttribution,
} from '../../../shared/types/aiRunV2VisualSpec';
import type { DesignSourceFile } from '../designContext/repoDesignContextReader';

export const PROTOTYPE_OUTPUT_PATH = 'prototype.html';

export type BuildPrototypeSpecificationInput = Readonly<{
  prototypeId: string;
  promptInputs: Record<string, unknown>;
  sourceFiles: ReadonlyArray<DesignSourceFile>;
  /** Paths the byte budget dropped, kept so the gap stays visible. */
  omittedSourcePaths?: ReadonlyArray<string>;
  colorTokens: unknown;
  navItems: ReadonlyArray<VisualNavItem>;
  model: VisualModelSettings;
  usage: VisualUsageAttribution;
  screenInventory?: unknown;
  catalog?: unknown;
}>;

export function buildPrototypeVisualSpecification(
  input: BuildPrototypeSpecificationInput,
): AiRunV2VisualSpecification {
  return {
    specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
    subjectId: input.prototypeId,
    subjectKind: 'design-prototype',
    promptInputs: {
      ...input.promptInputs,
      sourceFiles: input.sourceFiles,
      omittedSourcePaths: input.omittedSourcePaths ?? [],
    },
    designSystem: {
      catalog: input.catalog,
      screenInventory: input.screenInventory,
      colorTokens: input.colorTokens,
    },
    designReference: { navItems: input.navItems },
    model: input.model,
    usage: input.usage,
    outputPath: PROTOTYPE_OUTPUT_PATH,
  };
}
