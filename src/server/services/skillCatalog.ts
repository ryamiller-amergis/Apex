import * as azdev from 'azure-devops-node-api';
import type {
  AdoProject,
  AdoRepo,
  SkillEntry,
  SkillDetail,
  SupportingFile,
  SkillFrontmatter,
} from '../../shared/types/skills';
import {
  SKILL_DISCOVERY_ROOTS,
  selectSkillsByRootPrecedence,
} from '../../shared/skillPaths';

const ORG_URL = process.env.ADO_ORG || '';
const PAT = process.env.ADO_PAT || '';
/** Bound ADO code-search HTTP calls so MCP tools cannot hang the agent stream forever. */
const ADO_FETCH_TIMEOUT_MS =
  Number(process.env.ADO_FETCH_TIMEOUT_MS) > 0
    ? Number(process.env.ADO_FETCH_TIMEOUT_MS)
    : 30_000;

/** In-memory cache with TTL */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

const projectCache = makeCache<AdoProject[]>();
const repoCache = makeCache<AdoRepo[]>();
const branchCache = makeCache<string[]>();
const skillListCache = makeCache<SkillEntry[]>();
const skillDetailCache = makeCache<SkillDetail>();
const fileContentCache = makeCache<string>();
const codeSearchCache = makeCache<RepoCodeSearchResult[]>();

function getConnection(): azdev.WebApi {
  if (!ORG_URL || !PAT) {
    throw new Error('ADO_ORG and ADO_PAT must be set');
  }
  const auth = azdev.getPersonalAccessTokenHandler(PAT);
  return new azdev.WebApi(ORG_URL, auth, { socketTimeout: 30000 });
}

/** Parse YAML frontmatter from a markdown string. Only handles simple key: value pairs. */
export function parseFrontmatter(raw: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = raw.match(FM_RE);
  if (!match) {
    return { frontmatter: { name: '', description: '' }, body: raw };
  }
  const yamlBlock = match[1];
  const body = match[2];
  const fm: Record<string, string> = {};
  for (const line of yamlBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fm[key] = value;
  }
  return {
    frontmatter: {
      name: fm['name'] ?? '',
      description: fm['description'] ?? '',
      ...fm,
    },
    body,
  };
}

