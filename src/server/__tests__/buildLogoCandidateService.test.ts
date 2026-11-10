import {
  isApprovedLogoImplementationRequest,
  isLogoReviewRequest,
} from '../../shared/buildLogoReview';
import {
  createBuildLogoCandidateService,
  type BuildLogoCandidateDeps,
  type LogoCandidateFileStore,
} from '../services/build/buildLogoCandidateService';
import type { LogoImageProvider } from '../services/build/logoImageProvider';

const actor = {
  userId: 'user-1',
  displayName: 'Ryan',
  isProjectAdmin: false,
  isSuperAdmin: false,
};

function memoryDeps(): {
  deps: BuildLogoCandidateDeps;
  revisionCalls: string[];
} {
  const batches = new Map<
    string,
    Awaited<ReturnType<BuildLogoCandidateDeps['readBatch']>>
  >();
  let sequence = 0;
  const files = new Map<string, Buffer>();
  const revisionCalls: string[] = [];
  const store: LogoCandidateFileStore = {
    async save(bytes) {
      const storageKey = `image-${files.size + 1}.png`;
      files.set(storageKey, bytes);
      return { digest: `sha256:${'a'.repeat(64)}`, storageKey };
    },
    async read(storageKey) {
      return files.get(storageKey) ?? null;
    },
  };
  const provider: LogoImageProvider = {
    id: 'cursor_svg',
    async generate(input) {
      return Array.from({ length: input.count }, () =>
        Buffer.from(`logo-${input.seed}`)
      );
    },
  };
  const deps: BuildLogoCandidateDeps = {
    loadRun: async () => ({
      id: 'build-1',
      project: 'Apex',
      status: 'preview_ready',
      requesterUserId: actor.userId,
      prompt: 'Build a personal task application called Focus.',
      modelOverride: 'composer-2.5',
    }),
    findRunningBatch: async (buildId) =>
      [...batches.values()].find(
        (batch) => batch?.buildRunId === buildId && batch.status === 'running'
      ) ?? null,
    latestBatch: async (buildId) =>
      [...batches.values()]
        .filter((batch) => batch?.buildRunId === buildId)
        .sort((left, right) =>
          right!.createdAt.localeCompare(left!.createdAt)
        )[0] ?? null,
    readBatch: async (batchId) => batches.get(batchId) ?? null,
    readCandidate: async (candidateId) => {
      for (const batch of batches.values()) {
        const candidate = batch?.candidates.find(
          (item) => item.id === candidateId
        );
        if (candidate) return candidate;
      }
      return null;
    },
    insertBatch: async (input) => {
      sequence += 1;
      const batch = {
        id: `batch-${sequence}`,
        buildRunId: input.buildRunId,
        prompt: input.prompt,
        status: 'running' as const,
        failureMessage: null,
        createdAt: `2026-11-09T18:0${sequence}:00.000Z`,
        candidates: [],
      };
      batches.set(batch.id, batch);
      return batch;
    },
    insertCandidate: async (input) => {
      const batch = batches.get(input.batchId);
      if (!batch) return;
      sequence += 1;
      batch.candidates.push({
        id: `candidate-${sequence}`,
        batchId: batch.id,
        buildRunId: input.buildRunId,
        status: 'pending',
        digest: input.digest,
        storageKey: input.storageKey,
        createdAt: `2026-11-09T18:1${sequence}:00.000Z`,
      });
    },
    updateBatch: async (batchId, patch) => {
      const batch = batches.get(batchId);
      if (!batch) return;
      batch.status = patch.status;
      batch.failureMessage = patch.failureMessage ?? null;
    },
    decideCandidate: async (input) => {
      for (const batch of batches.values()) {
        const candidate = batch?.candidates.find(
          (item) => item.id === input.candidateId
        );
        if (!candidate || candidate.status !== 'pending') continue;
        candidate.status = input.status;
        return true;
      }
      return false;
    },
    supersedePending: async (batchId, exceptCandidateId) => {
      const batch = batches.get(batchId);
      for (const candidate of batch?.candidates ?? []) {
        if (
          candidate.status === 'pending' &&
          candidate.id !== exceptCandidateId
        ) {
          candidate.status = 'superseded';
        }
      }
    },
    store,
    provider,
    now: () => '2026-11-09T18:00:00.000Z',
    awaitGeneration: true,
    candidateCount: 2,
  };
  return { deps, revisionCalls };
}

describe('build logo candidates', () => {
  it('recognizes a request to review a logo before implementation', () => {
    expect(
      isLogoReviewRequest(
        'create a custom logo for me that i can review first and then we can implement it if it looks good'
      )
    ).toBe(true);
    expect(isLogoReviewRequest('Move the Cancel button to the right.')).toBe(
      false
    );
    expect(
      isApprovedLogoImplementationRequest(
        'Place the approved logo from /brand/logo.png in the navigation.'
      )
    ).toBe(true);
  });

  it('stores generated options without creating a Build revision', async () => {
    const { deps, revisionCalls } = memoryDeps();
    const service = createBuildLogoCandidateService(deps);

    const review = await service.generate({
      buildId: 'build-1',
      project: 'Apex',
      prompt: 'review a logo first',
      actor,
    });

    expect(review.status).toBe('ready');
    expect(review.candidates).toHaveLength(2);
    expect(
      review.candidates.every((candidate) => candidate.status === 'pending')
    ).toBe(true);
    expect(revisionCalls).toEqual([]);
    expect(await service.review('build-1')).toMatchObject({
      batchId: review.batchId,
    });
  });

  it('approves one option and keeps the others from being selected', async () => {
    const { deps } = memoryDeps();
    const service = createBuildLogoCandidateService(deps);
    const review = await service.generate({
      buildId: 'build-1',
      project: 'Apex',
      prompt: 'review a logo first',
      actor,
    });

    const approved = await service.decide({
      buildId: 'build-1',
      project: 'Apex',
      candidateId: review.candidates[0].id,
      decision: 'approved',
      actor,
    });

    expect(approved.approvedCandidateId).toBe(review.candidates[0].id);
    expect(approved.candidates.map((candidate) => candidate.status)).toEqual([
      'approved',
      'superseded',
    ]);
    const image = await service.image({
      buildId: 'build-1',
      project: 'Apex',
      candidateId: review.candidates[0].id,
      actor,
    });
    expect(image.length).toBeGreaterThan(0);
  });
});
