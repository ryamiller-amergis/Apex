import { evaluateInteractiveTierHealth } from '../services/interactiveTierHealthService';

jest.mock('../db/drizzle', () => ({ db: {} }));

describe('interactive tier health + first-token SLO (TBI-012 / PBI-007 h)', () => {
  const capacity = { reserved: 4, burstMax: 12 };

  it('VT-08: healthy lane below capacity within SLO does not alert', () => {
    const health = evaluateInteractiveTierHealth({
      interactiveInFlight: 4,
      ...capacity,
      observedFirstTokenP95Ms: 900,
      firstTokenSloMs: 1_500,
    });
    expect(health.interactiveSaturation).toBeCloseTo(4 / 16);
    expect(health.firstTokenSloStatus).toBe('ok');
    expect(health.alert).toBe(false);
  });

  it('VT-08: first-token P95 breaching the SLO raises an alert', () => {
    const health = evaluateInteractiveTierHealth({
      interactiveInFlight: 2,
      ...capacity,
      observedFirstTokenP95Ms: 2_100,
      firstTokenSloMs: 1_500,
    });
    expect(health.firstTokenSloStatus).toBe('breach');
    expect(health.alert).toBe(true);
  });

  it('VT-08: reserved+burst exhaustion reports saturation and alerts', () => {
    const health = evaluateInteractiveTierHealth({
      interactiveInFlight: 16,
      ...capacity,
      observedFirstTokenP95Ms: 800,
      firstTokenSloMs: 1_500,
    });
    expect(health.interactiveSaturation).toBe(1);
    expect(health.firstTokenSloStatus).toBe('ok');
    expect(health.alert).toBe(true);
  });

  it('reports unknown SLO status when no latency sample exists', () => {
    const health = evaluateInteractiveTierHealth({
      interactiveInFlight: 1,
      ...capacity,
      observedFirstTokenP95Ms: null,
      firstTokenSloMs: 1_500,
    });
    expect(health.firstTokenSloStatus).toBe('unknown');
    expect(health.alert).toBe(false);
  });
});
