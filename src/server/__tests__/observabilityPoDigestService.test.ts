import {
  buildObservabilityPoTelemetryInput,
  generateObservabilityPoDigest,
  getObservabilityPoDigest,
  isObservabilityTrendWindow,
  loadObservabilityPoSkillMarkdown,
  observabilityPoDigestScheduler,
  resetObservabilityPoDigestForTests,
  setObservabilityPoDigestRunStoreForTests,
  setObservabilityPoSkillMarkdownForTests,
  setObservabilityPoTelemetrySourceForTests,
} from '../services/observabilityPoDigestService';
import {
  buildObservabilityPoDigestSpecification,
  type ObservabilityPoDigestRunRecord,
  type ObservabilityPoDigestRunRequest,
  type ObservabilityPoDigestRunStore,
} from '../services/observabilityPoDigestRuns';
import {
  mergeSynthesisSuggestions,
  parseSkillSectionsFromMarkdown,
} from '../../shared/utils/observabilityPoDigest';
import { isAiRunV2DocumentSpecification } from '../../shared/types/aiRunV2DocumentSpec';
import {
  OBSERVABILITY_PO_SKILL_PATH,
  OBSERVABILITY_TREND_WINDOWS,
  type ObservabilityPoSkillSynthesis,
} from '../../shared/types/observability';

/** In-memory stand-in for the run table; `complete` mirrors what the document harvest stores. */
function createFakeRunStore() {
  const runs: ObservabilityPoDigestRunRecord[] = [];
  const requests: ObservabilityPoDigestRunRequest[] = [];
  const store: ObservabilityPoDigestRunStore = {
    async start(request) {
      requests.push(request);
      const runId = `run-${requests.length}`;
      runs.unshift({
        runId,
        project: request.project,
        window: request.window,
        slot: request.slot,
        model: request.model,
        effort: request.effort,
        status: 'running',
        previousSuggestions: request.previousSuggestions,
        synthesis: null,
        failureDetail: null,
        requestedAt: new Date().toISOString(),
        completedAt: null,
      });
      return { status: 'admitted', runId };
    },
    async latestRun(project, window) {
      return runs.find((run) => run.project === project && run.window === window) ?? null;
    },
    async latestCompleted(project, window) {
      return runs.find(
        (run) => run.project === project && run.window === window && run.status === 'completed',
      ) ?? null;
    },
  };
  function complete(runId: string, synthesis: ObservabilityPoSkillSynthesis, now: Date): void {
    const run = runs.find((candidate) => candidate.runId === runId);
    if (!run) throw new Error(`no run ${runId}`);
    run.synthesis = mergeSynthesisSuggestions({
      synthesis,
      previous: run.previousSuggestions,
      now,
    }).synthesis;
    run.status = 'completed';
    run.completedAt = now.toISOString();
  }
  return { store, requests, complete };
}

