import type {
  ArtifactRef,
  BuildPreviewEvidenceStatus,
} from '../../../shared/types/build';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const JOURNEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;
const SAFE_DETAIL_LIMIT = 20;

export interface BrowserJourneyStep {
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  detail?: string;
}

export interface BrowserNetworkFailure {
  method: string;
  path: string;
  status?: number;
  failure?: string;
}

export interface BrowserA11yViolation {
  id: string;
  impact: string | null;
  nodeCount: number;
}

export interface BrowserJourneyResult {
  passed: boolean;
  screenshot: Buffer | null;
  steps: BrowserJourneyStep[];
  consoleErrors: string[];
  pageErrors: string[];
  networkFailures: BrowserNetworkFailure[];
  a11yViolations: BrowserA11yViolation[];
  failure?: string;
}

export interface BrowserJourneyRunner {
  run(input: {
    checkId: string;
    targetUrl: string;
  }): Promise<BrowserJourneyResult>;
}

export interface BrowserEvidenceStore {
  put(input: {
    checkId: string;
    name: 'screenshot.png' | 'browser-check.json';
    bytes: Buffer;
    contentType: 'image/png' | 'application/json';
  }): Promise<ArtifactRef>;
}

export interface BrowserCheckIdentity {
  buildPreviewInstanceId: string;
  commit: string;
  artifactDigest: string;
}

