/**
 * Azure Artifacts Skill Service
 *
 * Handles interactions with the Azure Artifacts npm feed for the @apex/skills package:
 *   - Discover candidate versions published to the Local view
 *   - Download the package manifest (catalog.json) from a candidate
 *   - Verify package integrity (SHA-256 of the tarball)
 *   - Promote a candidate from the Local view to the Release view
 *
 * NOTE: Feed/view creation and PAT provisioning are human operational steps.
 * This code is complete but non-functional until the feed is configured via
 * the environment variables documented in .env.example.
 *
 * Required env vars (all optional — service degrades gracefully when absent):
 *   AZURE_ARTIFACTS_ORG      — Azure DevOps org name (e.g. "amergis")
 *   AZURE_ARTIFACTS_PROJECT  — ADO project containing the feed (leave empty for org-scoped feeds)
 *   AZURE_ARTIFACTS_FEED     — feed name (e.g. "apex-skills")
 *   AZURE_ARTIFACTS_PAT      — Personal Access Token with Packaging Read+Write scope
 */

import https from 'https';
import crypto from 'crypto';
import type { ArtifactCandidate } from '../../shared/types/foundationSkills';

// ── Config ────────────────────────────────────────────────────────────────────

function feedBaseUrl(): string | null {
  const org   = process.env.AZURE_ARTIFACTS_ORG;
  const feed  = process.env.AZURE_ARTIFACTS_FEED;
  if (!org || !feed) return null;

  const project = process.env.AZURE_ARTIFACTS_PROJECT;
  const base = project
    ? `https://pkgs.dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/packaging/feeds/${encodeURIComponent(feed)}`
    : `https://pkgs.dev.azure.com/${encodeURIComponent(org)}/_apis/packaging/feeds/${encodeURIComponent(feed)}`;
  return base;
}

