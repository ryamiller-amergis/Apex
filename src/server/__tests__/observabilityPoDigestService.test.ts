import {
  generateObservabilityPoDigest,
  getObservabilityPoDigest,
  isObservabilityTrendWindow,
  observabilityPoDigestScheduler,
  resetObservabilityPoDigestForTests,
} from '../services/observabilityPoDigestService';
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

  it('returns all 6 Product Owner signals, schedule status for 6 AM & 6 PM, and multi-window comparisons', async () => {
    const res = await getObservabilityPoDigest({
      project: 'Apex',
      window: '14d',
      model: 'composer-2.5',
      effort: 'high',
    });

    expect(res.digest.project).toBe('Apex');
    expect(res.digest.window).toBe('14d');
    expect(res.digest.windowLabel).toBe('Last 14 days');
    expect(res.digest.model).toBe('composer-2.5');
    expect(res.digest.effort).toBe('high');
    expect(res.digest.skillPath).toBe(OBSERVABILITY_PO_SKILL_PATH);

    // 1. Top users
    expect(res.digest.topUsers.length).toBeGreaterThan(0);
    expect(res.digest.topUsers[0]?.windowComparison['14d']).toBe(
      res.digest.topUsers[0]?.interactions,
    );

    // 2. Most common exceptions
    expect(res.digest.commonExceptions.length).toBeGreaterThan(0);
    expect(res.digest.commonExceptions[0]?.windowComparison['14d']).toBe(
      res.digest.commonExceptions[0]?.count,
    );

    // 3. Retention dropped per module
    expect(res.digest.moduleRetentionDrops.length).toBeGreaterThan(0);
    expect(res.digest.moduleRetentionDrops[0]?.dropPct).toBeGreaterThan(0);

    // 4. AI summary of why there could be drops
    expect(res.digest.dropReasonsSummary.headline).toContain('composer-2.5');
    expect(res.digest.dropReasonsSummary.findings.length).toBeGreaterThan(0);

    // 5. Top modules
    expect(res.digest.topModules.length).toBeGreaterThan(0);
    expect(res.digest.topModules[0]?.windowComparison['14d']).toBe(
      res.digest.topModules[0]?.interactions,
    );

    // 6. AI summary of how we can drive adoption
    expect(res.digest.adoptionRecommendations.headline).toContain('composer-2.5');
    expect(res.digest.adoptionRecommendations.recommendations.length).toBeGreaterThan(0);

    // Twice-daily schedule metadata (6:00 AM & 6:00 PM)
    expect(res.schedule.morningSlot.scheduledTimeLabel).toContain('6:00 AM');
    expect(res.schedule.eveningSlot.scheduledTimeLabel).toContain('6:00 PM');
  });

  it('persists selected model and effort on on-demand digest generation', async () => {
    const generated = await generateObservabilityPoDigest({
      project: 'Apex',
      window: '30d',
      model: 'composer-2.5',
      effort: 'high',
      slot: 'on_demand',
    });

    expect(generated.digest.slot).toBe('on_demand');
    expect(generated.digest.window).toBe('30d');
    expect(generated.digest.model).toBe('composer-2.5');
    expect(generated.digest.effort).toBe('high');
    expect(generated.schedule.configuredModel).toBe('composer-2.5');
    expect(generated.schedule.configuredEffort).toBe('high');
    expect(generated.history[0]?.slot).toBe('on_demand');
  });

  it('runs scheduled digests at 06:00 UTC (6 AM) and 18:00 UTC (6 PM)', async () => {
    const morningTime = new Date('2026-11-12T06:05:00.000Z');
    await observabilityPoDigestScheduler.tick(morningTime);

    const afterMorning = await getObservabilityPoDigest({ project: 'Apex', window: '7d' });
    expect(afterMorning.schedule.morningSlot.lastRunAt).toBe(morningTime.toISOString());

    const eveningTime = new Date('2026-11-12T18:10:00.000Z');
    await observabilityPoDigestScheduler.tick(eveningTime);

    const afterEvening = await getObservabilityPoDigest({ project: 'Apex', window: '7d' });
    expect(afterEvening.schedule.eveningSlot.lastRunAt).toBe(eveningTime.toISOString());
  });
});