describe('observabilityPoDigestService & scheduler', () => {
  beforeEach(() => {
    resetObservabilityPoDigestForTests();
    observabilityPoDigestScheduler.stop();
  });

  afterEach(() => {
    resetObservabilityPoDigestForTests();
    observabilityPoDigestScheduler.stop();
  });

  it('validates all six requested trend windows', () => {
    expect(OBSERVABILITY_TREND_WINDOWS).toEqual(['today', '1d', '7d', '14d', '30d', '60d']);
    for (const w of OBSERVABILITY_TREND_WINDOWS) {
      expect(isObservabilityTrendWindow(w)).toBe(true);
    }
    expect(isObservabilityTrendWindow('90d')).toBe(false);
    expect(isObservabilityTrendWindow('')).toBe(false);
  });

  it('loads the real .cursor/skills/observability-po-digest/SKILL.md file and builds the skill prompt', () => {
    const markdown = loadObservabilityPoSkillMarkdown();
    expect(markdown).toContain('Observability Product Owner Digest');
    expect(markdown).toContain('topUsers');
    expect(markdown).toContain('commonExceptions');
    expect(markdown).toContain('moduleRetentionDrops');
    expect(markdown).toContain('dropReasonsSummary');
    expect(markdown).toContain('topModules');
    expect(markdown).toContain('adoptionRecommendations');
  });

  it('computes all 6 signals from real database rows without masking even a single trace_event row', async () => {
    const now = new Date('2026-11-12T12:00:00.000Z');
    setObservabilityPoTelemetrySourceForTests({
      async loadTelemetry() {
        return {
          fromLiveDatabase: true,
          users: [
            {
              oid: 'real-user-1',
              displayName: 'Linus Torvalds',
              email: 'linus@kernel.org',
              role: 'Principal Engineer',
            },
            {
              oid: 'real-user-2',
              displayName: 'Barbara Liskov',
              email: 'barbara@mit.edu',
              role: 'Chief Scientist',
            },
          ],
          events: [
            // Current 7d window: Linus is active on UI Lab and triggers an error
            {
              id: 'db-evt-1',
              eventType: 'ui_action',
              occurredAt: new Date(now.getTime() - 2 * 3600 * 1000).toISOString(),
              actorUserId: 'real-user-1',
              projectId: 'Apex',
              sessionId: 'sess-linus-1',
              routeTemplate: '/ui-lab',
              httpMethod: 'GET',
              statusCode: 200,
              durationMs: 85,
              severity: 'info',
              message: null,
            },
            {
              id: 'db-evt-2',
              eventType: 'error',
              occurredAt: new Date(now.getTime() - 1 * 3600 * 1000).toISOString(),
              actorUserId: 'real-user-1',
              projectId: 'Apex',
              sessionId: 'sess-linus-1',
              routeTemplate: '/ui-lab',
              httpMethod: 'POST',
              statusCode: 502,
              durationMs: 940,
              severity: 'error',
              message: 'UiLabCanvasRenderError: failed to serialize Figma frame',
            },
            // Prior 7d baseline window (10 days ago): both Linus and Barbara were active on UI Lab
            {
              id: 'db-evt-3',
              eventType: 'ui_action',
              occurredAt: new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString(),
              actorUserId: 'real-user-1',
              projectId: 'Apex',
              sessionId: 'sess-linus-0',
              routeTemplate: '/ui-lab',
              httpMethod: 'GET',
              statusCode: 200,
              durationMs: 70,
              severity: 'info',
              message: null,
            },
            {
              id: 'db-evt-4',
              eventType: 'ui_action',
              occurredAt: new Date(now.getTime() - 11 * 24 * 3600 * 1000).toISOString(),
              actorUserId: 'real-user-2',
              projectId: 'Apex',
              sessionId: 'sess-barbara-0',
              routeTemplate: '/ui-lab',
              httpMethod: 'GET',
              statusCode: 200,
              durationMs: 65,
              severity: 'info',
              message: null,
            },
          ],
          rollups: [],
        };
      },
    });

    const res = await getObservabilityPoDigest({
      project: 'Apex',
      window: '7d',
      model: 'composer-2.5',
      effort: 'high',
      now,
    });

    expect(res.digest.project).toBe('Apex');
    expect(res.digest.window).toBe('7d');
    expect(res.digest.model).toBe('composer-2.5');
    expect(res.digest.effort).toBe('high');
    expect(res.digest.skillPath).toBe(OBSERVABILITY_PO_SKILL_PATH);

    // 1. Top users reflects Linus Torvalds from the DB rows, not fake seeds
    expect(res.digest.topUsers[0]).toMatchObject({
      userId: 'real-user-1',
      displayName: 'Linus Torvalds',
      role: 'Principal Engineer',
      interactions: 2,
      sessions: 1,
      topModule: 'UI Lab',
    });
    expect(res.digest.topUsers.map((u) => u.displayName)).not.toContain('Ada Lovelace');

    // 2. Most common exceptions reflects the real DB exception signature
    expect(res.digest.commonExceptions).toHaveLength(1);
    expect(res.digest.commonExceptions[0]).toMatchObject({
      signature: 'UiLabCanvasRenderError: failed to serialize Figma frame',
      module: 'UI Lab',
      statusCode: 502,
      count: 1,
      affectedUsers: 1,
    });

    // 3. Retention dropped per module: 2 users in prior 7d window -> 1 returned in current 7d window = 50% retention (50% drop)
    expect(res.digest.moduleRetentionDrops[0]).toMatchObject({
      module: 'UI Lab',
      previousRetentionPct: 100,
      currentRetentionPct: 50,
      dropPct: 50,
      returningUsers: 1,
      lostUsers: 1,
    });

    // 4 & 6. AI summaries cite the real DB exception and module
    expect(res.digest.dropReasonsSummary.findings[0]?.title).toContain(
      'UiLabCanvasRenderError',
    );
    expect(res.digest.adoptionRecommendations.recommendations[0]?.module).toBe('UI Lab');
  });

  it('admits a V2 document run with the skill, model, effort, and telemetry, then shows the harvested synthesis', async () => {
    const fake = createFakeRunStore();
    setObservabilityPoDigestRunStoreForTests(fake.store);

    const generated = await generateObservabilityPoDigest({
      project: 'Apex',
      window: '30d',
      model: 'composer-2.5',
      effort: 'high',
      slot: 'on_demand',
    });

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request).toMatchObject({
      project: 'Apex',
      window: '30d',
      slot: 'on_demand',
      model: 'composer-2.5',
      effort: 'high',
    });
    expect(request.skillMarkdown).toContain('Observability Product Owner Digest');
    expect(request.telemetryInput).toContain('Aggregated Telemetry Signals from PostgreSQL');
    expect(request.telemetryInput).not.toContain('# Observability Product Owner Digest');

    const specification = buildObservabilityPoDigestSpecification(request);
    expect(isAiRunV2DocumentSpecification(specification)).toBe(true);
    expect(specification).toMatchObject({
      workflowClass: 'observability-po-digest',
      threadId: 'observability-po-digest:Apex:30d',
      skillPath: OBSERVABILITY_PO_SKILL_PATH,
      model: 'composer-2.5',
      effort: 'high',
    });

    // The worker has not finished: the page shows the telemetry-only synthesis.
    expect(generated.synthesisRun).toMatchObject({ runId: 'run-1', status: 'running' });
    expect(generated.digest.headline).not.toBe('Custom AI Headline from Composer 2.5 Skill Execution');
    expect(generated.schedule.configuredModel).toBe('composer-2.5');
    expect(generated.schedule.configuredEffort).toBe('high');

    fake.complete('run-1', {
      headline: 'Custom AI Headline from Composer 2.5 Skill Execution',
      dropReasonsSummary: {
        headline: 'Skill-synthesized drop root cause',
        narrative: 'Detailed skill narrative from live telemetry',
        findings: [
          {
            id: 'f-1',
            module: 'Design Prototypes',
            title: 'Timeout spike on prototype stream',
            detail: 'Observed 504 timeouts',
            evidence: 'trace_events status_code=504',
            confidence: 'high' as const,
          },
        ],
      },
      adoptionRecommendations: {
        headline: 'Skill-synthesized adoption plan',
        narrative: 'Strategic adoption narrative',
        recommendations: [
          {
            id: 'r-1',
            module: 'Design Prototypes',
            title: 'Stream section checkpoints',
            action: 'Add progressive rendering',
            expectedLift: '+18% completion',
            impact: 'high' as const,
          },
        ],
      },
    }, new Date());

    const afterHarvest = await getObservabilityPoDigest({ project: 'Apex', window: '30d' });
    expect(afterHarvest.synthesisRun).toMatchObject({ runId: 'run-1', status: 'completed' });
    expect(afterHarvest.digest.headline).toBe(
      'Custom AI Headline from Composer 2.5 Skill Execution',
    );
    expect(afterHarvest.digest.dropReasonsSummary.headline).toBe(
      'Skill-synthesized drop root cause',
    );
    expect(afterHarvest.digest.adoptionRecommendations.headline).toBe(
      'Skill-synthesized adoption plan',
    );
    expect(afterHarvest.digest.model).toBe('composer-2.5');
    expect(afterHarvest.digest.effort).toBe('high');
  });

  it('starts no run and calls no model when the page only reads the digest', async () => {
    const fake = createFakeRunStore();
    setObservabilityPoDigestRunStoreForTests(fake.store);

    const res = await getObservabilityPoDigest({ project: 'Apex', window: '7d' });

    expect(fake.requests).toHaveLength(0);
    expect(res.synthesisRun).toBeNull();
  });

  it('runs scheduled digests at 06:00 UTC (6 AM) and 18:00 UTC (6 PM)', async () => {
    const morningTime = new Date('2026-11-12T06:05:00.000Z');
    await observabilityPoDigestScheduler.tick(morningTime);

    const afterMorning = await getObservabilityPoDigest({
      project: 'Apex',
      window: '7d',
      now: morningTime,
    });
    expect(afterMorning.schedule.morningSlot.lastRunAt).toBe(morningTime.toISOString());

    const eveningTime = new Date('2026-11-12T18:10:00.000Z');
    await observabilityPoDigestScheduler.tick(eveningTime);

    const afterEvening = await getObservabilityPoDigest({
      project: 'Apex',
      window: '7d',
      now: eveningTime,
    });
    expect(afterEvening.schedule.eveningSlot.lastRunAt).toBe(eveningTime.toISOString());
    expect(typeof buildObservabilityPoTelemetryInput).toBe('function');
  });

  it('dynamically parses and synthesizes 8th and 9th sections added to SKILL.md without code changes', async () => {
    const baseMarkdown = loadObservabilityPoSkillMarkdown();
    const extendedSkillMarkdown = [
      baseMarkdown,
      '',
      '8. **Cross-module journey drop-offs** (`journeyDropoffs`)',
      '   - Rank route transitions with the highest session abandonment rate in a ranked leaderboard.',
      '',
      '### 9. API Latency & Slow Routes (`apiLatencyTable`)',
      '- Present a table of slowest API routes and their p95 latency impact on user retention.',
    ].join('\n');

    const parsed = parseSkillSectionsFromMarkdown(extendedSkillMarkdown);
    expect(parsed.customSignals).toHaveLength(3);
    expect(parsed.customSignals[0]).toMatchObject({
      id: 'suggestiontracker',
      number: 7,
      isCoreSignal: false,
    });
    expect(parsed.customSignals[1]).toMatchObject({
      id: 'journeydropoffs',
      number: 8,
      title: 'Cross-module journey drop-offs',
      isCoreSignal: false,
    });
    expect(parsed.customSignals[2]).toMatchObject({
      id: 'apilatencytable',
      number: 9,
      title: 'API Latency & Slow Routes',
      isCoreSignal: false,
    });

    setObservabilityPoSkillMarkdownForTests(extendedSkillMarkdown);

    const res = await getObservabilityPoDigest({
      project: 'Apex',
      window: '14d',
      model: 'composer-2.5',
      effort: 'high',
    });

    expect(res.digest.customSections).toHaveLength(3);
    expect(res.digest.customSections?.[1]).toMatchObject({
      id: 'journeydropoffs',
      number: 8,
      title: 'Cross-module journey drop-offs',
      displayType: 'ranked_list',
    });
    expect(res.digest.customSections?.[1]?.items?.length).toBeGreaterThan(0);

    expect(res.digest.customSections?.[2]).toMatchObject({
      id: 'apilatencytable',
      number: 9,
      title: 'API Latency & Slow Routes',
      displayType: 'table',
    });
    expect(res.digest.customSections?.[2]?.items?.length).toBeGreaterThan(0);
  });

  it('builds the suggestion tracker from telemetry when the AI skill is unavailable', async () => {
    const res = await getObservabilityPoDigest({ project: 'Apex', window: '7d' });

    const tracker = res.digest.customSections?.find((sec) => sec.id === 'suggestiontracker');
    expect(tracker).toMatchObject({
      number: 7,
      title: 'Product innovation & suggestion tracker',
      displayType: 'tracker',
    });
    const categories = new Set(tracker?.items?.map((item) => item.category));
    expect(categories).toEqual(new Set(['enhance', 'consolidate', 'new_module']));
    for (const item of tracker?.items ?? []) {
      expect(item).toMatchObject({ stage: 'proposed', progressPct: 10, badge: 'Proposed' });
      expect(item.firstSuggestedAt).toEqual(expect.any(String));
    }
  });

  it('carries suggestion ids, stages, and first-suggested dates forward between digests', async () => {
    const firstRun = new Date('2026-11-10T06:00:00.000Z');
    const secondRun = new Date('2026-11-12T06:00:00.000Z');
    const fake = createFakeRunStore();
    setObservabilityPoDigestRunStoreForTests(fake.store);

    await generateObservabilityPoDigest({ project: 'Apex', window: '7d' }, firstRun);
    fake.complete('run-1', {
        customSections: [
          {
            id: 'suggestionTracker',
            title: 'Product innovation & suggestion tracker',
            items: [
              {
                id: 'credentialing-orchestrator',
                title: 'Credentialing & onboarding orchestrator',
                category: 'new_module',
                stage: 'proposed',
              },
              {
                id: 'merge-cost-views',
                title: 'Merge Cloud Cost into AI Cost Analytics',
                module: 'Cloud Cost',
                category: 'consolidate',
                stage: 'proposed',
              },
            ],
          },
        ],
      }, firstRun);

    await generateObservabilityPoDigest({ project: 'Apex', window: '7d' }, secondRun);
    const secondInput = fake.requests[1]?.telemetryInput ?? '';
    expect(secondInput).toContain('Previously Tracked Suggestions');
    expect(secondInput).toContain('credentialing-orchestrator');

    fake.complete('run-2', {
        customSections: [
          {
            id: 'suggestionTracker',
            title: 'Product innovation & suggestion tracker',
            items: [
              {
                id: 'credentialing-orchestrator',
                title: 'Credentialing & onboarding orchestrator',
                category: 'new_module',
                stage: 'in_progress',
                meta: 'New /credentialing routes appeared in telemetry',
              },
            ],
          },
        ],
      }, secondRun);

    const second = await getObservabilityPoDigest({ project: 'Apex', window: '7d', now: secondRun });

    const items =
      second.digest.customSections?.find((sec) => sec.id === 'suggestiontracker')?.items ?? [];
    expect(items.map((item) => item.id)).toEqual([
      'credentialing-orchestrator',
      'merge-cost-views',
    ]);
    expect(items[0]).toMatchObject({
      stage: 'in_progress',
      progressPct: 55,
      badge: 'In progress',
      firstSuggestedAt: firstRun.toISOString(),
      lastUpdatedAt: secondRun.toISOString(),
    });
    expect(items[1]).toMatchObject({
      stage: 'proposed',
      firstSuggestedAt: firstRun.toISOString(),
    });
  });
});