function authHeader(): string | null {
  const pat = process.env.AZURE_ARTIFACTS_PAT;
  if (!pat) return null;
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

/** True when the service is configured enough to make API calls. */
export function isAzureArtifactsConfigured(): boolean {
  return !!(process.env.AZURE_ARTIFACTS_ORG && process.env.AZURE_ARTIFACTS_FEED && process.env.AZURE_ARTIFACTS_PAT);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function get<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const auth = authHeader();
    if (!auth) return reject(new Error('AZURE_ARTIFACTS_PAT not set'));

    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body) as T); } catch (e) { reject(e); }
        } else {
          reject(new Error(`Azure Artifacts API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Azure Artifacts API timeout')); });
    req.end();
  });
}

function post<T>(url: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const auth = authHeader();
    if (!auth) return reject(new Error('AZURE_ARTIFACTS_PAT not set'));

    const payload = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) as T : {} as T); } catch (e) { reject(e); }
        } else {
          reject(new Error(`Azure Artifacts API ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Azure Artifacts API timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List published candidate versions of @apex/skills from the feed.
 * Returns an empty array when the feed is not configured (non-fatal).
 */
export async function listCandidates(): Promise<ArtifactCandidate[]> {
  const base = feedBaseUrl();
  if (!base) {
    console.warn('[azureArtifactsSkillService] Feed not configured — listCandidates returning []');
    return [];
  }

  const url = `${base}/packages?packageNameQuery=@apex%2Fskills&api-version=7.1-preview.1`;
  const result = await get<{
    value?: Array<{
      name: string;
      versions?: Array<{ version: string; publishDate?: string; isLatest?: boolean }>;
    }>;
  }>(url);

  const candidates: ArtifactCandidate[] = [];
  for (const pkg of result.value ?? []) {
    for (const v of pkg.versions ?? []) {
      candidates.push({
        packageName: pkg.name,
        version: v.version,
        publishedAt: v.publishDate ?? new Date().toISOString(),
        feedUrl: base,
        integrity: null,
        manifestUrl: null,
      });
    }
  }
  return candidates.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/**
 * Verify the integrity of a published package version by computing the SHA-256
 * of its tarball and comparing it against `expectedIntegrity`.
 *
 * Returns `true` when they match; `false` when they don't; `null` when the
 * feed is not configured or the download fails (non-fatal).
 */
export async function verifyPackageIntegrity(
  version: string,
  expectedIntegrity: string,
): Promise<boolean | null> {
  if (!isAzureArtifactsConfigured()) return null;

  const base = feedBaseUrl()!;
  const downloadUrl = `${base}/npm/packages/@apex%2Fskills/${encodeURIComponent(version)}/content`;

  return new Promise((resolve) => {
    const auth = authHeader()!;
    const hash = crypto.createHash('sha256');

    const req = https.request(downloadUrl, {
      method: 'GET',
      headers: { Authorization: auth },
    }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        console.warn(`[azureArtifactsSkillService] verifyIntegrity: HTTP ${res.statusCode}`);
        resolve(null);
        return;
      }
      res.on('data', (chunk: Buffer) => hash.update(chunk));
      res.on('end', () => {
        const actual = hash.digest('hex');
        resolve(actual.toLowerCase() === expectedIntegrity.toLowerCase());
      });
    });
    req.on('error', (e) => {
      console.warn(`[azureArtifactsSkillService] verifyIntegrity error: ${e.message}`);
      resolve(null);
    });
    req.setTimeout(30_000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Compute the SHA-256 hex digest of the npm tarball for a given version.
 * Returns null when the feed is not configured or download fails.
 */
export async function computePackageIntegrity(version: string): Promise<string | null> {
  if (!isAzureArtifactsConfigured()) return null;

  const base = feedBaseUrl()!;
  const downloadUrl = `${base}/npm/packages/@apex%2Fskills/${encodeURIComponent(version)}/content`;

  return new Promise((resolve) => {
    const auth = authHeader()!;
    const hash = crypto.createHash('sha256');

    const req = https.request(downloadUrl, {
      method: 'GET',
      headers: { Authorization: auth },
    }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        resolve(null);
        return;
      }
      res.on('data', (chunk: Buffer) => hash.update(chunk));
      res.on('end', () => resolve(hash.digest('hex')));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30_000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Promote a candidate version from the Local view to the Release view in
 * Azure Artifacts. This is the human-triggered "publish" step.
 *
 * Returns true on success, throws on failure.
 */
export async function promoteToReleaseView(version: string): Promise<void> {
  if (!isAzureArtifactsConfigured()) {
    throw new Error('Azure Artifacts feed not configured — set AZURE_ARTIFACTS_ORG, AZURE_ARTIFACTS_FEED, and AZURE_ARTIFACTS_PAT');
  }

  const base = feedBaseUrl()!;
  const url = `${base}/npm/packagesBatch?api-version=7.1-preview.1`;

  await post(url, {
    operation: 'promote',
    data: { viewId: 'Release' },
    packages: [{ id: '@apex/skills', version, protocolType: 'Npm' }],
  });

  console.log(`[azureArtifactsSkillService] Promoted @apex/skills@${version} to Release view`);
}

/**
 * Mark a version deprecated on the feed so `npm install` surfaces a warning and
 * the feed UI flags it. Pass an empty `message` to undeprecate.
 *
 * Deliberately non-destructive: unpublish/delete would 404 for teams already
 * pinned to this version and break their builds. Preventing *new* adoption is
 * handled by release targeting in APEX, which never resolves a deprecated
 * release as an install candidate.
 */
export async function deprecatePackageVersion(version: string, message: string): Promise<void> {
  if (!isAzureArtifactsConfigured()) {
    throw new Error('Azure Artifacts feed not configured — set AZURE_ARTIFACTS_ORG, AZURE_ARTIFACTS_FEED, and AZURE_ARTIFACTS_PAT');
  }

  const base = feedBaseUrl()!;
  const url = `${base}/npm/packagesBatch?api-version=7.1-preview.1`;

  await post(url, {
    operation: 'deprecate',
    data: { message },
    packages: [{ id: '@apex/skills', version, protocolType: 'Npm' }],
  });

  console.log(`[azureArtifactsSkillService] Deprecated @apex/skills@${version} on the feed`);
}
