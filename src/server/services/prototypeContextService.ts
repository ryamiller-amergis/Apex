/**
 * Prototype Context Service
 *
 * Resolves a per-project prototype context for Bedrock prototype generation.
 * Each project supplies its own design-system skill from its own ADO repo.
 *
 * Transition behaviour: while projects migrate their design systems into their own
 * repos, resolution falls back to the legacy bundled MaxView design system so
 * MaxView has zero downtime. The fallback is removed once MaxView's own
 * design-system skill reaches parity (see plan: remove-bundle todo).
 */

import { fetchAdoFileGeneric } from '../utils/adoFileFetch';
import { skillNameFromPath, skillPathCandidates } from '../../shared/skillPaths';

/** Default convention path for a project's design-system skill within its repo. */
export const DEFAULT_DESIGN_SYSTEM_PATH = '.cursor/skills/design-system/SKILL.md';

/** Default convention skill name for a project's design-system skill. */
const DEFAULT_DESIGN_SYSTEM_SKILL = 'design-system';

/** Cache TTL for resolved design-system content. 10 minutes. */
const CONTEXT_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  content: string;
  resolvedAt: number;
}

const designSystemCache = new Map<string, CacheEntry>();

export interface PrototypeContext {
  /** Human-readable application name injected into the Bedrock prompt. */
  appName: string;
  /**
   * Full markdown content of the project's design-system skill, including brand tokens
   * (CSS :root block), component look, spacing, typography, shell description, and the
   * self-contained HTML rules. This is the sole design reference injected into the prompt.
   */
  designSystemMarkdown: string;
  /**
   * Whether this context came from the project's own repo (true) or the legacy
   * bundled MaxView fallback (false). Used to gate MaxView-specific prompt blocks.
   */
  isProjectSpecific: boolean;
  /** EXTEND-mode sources, present when the project has a screen inventory configured. */
  extend?: {
    /** GitHub vs Azure DevOps — taken from Project Settings skill provider. */
    provider: 'ado' | 'github';
    /** ADO project name (for fetching existing page source). Empty for GitHub. */
    adoProject: string;
    /** ADO repo name, or GitHub `org/repo` as stored in Project Settings. */
    repo: string;
    branch: string;
    screenInventoryPath: string | null;
  };
}

function designSystemPathCandidates(configuredPath: string | null): string[] {
  const looksLikePath = Boolean(
    configuredPath && (configuredPath.includes('/') || /\.md$/i.test(configuredPath)),
  );
  const skillName =
    (looksLikePath && configuredPath && skillNameFromPath(configuredPath)) ||
    (!looksLikePath && configuredPath) ||
    DEFAULT_DESIGN_SYSTEM_SKILL;
  const preferredPath = looksLikePath ? configuredPath : null;
  return skillPathCandidates(skillName, preferredPath);
}

/**
 * Resolve the prototype context for a project.
 *
 * Resolution order:
 *   1. Try to fetch the project's own design-system skill from its repo
 *      (GitHub or ADO), trying the standard skill-folder candidates.
 *   2. On failure, log a warning and fall back to the bundled MaxView design
 *      system (transition fallback — removed once MaxView is migrated).
 *
 * Returns null only when neither source is available (network down + no bundle).
 */