export function repoDefaultBranch(branch: string | undefined): string {
  if (!branch) return 'main';
  return branch.replace('refs/heads/', '');
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function listProjects(): Promise<AdoProject[]> {
  const cached = projectCache.get('all');
  if (cached) return cached;

  const conn = getConnection();
  const coreApi = await conn.getCoreApi();
  const projects = await coreApi.getProjects();

  const result: AdoProject[] = (projects ?? []).map((p) => ({
    id: p.id ?? '',
    name: p.name ?? '',
    description: p.description ?? undefined,
  }));

  projectCache.set('all', result);
  return result;
}

export async function listRepos(project: string): Promise<AdoRepo[]> {
  const cacheKey = `repos:${project}`;
  const cached = repoCache.get(cacheKey);
  if (cached) return cached;

  const conn = getConnection();
  const gitApi = await conn.getGitApi();
  const repos = await gitApi.getRepositories(project);

  const result: AdoRepo[] = (repos ?? []).map((r) => ({
    id: r.id ?? '',
    name: r.name ?? '',
    defaultBranch: repoDefaultBranch(r.defaultBranch),
    webUrl: r.webUrl ?? '',
    project,
  }));

  repoCache.set(cacheKey, result);
  return result;
}

export async function listBranches(
  project: string,
  repo: string
): Promise<string[]> {
  const cacheKey = `branches:${project}:${repo}`;
  const cached = branchCache.get(cacheKey);
  if (cached) return cached;

  const conn = getConnection();
  const gitApi = await conn.getGitApi();
  const repos = await listRepos(project);
  const repoObj = repos.find(
    (r) => r.name.toLowerCase() === repo.toLowerCase()
  );
  if (!repoObj) return [];

  const branches = await gitApi.getBranches(repoObj.id);
  const result = (branches ?? [])
    .map((b) => b.name ?? '')
    .filter(Boolean)
    .sort((a, b) => {
      if (a === repoObj.defaultBranch) return -1;
      if (b === repoObj.defaultBranch) return 1;
      return a.localeCompare(b);
    });

  branchCache.set(cacheKey, result);
  return result;
}

export async function listSkills(
  project: string,
  repo: string,
  branch?: string
): Promise<SkillEntry[]> {
  const cacheKey = `skills:${project}:${repo}:${branch ?? 'default'}`;
  const cached = skillListCache.get(cacheKey);
  if (cached) return cached;

  const conn = getConnection();
  const gitApi = await conn.getGitApi();

  // Resolve default branch if not provided
  let resolvedBranch = branch;
  if (!resolvedBranch) {
    const repos = await listRepos(project);
    const found = repos.find((r) => r.name === repo);
    resolvedBranch = found?.defaultBranch ?? 'main';
  }

  const skillPaths: string[] = [];

  // SKILL_DISCOVERY_ROOTS order is deliberate; duplicates collapse below.
  for (const root of SKILL_DISCOVERY_ROOTS) {
    try {
      const items = await gitApi.getItems(
        repo,
        project,
        root,
        120, // VersionControlRecursionType.Full — recurse all subdirectories
        undefined,
        undefined,
        undefined,
        undefined,
        { versionType: 0, version: resolvedBranch } // 0 = Branch
      );
      for (const item of items ?? []) {
        if (
          item.path?.endsWith('/SKILL.md') ||
          item.path === `/${root}/SKILL.md`
        ) {
          skillPaths.push(item.path);
        }
      }
    } catch {
      // Root doesn't exist in this repo — skip
    }
  }

  const skills: SkillEntry[] = [];

  for (const skillPath of skillPaths) {
    try {
      const content = await fetchFileContent(
        project,
        repo,
        skillPath,
        resolvedBranch,
        gitApi
      );
      const { frontmatter } = parseFrontmatter(content);
      if (!frontmatter.name) continue;

      skills.push({
        id: `${project}/${repo}/${skillPath}`,
        name: frontmatter.name,
        description: frontmatter.description,
        project,
        repo,
        path: skillPath,
        branch: resolvedBranch,
        frontmatter,
      });
    } catch {
      // Couldn't read file — skip
    }
  }

  const resolved = selectSkillsByRootPrecedence(skills);
  for (const collision of resolved.collisions) {
    console.warn(
      `[skillCatalog] Duplicate skill "${collision.name}" in ${project}/${repo}: ` +
        `${collision.paths.join(', ')}. Using ${collision.paths[0]}.`
    );
  }
  skillListCache.set(cacheKey, resolved.skills);
  return resolved.skills;
}

export async function getSkill(
  project: string,
  repo: string,
  path: string,
  branch?: string
): Promise<SkillDetail> {
  const cacheKey = `detail:${project}:${repo}:${path}:${branch ?? 'default'}`;
  const cached = skillDetailCache.get(cacheKey);
  if (cached) return cached;

  const conn = getConnection();
  const gitApi = await conn.getGitApi();

  let resolvedBranch = branch;
  if (!resolvedBranch) {
    const repos = await listRepos(project);
    const found = repos.find((r) => r.name === repo);
    resolvedBranch = found?.defaultBranch ?? 'main';
  }

  const content = await fetchFileContent(
    project,
    repo,
    path,
    resolvedBranch,
    gitApi
  );
  const { frontmatter } = parseFrontmatter(content);

  // Collect sibling files + check for apex-skill.json contract
  const folder = path.substring(0, path.lastIndexOf('/'));
  const supportingFiles: SupportingFile[] = [];

  try {
    const siblings = await gitApi.getItems(
      repo,
      project,
      folder,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { versionType: 0, version: resolvedBranch }
    );
    let apexSkillJsonPath: string | null = null;
    for (const item of siblings ?? []) {
      if (!item.path || item.path === path || item.isFolder) continue;
      const name = item.path.substring(item.path.lastIndexOf('/') + 1);
      supportingFiles.push({ path: item.path, name });
      if (name === 'apex-skill.json') apexSkillJsonPath = item.path;
    }

    // Resolve declared foundation dependencies from apex-skill.json
    if (apexSkillJsonPath) {
      try {
        const contractText = await fetchFileContent(
          project,
          repo,
          apexSkillJsonPath,
          resolvedBranch,
          gitApi
        );
        const contract = JSON.parse(contractText) as {
          managedFoundationFiles?: string[];
        };
        for (const depPath of contract.managedFoundationFiles ?? []) {
          if (!depPath) continue;
          const depName = depPath.split('/').filter(Boolean).pop() ?? depPath;
          // Only add if not already in the list
          if (!supportingFiles.some((f) => f.path === depPath)) {
            supportingFiles.push({
              path: depPath,
              name: depName,
              isFoundationDep: true,
            });
          }
        }
      } catch {
        // Non-fatal — apex-skill.json may be absent or malformed
      }
    }
  } catch {
    // Couldn't list folder — non-fatal
  }

  const result: SkillDetail = {
    id: `${project}/${repo}/${path}`,
    name: frontmatter.name,
    description: frontmatter.description,
    project,
    repo,
    path,
    branch: resolvedBranch,
    frontmatter,
    content,
    supportingFiles,
  };

  skillDetailCache.set(cacheKey, result);
  return result;
}

export async function getSkillFile(
  project: string,
  repo: string,
  path: string,
  branch?: string
): Promise<string> {
  const cacheKey = `file:${project}:${repo}:${path}:${branch ?? 'default'}`;
  const cached = fileContentCache.get(cacheKey);
  if (cached) return cached;

  const conn = getConnection();
  const gitApi = await conn.getGitApi();

  let resolvedBranch = branch;
  if (!resolvedBranch) {
    const repos = await listRepos(project);
    const found = repos.find((r) => r.name === repo);
    resolvedBranch = found?.defaultBranch ?? 'main';
  }

  const content = await fetchFileContent(
    project,
    repo,
    path,
    resolvedBranch,
    gitApi
  );
  fileContentCache.set(cacheKey, content);
  return content;
}

export interface RepoFileEntry {
  path: string;
  name: string;
  isFolder: boolean;
}

export interface RepoCodeSearchMatch {
  lineNumber?: number;
  snippet: string;
}

export interface RepoCodeSearchResult {
  path: string;
  fileName: string;
  repository: string;
  project: string;
  branch?: string;
  matches: RepoCodeSearchMatch[];
}

const dirListCache = makeCache<RepoFileEntry[]>();

export async function listRepoDir(
  project: string,
  repo: string,
  dirPath: string,
  branch?: string
): Promise<RepoFileEntry[]> {
  const cacheKey = `dir:${project}:${repo}:${dirPath}:${branch ?? 'default'}`;
  const cached = dirListCache.get(cacheKey);
  if (cached) return cached;

  const conn = getConnection();
  const gitApi = await conn.getGitApi();

  let resolvedBranch = branch;
  if (!resolvedBranch) {
    const repos = await listRepos(project);
    const found = repos.find((r) => r.name === repo);
    resolvedBranch = found?.defaultBranch ?? 'main';
  }

  const scopePath = dirPath.startsWith('/') ? dirPath : `/${dirPath}`;

  const items = await gitApi.getItems(
    repo,
    project,
    scopePath,
    1, // VersionControlRecursionType.OneLevel — immediate children only
    undefined,
    undefined,
    undefined,
    undefined,
    { versionType: 0, version: resolvedBranch }
  );

  const result: RepoFileEntry[] = (items ?? [])
    .filter((item) => item.path && item.path !== scopePath)
    .map((item) => ({
      path: item.path ?? '',
      name: (item.path ?? '').split('/').filter(Boolean).pop() ?? '',
      isFolder: item.isFolder ?? false,
    }));

  dirListCache.set(cacheKey, result);
  return result;
}

export async function searchRepoCode(
  project: string,
  repo: string,
  query: string,
  branch?: string,
  limit = 10
): Promise<RepoCodeSearchResult[]> {
  if (!query.trim()) return [];

  const cacheKey = `codesearch:${project}:${repo}:${branch ?? 'default'}:${query}:${limit}`;
  const cached = codeSearchCache.get(cacheKey);
  if (cached) return cached;

  if (!ORG_URL || !PAT) {
    throw new Error('ADO_ORG and ADO_PAT must be set');
  }

  const org = extractOrgName(ORG_URL);
  if (!org) {
    throw new Error(
      `Could not parse organization name from ADO_ORG: ${ORG_URL}`
    );
  }

  const url = `https://almsearch.dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/search/codesearchresults?api-version=7.1-preview.1`;

  const payload = {
    searchText: query,
    $top: Math.min(Math.max(limit, 1), 50),
    $skip: 0,
    includeFacets: false,
    filters: {
      Project: [project],
      Repository: [repo],
    },
  };

  const authHeader = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ADO_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Code search request failed (${response.status} ${response.statusText}). ${errorBody}`.trim()
    );
  }

  // The ADO code search API returns matches as an object keyed by match type
  // (e.g. { content: [...], fileName: [...] }), not a flat array.
  // Each entry has { charOffset, length, line, column, codeSnippet, type }.
  const body = (await response.json()) as {
    count?: number;
    results?: Array<{
      path?: string;
      fileName?: string;
      repository?: { name?: string };
      project?: { name?: string };
      versions?: Array<{ branchName?: string }>;
      matches?: Record<
        string,
        Array<{
          charOffset?: number;
          length?: number;
          line?: number;
          column?: number;
          codeSnippet?: string | null;
          type?: string | null;
        }>
      >;
    }>;
  };

  const results: RepoCodeSearchResult[] = (body.results ?? []).map((item) => {
    // Flatten all match-type arrays from the matches object into one list.
    const allMatchEntries = Object.values(item.matches ?? {}).flat();
    const matches: RepoCodeSearchMatch[] = allMatchEntries
      .map((m) => ({
        lineNumber: m.line,
        snippet: (m.codeSnippet ?? '').trim(),
      }))
      .filter((m) => m.snippet.length > 0);

    // Derive a branch label from versions if available
    const branch = item.versions?.[0]?.branchName;

    return {
      path: item.path ?? '',
      fileName: item.fileName ?? (item.path ?? '').split('/').pop() ?? '',
      repository: item.repository?.name ?? repo,
      project: item.project?.name ?? project,
      branch,
      matches,
    };
  });

  codeSearchCache.set(cacheKey, results);
  return results;
}

export function searchSkills(
  skills: SkillEntry[],
  query: string,
  limit = 10
): SkillEntry[] {
  const q = query.toLowerCase();
  return skills
    .map((s) => {
      const nameMatch = s.name.toLowerCase().includes(q) ? 2 : 0;
      const descMatch = s.description.toLowerCase().includes(q) ? 1 : 0;
      return { skill: s, score: nameMatch + descMatch };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.skill);
}

export function invalidateCache(project?: string, repo?: string) {
  if (project && repo) {
    skillListCache.invalidate(`skills:${project}:${repo}`);
    skillDetailCache.invalidate(`detail:${project}:${repo}`);
    fileContentCache.invalidate(`file:${project}:${repo}`);
    codeSearchCache.invalidate(`codesearch:${project}:${repo}`);
  } else if (project) {
    repoCache.invalidate(`repos:${project}`);
    skillListCache.invalidate(`skills:${project}`);
    skillDetailCache.invalidate(`detail:${project}`);
    fileContentCache.invalidate(`file:${project}`);
    codeSearchCache.invalidate(`codesearch:${project}`);
  } else {
    projectCache.invalidate('all');
    codeSearchCache.invalidate('codesearch:');
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function fetchFileContent(
  project: string,
  repo: string,
  path: string,
  branch: string,
  gitApi: Awaited<ReturnType<azdev.WebApi['getGitApi']>>
): Promise<string> {
  const stream = await gitApi.getItemContent(
    repo,
    path,
    project,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { versionType: 0, version: branch }
  );

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', reject);
  });
}

function extractOrgName(orgUrl: string): string {
  try {
    const url = new URL(orgUrl);
    const host = url.hostname.toLowerCase();

    if (host.endsWith('.visualstudio.com')) {
      return host.replace('.visualstudio.com', '');
    }

    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
      return pathParts[0];
    }

    return '';
  } catch {
    return '';
  }
}
