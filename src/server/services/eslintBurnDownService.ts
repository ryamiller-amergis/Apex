import * as azdev from 'azure-devops-node-api';
import { BuildQueryOrder, BuildStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { inflateRaw } from 'zlib';
import { promisify } from 'util';
import type { EslintBurnDownResponse, EslintBuildSnapshot, EslintSummaryArtifact } from '../types/workitem';

const inflateRawAsync = promisify(inflateRaw);

/** MaxView nightly pipeline contract — stable org-wide, not per-environment. */
const ESLINT_BUILD_PROJECT = 'MaxView';
const ESLINT_BUILD_DEFINITION = 'mv-nightly-runs-workflow';
const ESLINT_ARTIFACT_NAME = 'eslint-burn-down';
/** Paths tried inside the artifact zip (folder layout from the pipeline publish step). */
const ESLINT_SUMMARY_PATHS = ['eslint-burn-down/eslint-summary.json', 'eslint-summary.json'];
const BUILD_FETCH_TOP = 200;
const ARTIFACT_CONCURRENCY = 5;

function normalizePagedList<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page;
  if (page && typeof page === 'object' && Array.isArray((page as { value?: unknown[] }).value)) {
    return (page as { value: T[] }).value;
  }
  return [];
}

async function resolveBuildDefinition(
  buildApi: Awaited<ReturnType<azdev.WebApi['getBuildApi']>>,
  project: string,
  definitionName: string,
): Promise<{ id: number; name: string }> {
  const definitions = normalizePagedList<{ id?: number; name?: string }>(
    await buildApi.getDefinitions(project, definitionName),
  );
  const exact = definitions.find(item => item.name === definitionName);
  if (exact?.id) {
    return { id: exact.id, name: exact.name ?? definitionName };
  }

  const fuzzy = definitions.find(item => item.name?.toLowerCase().includes(definitionName.toLowerCase()));
  if (fuzzy?.id) {
    return { id: fuzzy.id, name: fuzzy.name ?? definitionName };
  }

  const allDefinitions = normalizePagedList<{ id?: number; name?: string }>(await buildApi.getDefinitions(project));
  const nightly = allDefinitions.find(item => item.name?.toLowerCase().includes('nightly'));
  if (nightly?.id) {
    return { id: nightly.id, name: nightly.name ?? definitionName };
  }

  throw new Error(
    `Build definition "${definitionName}" was not found in project "${project}". ` +
      `Checked ${definitions.length} name-filtered and ${allDefinitions.length} total definitions.`,
  );
}

interface ZipEntry {
  fileName: string;
  compression: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZipEntries(zip: Buffer): ZipEntry[] {
  // Parse central directory (handles ADO zips that use data descriptors in local headers)
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return [];

  const centralDirOffset = zip.readUInt32LE(eocdOffset + 16);
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount && offset + 46 <= zip.length; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const fileNameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const fileName = zip.toString('utf8', offset + 46, offset + 46 + fileNameLen).replace(/\\/g, '/');
    entries.push({ fileName, compression, compressedSize, localHeaderOffset });
    offset = offset + 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

async function readZipEntryData(zip: Buffer, entry: ZipEntry): Promise<Buffer | null> {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) return null;

  const fileNameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + fileNameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zip.length) return null;

  const compressed = zip.subarray(dataStart, dataEnd);
  if (entry.compression === 0) return compressed;
  if (entry.compression === 8) return inflateRawAsync(compressed);
  return null;
}

async function extractJsonFromZip(zip: Buffer, summaryFileName: string): Promise<string | null> {
  const targetName = summaryFileName.replace(/\\/g, '/');
  const targetBase = targetName.split('/').pop()?.toLowerCase() ?? targetName.toLowerCase();

  for (const entry of readZipEntries(zip)) {
    const fileBase = entry.fileName.split('/').pop()?.toLowerCase() ?? entry.fileName.toLowerCase();
    const nameMatches =
      entry.fileName === targetName ||
      entry.fileName.endsWith(`/${targetBase}`) ||
      fileBase === targetBase;
    if (!nameMatches) continue;

    const raw = await readZipEntryData(zip, entry);
    if (!raw) {
      throw new Error(`Unsupported ZIP compression method ${entry.compression} for ${entry.fileName}`);
    }
    return raw.toString('utf8');
  }

  return null;
}