export async function resolvePrototypeContext(
  project: string,
  skillSettingsId?: string | null,
): Promise<PrototypeContext | null> {
  const { resolveSkillConfig } = await import('./projectSettingsService');
  const cfg = await resolveSkillConfig({ project, settingsId: skillSettingsId ?? undefined });

  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;

  // Derive the app name from the project identifier (last path segment, title-cased).
  const appName = project.split(/[/\\]/).pop()?.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? project;

  // Parse repo coordinates from skillRepo using the Project Settings provider
  // (GitHub `org/repo` vs Azure DevOps `ADOProject/RepoName` or `RepoName`).
  const extendCtx = cfg?.skillRepo ? (() => {
    const provider: 'ado' | 'github' = cfg.skillProvider === 'github' ? 'github' : 'ado';
    if (provider === 'github') {
      return {
        provider,
        adoProject: '',
        repo: cfg.skillRepo,
        branch: cfg.skillBranch ?? 'main',
        screenInventoryPath: cfg.screenInventoryPath ?? null,
      };
    }
    const [adoProj, repoName] = cfg.skillRepo!.includes('/')
      ? cfg.skillRepo!.split('/', 2) as [string, string]
      : [project, cfg.skillRepo!];
    return {
      provider,
      adoProject: adoProj,
      repo: repoName,
      branch: cfg.skillBranch ?? 'main',
      screenInventoryPath: cfg.screenInventoryPath ?? null,
    };
  })() : undefined;

  // ── Try project-specific design system ──────────────────────────────────────
  if (cfg?.skillRepo) {
    const configuredPath = cfg.prototypeDesignSystemPath?.trim() || null;
    const candidates = designSystemPathCandidates(configuredPath);
    const cacheKey = `${cfg.skillProvider ?? 'ado'}:${cfg.skillRepo}@${cfg.skillBranch ?? 'main'}:${candidates.join('|')}`;
    const cached = designSystemCache.get(cacheKey);
    if (cached && Date.now() - cached.resolvedAt < CONTEXT_CACHE_TTL_MS) {
      return {
        appName,
        designSystemMarkdown: cached.content,
        isProjectSpecific: true,
        extend: extendCtx,
      };
    }

    const branch = cfg.skillBranch ?? 'main';
    const provider: 'ado' | 'github' = cfg.skillProvider === 'github' ? 'github' : 'ado';
    let lastError: string | null = null;

    for (const candidate of candidates) {
      try {
        let content = '';
        if (provider === 'github') {
          const { getSkillFile } = await import('./skillCatalogFacade');
          content = await getSkillFile(project, cfg.skillRepo, candidate, branch, 'github');
        } else {
          if (!orgUrl || !pat) {
            throw new Error('ADO_ORG or ADO_PAT not set');
          }
          const [adoProject, repo] = cfg.skillRepo.includes('/')
            ? cfg.skillRepo.split('/', 2) as [string, string]
            : [project, cfg.skillRepo];
          content = await fetchAdoFileGeneric(orgUrl, pat, adoProject, repo, candidate, branch);
        }
        if (content.trim()) {
          designSystemCache.set(cacheKey, { content: content.trim(), resolvedAt: Date.now() });
          console.log(`[prototypeContextService] Loaded design system for "${project}" from ${provider}:${cfg.skillRepo}@${branch}:${candidate} (${content.length} chars)`);
          return {
            appName,
            designSystemMarkdown: content.trim(),
            isProjectSpecific: true,
            extend: extendCtx,
          };
        }
        lastError = `Design system skill at "${candidate}" in ${cfg.skillRepo}@${branch} is empty`;
      } catch (err: any) {
        lastError = err.message;
      }
    }
    console.error(`[prototypeContextService] Could not fetch project design system for "${project}" (${provider}:${cfg.skillRepo}@${branch}): ${lastError} — failing prototype rather than using MaxView fallback`);
    return null;
  }

  // ── Transition fallback: bundled MaxView design system ──────────────────────
  // Only used when no skillRepo is configured for the project (unconfigured) OR
  // when ADO_ORG / ADO_PAT are absent. Projects with a skillRepo configured but
  // a fetch failure hit the early-return null above (fail loudly).
  // Remove this block when the "remove-bundle" plan todo is executed.
  try {
    const [{ getMaxviewColorTokens }, { getDesignSystemCatalog }] = await Promise.all([
      import('./designTokensService'),
      import('./designSystemService'),
    ]);
    const colorTokens = getMaxviewColorTokens();
    const catalog = await getDesignSystemCatalog();
    if (colorTokens || catalog.uiKnowledgeBase) {
      const fallback = [
        '# MaxView Design System (bundled fallback)',
        '',
        colorTokens ? `## Color Tokens\n\n${colorTokens}` : '',
        catalog.uiKnowledgeBase ? `## UI Knowledge Base\n\n${catalog.uiKnowledgeBase}` : '',
      ].filter(Boolean).join('\n\n');
      console.warn(`[prototypeContextService] Using bundled MaxView fallback for project "${project}"`);
      return {
        appName,
        designSystemMarkdown: fallback,
        isProjectSpecific: false,
        extend: extendCtx,
      };
    }
  } catch (err: any) {
    console.error(`[prototypeContextService] Bundled fallback also failed: ${err.message}`);
  }

  console.error(`[prototypeContextService] No design system available for project "${project}" — prototype will fail`);
  return null;
}

/** Turn a Project Settings design-system skill value into a repo-relative SKILL.md path. */
export function normalizeDesignSystemSkillPath(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\\/g, '/');
  if (!trimmed) return DEFAULT_DESIGN_SYSTEM_PATH;
  const withoutLeading = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  if (/\.md$/i.test(withoutLeading)) return withoutLeading;
  if (!withoutLeading.includes('/')) return `.cursor/skills/${withoutLeading}/SKILL.md`;
  return `${withoutLeading.replace(/\/$/, '')}/SKILL.md`;
}

/**
 * EXTEND when the plan targets an existing route and we have page source and/or a screenshot.
 * Project-specific apps (Apex, foundation-skill consumers) are not forced into NEW-page mode.
 */
export function resolvePrototypeExtendMode(input: {
  targetRoute?: string;
  existingPageContext?: string | null;
  pageScreenshot?: unknown;
}): { extendMode: boolean; attachScreenshot: boolean } {
  const hasRoute = Boolean(input.targetRoute?.trim());
  const hasPage = Boolean(input.existingPageContext?.trim());
  const hasShot = Boolean(input.pageScreenshot);
  return {
    extendMode: hasRoute && (hasPage || hasShot),
    attachScreenshot: hasRoute && hasShot,
  };
}

/** Invalidate the design system cache for a specific project/repo path (e.g. after config change). */
export function invalidatePrototypeContextCache(cacheKey?: string): void {
  if (cacheKey) {
    designSystemCache.delete(cacheKey);
  } else {
    designSystemCache.clear();
  }
}

/**
 * Fetch the existing-page context (source code) for EXTEND mode from a project's own repo.
 * Called with project-resolved repo/branch instead of the MaxView-hardcoded values.
 */
export async function fetchProjectPageContext(
  adoProject: string,
  repo: string,
  branch: string,
  route: string,
  inventoryPath?: string | null,
): Promise<string | null> {
  try {
    const { fetchExistingPageContext } = await import('./designSystemService');
    const ctx = await fetchExistingPageContext(route, undefined, {
      adoProject,
      repo,
      branch,
      inventoryPath: inventoryPath ?? undefined,
    });
    return ctx || null;
  } catch {
    return null;
  }
}
