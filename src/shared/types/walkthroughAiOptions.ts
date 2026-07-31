/**
 * Platform Admin → Walkthroughs → Options (persisted skill + agent model).
 */

export const WALKTHROUGH_AI_OPTIONS_SINGLETON_ID = 'default' as const;

export const DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH =
  '.cursor/skills/walkthrough-generation/SKILL.md';

export const DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH_FOR_OPTIONS =
  '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md';

export const DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH_FOR_OPTIONS =
  '.cursor/skills/walkthrough-anchor-discovery/SKILL.md';

const SKILL_PATH_RE = /^\.cursor\/skills\/[^/]+\/SKILL\.md$/;

export interface WalkthroughAiOptionsRecord {
  id: typeof WALKTHROUGH_AI_OPTIONS_SINGLETON_ID;
  walkthroughGenerationSkillPath: string;
  /** Empty string = project / platform default model. */
  walkthroughGenerationModel: string;
  anchorSmartTaggingSkillPath: string;
  /** Empty string = project / platform default model. */
  anchorSmartTaggingModel: string;
  anchorDiscoverySkillPath: string;
  /** Empty string = project / platform default model. */
  anchorDiscoveryModel: string;
  createdBy: string;
  createdByDisplayName: string;
  createdAt: string;
  updatedBy: string;
  updatedByDisplayName: string;
  updatedAt: string;
}

export interface SaveWalkthroughAiOptionsCommand {
  walkthroughGenerationSkillPath: string;
  walkthroughGenerationModel?: string | null;
  anchorSmartTaggingSkillPath: string;
  anchorSmartTaggingModel?: string | null;
  anchorDiscoverySkillPath: string;
  anchorDiscoveryModel?: string | null;
}

export class WalkthroughAiOptionsError extends Error {
  constructor(
    public readonly code: 'VALIDATION_ERROR' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'WalkthroughAiOptionsError';
  }
}

export function validateWalkthroughSkillPath(
  skillPath: string,
  fieldName: string,
): string {
  const normalized = skillPath.trim().replace(/^\//, '').replace(/\\/g, '/');
  if (!SKILL_PATH_RE.test(normalized)) {
    throw new WalkthroughAiOptionsError(
      'VALIDATION_ERROR',
      `${fieldName} must match .cursor/skills/*/SKILL.md`,
    );
  }
  return normalized;
}

export function normalizeOptionalModel(model: string | null | undefined): string {
  return typeof model === 'string' ? model.trim() : '';
}

export function validateSaveWalkthroughAiOptionsCommand(
  body: unknown,
): SaveWalkthroughAiOptionsCommand {
  if (!body || typeof body !== 'object') {
    throw new WalkthroughAiOptionsError(
      'VALIDATION_ERROR',
      'Request body is required',
    );
  }
  const b = body as Record<string, unknown>;
  if (typeof b.walkthroughGenerationSkillPath !== 'string') {
    throw new WalkthroughAiOptionsError(
      'VALIDATION_ERROR',
      'walkthroughGenerationSkillPath is required',
    );
  }
  if (typeof b.anchorSmartTaggingSkillPath !== 'string') {
    throw new WalkthroughAiOptionsError(
      'VALIDATION_ERROR',
      'anchorSmartTaggingSkillPath is required',
    );
  }
  if (typeof b.anchorDiscoverySkillPath !== 'string') {
    throw new WalkthroughAiOptionsError(
      'VALIDATION_ERROR',
      'anchorDiscoverySkillPath is required',
    );
  }
  return {
    walkthroughGenerationSkillPath: validateWalkthroughSkillPath(
      b.walkthroughGenerationSkillPath,
      'walkthroughGenerationSkillPath',
    ),
    walkthroughGenerationModel: normalizeOptionalModel(
      b.walkthroughGenerationModel as string | null | undefined,
    ),
    anchorSmartTaggingSkillPath: validateWalkthroughSkillPath(
      b.anchorSmartTaggingSkillPath,
      'anchorSmartTaggingSkillPath',
    ),
    anchorSmartTaggingModel: normalizeOptionalModel(
      b.anchorSmartTaggingModel as string | null | undefined,
    ),
    anchorDiscoverySkillPath: validateWalkthroughSkillPath(
      b.anchorDiscoverySkillPath,
      'anchorDiscoverySkillPath',
    ),
    anchorDiscoveryModel: normalizeOptionalModel(
      b.anchorDiscoveryModel as string | null | undefined,
    ),
  };
}

export function defaultWalkthroughAiOptionsRecord(
  now = new Date().toISOString(),
): WalkthroughAiOptionsRecord {
  return {
    id: WALKTHROUGH_AI_OPTIONS_SINGLETON_ID,
    walkthroughGenerationSkillPath: DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH,
    walkthroughGenerationModel: '',
    anchorSmartTaggingSkillPath:
      DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH_FOR_OPTIONS,
    anchorSmartTaggingModel: '',
    anchorDiscoverySkillPath:
      DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH_FOR_OPTIONS,
    anchorDiscoveryModel: '',
    createdBy: 'system',
    createdByDisplayName: 'System',
    createdAt: now,
    updatedBy: 'system',
    updatedByDisplayName: 'System',
    updatedAt: now,
  };
}
