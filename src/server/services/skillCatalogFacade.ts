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
    return githubCatalog.listBranches(repo);
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
    return githubCatalog.listSkills(repo, branch);
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
    return githubCatalog.getSkill(repo, path, branch);
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
    return githubCatalog.getSkillFile(repo, path, branch);
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
    return githubCatalog.listRepoDir(repo, dirPath, branch);
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
    return githubCatalog.searchRepoCode(repo, query, branch, undefined, boundedLimit);
  }
  return adoCatalog.searchRepoCode(project, repo, query, branch, boundedLimit);
}

export function invalidateCache(
  project?: string,
  repo?: string,
  provider: SkillProvider = 'ado',
): void {
  if (provider === 'github') {
    githubCatalog.invalidateCache(undefined, repo);
  } else {
    adoCatalog.invalidateCache(project, repo);
  }
}
