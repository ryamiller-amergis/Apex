/**
 * GitHub Skill Catalog Service
 *
 * Mirrors the ADO skill catalog interface but uses GitHub's REST API.
 *
 * Required environment variables:
 *   GITHUB_TOKEN or GITHUB_PAT — Personal access token for GitHub API
 *   GITHUB_ORG               — Default GitHub organization (optional, can be overridden per call)
 */

import type { SkillEntry, SkillDetail, SupportingFile, SkillFrontmatter } from '../../shared/types/skills';
import { parseFrontmatter } from './skillCatalog';

const GITHUB_API = 'https://api.github.com';
/** Bound outbound GitHub HTTP calls so MCP tools cannot hang the agent stream forever. */
const GITHUB_FETCH_TIMEOUT_MS = Number(process.env.GITHUB_FETCH_TIMEOUT_MS) > 0
  ? Number(process.env.GITHUB_FETCH_TIMEOUT_MS)
  : 30_000;
const CODE_SEARCH_MIN_INTERVAL_MS = Number(process.env.GITHUB_CODE_SEARCH_MIN_INTERVAL_MS) >= 0
  ? Number(process.env.GITHUB_CODE_SEARCH_MIN_INTERVAL_MS)
  : 6_000;
const CODE_SEARCH_RATE_LIMIT_FALLBACK_MS = 60_000;
const SKILL_ROOTS = ['skills', '.cursor/skills'];

// ── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

function makeCache<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | null {
      const entry = map.get(key);
      if (!entry || Date.now() > entry.expiresAt) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key: string, value: T) {
      map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    },
    invalidate(prefix: string) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    },
  };
}

const repoCache = makeCache<GitHubRepo[]>();
const branchCache = makeCache<string[]>();
const skillListCache = makeCache<SkillEntry[]>();
const skillDetailCache = makeCache<SkillDetail>();
const fileContentCache = makeCache<string>();
const codeSearchCache = makeCache<CodeSearchResult[]>();
let activeCodeSearch: { key: string; promise: Promise<CodeSearchResult[]> } | null = null;
let lastCodeSearchStartedAt = 0;
let codeSearchBlockedUntil = 0;

// ── Types ────────────────────────────────────────────────────────────────────

export interface GitHubRepo {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
}

interface GitHubTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
  url: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getToken(): string {
 const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || process.env.GH_SKILL_TOKEN || '';
 if (!token) throw new Error('GITHUB_TOKEN, GITHUB_PAT, or GH_SKILL_TOKEN must be set');
  return token;
}

function getDefaultOrg(): string {
  return process.env.GITHUB_ORG || '';
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

function resolveRetryAfterMs(response: Response): number | undefined {
  const retryAfter = Number(response.headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000;

  const resetEpochSeconds = Number(response.headers?.get('x-ratelimit-reset'));
  if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
    return Math.max(1_000, resetEpochSeconds * 1_000 - Date.now());
  }
  return undefined;
}

async function ghFetch<T>(path: string, textMatchAccept = false): Promise<T> {
  const token = getToken();
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const accept = textMatchAccept
    ? 'application/vnd.github.text-match+json'
    : 'application/vnd.github.v3+json';
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      'User-Agent': 'ai-pilot-skill-catalog',
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new GitHubApiError(
      response.status,
      `GitHub API ${response.status} ${response.statusText}: ${body}`.trim(),
      resolveRetryAfterMs(response),
    );
  }
  return response.json() as Promise<T>;
}

