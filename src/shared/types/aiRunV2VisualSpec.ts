/**
 * The visual lane's execution specification.
 *
 * Everything a visual worker needs to build its prompt and call Bedrock,
 * resolved on the App Service side where the database lives and written to
 * Blob as one immutable document. A worker reads this and nothing else — that
 * is what lets the visual lane leave App Service.
 *
 * Today `bedrockService` reads this context inline, deep inside its prompt
 * builders (`getFigmaReference`, `getMaxviewColorTokens`,
 * `getDesignSystemCatalog`, `getScreenInventory`, `resolvePrototypeExtendMode`).
 * Those reads collapse into this shape.
 */

export const AI_RUN_V2_VISUAL_SPEC_VERSION = 1 as const;

export type VisualNavItem = Readonly<{
  label: string;
  route: string;
  icon?: string;
}>;

/** Design reference imagery, already fetched so the worker never calls Figma. */
export type VisualDesignReference = Readonly<{
  navItems: ReadonlyArray<VisualNavItem>;
  screenshotBase64?: string;
  screenshotMediaType?: string;
  screenshotWidth?: number;
  screenshotHeight?: number;
}>;

export type VisualModelSettings = Readonly<{
  modelId: string;
  maxTokens?: number;
  timeoutMs?: number;
}>;

/**
 * Attribution for the usage row. The worker cannot write it — it has no
 * database — so it travels back with the terminal result instead.
 */
export type VisualUsageAttribution = Readonly<{
  feature: string;
  project?: string;
  userId?: string;
}>;

export type AiRunV2VisualSpecification = Readonly<{
  specVersion: typeof AI_RUN_V2_VISUAL_SPEC_VERSION;
  /** The domain row this run produces output for, e.g. a prototype id. */
  subjectId: string;
  subjectKind: 'design-prototype' | 'ui-lab-screen';
  /** Resolved prompt inputs. Opaque to the transport, meaningful to the lane. */
  promptInputs: Record<string, unknown>;
  /** Resolved design-system context, already read from the database. */
  designSystem: Readonly<{
    catalog?: unknown;
    screenInventory?: unknown;
    colorTokens?: unknown;
  }>;
  designReference: VisualDesignReference;
  model: VisualModelSettings;
  usage: VisualUsageAttribution;
  /** Name the artifact must be written under, so the owner can find it. */
  outputPath: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isAiRunV2VisualSpecification(
  value: unknown,
): value is AiRunV2VisualSpecification {
  if (!isRecord(value)) return false;
  if (value.specVersion !== AI_RUN_V2_VISUAL_SPEC_VERSION) return false;
  if (!isNonEmptyString(value.subjectId)) return false;
  if (value.subjectKind !== 'design-prototype' && value.subjectKind !== 'ui-lab-screen') {
    return false;
  }
  if (!isNonEmptyString(value.outputPath)) return false;
  if (!isRecord(value.promptInputs)) return false;
  if (!isRecord(value.designSystem)) return false;
  if (!isRecord(value.designReference)) return false;
  if (!Array.isArray((value.designReference as { navItems?: unknown }).navItems)) {
    return false;
  }
  if (!isRecord(value.model) || !isNonEmptyString(value.model.modelId)) {
    return false;
  }
  if (!isRecord(value.usage) || !isNonEmptyString(value.usage.feature)) {
    return false;
  }
  return true;
}
