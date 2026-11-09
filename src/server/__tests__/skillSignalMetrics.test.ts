import { describe, expect, it } from '@jest/globals';
import { buildProjectSignals, buildSignalSurface, type SkillSignalRowInput } from '../services/skillSignalMetrics';
import { SKILL_LEARNING_SURFACES } from '../../shared/constants/skillLearningSurfaces';

const row = (overrides: Partial<SkillSignalRowInput> = {}): SkillSignalRowInput => ({
  project: 'Apex',
  surface: 'adr_assistant',
  kind: 'accepted',
  value: null,
  skillSha256: null,
  metadata: null,
  ...overrides,
});

const repeat = (n: number, overrides: Partial<SkillSignalRowInput>) =>
  Array.from({ length: n }, () => row(overrides));

describe('buildSignalSurface', () => {
  it('counts accepted and rejected as decisions and gives an interval', () => {
    const surface = buildSignalSurface('adr_assistant', [
      ...repeat(3, { kind: 'accepted' }),
      row({ kind: 'rejected' }),
    ]);
    expect(surface.decisions).toBe(4);
    expect(surface.acceptanceRate).toBe(0.75);
    expect(surface.acceptanceInterval?.low).toBeLessThan(0.75);
    expect(surface.acceptanceInterval?.high).toBeGreaterThan(0.75);
    expect(surface.sufficientSample).toBe(false);
  });

  it('treats Playbook gate decisions as accept or reject', () => {
    const surface = buildSignalSurface('playbook', [
      row({ surface: 'playbook', kind: 'gate_approved' }),
      row({ surface: 'playbook', kind: 'gate_rejected' }),
    ]);
    expect(surface.decisions).toBe(2);
    expect(surface.acceptanceRate).toBe(0.5);
  });

  it('reports edits before accept, regenerations per accept and failures', () => {
    const surface = buildSignalSurface('prd_assistant', [
      row({ kind: 'accepted', metadata: { editedBeforeApply: true } }),
      row({ kind: 'accepted', metadata: { editedBeforeApply: false } }),
      ...repeat(3, { kind: 'regenerated' }),
      row({ kind: 'completed' }),
      row({ kind: 'run_failed' }),
    ]);
    expect(surface.editedBeforeAcceptRate).toBe(0.5);
    expect(surface.regenerationsPerAccepted).toBe(1.5);
    expect(surface.failureRate).toBe(0.5);
  });

  it('averages ratings on the −1 to 1 scale', () => {
    const surface = buildSignalSurface('home_chat', [
      row({ kind: 'rating', value: 1 }),
      row({ kind: 'rating', value: 1 }),
      row({ kind: 'rating', value: -1 }),
      row({ kind: 'rating', value: 0 }),
    ]);
    expect(surface.ratings).toBe(4);
    expect(surface.ratingScore).toBe(0.25);
    expect(surface.decisions).toBe(0);
    expect(surface.acceptanceRate).toBeNull();
  });

  it('splits acceptance by Skill version and marks small versions', () => {
    const surface = buildSignalSurface('adr_assistant', [
      ...repeat(10, { kind: 'accepted', skillSha256: 'a'.repeat(64) }),
      ...repeat(2, { kind: 'rejected', skillSha256: 'b'.repeat(64) }),
      row({ kind: 'regenerated', skillSha256: 'c'.repeat(64) }),
    ]);
    expect(surface.versions.map((v) => [v.skillSha256?.[0], v.decisions, v.sufficientSample])).toEqual([
      ['a', 10, true],
      ['b', 2, false],
    ]);
  });
});

describe('buildProjectSignals', () => {
  it('lists only surfaces with signals and reports coverage against every surface', () => {
    const signals = buildProjectSignals([
      row({ surface: 'qa_lab' }),
      row({ surface: 'brainstorm', kind: 'handoff_completed' }),
    ]);
    expect(signals.surfaces.map((s) => s.surface)).toEqual(['brainstorm', 'qa_lab']);
    expect(signals.coverage).toEqual({ active: 2, total: SKILL_LEARNING_SURFACES.length });
  });
});