async function extractSummaryJson(zip: Buffer): Promise<string | null> {
  for (const summaryPath of ESLINT_SUMMARY_PATHS) {
    const jsonText = await extractJsonFromZip(zip, summaryPath);
    if (jsonText) return jsonText;
  }

  return extractJsonFromZip(zip, 'eslint-summary.json');
}

function getAdoPat(): string {
  const pat = process.env.ADO_PAT?.trim();
  if (!pat) throw new Error('ADO_PAT must be configured to load ESLint burn-down data');
  return pat;
}

function getAdoConnection(): azdev.WebApi {
  const orgUrl = process.env.ADO_ORG?.trim();
  const pat = getAdoPat();
  if (!orgUrl) {
    throw new Error('ADO_ORG must be configured to load ESLint burn-down data');
  }
  return new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(pat), { socketTimeout: 120000 });
}

interface ArtifactResource {
  type?: string;
  downloadUrl?: string;
  url?: string;
}

/** Download artifact bytes — PipelineArtifact needs resource.downloadUrl, not getArtifactContentZip alone. */
async function downloadArtifactZip(
  buildApi: Awaited<ReturnType<azdev.WebApi['getBuildApi']>>,
  project: string,
  buildId: number,
  artifactName: string,
): Promise<Buffer | null> {
  const auth = `Basic ${Buffer.from(`:${getAdoPat()}`).toString('base64')}`;

  try {
    const meta = (await buildApi.getArtifact(project, buildId, artifactName)) as {
      resource?: ArtifactResource;
    };
    const resource = meta?.resource;
    const downloadUrl = resource?.downloadUrl ?? resource?.url;
    if (downloadUrl) {
      const zipUrl =
        downloadUrl.includes('$format=zip') || downloadUrl.includes('%24format=zip')
          ? downloadUrl
          : `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}$format=zip`;
      const res = await fetch(zipUrl, {
        headers: { Authorization: auth, Accept: 'application/zip' },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 500) return buf;
      }
    }
  } catch {
    // This build has no artifact with that name — normal for most nightly runs.
  }

  try {
    const zipStream = await buildApi.getArtifactContentZip(project, buildId, artifactName);
    const buf = await streamToBuffer(zipStream);
    if (buf.length > 500) return buf;
  } catch {
    // Fall through
  }

  return null;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseSummaryArtifact(raw: string, buildId: number, buildNumber: string): EslintSummaryArtifact {
  const parsed = JSON.parse(raw) as EslintSummaryArtifact;
  if (!parsed?.eslint || !parsed?.generatedAt) {
    throw new Error(`Invalid eslint-summary.json from build ${buildNumber}`);
  }

  return {
    ...parsed,
    build: {
      ...parsed.build,
      id: parsed.build?.id ?? String(buildId),
      buildNumber: parsed.build?.buildNumber ?? buildNumber,
    },
  };
}

function toSnapshot(artifact: EslintSummaryArtifact): EslintBuildSnapshot {
  const totalErrors = artifact.eslint.totalErrors ?? 0;
  const totalWarnings = artifact.eslint.totalWarnings ?? 0;
  return {
    capturedAt: artifact.generatedAt,
    buildId: artifact.build.id,
    buildNumber: artifact.build.buildNumber,
    definitionName: artifact.build.definitionName,
    totalFiles: artifact.eslint.totalFiles ?? 0,
    filesWithProblems: artifact.eslint.filesWithProblems ?? 0,
    totalErrors,
    totalWarnings,
    issueCount: totalErrors + totalWarnings,
    fixableCount: (artifact.eslint.totalFixableErrors ?? 0) + (artifact.eslint.totalFixableWarnings ?? 0),
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function getMaxViewEslintBurnDown(from: string, to: string): Promise<EslintBurnDownResponse> {
  const minTime = new Date(`${from}T00:00:00.000Z`);
  const maxTime = new Date(`${to}T23:59:59.999Z`);

  if (Number.isNaN(minTime.getTime()) || Number.isNaN(maxTime.getTime())) {
    throw new Error('Invalid from/to date range for ESLint burn-down');
  }
  if (minTime > maxTime) {
    throw new Error('The from date must be before the to date');
  }

  const connection = getAdoConnection();
  const buildApi = await connection.getBuildApi();
  const definition = await resolveBuildDefinition(buildApi, ESLINT_BUILD_PROJECT, ESLINT_BUILD_DEFINITION);

  // List finished pipeline runs in the date window. We do NOT filter by build result
  // (succeeded/failed/partial) — only whether eslint-burn-down/eslint-summary.json exists.
  const buildsPage = await buildApi.getBuilds(
    ESLINT_BUILD_PROJECT,
    [definition.id],
    undefined,
    undefined,
    minTime,
    maxTime,
    undefined,
    undefined,
    BuildStatus.Completed,
    undefined,
    undefined,
    undefined,
    BUILD_FETCH_TOP,
    undefined,
    undefined,
    undefined,
    BuildQueryOrder.FinishTimeAscending,
  );

  const builds = normalizePagedList<{ id?: number; buildNumber?: string; finishTime?: Date; result?: number }>(buildsPage);

  let hint: string | undefined;
  if (builds.length === 0) {
    const latestPage = await buildApi.getBuilds(
      ESLINT_BUILD_PROJECT,
      [definition.id],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      BuildStatus.Completed,
      undefined,
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      undefined,
      BuildQueryOrder.FinishTimeDescending,
    );
    const latest = normalizePagedList<{ id?: number; buildNumber?: string; finishTime?: Date }>(latestPage)[0];
    if (latest?.finishTime) {
      const latestDay = new Date(latest.finishTime).toISOString().slice(0, 10);
      hint =
        `No completed builds in ${from}–${to}. Latest run for this pipeline finished ${latestDay} ` +
        `(build ${latest.buildNumber ?? latest.id}). Widen the Time Frame filter.`;
    } else {
      hint =
        `No completed builds found for "${definition.name}" in ${ESLINT_BUILD_PROJECT}. ` +
        'Confirm the pipeline has run and the PAT has Build (Read) scope.';
    }
  }
  const snapshots = (
    await mapWithConcurrency(builds, ARTIFACT_CONCURRENCY, async build => {
      if (!build.id) return null;
      try {
        const buildLabel = String(build.buildNumber ?? build.id);
        const zipBuffer = await downloadArtifactZip(buildApi, ESLINT_BUILD_PROJECT, build.id, ESLINT_ARTIFACT_NAME);
        if (!zipBuffer) return null;
        const jsonText = await extractSummaryJson(zipBuffer);
        if (!jsonText) {
          return null;
        }
        const artifact = parseSummaryArtifact(jsonText, build.id, buildLabel);
        return toSnapshot(artifact);
      } catch {
        return null;
      }
    })
  )
    .filter((snapshot): snapshot is EslintBuildSnapshot => snapshot !== null)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  const startingIssueCount = snapshots[0]?.issueCount ?? null;
  const endingIssueCount = snapshots[snapshots.length - 1]?.issueCount ?? null;
  const issueReduction =
    startingIssueCount !== null && endingIssueCount !== null ? startingIssueCount - endingIssueCount : null;
  const reductionPercent =
    issueReduction !== null && startingIssueCount !== null && startingIssueCount > 0
      ? Math.round((issueReduction / startingIssueCount) * 1000) / 10
      : null;

  if (builds.length > 0 && snapshots.length === 0) {
    hint =
      `Checked ${builds.length} finished pipeline run(s) in this range; none had a readable ` +
      `"${ESLINT_ARTIFACT_NAME}" artifact with eslint-summary.json. Pipeline pass/fail is ignored — only the published file counts.`;
  }

  return {
    from,
    to,
    definitionName: definition.name,
    artifactName: ESLINT_ARTIFACT_NAME,
    snapshots,
    latest: snapshots[snapshots.length - 1] ?? null,
    summary: {
      definitionId: definition.id,
      buildsScanned: builds.length,
      buildsWithArtifact: snapshots.length,
      startingIssueCount,
      endingIssueCount,
      issueReduction,
      reductionPercent,
      hint,
    },
  };
}
