/**
 * Uncached reads of the branch head, so every hash describes the content at
 * run start. Uses the Apex ADO token, never the Cloud Agent identity.
 */
import https from 'https';
import { fetchAdoFileGeneric, fetchAdoTreeGeneric } from '../../utils/adoFileFetch';
import {
  RepoReadUnavailableError,
  type AdoRepoCoords,
  type PipelineDefinitionSummary,
} from './ports';

export const PREFLIGHT_READ_TIMEOUT_MS = 5_000;

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /^ADO 404\b/.test(err.message);
}

function credentials(): { orgUrl: string; pat: string } {
  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;
  if (!orgUrl || !pat) throw new RepoReadUnavailableError(new Error('ADO_ORG or ADO_PAT not set'));
  return { orgUrl, pat };
}

export async function readRepoFile(coords: AdoRepoCoords, path: string): Promise<string | null> {
  const { orgUrl, pat } = credentials();
  try {
    return await fetchAdoFileGeneric(orgUrl, pat, coords.adoProject, coords.repo, path, coords.branch, PREFLIGHT_READ_TIMEOUT_MS);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new RepoReadUnavailableError(err);
  }
}

export async function listRepoFolder(coords: AdoRepoCoords, path: string): Promise<string[] | null> {
  const { orgUrl, pat } = credentials();
  try {
    const items = await fetchAdoTreeGeneric(
      orgUrl,
      pat,
      coords.adoProject,
      coords.repo,
      path,
      coords.branch,
      'OneLevel',
      PREFLIGHT_READ_TIMEOUT_MS,
    );
    return items.map((item) => item.replace(/^\/+/, ''));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new RepoReadUnavailableError(err);
  }
}

function getJson(url: URL, pat: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${pat}`).toString('base64');
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve({ status, body: null });
            return;
          }
          try {
            resolve({ status, body: JSON.parse(data) });
          } catch {
            reject(new Error('ADO build definition response was not valid JSON'));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(PREFLIGHT_READ_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('Timeout reading build definition'));
    });
    req.end();
  });
}

interface RawDefinition {
  queueStatus?: string;
  repository?: { id?: string; name?: string };
  process?: { yamlFilename?: string };
  variables?: Record<string, { allowOverride?: boolean }>;
}

/** Names declared under a top-level `parameters:` list in pipeline YAML. */
export function yamlParameterNames(yaml: string): string[] {
  const names: string[] = [];
  const lines = yaml.split(/\r?\n/);
  let inParameters = false;
  for (const line of lines) {
    if (/^parameters:\s*$/.test(line)) {
      inParameters = true;
      continue;
    }
    if (inParameters && /^\S/.test(line)) break;
    const match = inParameters ? /^\s*-\s*name:\s*['"]?([A-Za-z_][\w]*)['"]?\s*$/.exec(line) : null;
    if (match) names.push(match[1]);
  }
  return names;
}

export async function readPipelineDefinition(
  coords: AdoRepoCoords,
  definitionId: number,
): Promise<PipelineDefinitionSummary | null> {
  const { orgUrl, pat } = credentials();
  let raw: RawDefinition;
  try {
    const url = new URL(`${orgUrl}/${encodeURIComponent(coords.adoProject)}/_apis/build/definitions/${definitionId}?api-version=7.1`);
    const { status, body } = await getJson(url, pat);
    if (status === 404) return null;
    if (!body) throw new Error(`ADO ${status} reading build definition`);
    raw = body as RawDefinition;
  } catch (err) {
    throw new RepoReadUnavailableError(err);
  }

  const parameterNames = Object.entries(raw.variables ?? {})
    .filter(([, variable]) => variable?.allowOverride === true)
    .map(([name]) => name);
  const yamlPath = raw.process?.yamlFilename?.trim();
  if (yamlPath) {
    const yaml = await readRepoFile(coords, yamlPath);
    if (yaml) parameterNames.push(...yamlParameterNames(yaml));
  }

  return {
    enabled: (raw.queueStatus ?? 'enabled').toLowerCase() === 'enabled',
    repositoryName: raw.repository?.name ?? null,
    repositoryId: raw.repository?.id ?? null,
    parameterNames,
  };
}
