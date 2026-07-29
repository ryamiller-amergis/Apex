/**
 * Best-effort Microsoft Graph org snapshot for the signed-in user (User.Read).
 * Never throws to callers — returns null when Graph is unavailable.
 */
import type { Request } from 'express';
import {
  MAX_DIRECT_REPORTS_ON_PROFILE,
  type CurrentProfileOrg,
  type ProfileOrgPerson,
} from '../../shared/types/profile';
import { getGraphTokenForUser } from './graphUserToken';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

const ME_SELECT =
  'id,displayName,jobTitle,department,officeLocation,companyName,mail,userPrincipalName';
const PERSON_SELECT = 'id,displayName,jobTitle,mail,userPrincipalName';

interface GraphUserPayload {
  id?: string;
  displayName?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  companyName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

function nonempty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapPerson(raw: GraphUserPayload | null | undefined): ProfileOrgPerson | null {
  if (!raw || typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return null;
  }
  const displayName = nonempty(raw.displayName) ?? 'Unknown User';
  return {
    userOid: raw.id.trim(),
    displayName,
    jobTitle: nonempty(raw.jobTitle),
    email: nonempty(raw.mail) ?? nonempty(raw.userPrincipalName),
  };
}

async function graphGet<T>(
  accessToken: string,
  path: string
): Promise<{ ok: true; body: T } | { ok: false; status: number }> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const body = (await res.json()) as T;
  return { ok: true, body };
}

/**
 * Load organization fields for the current user via Graph.
 * Returns null when no token is available or Graph calls fail.
 */
export async function fetchCurrentUserOrgProfile(
  req: Request
): Promise<CurrentProfileOrg | null> {
  const accessToken = await getGraphTokenForUser(req);
  if (!accessToken) {
    return null;
  }

  try {
    const meResult = await graphGet<GraphUserPayload>(
      accessToken,
      `/me?$select=${ME_SELECT}`
    );
    if (meResult.ok === false) {
      console.error(`[graphOrgProfile] /me failed with status ${meResult.status}`);
      return null;
    }

    const me = meResult.body;

    let manager: ProfileOrgPerson | null = null;
    const managerResult = await graphGet<GraphUserPayload>(
      accessToken,
      `/me/manager?$select=${PERSON_SELECT}`
    );
    if (managerResult.ok) {
      manager = mapPerson(managerResult.body);
    }
    // 404 = no manager assigned — treat as null, not a hard failure.

    let directReports: ProfileOrgPerson[] = [];
    const reportsResult = await graphGet<{ value?: GraphUserPayload[] }>(
      accessToken,
      `/me/directReports?$select=${PERSON_SELECT}&$top=${MAX_DIRECT_REPORTS_ON_PROFILE}`
    );
    if (reportsResult.ok && Array.isArray(reportsResult.body.value)) {
      directReports = reportsResult.body.value
        .map((row) => mapPerson(row))
        .filter((p): p is ProfileOrgPerson => p !== null)
        .slice(0, MAX_DIRECT_REPORTS_ON_PROFILE);
    }

    return {
      jobTitle: nonempty(me.jobTitle),
      department: nonempty(me.department),
      officeLocation: nonempty(me.officeLocation),
      companyName: nonempty(me.companyName),
      manager,
      directReports,
    };
  } catch (err) {
    console.error(
      '[graphOrgProfile] unexpected error:',
      (err as any)?.message ?? err
    );
    return null;
  }
}
