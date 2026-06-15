/**
 * Determines which ADO projects a user belongs to by checking team membership
 * via the Teams/Members REST API.
 *
 * The Member Entitlements API (vsaex.dev.azure.com) returns empty
 * projectEntitlements for orgs that use group-based project access (Azure AD
 * security groups added to project teams). The Teams/Members API works
 * regardless of how the user was added.
 *
 * Two-layer cache:
 *   - Project teams (org-wide, 30-min TTL) — rarely changes, shared across users
 *   - User membership (per-user, 15-min TTL) — filtered project list per user
 */

import https from 'node:https';

/* ── Config ─────────────────────────────────────────────────── */

const TEAMS_CACHE_TTL_MS = 30 * 60 * 1000;
const USER_CACHE_TTL_MS = 15 * 60 * 1000;

interface TeamInfo {
  id: string;
  name: string;
}

interface ProjectTeams {
  projectId: string;
  projectName: string;
  projectDescription: string;
  teams: TeamInfo[];
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/* ── Caches ─────────────────────────────────────────────────── */

let projectTeamsCache: CacheEntry<ProjectTeams[]> | null = null;
const userProjectsCache = new Map<string, CacheEntry<string[]>>();

/* ── Helpers ────────────────────────────────────────────────── */

function getAdoConfig(): { orgUrl: string; pat: string; orgName: string } {
  const orgUrl = process.env.ADO_ORG || '';
  const pat = process.env.ADO_PAT || '';
  if (!orgUrl || !pat) {
    throw new Error('ADO_ORG and ADO_PAT must be set');
  }

  let orgName: string;
  try {
    const url = new URL(orgUrl);
    const host = url.hostname.toLowerCase();
    if (host.endsWith('.visualstudio.com')) {
      orgName = host.replace('.visualstudio.com', '');
    } else {
      const parts = url.pathname.split('/').filter(Boolean);
      orgName = parts[0] || '';
    }
  } catch {
    orgName = '';
  }
  if (!orgName) {
    throw new Error(`Could not parse organization name from ADO_ORG: ${orgUrl}`);
  }

  return { orgUrl, pat, orgName };
}

function adoGet<T>(url: string, pat: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + Buffer.from(':' + pat).toString('base64'),
        Accept: 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(new Error(`Failed to parse ADO response: ${e}`));
          }
        } else {
          reject(new Error(`ADO API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/* ── Core Logic ─────────────────────────────────────────────── */

interface AdoProjectsResponse {
  value: Array<{ id: string; name: string; description?: string }>;
}

interface AdoTeamsResponse {
  value: Array<{ id: string; name: string }>;
}

interface AdoMembersResponse {
  value: Array<{ identity: { uniqueName: string } }>;
}

async function fetchAllProjectTeams(): Promise<ProjectTeams[]> {
  const now = Date.now();
  if (projectTeamsCache && projectTeamsCache.expiresAt > now) {
    return projectTeamsCache.data;
  }

  const { orgUrl, pat } = getAdoConfig();

  const projectsResp = await adoGet<AdoProjectsResponse>(
    `${orgUrl}/_apis/projects?api-version=7.1`,
    pat,
  );

  const results: ProjectTeams[] = await Promise.all(
    projectsResp.value.map(async (project) => {
      const teamsResp = await adoGet<AdoTeamsResponse>(
        `${orgUrl}/_apis/projects/${encodeURIComponent(project.name)}/teams?api-version=7.1`,
        pat,
      );
      return {
        projectId: project.id,
        projectName: project.name,
        projectDescription: project.description || '',
        teams: teamsResp.value.map((t) => ({ id: t.id, name: t.name })),
      };
    }),
  );

  projectTeamsCache = { data: results, expiresAt: now + TEAMS_CACHE_TTL_MS };
  return results;
}

async function checkUserMembership(
  email: string,
  projectTeams: ProjectTeams[],
): Promise<string[]> {
  const { orgUrl, pat } = getAdoConfig();
  const lowerEmail = email.toLowerCase();

  const checks = await Promise.all(
    projectTeams.map(async (pt) => {
      for (const team of pt.teams) {
        try {
          const membersResp = await adoGet<AdoMembersResponse>(
            `${orgUrl}/_apis/projects/${encodeURIComponent(pt.projectName)}/teams/${encodeURIComponent(team.id)}/members?api-version=7.1`,
            pat,
          );
          const found = membersResp.value.some(
            (m) => m.identity.uniqueName.toLowerCase() === lowerEmail,
          );
          if (found) return pt.projectName;
        } catch (err) {
          console.warn(`[adoMembership] Failed to fetch members for ${pt.projectName}/${team.name}:`, err);
        }
      }
      return null;
    }),
  );

  return checks.filter((name): name is string => name !== null);
}

/* ── Public API ─────────────────────────────────────────────── */

export interface UserProjectInfo {
  name: string;
  id: string;
  description: string;
}

/**
 * Returns the ADO projects that `email` is a team member of.
 * Results are cached per user for 15 minutes.
 */
export async function getUserProjects(email: string): Promise<UserProjectInfo[]> {
  const cacheKey = email.toLowerCase();
  const now = Date.now();
  const cached = userProjectsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    const allPt = await fetchAllProjectTeams();
    return cached.data.map((name) => {
      const pt = allPt.find((p) => p.projectName === name);
      return { name, id: pt?.projectId ?? '', description: pt?.projectDescription ?? '' };
    });
  }

  const allProjectTeams = await fetchAllProjectTeams();
  const projectNames = await checkUserMembership(email, allProjectTeams);

  userProjectsCache.set(cacheKey, { data: projectNames, expiresAt: now + USER_CACHE_TTL_MS });

  return projectNames.map((name) => {
    const pt = allProjectTeams.find((p) => p.projectName === name);
    return { name, id: pt?.projectId ?? '', description: pt?.projectDescription ?? '' };
  });
}

/** Evict a single user from the membership cache (e.g. after override change). */
export function invalidateUserProjectsCache(email: string): void {
  userProjectsCache.delete(email.toLowerCase());
}

/** Evict all caches (useful for testing or admin-triggered refresh). */
export function invalidateAllCaches(): void {
  projectTeamsCache = null;
  userProjectsCache.clear();
}
