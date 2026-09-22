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
 * The prototype lane has two prompts, not one, and they share almost no text.
 *
 * `bedrockService` picks between them on whether `resolvePrototypeContext`
 * returned anything: a project that ships its own design-system skill is
 * prompted entirely from that skill, and every other project gets the
 * bundled MaxView prompt with its catalog, palette, sidebar, and Figma
 * reference. Neither choice is a worker's to make — the design system lives
 * in the project's own repository and the web references need a search key —
 * so App Service resolves the branch and it travels with the specification.
 */
export type MaxViewPrototypePrompt = Readonly<{ branch: 'maxview' }>;

export type ProjectPrototypePrompt = Readonly<{
  branch: 'project-design-system';
  /** Application name the prompt names throughout, from `PrototypeContext`. */
  appName: string;
  /** The project's design-system skill, already read from its repository. */
  designSystemMarkdown: string;
  /**
   * EXTEND an existing page rather than render a new one. The project prompt
   * drops its annotation block in EXTEND mode, so the worker has to be told
   * which of the two it is building.
   */
  extendMode: boolean;
  /**
   * Live web design references, searched on App Service. Absent unless the
   * project turned them on, and the section is then left out entirely — the
   * same thing the in-process path does.
   */
  webReferences?: string;
}>;

export type PrototypePromptSelection =
  | MaxViewPrototypePrompt
  | ProjectPrototypePrompt;

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

type VisualSpecificationBase = Readonly<{
  specVersion: typeof AI_RUN_V2_VISUAL_SPEC_VERSION;
  /** The domain row this run produces output for, e.g. a prototype id. */
  subjectId: string;
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

export type DesignPrototypeVisualSpecification = VisualSpecificationBase &
  Readonly<{
    subjectKind: 'design-prototype';
    prototypePrompt: PrototypePromptSelection;
  }>;

export type UiLabVisualSpecification = VisualSpecificationBase &
  Readonly<{ subjectKind: 'ui-lab-screen' }>;

/**
 * Split by subject kind so a prototype run cannot be built without naming its
 * prompt branch, while UI Lab — which has one prompt — is not asked for one.
 */
export type AiRunV2VisualSpecification =
  | DesignPrototypeVisualSpecification
  | UiLabVisualSpecification;

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

/**
 * Refuses a prototype run whose branch is missing or incomplete, for the same
 * reason the model settings are refused: a worker that filled the gap in
 * would pick a prompt, and picking the MaxView prompt for a project that has
 * its own design system is the exact defect this field exists to stop.
 */
function isPrototypePromptSelection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.branch) {
    case 'maxview':
      return true;
    case 'project-design-system':
      return (
        isNonEmptyString(value.appName) &&
        isNonEmptyString(value.designSystemMarkdown) &&
        typeof value.extendMode === 'boolean' &&
        (value.webReferences === undefined || typeof value.webReferences === 'string')
      );
    default:
      return false;
  }
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
  if (
    value.subjectKind === 'design-prototype' &&
    !isPrototypePromptSelection(value.prototypePrompt)
  ) {
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
