import {
  buildObservabilityPoSkillPrompt,
  generateObservabilityPoDigest,
  getObservabilityPoDigest,
  isObservabilityTrendWindow,
  loadObservabilityPoSkillMarkdown,
  observabilityPoDigestScheduler,
  resetObservabilityPoDigestForTests,
  setObservabilityPoAiProviderForTests,
  setObservabilityPoSkillMarkdownForTests,
  setObservabilityPoTelemetrySourceForTests,
} from '../services/observabilityPoDigestService';
import { parseSkillSectionsFromMarkdown } from '../../shared/utils/observabilityPoDigest';
import {
  OBSERVABILITY_PO_SKILL_PATH,
  OBSERVABILITY_TREND_WINDOWS,
} from '../../shared/types/observability';

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

  it('invokes the skill AI provider with skill markdown, model, and effort when configured', async () => {
    const synthesizeDigest = jest.fn().mockResolvedValue({
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
    });

    setObservabilityPoAiProviderForTests({ synthesizeDigest });

    const generated = await generateObservabilityPoDigest({
      project: 'Apex',
      window: '30d',
      model: 'composer-2.5',
      effort: 'high',
      slot: 'on_demand',
    });

    expect(synthesizeDigest).toHaveBeenCalledTimes(1);
    expect(synthesizeDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'composer-2.5',
        effort: 'high',
        project: 'Apex',
        window: '30d',
        skillMarkdown: expect.stringContaining('Observability Product Owner Digest'),
        prompt: expect.stringContaining('Aggregated Telemetry Signals from PostgreSQL'),
      }),
    );

    expect(generated.digest.headline).toBe(
      'Custom AI Headline from Composer 2.5 Skill Execution',
    );
    expect(generated.digest.dropReasonsSummary.headline).toBe(
      'Skill-synthesized drop root cause',
    );
    expect(generated.digest.adoptionRecommendations.headline).toBe(
      'Skill-synthesized adoption plan',
    );
    expect(generated.schedule.configuredModel).toBe('composer-2.5');
    expect(generated.schedule.configuredEffort).toBe('high');
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
    expect(typeof buildObservabilityPoSkillPrompt).toBe('function');
  });

  it('dynamically parses and synthesizes 7th and 8th sections added to SKILL.md without code changes', async () => {
    const baseMarkdown = loadObservabilityPoSkillMarkdown();
    const extendedSkillMarkdown = [
      baseMarkdown,
      '',
      '7. **Cross-module journey drop-offs** (`journeyDropoffs`)',
      '   - Rank route transitions with the highest session abandonment rate in a ranked leaderboard.',
      '',
      '### 8. API Latency & Slow Routes (`apiLatencyTable`)',
      '- Present a table of slowest API routes and their p95 latency impact on user retention.',
    ].join('\n');

    const parsed = parseSkillSectionsFromMarkdown(extendedSkillMarkdown);
    expect(parsed.customSignals).toHaveLength(2);
    expect(parsed.customSignals[0]).toMatchObject({
      id: 'journeydropoffs',
      number: 7,
      title: 'Cross-module journey drop-offs',
      isCoreSignal: false,
    });
    expect(parsed.customSignals[1]).toMatchObject({
      id: 'apilatencytable',
      number: 8,
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

    expect(res.digest.customSections).toHaveLength(2);
    expect(res.digest.customSections?.[0]).toMatchObject({
      id: 'journeydropoffs',
      number: 7,
      title: 'Cross-module journey drop-offs',
      displayType: 'ranked_list',
    });
    expect(res.digest.customSections?.[0]?.items?.length).toBeGreaterThan(0);

    expect(res.digest.customSections?.[1]).toMatchObject({
      id: 'apilatencytable',
      number: 8,
      title: 'API Latency & Slow Routes',
      displayType: 'table',
    });
    expect(res.digest.customSections?.[1]?.items?.length).toBeGreaterThan(0);
  });
});
