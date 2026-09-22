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

/**
 * Artifact the worker writes its token counts to, read by the owning service
 * when it applies the output. Shared so both ends name the same file.
 */
export const VISUAL_USAGE_FILE_NAME = 'usage.json';

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

/**
 * The kinds of subject the visual lane carries. Every place that dispatches
 * on one switches exhaustively, so adding a kind here fails the compile until
 * its prompt, its thread namespace, and its harvest exist.
 */
export type VisualSubjectKind = 'design-prototype' | 'ui-lab-screen';

/**
 * The design system a UI Lab screen is generated against, chosen from the
 * project on the App Service side. It selects the palette, the component
 * reference, and the font rule, so it travels with the specification rather
 * than being re-derived by a worker that cannot see project settings.
 */
export type UiLabDesignSystemName = 'APEX' | 'MaxView';

/**
 * Every value the model call needs, resolved before the run leaves App
 * Service. None of them is optional with a fallback on the worker: the
 * project override lives in the database and the app default is tuned by an
 * environment variable, and a worker can read neither, so a default of its
 * own would quietly disagree with the in-process path instead of matching it.
 */
export type VisualModelSettings = Readonly<{
  modelId: string;
  /** Project override where set, otherwise the lane's own app default. */
  maxTokens: number;
  timeoutMs: number;
  /** Only where the project set one; the prototype lane sends none. */
  temperature?: number;
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
  subjectKind: VisualSubjectKind;
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

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The worker runs this before the model call, so a specification that lost a
 * resolved value on the way is refused rather than answered with an invented
 * one. `??` would have treated the same gap as valid configuration.
 */
function isResolvedModel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.modelId)) return false;
  if (!isPositiveNumber(value.maxTokens)) return false;
  if (!isPositiveNumber(value.timeoutMs)) return false;
  return (
    value.temperature === undefined ||
    (typeof value.temperature === 'number' && Number.isFinite(value.temperature))
  );
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
  if (!isResolvedModel(value.model)) return false;
  if (!isRecord(value.usage) || !isNonEmptyString(value.usage.feature)) {
    return false;
  }
  return true;
}
