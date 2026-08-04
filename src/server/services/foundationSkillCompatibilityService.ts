/**
 * Foundation Skill Compatibility Service
 *
 * Reads `apex-skills.lock.json` from a configured ADO/GitHub repo, compares
 * it against a candidate release, and returns an evidence-based compatibility report.
 *
 * Also manages `foundation_skill_repo_status` — persisting the last-observed
 * state of each consumer repo so the Platform Admin dashboard can show update
 * availability without triggering a live scan on every page load.
 */

import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../db/drizzle';
import { foundationSkillRepoStatus } from '../db/schema';
import { getLatestPublishedRelease, getReleaseByVersion } from './foundationSkillReleaseService';
import * as facade from './skillCatalogFacade';
import type {
  FoundationSkillCompatibilityReport,
  FoundationSkillRepoStatus,
  CheckCompatibilityRequest,
  FoundationSkillCompatibilityStatus,
} from '../../shared/types/foundationSkills';
import type { SkillProvider } from '../../shared/types/projectSettings';

// ── Types ─────────────────────────────────────────────────────────────────────

interface LockfileShape {
  suiteVersion?: string;
  foundation?: { version?: string };
  selectedSkills?: string[];
  skills?: Record<string, unknown>;
  integrity?: string;
  files?: Record<string, string>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function mapStatusRow(row: typeof foundationSkillRepoStatus.$inferSelect): FoundationSkillRepoStatus {
  return {
    id:                    row.id,
    provider:              row.provider as 'ado' | 'github',
    project:               row.project,
    repo:                  row.repo,
    branch:                row.branch,
    apexProject:           row.apexProject ?? null,
    installedVersion:      row.installedVersion ?? null,
    selectedSkills:        (row.selectedSkills as string[]) ?? [],
    lockHash:              row.lockHash ?? null,
    compatibilityStatus:   (row.compatibilityStatus as FoundationSkillCompatibilityStatus) ?? 'unknown',
    compatibilityErrors:   (row.compatibilityErrors as string[]) ?? [],
    availableVersion:      row.availableVersion ?? null,
    updateAvailable:       row.updateAvailable,
    compatibilityCheckedAt: row.compatibilityCheckedAt ?? null,
    lastObservedAt:        row.lastObservedAt,
    observedBy:            row.observedBy ?? null,
    createdAt:             row.createdAt,
    updatedAt:             row.updatedAt,
  };
}

/** Fetch the lockfile from a remote repo. Returns null on any error. */
async function fetchLockfile(
  project: string,
  repo: string,
  branch: string,
  provider: SkillProvider,
): Promise<LockfileShape | null> {
  try {
    const raw = await facade.getSkillFile(project, repo, '/apex-skills.lock.json', branch, provider);
    if (!raw?.trim()) return null;
    return JSON.parse(raw) as LockfileShape;
  } catch {
    return null;
  }
}

/** Compare semver strings — returns 1, 0, or -1. Handles null safely. */
function semverGt(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a compatibility check for a consumer repo against a candidate release.
 * Persists the result to `foundation_skill_repo_status` and returns the report.
 */
export async function checkCompatibility(
  req: CheckCompatibilityRequest,
  actor?: { id?: string | null },
): Promise<FoundationSkillCompatibilityReport> {
  const { project, repo, provider = 'ado' } = req;
  const branch = req.branch ?? 'main';
  const now = new Date().toISOString();

  // Resolve candidate version — respect project targeting when auto-resolving
  let candidateVersion: string | null | undefined = req.candidateVersion;
  if (!candidateVersion) {
    const latest = await getLatestPublishedRelease(req.apexProject ?? null);
    candidateVersion = latest?.version ?? null;
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const driftedFiles: string[] = [];
  let status: FoundationSkillCompatibilityStatus = 'unknown';
  let installedVersion: string | null = null;
  let installedReleaseStatus: FoundationSkillCompatibilityReport['installedReleaseStatus'] = null;
  let selectedSkills: string[] = [];
  let lockHash: string | null = null;
  let updateAvailable = false;

  // Fetch lockfile from the consumer repo
  const lockfile = await fetchLockfile(project, repo, branch, provider as SkillProvider);

  if (!lockfile) {
    status = 'not-installed';
    warnings.push('apex-skills.lock.json not found in this repo — @apex/skills may not be installed');
    // A published release that targets this project is an available first install.
    // Without this, Agent Home never shows the "Getting started" banner.
    if (candidateVersion) {
      updateAvailable = true;
    }
  } else {
    installedVersion = lockfile.suiteVersion ?? lockfile.foundation?.version ?? null;
    selectedSkills   = lockfile.selectedSkills ?? Object.keys(lockfile.skills ?? {});
    lockHash         = lockfile.integrity ?? null;

    if (!installedVersion) {
      errors.push('Lockfile is missing suiteVersion field — it may be corrupt or from an older install');
      status = 'incompatible';
    } else if (candidateVersion && semverGt(candidateVersion, installedVersion)) {
      updateAvailable = true;
    }

    // Flag a deprecated installed release. Advisory only — it must not set
    // `updateAvailable`, since the replacement release may be a lower semver
    // (or may not exist yet) and teams are never force-migrated.
    if (installedVersion) {
      const installedRelease = await getReleaseByVersion(installedVersion);
      installedReleaseStatus = installedRelease?.status ?? null;
      if (installedReleaseStatus === 'deprecated') {
        warnings.push(
          `Installed release v${installedVersion} is deprecated — it keeps working, ` +
          `but it is no longer offered to new installs. Move to a supported release when convenient.`,
        );
      }
    }

    // Check for foundation file drift (files recorded in lockfile that no longer match)
    if (lockfile.files && Object.keys(lockfile.files).length > 0) {
      // Drift detection against a remote repo requires fetching each file and comparing
      // its hash, which is expensive — skip unless a specific candidate check was requested
      if (req.candidateVersion) {
        for (const [relPath, expectedHash] of Object.entries(lockfile.files)) {
          try {
            const content = await facade.getSkillFile(project, repo, `/${relPath}`, branch, provider as SkillProvider);
            const actualHash = content
              ? crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex')
              : null;
            if (actualHash && actualHash !== expectedHash) {
              driftedFiles.push(relPath);
            }
          } catch {
            // Non-fatal — file may have been removed
          }
        }
        if (driftedFiles.length > 0) {
          warnings.push(`${driftedFiles.length} foundation file(s) have been modified since install: ${driftedFiles.join(', ')}`);
        }
      }
    }

    if (status === 'unknown') {
      if (errors.length > 0) {
        status = 'incompatible';
      } else if (driftedFiles.length > 0) {
        status = 'drift';
      } else {
        status = 'compatible';
      }
    }
  }

  const report: FoundationSkillCompatibilityReport = {
    provider: provider as 'ado' | 'github',
    project,
    repo,
    branch,
    installedVersion,
    candidateVersion: candidateVersion ?? 'unknown',
    status,
    installedReleaseStatus,
    errors,
    warnings,
    driftedFiles,
    checkedAt: now,
  };

  // Persist the observed status
  await upsertRepoStatus({
    provider: provider as 'ado' | 'github',
    project,
    repo,
    branch,
    apexProject: req.apexProject ?? null,
    installedVersion,
    selectedSkills,
    lockHash,
    compatibilityStatus: status,
    compatibilityErrors: errors,
    availableVersion: candidateVersion ?? null,
    updateAvailable,
    compatibilityCheckedAt: now,
    observedBy: actor?.id ?? null,
  });

  return report;
}

/** Upsert the last-observed status for a repo. */
export async function upsertRepoStatus(data: {
  provider: 'ado' | 'github';
  project: string;
  repo: string;
  branch: string;
  apexProject?: string | null;
  installedVersion: string | null;
  selectedSkills: string[];
  lockHash: string | null;
  compatibilityStatus: FoundationSkillCompatibilityStatus;
  compatibilityErrors: string[];
  availableVersion: string | null;
  updateAvailable: boolean;
  compatibilityCheckedAt: string | null;
  observedBy: string | null;
}): Promise<FoundationSkillRepoStatus> {
  const now = new Date().toISOString();
  const existing = await db
    .select()
    .from(foundationSkillRepoStatus)
    .where(and(
      eq(foundationSkillRepoStatus.provider, data.provider),
      eq(foundationSkillRepoStatus.project,  data.project),
      eq(foundationSkillRepoStatus.repo,     data.repo),
      eq(foundationSkillRepoStatus.branch,   data.branch),
    ))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(foundationSkillRepoStatus)
      .set({
        // Preserve a previously recorded Apex project when this caller didn't supply one
        ...(data.apexProject ? { apexProject: data.apexProject } : {}),
        installedVersion:      data.installedVersion,
        selectedSkills:        data.selectedSkills,
        lockHash:              data.lockHash,
        compatibilityStatus:   data.compatibilityStatus,
        compatibilityErrors:   data.compatibilityErrors,
        availableVersion:      data.availableVersion,
        updateAvailable:       data.updateAvailable,
        compatibilityCheckedAt: data.compatibilityCheckedAt,
        lastObservedAt:        now,
        observedBy:            data.observedBy,
        updatedAt:             now,
      })
      .where(eq(foundationSkillRepoStatus.id, existing[0].id))
      .returning();
    return mapStatusRow(updated);
  }

  const [inserted] = await db
    .insert(foundationSkillRepoStatus)
    .values({
      provider:              data.provider,
      project:               data.project,
      repo:                  data.repo,
      branch:                data.branch,
      apexProject:           data.apexProject ?? null,
      installedVersion:      data.installedVersion,
      selectedSkills:        data.selectedSkills,
      lockHash:              data.lockHash,
      compatibilityStatus:   data.compatibilityStatus,
      compatibilityErrors:   data.compatibilityErrors,
      availableVersion:      data.availableVersion,
      updateAvailable:       data.updateAvailable,
      compatibilityCheckedAt: data.compatibilityCheckedAt,
      lastObservedAt:        now,
      observedBy:            data.observedBy,
    })
    .returning();
  return mapStatusRow(inserted);
}

/** List all observed repo statuses, most recently checked first. */
export async function listRepoStatuses(): Promise<FoundationSkillRepoStatus[]> {
  const rows = await db
    .select()
    .from(foundationSkillRepoStatus)
    .orderBy(foundationSkillRepoStatus.lastObservedAt);
  return rows.map(mapStatusRow);
}

/** Get status for a single repo, or null when not yet observed. */
export async function getRepoStatus(
  provider: 'ado' | 'github',
  project: string,
  repo: string,
  branch = 'main',
): Promise<FoundationSkillRepoStatus | null> {
  const rows = await db
    .select()
    .from(foundationSkillRepoStatus)
    .where(and(
      eq(foundationSkillRepoStatus.provider, provider),
      eq(foundationSkillRepoStatus.project,  project),
      eq(foundationSkillRepoStatus.repo,     repo),
      eq(foundationSkillRepoStatus.branch,   branch),
    ))
    .limit(1);
  return rows[0] ? mapStatusRow(rows[0]) : null;
}
