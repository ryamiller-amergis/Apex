/**
 * Assembles the immutable specification a visual worker executes from.
 *
 * Runs on App Service, where the repository reader and design tokens are
 * reachable. Everything the prompt needs is resolved here and frozen, so a
 * redelivered command rebuilds an identical prompt.
 */
import {
  AI_RUN_V2_VISUAL_SPEC_VERSION,
  type DesignPrototypeVisualSpecification,
  type PrototypePromptSelection,
  type UiLabDesignSystemName,
  type UiLabVisualSpecification,
  type VisualDesignReference,
  type VisualModelSettings,
  type VisualNavItem,
  type VisualUsageAttribution,
} from '../../../shared/types/aiRunV2VisualSpec';
import type { DesignSourceFile } from '../designContext/repoDesignContextReader';

export const PROTOTYPE_OUTPUT_PATH = 'prototype.html';

/**
 * The Figma screenshot both in-process visual paths attach as a vision input.
 * Optional because `getFigmaReference` returns none when the asset is
 * missing, and both paths then send text only.
 */
export type VisualReferenceScreenshot = Readonly<{
  screenshotBase64?: string;
  screenshotMediaType?: string;
  screenshotWidth?: number;
  screenshotHeight?: number;
}>;

/**
 * Kept off the object entirely when there is no screenshot, so a
 * reference-less specification is byte-identical to the one built before
 * images travelled.
 */
function buildDesignReference(
  navItems: ReadonlyArray<VisualNavItem>,
  screenshot: VisualReferenceScreenshot,
): VisualDesignReference {
  if (!screenshot.screenshotBase64) return { navItems };

  return {
    navItems,
    screenshotBase64: screenshot.screenshotBase64,
    ...(screenshot.screenshotMediaType != null
      ? { screenshotMediaType: screenshot.screenshotMediaType }
      : {}),
    ...(screenshot.screenshotWidth != null
      ? { screenshotWidth: screenshot.screenshotWidth }
      : {}),
    ...(screenshot.screenshotHeight != null
      ? { screenshotHeight: screenshot.screenshotHeight }
      : {}),
  };
}

export type BuildPrototypeSpecificationInput = Readonly<{
  prototypeId: string;
  /** Which of the two prototype prompts the worker must build. */
  prototypePrompt: PrototypePromptSelection;
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
}> &
  VisualReferenceScreenshot;

export function buildPrototypeVisualSpecification(
  input: BuildPrototypeSpecificationInput,
): DesignPrototypeVisualSpecification {
  return {
    specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
    subjectId: input.prototypeId,
    subjectKind: 'design-prototype',
    prototypePrompt: input.prototypePrompt,
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
    designReference: buildDesignReference(input.navItems, input),
    model: input.model,
    usage: input.usage,
    outputPath: PROTOTYPE_OUTPUT_PATH,
  };
}

export const UI_LAB_OUTPUT_PATH = 'design.html';

export type BuildUiLabSpecificationInput = Readonly<{
  designId: string;
  /** The brief the author typed, verbatim. */
  userPrompt: string;
  /** The page being extended, or null for a standalone screen. */
  targetRoute: string | null;
  designSystemName: UiLabDesignSystemName;
  /** Resolved UI Lab SKILL.md, local or remote — a worker cannot fetch it. */
  skillMarkdown: string;
  /** APEX only; the MaxView branch uses the design-system catalog instead. */
  componentIndex: string;
  /** EXTEND mode page source, read through `fetchExistingPageContext`. */
  existingPageContext: string;
  colorTokens: unknown;
  catalog?: unknown;
  screenInventory?: unknown;
  navItems: ReadonlyArray<VisualNavItem>;
  model: VisualModelSettings;
  usage: VisualUsageAttribution;
}> &
  VisualReferenceScreenshot;

/**
 * The UI Lab half of the visual contract.
 *
 * Every `promptInputs` key here is read by `uiLabPromptBuilder` on the
 * worker. Nothing else reads them, so the two move together or a section
 * disappears from the prompt without a word.
 */
export function buildUiLabVisualSpecification(
  input: BuildUiLabSpecificationInput,
): UiLabVisualSpecification {
  return {
    specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
    subjectId: input.designId,
    subjectKind: 'ui-lab-screen',
    promptInputs: {
      userPrompt: input.userPrompt,
      targetRoute: input.targetRoute,
      designSystemName: input.designSystemName,
      skillMarkdown: input.skillMarkdown,
      componentIndex: input.componentIndex,
      existingPageContext: input.existingPageContext,
    },
    designSystem: {
      catalog: input.catalog,
      screenInventory: input.screenInventory,
      colorTokens: input.colorTokens,
    },
    designReference: buildDesignReference(input.navItems, input),
    model: input.model,
    usage: input.usage,
    outputPath: UI_LAB_OUTPUT_PATH,
  };
}
