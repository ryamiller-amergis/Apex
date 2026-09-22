/**
 * Applies finished V2 document artifacts from Blob to their owning workflows.
 *
 * The orchestrator remains domain-neutral: it finalizes the attempt and stores
 * the manifest reference. This App Service recovery consumer owns the durable
 * claim, verifies the immutable files, and invokes the same domain completion
 * paths used by V1.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BackgroundWorkflowClass } from '../../shared/types/backgroundWorkflow';
import type { AiRunV2ArtifactManifest } from '../../shared/types/aiRunV2';
import { WalkthroughAnchorSmartTaggingError } from '../../shared/types/walkthroughAnchorSmartTagging';
import {
  ArtifactVerificationError,
  createArtifactReader,
  type ArtifactReader,
} from './aiRunV2/artifactReader';
import {
  createFinishedAttemptReader,
  type FinishedAttemptReader,
  type FinishedV2DocumentAttempt,
} from './aiRunV2/finishedAttemptReader';

const HARVEST_BATCH_SIZE = 100;

export type DocumentWorkspaceApplyInput = Readonly<{
  attempt: FinishedV2DocumentAttempt;
  workspacePath: string;
  failureDetail?: string;
}>;

export type DocumentV2HarvestDependencies = Readonly<{
  finishedAttempts?: FinishedAttemptReader;
  artifacts?: ArtifactReader;
  applyWorkspace?: (input: DocumentWorkspaceApplyInput) => Promise<void>;
  applySmartTagging?: (input: {
    threadId: string;
    runId: string;
    rawJson: string;
  }) => Promise<boolean>;
  batchSize?: number;
  tempRoot?: string;
}>;

function isExpectedArtifactPath(
  workflowClass: BackgroundWorkflowClass,
  artifactPath: string,
): boolean {
  if (
    !artifactPath.startsWith('output/')
    || artifactPath.slice('output/'.length).includes('/')
    || artifactPath.includes('\\')
  ) {
    return false;
  }
  const name = artifactPath.slice('output/'.length);
  switch (workflowClass) {
    case 'prd':
      return (
        name === 'PRD.md'
        || /\.prd\.md$/i.test(name)
        || /\.backlog\.json$/i.test(name)
      );
    case 'design-doc':
      return (
        /[-.]design\.md$/i.test(name)
        || /[-.]tech-spec\.md$/i.test(name)
        || /[-.]assumptions\.md$/i.test(name)
      );
    case 'validation':
      return (
        name === 'review-scorecard.json'
        || name === 'review-scorecard.md'
      );
    case 'test-cases':
      return (
        /\.test-cases\.json$/i.test(name)
        || /\.test-cases\.md$/i.test(name)
        || /\.backlog\.json$/i.test(name)
      );
    case 'walkthrough-smart-tagging':
      return name === 'walkthrough-anchor-smart-tagging.json';
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unsupported document workflow: ${String(unhandled)}`);
    }
  }
}

async function defaultApplyWorkspace(
  input: DocumentWorkspaceApplyInput,
): Promise<void> {
  const { syncOutputToDb } = await import('./chatAgentService');
  await syncOutputToDb(
    input.attempt.threadId,
    input.workspacePath,
    input.failureDetail,
  );
}

async function defaultApplySmartTagging(input: {
  threadId: string;
  runId: string;
  rawJson: string;
}): Promise<boolean> {
  const { applyV2SmartTaggingResult } = await import(
    './walkthroughAnchorSmartTaggingService'
  );
  return applyV2SmartTaggingResult(input);
}

async function createHarvestWorkspace(tempRoot: string): Promise<string> {
  const workspacePath = await fs.mkdtemp(
    path.join(tempRoot, 'apex-document-harvest-'),
  );
  await fs.mkdir(path.join(workspacePath, '.ai-pilot', 'output'), {
    recursive: true,
  });
  return workspacePath;
}

function assertManifestIdentity(
  attempt: FinishedV2DocumentAttempt,
  manifest: AiRunV2ArtifactManifest,
): void {
  if (
    manifest.runId !== attempt.runId
    || manifest.attemptId !== attempt.attemptId
    || manifest.attemptNumber !== attempt.attemptNumber
  ) {
    throw new ArtifactVerificationError(
      'Artifact manifest identity does not match the finished attempt',
    );
  }
}

async function materializeManifest(
  attempt: FinishedV2DocumentAttempt,
  manifest: AiRunV2ArtifactManifest,
  artifacts: ArtifactReader,
  workspacePath: string,
): Promise<void> {
  assertManifestIdentity(attempt, manifest);
  for (const entry of manifest.files) {
    if (!isExpectedArtifactPath(attempt.workflowClass, entry.path)) {
      throw new ArtifactVerificationError(
        `Artifact manifest contains unexpected document output ${entry.path}`,
      );
    }
    const target = path.resolve(
      workspacePath,
      '.ai-pilot',
      ...entry.path.split('/'),
    );
    const relative = path.relative(workspacePath, target);
    if (
      relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new ArtifactVerificationError(
        `Artifact path escapes the harvest workspace: ${entry.path}`,
      );
    }
    const body = await artifacts.readFile(entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { flag: 'wx', mode: 0o600 });
  }
}

async function clearHarvestOutput(workspacePath: string): Promise<void> {
  const output = path.join(workspacePath, '.ai-pilot', 'output');
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
}

async function applyAttempt(
  attempt: FinishedV2DocumentAttempt,
  workspacePath: string,
  applyWorkspace: (input: DocumentWorkspaceApplyInput) => Promise<void>,
  applySmartTagging: NonNullable<
    DocumentV2HarvestDependencies['applySmartTagging']
  >,
  failureDetail?: string,
): Promise<void> {
  switch (attempt.workflowClass) {
    case 'prd':
    case 'design-doc':
    case 'validation':
    case 'test-cases':
      await applyWorkspace({
        attempt,
        workspacePath,
        ...(failureDetail ? { failureDetail } : {}),
      });
      return;
    case 'walkthrough-smart-tagging':
      if (failureDetail) return;
      await applySmartTagging({
        threadId: attempt.threadId,
        runId: attempt.runId,
        rawJson: await fs.readFile(
          path.join(
            workspacePath,
            '.ai-pilot',
            'output',
            'walkthrough-anchor-smart-tagging.json',
          ),
          'utf8',
        ),
      });
      return;
    default: {
      const unhandled: never = attempt.workflowClass;
      throw new Error(`Unsupported document workflow: ${String(unhandled)}`);
    }
  }
}

function terminalFailureDetail(attempt: FinishedV2DocumentAttempt): string {
  const detail = attempt.failureDetail?.trim();
  if (attempt.status === 'cancelled') {
    return detail
      ? `Document generation was cancelled: ${detail}`
      : 'Document generation was cancelled.';
  }
  return detail || 'Document generation failed on the durable transport.';
}

/**
 * Apply a bounded batch. Claims remain unprocessed after transient Blob or
 * domain errors, so the next lease-owned recovery sweep retries them.
 */
