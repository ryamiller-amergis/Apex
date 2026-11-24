import {
  formatBucketLabel,
  getAiExperienceMetrics,
  type AiExperienceDbExecutor,
} from '../services/aiExperienceMetricsService';

function createMockExecutor(responses: Array<unknown | (() => Promise<unknown>)>): AiExperienceDbExecutor {
  let idx = 0;
  return {
    execute: jest.fn(async () => {
      const entry = responses[idx++];
      if (typeof entry === 'function') {
        return (entry as () => Promise<unknown>)();
      }
      return { rows: entry ?? [] };
    }),
  };
}

describe('aiExperienceMetricsService', () => {
  it('formats month and week bucket labels cleanly', () => {
    expect(formatBucketLabel('2026-11', 'month')).toBe('Nov 26');
    expect(formatBucketLabel('2026-07', 'month')).toBe('Jul 26');
    expect(formatBucketLabel('2026-11-09', 'week')).toBe('Nov 9');
  });

  it('aggregates conversational, generation, stage timings, reliability, API, and cost metrics', async () => {
    // Order matches Promise.all in getAiExperienceMetrics (including 3 calls inside loadStageTimings)
    const executor = createMockExecutor([
      // 1. available projects
      [{ project: 'Apex' }, { project: 'MaxView' }],
      // 2. convBuckets
      [
        { surface: 'home-chat', bucket: '2026-09', turns: 200, avg_sec: '96.5', p50_sec: '69.3', p90_sec: '202.2' },
        { surface: 'home-chat', bucket: '2026-11', turns: 159, avg_sec: '34.1', p50_sec: '21.8', p90_sec: '81.1' },
        { surface: 'brainstorm', bucket: '2026-11', turns: 59, avg_sec: '40.6', p50_sec: '28.9', p90_sec: '93.4' },
        { surface: 'interview', bucket: '2026-09', turns: 120, avg_sec: '53.4', p50_sec: '21.2', p90_sec: '121.1' },
        { surface: 'interview', bucket: '2026-11', turns: 63, avg_sec: '23.9', p50_sec: '18.7', p90_sec: '43.1' },
      ],
      // 3. convSummary
      [
        { surface: 'home-chat', turns: 359, avg_sec: '68.0', p50_sec: '41.0', p90_sec: '150.0' },
        { surface: 'interview', turns: 183, avg_sec: '40.0', p50_sec: '20.5', p90_sec: '88.0' },
        { surface: 'brainstorm', turns: 59, avg_sec: '40.6', p50_sec: '28.9', p90_sec: '93.4' },
      ],
      // 4. homeSplit
      [
        { bucket: '2026-09', kind: 'app-knowledge', turns: 100, p50_sec: '84.8' },
        { bucket: '2026-11', kind: 'app-knowledge', turns: 75, p50_sec: '36.7' },
        { bucket: '2026-11', kind: 'other-skill', turns: 71, p50_sec: '12.1' },
      ],
      // 5. genBuckets
      [
        { surface: 'design-doc-generation', bucket: '2026-09', total_runs: 59, kept_runs: 35, success_runs: 35, avg_sec: '735.0', p50_sec: '635.0', p90_sec: '1248.5', avg_cost_usd: '1.2500' },
        { surface: 'design-doc-generation', bucket: '2026-11', total_runs: 12, kept_runs: 12, success_runs: 12, avg_sec: '251.9', p50_sec: '148.4', p90_sec: '618.1', avg_cost_usd: '0.6200' },
        { surface: 'prd-generation', bucket: '2026-09', total_runs: 9, kept_runs: 9, success_runs: 9, avg_sec: '504.6', p50_sec: '577.6', p90_sec: '675.4', avg_cost_usd: '0.9500' },
        { surface: 'prd-generation', bucket: '2026-11', total_runs: 3, kept_runs: 3, success_runs: 3, avg_sec: '235.7', p50_sec: '211.8', p90_sec: '298.2', avg_cost_usd: '0.4800' },
      ],
      // 6. genSummary
      [
        { surface: 'design-doc-generation', total_runs: 71, kept_runs: 47, success_runs: 47, avg_sec: '550.0', p50_sec: '420.0', p90_sec: '900.0', avg_cost_usd: '0.9800' },
        { surface: 'prd-generation', total_runs: 12, kept_runs: 12, success_runs: 12, avg_sec: '410.0', p50_sec: '360.0', p90_sec: '640.0', avg_cost_usd: '0.7700' },
      ],
      // 7a. stageTimings overall
      [
        {
          samples: 25,
          ttft_p50_ms: '1450',
          ttft_p90_ms: '3200',
          first_event_p50_ms: '620',
          workspace_p50_ms: '180',
          acquire_p50_ms: '310',
          worker_turn_p50_ms: '18500',
          warm_count: 18,
          resumed_count: 5,
          recreated_count: 2,
        },
      ],
      // 7b. stageTimings byArea
      [
        {
          area: 'brainstorm',
          samples: 15,
          ttft_p50_ms: '1200',
          ttft_p90_ms: '2600',
          first_event_p50_ms: '500',
          worker_turn_p50_ms: '16000',
          warm_count: 12,
        },
      ],
      // 7c. stageTimings trend
      [
        { bucket: '2026-11', samples: 25, ttft_p50_ms: '1450', first_event_p50_ms: '620', worker_turn_p50_ms: '18500' },
      ],
      // 8. reliability overall
      [
        { total_runs: 200, completed_runs: 188, failed_runs: 10, cancelled_runs: 2, queue_wait_p50_sec: '0.85', queue_wait_p90_sec: '4.10' },
      ],
      // 9. reliability trend
      [
        { bucket: '2026-11', total_runs: 100, completed_runs: 96, failed_runs: 3, cancelled_runs: 1, queue_wait_p50_sec: '0.60' },
      ],
      // 10. terminal reasons
      [{ reason: 'progress_timeout', count: 6 }, { reason: 'worker_lost', count: 4 }],
      // 11. api overall
      [{ total_requests: 12000, error_requests: 36, p50_ms: '42', p95_ms: '310', client_errors: 14 }],
      // 12. api trend
      [{ bucket: '2026-11', requests: 6000, error_requests: 12, p50_ms: '38', p95_ms: '260' }],
      // 13. api routes
      [{ route_template: '/api/prds/:id', requests: 250, error_requests: 1, p50_ms: '120', p95_ms: '680' }],
      // 14. cost overall
      [{ total_cost_usd: '142.50', interactions: 600, input_tokens: '1000000', cache_read_tokens: '3000000' }],
      // 15. cost trend
      [{ bucket: '2026-11', total_cost_usd: '48.00', interactions: 200, input_tokens: '250000', cache_read_tokens: '750000' }],
      // 16. models
      [{ model_id: 'claude-sonnet-4-6', runs: 400, avg_sec: '35.2', p50_sec: '22.4', total_cost_usd: '90.00', input_tokens: '500000', cache_read_tokens: '1500000' }],
      // 17. ratings
      [{ good: 18, needs_improvement: 2, bad: 0 }],
      // 18. flagged threads
      [{ flagged: 3, total: 150 }],
    ]);

    const res = await getAiExperienceMetrics(
      { window: '120d', granularity: 'month', project: 'all', now: new Date('2026-11-19T00:00:00.000Z') },
      executor,
    );

    expect(res.project).toBeNull();
    expect(res.availableProjects).toEqual(['Apex', 'MaxView']);
    expect(res.headline.firstTokenMedianMs).toBe(1450);
    expect(res.headline.firstTokenSamples).toBe(25);
    expect(res.headline.successRatePct).toBe(94);
    expect(res.headline.apiP95Ms).toBe(310);
    expect(res.headline.cacheHitPct).toBe(75);

    const designDoc = res.modules.find((m) => m.key === 'design-doc-generation');
    expect(designDoc).toBeDefined();
    expect(designDoc?.deltaPct).toBeLessThan(-70); // 635s -> 148.4s is ~76.6% faster
    expect(designDoc?.successRatePct).toBe(66.2);

    const brainstorm = res.modules.find((m) => m.key === 'brainstorm');
    expect(brainstorm?.turns).toBe(59);
    expect(brainstorm?.deltaPct).toBeNull(); // single month

    expect(res.stageTimings.warmCount).toBe(18);
    expect(res.stageTimings.byArea[0]).toMatchObject({
      area: 'brainstorm',
      label: 'Brainstorm',
      ttftP50Ms: 1200,
      warmPct: 80,
    });
    expect(res.costAndQuality.ratings.positiveRatePct).toBe(90);
    expect(res.costAndQuality.flaggedThreads.ratePct).toBe(2);
  });

  it('degrades gracefully when ai_turn_stage_timings relation does not exist yet', async () => {
    const missingRelErr = Object.assign(new Error('relation "ai_turn_stage_timings" does not exist'), {
      code: '42P01',
    });

    const responses: Array<unknown | (() => Promise<unknown>)> = [
      [], // projects
      [], // convBuckets
      [], // convSummary
      [], // homeSplit
      [], // genBuckets
      [], // genSummary
      () => Promise.reject(missingRelErr), // stage overall
      () => Promise.reject(missingRelErr), // stage area
      () => Promise.reject(missingRelErr), // stage trend
      [{ total_runs: 0, completed_runs: 0, failed_runs: 0, cancelled_runs: 0, queue_wait_p50_sec: null, queue_wait_p90_sec: null }],
      [],
      [],
      [{ total_requests: 0, error_requests: 0, p50_ms: null, p95_ms: null, client_errors: 0 }],
      [],
      [],
      [{ total_cost_usd: '0', interactions: 0, input_tokens: '0', cache_read_tokens: '0' }],
      [],
      [],
      [{ good: 0, needs_improvement: 0, bad: 0 }],
      [{ flagged: 0, total: 0 }],
    ];

    const executor = createMockExecutor(responses);
    const res = await getAiExperienceMetrics({ window: '30d' }, executor);

    expect(res.granularity).toBe('week');
    expect(res.stageTimings.sampleCount).toBe(0);
    expect(res.stageTimings.ttftP50Ms).toBeNull();
    expect(res.headline.firstTokenSamples).toBe(0);
  });
});
