/**
 * Unified Skill Catalog Facade
 *
 * Routes skill catalog operations to the ADO or GitHub implementation
 * based on the provider parameter (defaults to 'ado' for backward compat).
 */

import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RepoDirEntry, RepoSearchResult } from '../../shared/types/repoReader';
import type { SkillEntry, SkillDetail } from '../../shared/types/skills';
import * as adoCatalog from './skillCatalog';
import * as githubCatalog from './skillCatalogGitHub';

export type { SkillEntry, SkillDetail };

export interface RepoInfo {
  id: string;
  name: string;
  defaultBranch: string;
}

function githubRepositoryTarget(repo: string): {
  repo: string;
  org?: string;
} {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) return { repo };
  return {
    org: repo.slice(0, slash),
    repo: repo.slice(slash + 1),
  };
}

export async function listRepos(
  project: string,
  provider: SkillProvider = 'ado',
): Promise<RepoInfo[]> {
  if (provider === 'github') {
    // For GitHub, ignore the project name and use GITHUB_ORG env var
    const repos = await githubCatalog.listRepos();
    return repos.map((r) => ({
      id: r.id,
      name: r.name,
      defaultBranch: r.defaultBranch,
    }));
  }

  const repos = await adoCatalog.listRepos(project);
  return repos.map((r) => ({
    id: r.id,
    name: r.name,
    defaultBranch: r.defaultBranch,
  }));
}

export async function listBranches(
  project: string,
  repo: string,
  provider: SkillProvider = 'ado',
): Promise<string[]> {
  if (provider === 'github') {
    const target = githubRepositoryTarget(repo);
    return githubCatalog.listBranches(target.repo, target.org);
  }
  return adoCatalog.listBranches(project, repo);
}

export async function listSkills(
  project: string,
  repo: string,
  branch?: string,
  provider: SkillProvider = 'ado',
): Promise<SkillEntry[]> {
  if (provider === 'github') {
    const target = githubRepositoryTarget(repo);
    return githubCatalog.listSkills(target.repo, branch, target.org);
  }
  return adoCatalog.listSkills(project, repo, branch);
}

export async function getSkill(
  project: string,
  repo: string,
  path: string,
  branch?: string,
  provider: SkillProvider = 'ado',
): Promise<SkillDetail> {
  if (provider === 'github') {
    const target = githubRepositoryTarget(repo);
    return githubCatalog.getSkill(target.repo, path, branch, target.org);
  }
  return adoCatalog.getSkill(project, repo, path, branch);
}

export async function getSkillFile(
  project: string,
  repo: string,
  path: string,
  branch?: string,
  provider: SkillProvider = 'ado',
): Promise<string> {
  if (provider === 'github') {
    const target = githubRepositoryTarget(repo);
    return githubCatalog.getSkillFile(target.repo, path, branch, target.org);
  }
  return adoCatalog.getSkillFile(project, repo, path, branch);
}

export async function listRepoDir(
  project: string,
  repo: string,
  dirPath: string,
  branch?: string,
  provider: SkillProvider = 'ado',
): Promise<RepoDirEntry[]> {
  if (provider === 'github') {
    const target = githubRepositoryTarget(repo);
    return githubCatalog.listRepoDir(
      target.repo,
      dirPath,
      branch,
      target.org,
    );
  }
  return adoCatalog.listRepoDir(project, repo, dirPath, branch);
}

export async function searchRepoCode(
  project: string,
  repo: string,
  query: string,
  branch?: string,
  limit = 10,
  provider: SkillProvider = 'ado',
): Promise<RepoSearchResult[]> {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 30);
  if (provider === 'github') {
    const target = githubRepositoryTarget(repo);
    return githubCatalog.searchRepoCode(
      target.repo,
      query,
      branch,
      target.org,
      boundedLimit,
    );
  }
  return adoCatalog.searchRepoCode(project, repo, query, branch, boundedLimit);
}

export function invalidateCache(
  project?: string,
  repo?: string,
  provider: SkillProvider = 'ado',
): void {
  if (provider === 'github') {
    if (repo) {
      const target = githubRepositoryTarget(repo);
      githubCatalog.invalidateCache(target.org, target.repo);
    } else {
      githubCatalog.invalidateCache();
    }
  } else {
    adoCatalog.invalidateCache(project, repo);
  }
}
