import * as azdev from 'azure-devops-node-api';
import { BuildQueryOrder, BuildResult, BuildStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { inflateRaw } from 'zlib';
import { promisify } from 'util';
import type { EslintBurnDownResponse, EslintBuildSnapshot, EslintSummaryArtifact } from '../types/workitem';

const inflateRawAsync = promisify(inflateRaw);

/** MaxView nightly pipeline contract — stable org-wide, not per-environment. */
const ESLINT_BUILD_PROJECT = 'MaxView';
const ESLINT_BUILD_DEFINITION = 'mv-nightly-runs-workflow';
const ESLINT_ARTIFACT_NAME = 'eslint-burn-down';
const ESLINT_SUMMARY_FILE = 'eslint-summary.json';
const BUILD_FETCH_TOP = 200;
const ARTIFACT_CONCURRENCY = 5;

function getAdoConnection(): azdev.WebApi {
  const orgUrl = process.env.ADO_ORG?.trim();
  const pat = process.env.ADO_PAT?.trim();
  if (!orgUrl || !pat) {
    throw new Error('ADO_ORG and ADO_PAT must be configured to load ESLint burn-down data');
  }
  return new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(pat), { socketTimeout: 120000 });
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function extractJsonFromZip(zip: Buffer, summaryFileName: string): Promise<string | null> {
  const targetName = summaryFileName.replace(/\\/g, '/');
  const targetBase = targetName.split('/').pop() ?? targetName;
  let offset = 0;

  while (offset < zip.length - 30) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const compression = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const fileNameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const fileName = zip.toString('utf8', offset + 30, offset + 30 + fileNameLen).replace(/\\/g, '/');
    const dataStart = offset + 30 + fileNameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    if (fileName === targetName || fileName.endsWith(`/${targetBase}`) || fileName.endsWith(targetBase)) {
      const compressed = zip.subarray(dataStart, dataEnd);
      const raw =
        compression === 0
          ? compressed
          : compression === 8
            ? await inflateRawAsync(compressed)
            : null;
      if (!raw) {
        throw new Error(`Unsupported ZIP compression method ${compression} for ${fileName}`);
      }
      return raw.toString('utf8');
    }

    offset = dataEnd;
  }

  return null;
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
  const definitions = await buildApi.getDefinitions(ESLINT_BUILD_PROJECT, ESLINT_BUILD_DEFINITION);
  const definition = definitions.find(item => item.name === ESLINT_BUILD_DEFINITION) ?? definitions[0];
  if (!definition?.id) {
    throw new Error(`Build definition "${ESLINT_BUILD_DEFINITION}" was not found in project "${ESLINT_BUILD_PROJECT}"`);
  }

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
    BuildResult.Succeeded,
    undefined,
    undefined,
    BUILD_FETCH_TOP,
    undefined,
    undefined,
    undefined,
    BuildQueryOrder.FinishTimeAscending,
  );

  const builds = buildsPage ?? [];
  const snapshots = (
    await mapWithConcurrency(builds, ARTIFACT_CONCURRENCY, async build => {
      if (!build.id) return null;
      try {
        const zipStream = await buildApi.getArtifactContentZip(ESLINT_BUILD_PROJECT, build.id, ESLINT_ARTIFACT_NAME);
        const zipBuffer = await streamToBuffer(zipStream);
        const jsonText = await extractJsonFromZip(zipBuffer, ESLINT_SUMMARY_FILE);
        if (!jsonText) return null;
        const artifact = parseSummaryArtifact(jsonText, build.id, build.buildNumber ?? String(build.id));
        return toSnapshot(artifact);
      } catch (error) {
        console.warn(
          `[eslintBurnDown] Skipping build ${build.buildNumber ?? build.id}:`,
          error instanceof Error ? error.message : error,
        );
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

  return {
    from,
    to,
    definitionName: ESLINT_BUILD_DEFINITION,
    artifactName: ESLINT_ARTIFACT_NAME,
    snapshots,
    latest: snapshots[snapshots.length - 1] ?? null,
    summary: {
      buildsScanned: builds.length,
      buildsWithArtifact: snapshots.length,
      startingIssueCount,
      endingIssueCount,
      issueReduction,
      reductionPercent,
    },
  };
}
