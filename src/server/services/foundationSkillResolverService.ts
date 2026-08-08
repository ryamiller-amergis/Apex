/**
 * Foundation Skill Resolver Service
 *
 * Resolves the full text bundle for a skill in APEX-local process mode
 * (disk reads only — not for agent sandbox/MCP sessions).
 *
 * Precedence (Option 3 layout):
 *   1. Project adapter   (.cursor/skills/<skill>/SKILL.md) — contains the
 *      fenced managed foundation region plus any project notes
 *   2. Explicit bundled fallback (caller-provided fallback string)
 *
 * Returns an ordered SkillBundle so callers can inject content into prompts
 * with source/version diagnostics for logging and the "fail-loud" gate.
 */

import fs from 'fs';
import path from 'path';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import * as facade from './skillCatalogFacade';

// ── Types ──────────────────────────────────────────────────────────────────

export type SkillSource =
  | 'adapter-only'       // project adapter present (includes baked-in foundation)
  | 'bundled-fallback'   // neither; using caller-provided fallback
  | 'not-found'          // no content at all
  // Legacy values retained for log compatibility with older installs:
  | 'adapter+foundation'
  | 'foundation-only';

export interface SkillBundle {
  /** Combined text for prompt injection. */
  content: string;
  /** Where the content came from, for diagnostics. */
  source: SkillSource;
  /** Path used for the adapter layer, or null. */
  adapterPath: string | null;
  /** Always null after Option 3 — foundation is baked into the adapter. */
  foundationPath: string | null;
  /** Version from the lockfile, or null when not installed via the CLI. */
  foundationVersion: string | null;
  /** True when the resolver could not find the skill at all. */
  notFound: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const CWD = process.cwd();

function repoPath(...parts: string[]): string {
  return path.join(CWD, ...parts);
}

function readLocal(absPath: string): string | null {
  try {
    if (fs.existsSync(absPath)) return fs.readFileSync(absPath, 'utf-8').trim();
  } catch { /* non-fatal */ }
  return null;
}

/** Read and parse apex-skills.lock.json from the repo root, non-fatal. */
function readLockfile(): Record<string, unknown> | null {
  try {
    const p = repoPath('apex-skills.lock.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* non-fatal */ }
  return null;
}

function foundationVersionFromLock(skillName: string): string | null {
  const lock = readLockfile();
  if (!lock) return null;
  const version = (lock as any).suiteVersion ?? (lock as any).foundation?.version ?? null;
  const skills  = (lock as any).skills ?? {};
  return skills[skillName] ? String(version ?? '') || null : null;
}

// ── Remote (ADO / GitHub) skill fetch ─────────────────────────────────────

/**
 * Fetch a skill file from a remote repo (ADO or GitHub) via the skill catalog
 * facade. Returns null on any error (non-fatal).
 */
async function fetchRemoteSkillFile(
  skillPath: string,
  config: Pick<ProjectSkillConfig, 'skillProvider' | 'skillRepo' | 'skillBranch'> & { project?: string | null },
): Promise<string | null> {
  if (!skillPath || !config.skillRepo) return null;
  try {
    const content = await facade.getSkillFile(
      config.project ?? '',
      config.skillRepo,
      skillPath,
      config.skillBranch,
      config.skillProvider ?? 'ado',
    );
    return content?.trim() || null;
  } catch (e: any) {
    console.warn(`[foundationSkillResolver] Could not fetch remote skill ${skillPath}: ${e.message}`);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve a skill bundle from the local filesystem.
 *
 * @param skillName      - e.g. "ui-lab", "to-prd" (matches catalog/adapter directory name)
 * @param fallbackText   - text to use as `bundled-fallback` when nothing else is found
 * @returns              - SkillBundle with content + source diagnostics
 */
export function resolveLocalSkillBundle(
  skillName: string,
  fallbackText?: string,
): SkillBundle {
  const adapterAbs = repoPath('.cursor', 'skills', skillName, 'SKILL.md');
  const adapterContent = readLocal(adapterAbs);
  const version = foundationVersionFromLock(skillName);

  if (adapterContent) {
    return {
      content: adapterContent,
      source: 'adapter-only',
      adapterPath: adapterAbs,
      foundationPath: null,
      foundationVersion: version,
      notFound: false,
    };
  }

  if (fallbackText?.trim()) {
    return {
      content: fallbackText.trim(),
      source: 'bundled-fallback',
      adapterPath: null,
      foundationPath: null,
      foundationVersion: null,
      notFound: false,
    };
  }

  return {
    content: '',
    source: 'not-found',
    adapterPath: null,
    foundationPath: null,
    foundationVersion: null,
    notFound: true,
  };
}

/**
 * Resolve a skill bundle from a remote repo (ADO / GitHub).
 * Falls back to the local filesystem if the remote fetch fails.
 *
 * @param skillPath      - Repo-relative path to the SKILL.md (from project settings)
 * @param skillName      - Friendly name used for local-fallback resolution (e.g. "ui-lab")
 * @param config         - Project skill config for remote fetch
 * @param fallbackText   - Text to use as `bundled-fallback` when nothing else is found
 */
export async function resolveRemoteSkillBundle(
  skillPath: string | null | undefined,
  skillName: string,
  config: Pick<ProjectSkillConfig, 'skillProvider' | 'skillRepo' | 'skillBranch'> & { project?: string | null },
  fallbackText?: string,
): Promise<SkillBundle> {
  if (skillPath) {
    const remote = await fetchRemoteSkillFile(skillPath, config);
    if (remote) {
      const version = foundationVersionFromLock(skillName);
      return {
        content: remote,
        source: 'adapter-only',
        adapterPath: skillPath,
        foundationPath: null,
        foundationVersion: version,
        notFound: false,
      };
    }
  }

  return resolveLocalSkillBundle(skillName, fallbackText);
}

/**
 * Log diagnostics for a resolved bundle. Call after resolution to surface
 * unexpected source choices without throwing.
 */
export function logBundleDiagnostics(skillName: string, bundle: SkillBundle): void {
  if (bundle.notFound) {
    console.warn(`[foundationSkillResolver] "${skillName}": not found — no content`);
  } else {
    console.log(
      `[foundationSkillResolver] "${skillName}": source=${bundle.source}` +
      (bundle.foundationVersion ? ` version=${bundle.foundationVersion}` : ''),
    );
  }
}
