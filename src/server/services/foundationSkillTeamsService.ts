/**
 * Foundation Skill Teams Service
 *
 * Builds the Platform Admin "active teams" view: which Apex project is on which
 * suite version, and which skills that version actually shipped to them.
 *
 * Team discovery is driven by `project_skill_settings` (the registry of repos
 * each project has configured), not by observed status rows. A project that has
 * registered a repo but never been scanned still appears, with `observed: false`
 * — that surfaces teams who have not onboarded yet instead of hiding them.
 *
 * Install state is layered on from `foundation_skill_repo_status`, and the
 * release row for the installed version supplies the shipped-skill list. The
 * release is resolved at read time (never denormalized onto the status row) so a
 * deprecation applied after the last scan is reflected immediately.
 */

import { listSkillConfigs } from './projectSettingsService';
import { listRepoStatuses } from './foundationSkillCompatibilityService';
import { getReleaseByVersion, getVisibleSkillsForProject } from './foundationSkillReleaseService';
import type {
  FoundationSkillTeam,
  FoundationSkillTeamRepo,
  FoundationSkillRelease,
  FoundationSkillRepoStatus,
} from '../../shared/types/foundationSkills';

/** Join key for a logical repo+branch. Case-insensitive — ADO is not case-sensitive here. */
function repoKey(provider: string, project: string, repo: string, branch: string): string {
  return [provider, project, repo, branch].map((p) => p.trim().toLowerCase()).join('|');
}

/**
 * Returns every Apex project with a registered skills repo, joined to its
 * observed install state and the skills shipped by its installed release.
 * Sorted by project name, repos by friendly name.
 */
export async function getFoundationSkillTeams(): Promise<FoundationSkillTeam[]> {
  const [configs, statuses] = await Promise.all([listSkillConfigs(), listRepoStatuses()]);

  const statusByKey = new Map<string, FoundationSkillRepoStatus>();
  for (const s of statuses) {
    statusByKey.set(repoKey(s.provider, s.project, s.repo, s.branch), s);
  }

  // Cache release lookups — many repos share the same installed version.
  const releaseCache = new Map<string, FoundationSkillRelease | null>();
  const resolveRelease = async (version: string): Promise<FoundationSkillRelease | null> => {
    if (!releaseCache.has(version)) {
      releaseCache.set(version, await getReleaseByVersion(version));
    }
    return releaseCache.get(version) ?? null;
  };

  const byProject = new Map<string, FoundationSkillTeamRepo[]>();

  for (const config of configs) {
    const provider = config.skillProvider ?? 'ado';
    const branch   = config.skillBranch || 'main';
    const status   = statusByKey.get(repoKey(provider, config.project, config.skillRepo, branch)) ?? null;

    let installedReleaseStatus: FoundationSkillTeamRepo['installedReleaseStatus'] = null;
    let releasedSkills: string[] = [];

    if (status?.installedVersion) {
      const release = await resolveRelease(status.installedVersion);
      if (release) {
        installedReleaseStatus = release.status;
        // Resolve through per-skill targeting so the list reflects what this
        // specific project was entitled to, not the whole release contents.
        releasedSkills = getVisibleSkillsForProject(release, config.project);
      }
    }

    const entry: FoundationSkillTeamRepo = {
      provider,
      project:                config.project,
      repo:                   config.skillRepo,
      branch,
      friendlyName:           config.friendlyName,
      observed:               !!status,
      installedVersion:       status?.installedVersion ?? null,
      installedReleaseStatus,
      installedSkills:        status?.selectedSkills ?? [],
      releasedSkills,
      availableVersion:       status?.availableVersion ?? null,
      updateAvailable:        status?.updateAvailable ?? false,
      compatibilityStatus:    status?.compatibilityStatus ?? 'unknown',
      compatibilityCheckedAt: status?.compatibilityCheckedAt ?? null,
      lastObservedAt:         status?.lastObservedAt ?? null,
    };

    const list = byProject.get(config.project) ?? [];
    list.push(entry);
    byProject.set(config.project, list);
  }

  return [...byProject.entries()]
    .map(([apexProject, repos]) => ({
      apexProject,
      repos: repos.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName)),
    }))
    .sort((a, b) => a.apexProject.localeCompare(b.apexProject));
}

/**
 * Every registered (provider, project, repo, branch) tuple, deduped — the sweep
 * target list for the scan scheduler.
 */
export async function listRegisteredSkillRepos(): Promise<Array<{
  provider: 'ado' | 'github';
  project: string;
  repo: string;
  branch: string;
}>> {
  const configs = await listSkillConfigs();
  const seen = new Map<string, { provider: 'ado' | 'github'; project: string; repo: string; branch: string }>();

  for (const config of configs) {
    if (!config.skillRepo?.trim()) continue;
    const provider = config.skillProvider ?? 'ado';
    const branch   = config.skillBranch || 'main';
    seen.set(repoKey(provider, config.project, config.skillRepo, branch), {
      provider,
      project: config.project,
      repo:    config.skillRepo,
      branch,
    });
  }

  return [...seen.values()];
}
