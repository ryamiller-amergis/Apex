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

/** Default convention path for a project's design-system skill within its repo. */
const DEFAULT_DESIGN_SYSTEM_PATH = '.cursor/skills/design-system/SKILL.md';

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
    /** ADO project name (for fetching existing page source). */
    adoProject: string;
    repo: string;
    branch: string;
    screenInventoryPath: string | null;
  };
}

/**
 * Resolve the prototype context for a project.
 *
 * Resolution order:
 *   1. Try to fetch the project's own design-system skill from its ADO repo
 *      (at `prototype_design_system_path`, defaulting to the convention path).
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

  // Parse adoProject + repo from skillRepo using the same split logic used below
  // for the design-system fetch. Format: "ADOProject/RepoName" or just "RepoName".
  const extendCtx = cfg?.skillRepo ? (() => {
    const [adoProj, repoName] = cfg.skillRepo!.includes('/')
      ? cfg.skillRepo!.split('/', 2) as [string, string]
      : [project, cfg.skillRepo!];
    return {
      adoProject: adoProj,
      repo: repoName,
      branch: cfg.skillBranch ?? 'main',
      screenInventoryPath: cfg.screenInventoryPath ?? null,
    };
  })() : undefined;

  // ── Try project-specific design system ──────────────────────────────────────
  if (cfg?.skillRepo && orgUrl && pat) {
    const skillPath = cfg.prototypeDesignSystemPath?.trim() || DEFAULT_DESIGN_SYSTEM_PATH;
    const cacheKey = `${cfg.skillRepo}@${cfg.skillBranch ?? 'main'}:${skillPath}`;
    const cached = designSystemCache.get(cacheKey);
    if (cached && Date.now() - cached.resolvedAt < CONTEXT_CACHE_TTL_MS) {
      return {
        appName,
        designSystemMarkdown: cached.content,
        isProjectSpecific: true,
        extend: extendCtx,
      };
    }

    // Derive ADO project from the skillRepo (format: "ADOProject/RepoName" or just "RepoName")
    const [adoProject, repo] = cfg.skillRepo.includes('/')
      ? cfg.skillRepo.split('/', 2) as [string, string]
      : [project, cfg.skillRepo];
    const branch = cfg.skillBranch ?? 'main';

    try {
      const content = await fetchAdoFileGeneric(orgUrl, pat, adoProject, repo, skillPath, branch);
      if (content.trim()) {
        designSystemCache.set(cacheKey, { content: content.trim(), resolvedAt: Date.now() });
        console.log(`[prototypeContextService] Loaded design system for "${project}" from ${repo}@${branch}:${skillPath} (${content.length} chars)`);
        return {
          appName,
          designSystemMarkdown: content.trim(),
          isProjectSpecific: true,
          extend: extendCtx,
        };
      }
      // File exists but is empty — treat as a misconfiguration, not a missing file.
      console.error(`[prototypeContextService] Design system skill at "${skillPath}" in ${repo}@${branch} is empty for project "${project}" — prototype generation will fail`);
      return null;
    } catch (err: any) {
      // The project has a skillRepo + ADO creds configured, but the design-system file
      // could not be fetched. This is a configuration error — fail loudly so the
      // prototype is marked generation_failed rather than silently using MaxView styles.
      console.error(`[prototypeContextService] Could not fetch project design system for "${project}" (${repo}@${branch}:${skillPath}): ${err.message} — failing prototype rather than using MaxView fallback`);
      return null;
    }
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
): Promise<string | null> {
  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;
  if (!orgUrl || !pat) return null;

  try {
    const { fetchExistingPageContext } = await import('./designSystemService');
    // designSystemService's fetchExistingPageContext currently uses the MaxView DS_REPO/DS_PROJECT.
    // Until those are made parameterised, this wrapper provides the interface; the actual
    // generalization of the underlying ADO calls is done in the bedrock-refactor step.
    void adoProject; void repo; void branch; // future: pass these through once designSystemService is parameterised
    const ctx = await fetchExistingPageContext(route);
    return ctx || null;
  } catch {
    return null;
  }
}