export async function harvestFinishedV2Documents(
  dependencies: DocumentV2HarvestDependencies = {},
): Promise<number> {
  const finishedAttempts =
    dependencies.finishedAttempts ?? createFinishedAttemptReader();
  const artifacts = dependencies.artifacts ?? createArtifactReader();
  const applyWorkspace =
    dependencies.applyWorkspace ?? defaultApplyWorkspace;
  const applySmartTagging =
    dependencies.applySmartTagging ?? defaultApplySmartTagging;
  const tempRoot = dependencies.tempRoot ?? os.tmpdir();
  const attempts = await finishedAttempts.listFinishedDocuments(
    dependencies.batchSize ?? HARVEST_BATCH_SIZE,
  );

  let harvested = 0;
  for (const attempt of attempts) {
    if (
      (await finishedAttempts.claimHarvest(attempt))
      === 'already_harvested'
    ) {
      continue;
    }

    const workspacePath = await createHarvestWorkspace(tempRoot);
    try {
      if (attempt.status !== 'completed') {
        await applyAttempt(
          attempt,
          workspacePath,
          applyWorkspace,
          applySmartTagging,
          terminalFailureDetail(attempt),
        );
      } else if (!attempt.manifestRef) {
        await applyAttempt(
          attempt,
          workspacePath,
          applyWorkspace,
          applySmartTagging,
          'Document generation finished without an artifact manifest.',
        );
      } else {
        try {
          const manifest = await artifacts.readManifest(attempt.manifestRef);
          await materializeManifest(
            attempt,
            manifest,
            artifacts,
            workspacePath,
          );
          await applyAttempt(
            attempt,
            workspacePath,
            applyWorkspace,
            applySmartTagging,
          );
        } catch (error) {
          if (
            !(error instanceof ArtifactVerificationError)
            && !(error instanceof WalkthroughAnchorSmartTaggingError)
          ) {
            throw error;
          }
          await clearHarvestOutput(workspacePath);
          await applyAttempt(
            attempt,
            workspacePath,
            applyWorkspace,
            applySmartTagging,
            `Generated document artifacts could not be verified: ${error.message}`,
          );
        }
      }

      await finishedAttempts.completeHarvest(attempt.attemptId);
      harvested += 1;
    } catch (error) {
      // The durable claim remains unprocessed; a later sweep retries it.
      console.error(
        `[documentV2Harvest] Could not apply run ${attempt.runId} `
          + `to ${attempt.workflowClass} thread ${attempt.threadId}:`,
        error,
      );
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  }
  return harvested;
}