async function ghFetchRaw(path: string): Promise<string> {
  const token = getToken();
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3.raw',
      'User-Agent': 'ai-pilot-skill-catalog',
    },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`.trim());
  }
  return response.text();
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listRepos(org?: string): Promise<GitHubRepo[]> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required (set GITHUB_ORG or pass org parameter)');

  const cacheKey = `repos:${resolvedOrg}`;
  const cached = repoCache.get(cacheKey);
  if (cached) return cached;

  // Try /orgs/ first (GitHub Organization), fall back to /users/ (personal account)
  let repos: Array<{
    id: number;
    name: string;
    full_name: string;
    default_branch: string;
    html_url: string;
  }>;

  try {
    repos = await ghFetch(`/orgs/${encodeURIComponent(resolvedOrg)}/repos?per_page=100&sort=full_name`);
  } catch {
    repos = await ghFetch(`/users/${encodeURIComponent(resolvedOrg)}/repos?per_page=100&sort=full_name`);
  }

  const result: GitHubRepo[] = repos.map((r) => ({
    id: String(r.id),
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
  }));

  repoCache.set(cacheKey, result);
  return result;
}

export async function getDefaultBranch(repo: string, org?: string): Promise<string> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');

  const repos = await listRepos(resolvedOrg);
  const repoObj = repos.find((r) => r.name === repo);
  return repoObj?.defaultBranch ?? 'main';
}

export async function createPullRequest(opts: {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  org?: string;
}): Promise<string> {
  const resolvedOrg = opts.org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');

  const token = getToken();
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(resolvedOrg)}/${encodeURIComponent(opts.repo)}/pulls`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ai-pilot-skill-catalog',
      },
      body: JSON.stringify({
        title: opts.title,
        head: opts.sourceBranch,
        base: opts.targetBranch,
        body: opts.description ?? '',
      }),
      signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`.trim());
  }

  const pr = await response.json() as { html_url: string };
  return pr.html_url;
}

export async function listBranches(repo: string, org?: string): Promise<string[]> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');

  const branches = await ghFetch<Array<{ name: string }>>(`/repos/${encodeURIComponent(resolvedOrg)}/${encodeURIComponent(repo)}/branches?per_page=100`);

  const repos = await listRepos(resolvedOrg);
  const repoObj = repos.find((r) => r.name === repo);
  const defaultBranch = repoObj?.defaultBranch ?? 'main';

  return branches
    .map((b) => b.name)
    .sort((a, b) => {
      if (a === defaultBranch) return -1;
      if (b === defaultBranch) return 1;
      return a.localeCompare(b);
    });
}

export async function listSkills(
  repo: string,
  branch?: string,
  org?: string,
): Promise<SkillEntry[]> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');

  const resolvedBranch = branch || 'main';
  const cacheKey = `skills:${resolvedOrg}:${repo}:${resolvedBranch}`;
  const cached = skillListCache.get(cacheKey);
  if (cached) return cached;

  const skillPaths: string[] = [];

  // Use the Git Trees API to recursively list files
  try {
    const tree = await ghFetch<{ tree: GitHubTreeItem[]; truncated: boolean }>(
      `/repos/${encodeURIComponent(resolvedOrg)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(resolvedBranch)}?recursive=1`,
    );

    for (const item of tree.tree) {
      if (item.type !== 'blob') continue;
      for (const root of SKILL_ROOTS) {
        if (item.path.startsWith(`${root}/`) && item.path.endsWith('/SKILL.md')) {
          skillPaths.push(item.path);
        }
        if (item.path === `${root}/SKILL.md`) {
          skillPaths.push(item.path);
        }
      }
    }
  } catch {
    // Tree fetch failed — repo may be empty or branch doesn't exist
  }

  const skills: SkillEntry[] = [];

  for (const skillPath of skillPaths) {
    try {
      const content = await fetchFileContent(resolvedOrg, repo, skillPath, resolvedBranch);
      const { frontmatter } = parseFrontmatter(content);
      if (!frontmatter.name) continue;

      skills.push({
        id: `github:${resolvedOrg}/${repo}/${skillPath}`,
        name: frontmatter.name,
        description: frontmatter.description,
        project: resolvedOrg,
        repo,
        path: `/${skillPath}`,
        branch: resolvedBranch,
        frontmatter,
      });
    } catch {
      // Couldn't read file — skip
    }
  }

  skillListCache.set(cacheKey, skills);
  return skills;
}

export async function getSkill(
  repo: string,
  skillPath: string,
  branch?: string,
  org?: string,
): Promise<SkillDetail> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');

  const resolvedBranch = branch || 'main';
  const normalizedPath = skillPath.startsWith('/') ? skillPath.slice(1) : skillPath;
  const cacheKey = `detail:${resolvedOrg}:${repo}:${normalizedPath}:${resolvedBranch}`;
  const cached = skillDetailCache.get(cacheKey);
  if (cached) return cached;

  const content = await fetchFileContent(resolvedOrg, repo, normalizedPath, resolvedBranch);
  const { frontmatter } = parseFrontmatter(content);

  // Find sibling files
  const folder = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
  const supportingFiles: SupportingFile[] = [];

  try {
    const items = await ghFetch<Array<{ name: string; path: string; type: string }>>(
      `/repos/${encodeURIComponent(resolvedOrg)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(folder)}?ref=${encodeURIComponent(resolvedBranch)}`,
    );
    for (const item of items) {
      if (item.type !== 'file' || item.path === normalizedPath) continue;
      supportingFiles.push({ path: `/${item.path}`, name: item.name });
    }
  } catch {
    // Non-fatal
  }

  const result: SkillDetail = {
    id: `github:${resolvedOrg}/${repo}/${normalizedPath}`,
    name: frontmatter.name,
    description: frontmatter.description,
    project: resolvedOrg,
    repo,
    path: `/${normalizedPath}`,
    branch: resolvedBranch,
    frontmatter,
    content,
    supportingFiles,
  };

  skillDetailCache.set(cacheKey, result);
  return result;
}

export async function getSkillFile(
  repo: string,
  filePath: string,
  branch?: string,
  org?: string,
): Promise<string> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');

  const resolvedBranch = branch || 'main';
  const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  const cacheKey = `file:${resolvedOrg}:${repo}:${normalizedPath}:${resolvedBranch}`;
  const cached = fileContentCache.get(cacheKey);
  if (cached) return cached;

  const content = await fetchFileContent(resolvedOrg, repo, normalizedPath, resolvedBranch);
  fileContentCache.set(cacheKey, content);
  return content;
}

export interface RepoFileEntry {
  path: string;
  name: string;
  isFolder: boolean;
}

export async function listRepoDir(
  repo: string,
  dirPath: string,
  branch?: string,
  org?: string,
): Promise<RepoFileEntry[]> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');

  const resolvedBranch = branch || 'main';
  const normalizedPath = dirPath.replace(/^\/+/, '') || '';
  const encodedPath = normalizedPath ? encodeURIComponent(normalizedPath) : '';
  const url = `/repos/${encodeURIComponent(resolvedOrg)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(resolvedBranch)}`;

  const items = await ghFetch<Array<{ name: string; path: string; type: string }>>(url);

  return items
    .map((item) => ({
      path: `/${item.path}`,
      name: item.name,
      isFolder: item.type === 'dir',
    }))
    .sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export interface CodeSearchResult {
  path: string;
  url: string;
  matches: Array<{ fragment: string }>;
}

export async function searchRepoCode(
  repo: string,
  query: string,
  branch?: string,
  org?: string,
  limit = 10,
): Promise<CodeSearchResult[]> {
  const resolvedOrg = org || getDefaultOrg();
  if (!resolvedOrg) throw new Error('GitHub org is required');
  if (!query.trim()) return [];

  // GitHub code search is capped ~10 req/min; cache identical interview lookups.
  const cacheKey = `codesearch:${resolvedOrg}:${repo}:${branch ?? 'default'}:${query}:${limit}`;
  const cached = codeSearchCache.get(cacheKey);
  if (cached) return cached;

  // Debounce identical concurrent requests. Reject a different overlapping
  // search quickly instead of queuing behind a potentially wedged GitHub call
  // until the outer MCP timeout fires.
  if (activeCodeSearch) {
    if (activeCodeSearch.key === cacheKey) return activeCodeSearch.promise;
    throw new Error(
      'GitHub code search is already running; use list_repo_dir/get_skill_file or retry shortly',
    );
  }

  const now = Date.now();
  if (now < codeSearchBlockedUntil) {
    const retrySeconds = Math.max(1, Math.ceil((codeSearchBlockedUntil - now) / 1_000));
    throw new Error(`GitHub code search is rate-limited; retry after ${retrySeconds}s`);
  }
  const elapsedSinceLastSearch = now - lastCodeSearchStartedAt;
  if (elapsedSinceLastSearch < CODE_SEARCH_MIN_INTERVAL_MS) {
    const retryMs = CODE_SEARCH_MIN_INTERVAL_MS - elapsedSinceLastSearch;
    throw new Error(
      `GitHub code search is throttled; use list_repo_dir/get_skill_file or retry after ${Math.ceil(retryMs / 1_000)}s`,
    );
  }

  const promise = (async (): Promise<CodeSearchResult[]> => {
    lastCodeSearchStartedAt = Date.now();
    try {
      // Branch is best-effort only — GitHub code search indexes the default branch
      // and does not support a reliable branch qualifier; keep it in the cache key only.
      const q = encodeURIComponent(`${query} repo:${resolvedOrg}/${repo}`);
      const response = await ghFetch<{
        items: Array<{
          name: string;
          path: string;
          html_url: string;
          text_matches?: Array<{ fragment: string }>;
        }>;
      }>(`/search/code?q=${q}&per_page=${limit}`, true);

      const results = (response.items ?? []).map((item) => ({
        path: `/${item.path}`,
        url: item.html_url,
        matches: (item.text_matches ?? []).map((m) => ({ fragment: m.fragment })),
      }));
      codeSearchCache.set(cacheKey, results);
      return results;
    } catch (err) {
      const isRateLimited = err instanceof GitHubApiError
        && err.status === 403
        && (err.retryAfterMs !== undefined || /rate.?limit/i.test(err.message));
      if (isRateLimited) {
        codeSearchBlockedUntil = Date.now()
          + (err.retryAfterMs ?? CODE_SEARCH_RATE_LIMIT_FALLBACK_MS);
        throw new Error(
          `GitHub code search rate-limited (403); retry later or use list_repo_dir/get_skill_file`,
        );
      }
      throw err;
    }
  })();

  activeCodeSearch = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (activeCodeSearch?.promise === promise) activeCodeSearch = null;
  }
}

export function invalidateCache(org?: string, repo?: string) {
  const resolvedOrg = org || getDefaultOrg();
  if (resolvedOrg && repo) {
    skillListCache.invalidate(`skills:${resolvedOrg}:${repo}`);
    skillDetailCache.invalidate(`detail:${resolvedOrg}:${repo}`);
    fileContentCache.invalidate(`file:${resolvedOrg}:${repo}`);
    codeSearchCache.invalidate(`codesearch:${resolvedOrg}:${repo}`);
  } else if (resolvedOrg) {
    repoCache.invalidate(`repos:${resolvedOrg}`);
    skillListCache.invalidate(`skills:${resolvedOrg}`);
    skillDetailCache.invalidate(`detail:${resolvedOrg}`);
    fileContentCache.invalidate(`file:${resolvedOrg}`);
    codeSearchCache.invalidate(`codesearch:${resolvedOrg}`);
  } else {
    repoCache.invalidate('repos:');
    codeSearchCache.invalidate('codesearch:');
  }
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function fetchFileContent(
  org: string,
  repo: string,
  filePath: string,
  branch: string,
): Promise<string> {
  return ghFetchRaw(
    `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
  );
}