export interface BrowserCheckCompletion extends BrowserCheckIdentity {
  id: string;
  status: Exclude<BuildPreviewEvidenceStatus, 'pending'>;
  evidenceRefs: ArtifactRef[];
  consoleSummary: Record<string, unknown>;
  networkSummary: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export interface BrowserCheckRepository {
  createPending(
    input: BrowserCheckIdentity & { journeyVersion: string }
  ): Promise<{ id: string }>;
  complete(input: BrowserCheckCompletion): Promise<void>;
}

export interface BrowserVerificationRequest {
  revisionId: string;
  instanceId: string;
  commit: string;
  artifactDigest: string;
  targetUrl: string;
  journeyVersion: string;
}

export interface BrowserVerificationOutcome {
  checkId: string;
  status: Exclude<BuildPreviewEvidenceStatus, 'pending'>;
  evidenceRefs: ArtifactRef[];
}

export type BrowserTargetPolicy = (target: URL) => boolean;

export function createBuildPreviewBrowserVerifier(dependencies: {
  repository: BrowserCheckRepository;
  evidence: BrowserEvidenceStore;
  runner: BrowserJourneyRunner;
  now?: () => Date;
  targetPolicy?: BrowserTargetPolicy;
}) {
  const now = dependencies.now ?? (() => new Date());

  return {
    async verify(
      input: BrowserVerificationRequest
    ): Promise<BrowserVerificationOutcome> {
      validateRequest(input, dependencies.targetPolicy ?? isLocalDockerTarget);
      const identity: BrowserCheckIdentity = {
        buildPreviewInstanceId: input.instanceId,
        commit: input.commit,
        artifactDigest: input.artifactDigest,
      };
      const pending = await dependencies.repository.createPending({
        ...identity,
        journeyVersion: input.journeyVersion,
      });
      const startedAt = now().toISOString();
      const evidenceRefs: ArtifactRef[] = [];
      let journey: BrowserJourneyResult;
      let verifierError: string | undefined;

      try {
        journey = await dependencies.runner.run({
          checkId: pending.id,
          targetUrl: input.targetUrl,
        });
      } catch {
        verifierError = 'Browser verification could not complete.';
        journey = failedJourney(verifierError);
      }

      let status: 'passed' | 'failed' = journeyPassed(journey)
        ? 'passed'
        : 'failed';

      if (journey.screenshot) {
        try {
          evidenceRefs.push(
            await dependencies.evidence.put({
              checkId: pending.id,
              name: 'screenshot.png',
              bytes: journey.screenshot,
              contentType: 'image/png',
            })
          );
        } catch {
          status = 'failed';
          verifierError = 'Browser evidence could not be stored.';
        }
      }

      const evidenceDocument = {
        schemaVersion: 1,
        checkId: pending.id,
        revisionId: input.revisionId,
        instanceId: input.instanceId,
        commit: input.commit,
        artifactDigest: input.artifactDigest,
        journeyVersion: input.journeyVersion,
        status,
        steps: journey.steps.slice(0, SAFE_DETAIL_LIMIT).map((step) => ({
          name: safeEvidenceText(step.name, 100),
          status: step.status,
          durationMs: Math.max(0, Math.floor(step.durationMs)),
          ...(step.detail
            ? { detail: safeEvidenceText(step.detail, 500) }
            : {}),
        })),
        consoleErrors: bounded(journey.consoleErrors),
        pageErrors: bounded(journey.pageErrors),
        networkFailures: boundedNetworkFailures(journey.networkFailures),
        a11yViolations: journey.a11yViolations
          .slice(0, SAFE_DETAIL_LIMIT)
          .map((violation) => ({
            id: safeEvidenceText(violation.id, 100),
            impact: violation.impact
              ? safeEvidenceText(violation.impact, 50)
              : null,
            nodeCount: Math.max(0, Math.floor(violation.nodeCount)),
          })),
        failure: safeOptionalEvidenceText(verifierError ?? journey.failure),
      };

      try {
        evidenceRefs.push(
          await dependencies.evidence.put({
            checkId: pending.id,
            name: 'browser-check.json',
            bytes: Buffer.from(
              `${JSON.stringify(evidenceDocument, null, 2)}\n`,
              'utf8'
            ),
            contentType: 'application/json',
          })
        );
      } catch {
        status = 'failed';
        verifierError = 'Browser evidence could not be stored.';
      }

      const consoleSummary: Record<string, unknown> = {
        errorCount: journey.consoleErrors.length,
        pageErrorCount: journey.pageErrors.length,
        errors: bounded([...journey.consoleErrors, ...journey.pageErrors]),
      };
      if (verifierError) consoleSummary.verifierError = verifierError;

      await dependencies.repository.complete({
        id: pending.id,
        ...identity,
        status,
        evidenceRefs,
        consoleSummary,
        networkSummary: {
          failureCount: journey.networkFailures.length,
          failures: boundedNetworkFailures(journey.networkFailures),
        },
        startedAt,
        completedAt: now().toISOString(),
      });

      return {
        checkId: pending.id,
        status,
        evidenceRefs,
      };
    },
  };
}

function journeyPassed(result: BrowserJourneyResult): boolean {
  return (
    result.passed &&
    result.screenshot !== null &&
    result.consoleErrors.length === 0 &&
    result.pageErrors.length === 0 &&
    result.networkFailures.length === 0 &&
    result.a11yViolations.length === 0 &&
    result.steps.every((step) => step.status === 'passed')
  );
}

function failedJourney(failure: string): BrowserJourneyResult {
  return {
    passed: false,
    screenshot: null,
    steps: [],
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    a11yViolations: [],
    failure,
  };
}

function bounded(values: string[]): string[] {
  return values
    .slice(0, SAFE_DETAIL_LIMIT)
    .map((value) => safeEvidenceText(value, 500));
}

function boundedNetworkFailures(
  failures: BrowserNetworkFailure[]
): BrowserNetworkFailure[] {
  return failures.slice(0, SAFE_DETAIL_LIMIT).map((failure) => ({
    method: safeEvidenceText(failure.method, 16),
    path: safeEvidencePath(failure.path),
    ...(failure.status === undefined
      ? {}
      : { status: Math.max(0, Math.floor(failure.status)) }),
    ...(failure.failure
      ? { failure: safeEvidenceText(failure.failure, 500) }
      : {}),
  }));
}

function safeOptionalEvidenceText(
  value: string | undefined
): string | undefined {
  return value ? safeEvidenceText(value, 500) : undefined;
}

function safeEvidenceText(value: string, limit: number): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeEvidencePath(url))
    .replace(
      /\b(authorization|token|password|secret)\b\s*[:=]?\s*(?:bearer\s+)?[^,\s;]*/gi,
      '$1=[redacted]'
    )
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function safeEvidencePath(value: string): string {
  try {
    return new URL(value, 'https://evidence.invalid').pathname.slice(0, 300);
  } catch {
    return '/invalid-path';
  }
}

function validateRequest(
  input: BrowserVerificationRequest,
  targetPolicy: BrowserTargetPolicy
): void {
  if (!input.revisionId.trim() || !input.instanceId.trim()) {
    throw new Error('Browser verification requires revision and instance IDs.');
  }
  if (!COMMIT_PATTERN.test(input.commit)) {
    throw new Error('Browser verification commit is invalid.');
  }
  if (!DIGEST_PATTERN.test(input.artifactDigest)) {
    throw new Error('Browser verification artifact digest is invalid.');
  }
  if (!JOURNEY_PATTERN.test(input.journeyVersion)) {
    throw new Error('Browser verification journey version is invalid.');
  }

  let target: URL;
  try {
    target = new URL(input.targetUrl);
  } catch {
    throw new Error('Browser verification target URL is invalid.');
  }
  if (
    !targetPolicy(target) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.pathname !== '/' && target.pathname !== '')
  ) {
    throw new Error('Browser verification target URL is not allowed.');
  }
}

function isLocalDockerTarget(target: URL): boolean {
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
  return target.protocol === 'http:' && loopback.has(target.hostname);
}
