import fs from 'fs';
import type { CursorTeamSummary } from '../types/cursorAnalytics';
import type { AiCapabilityBaseline } from '../types/aiCapabilityLadder';
import { buildLadderResult } from '../services/aiCapabilityLadderService';
import { getBaseline, saveBaseline } from '../services/aiCapabilityBaselineService';

// ── Baseline service ───────────────────────────────────────────────────────────

jest.mock('fs', () => {
  const real = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...real,
    readFileSync: jest.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

describe('aiCapabilityBaselineService', () => {
  it('returns empty baseline when file is missing', () => {
    const b = getBaseline();
    expect(b.capturedAt).toBe('');
    expect(b.prCycleTimeDays).toBeNull();
    expect(b.identifiedUseCases).toEqual([]);
  });

  it('saveBaseline calls writeFileSync', () => {
    const baseline: AiCapabilityBaseline = {
      capturedAt: '2024-01-01',
      prCycleTimeDays: 3.5,
      leadTimeDays: 7,
      defectRatePerPbi: 0.2,
      deploysPerMonth: 4,
      trainingCompletionByDeveloper: { 'Alice': true },
      identifiedUseCases: ['PR review'],
      skillContributions: [{ developer: 'Alice', skillName: 'review-helper', sharedRegistry: true }],
      crossTeamDemoEvidence: ['Demoed at all-hands 2024-03-15'],
    };
    saveBaseline(baseline);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCursorSummary(overrides: Partial<CursorTeamSummary> = {}): CursorTeamSummary {
  return {
    teamSize: 5,
    activeSeats: 5,
    developers: [
      { email: 'a@co.com', name: 'Alice', cursorId: 1, role: 'member', activeDays: 18, windowDays: 30, dauFraction: 0.6, sustainedWeeks: 3, totalAcceptedLines: 500, totalApplies: 40, totalAccepts: 150, cmdkUsages: 10, bugbotUsages: 2 },
      { email: 'b@co.com', name: 'Bob',   cursorId: 2, role: 'member', activeDays: 4,  windowDays: 30, dauFraction: 0.13, sustainedWeeks: 1, totalAcceptedLines: 50,  totalApplies: 3,  totalAccepts: 10,  cmdkUsages: 1,  bugbotUsages: 0 },
      { email: 'c@co.com', name: 'Carol', cursorId: 3, role: 'member', activeDays: 20, windowDays: 30, dauFraction: 0.67, sustainedWeeks: 4, totalAcceptedLines: 800, totalApplies: 60, totalAccepts: 200, cmdkUsages: 15, bugbotUsages: 5 },
      { email: 'd@co.com', name: 'Dave',  cursorId: 4, role: 'member', activeDays: 15, windowDays: 30, dauFraction: 0.5,  sustainedWeeks: 2, totalAcceptedLines: 300, totalApplies: 25, totalAccepts: 90,  cmdkUsages: 8,  bugbotUsages: 1 },
      { email: 'e@co.com', name: 'Eve',   cursorId: 5, role: 'member', activeDays: 0,  windowDays: 30, dauFraction: 0,    sustainedWeeks: 0, totalAcceptedLines: 0,   totalApplies: 0,  totalAccepts: 0,   cmdkUsages: 0,  bugbotUsages: 0 },
    ],
    dauSeries: [],
    daysAbove50pct: 12, daysAbove80pct: 3,
    weeksAbove50pct: 2, weeksAbove80pct: 0,
    recentDauPct: 0.6, totalDauDays: 14,
    tabAcceptRate: 0.45, agentEditAcceptRate: 0.3,
    skillsInUse: ['review-helper'], totalSkillUsages: 55,
    mcpToolsInUse: ['get_issue'], planModeUsages: 20,
    commandsUsed: ['agent', 'composer'],
    ...overrides,
  };
}

function makeBaseline(overrides: Partial<AiCapabilityBaseline> = {}): AiCapabilityBaseline {
  return {
    capturedAt: '2024-01-01',
    prCycleTimeDays: 5.0, leadTimeDays: 10.0, defectRatePerPbi: 0.3, deploysPerMonth: 2,
    trainingCompletionByDeveloper: {}, identifiedUseCases: ['PR review'],
    skillContributions: [], crossTeamDemoEvidence: [],
    ...overrides,
  };
}

const BASE_INPUTS = {
  cursorDataAvailable: true as const,
  cursorApiError: null as null,
  kickoffCount: 0,
  totalEligibleFeatures: 0,
  aiCodeWorkItemAdoption: {
    totalAssignedWorkItems: 0,
    aiCodeWorkItems: 0,
    adoptionRate: null,
    developerAdoption: [],
  },
  avgPrCycleTimeDays: null as null,
  avgLeadTimeDays: null as null,
  avgDefectRatePerPbi: null as null,
  deployFrequencyPerMonth: null as null,
  fromDate: '2024-01-01',
  toDate: '2024-01-31',
};

// ── Bar 1 ──────────────────────────────────────────────────────────────────────

describe('buildLadderResult - Bar 1', () => {
  const adoMembers = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];

  it('reports not-met seat coverage when some members lack Cursor seats', () => {
    const cursor = makeCursorSummary({ activeSeats: 3, teamSize: 5 });
    const result = buildLadderResult({ ...BASE_INPUTS, cursorSummary: cursor, adoMembers, baseline: makeBaseline() });
    const b1 = result.bars.find(b => b.bar === 'bar1')!;
    const seats = b1.criteria.find(c => c.id === 'b1-seats')!;
    expect(seats.status).toBe('not-met');
    expect(seats.currentValue).toBeCloseTo(0.6);
  });

  it('reports met seat coverage when all ADO members have seats', () => {
    const cursor = makeCursorSummary({ activeSeats: 5, teamSize: 5 });
    const result = buildLadderResult({ ...BASE_INPUTS, cursorSummary: cursor, adoMembers, baseline: makeBaseline({ capturedAt: '' }) });
    const b1 = result.bars.find(b => b.bar === 'bar1')!;
    expect(b1.criteria.find(c => c.id === 'b1-seats')!.status).toBe('met');
  });

  it('marks DAU criterion not-met when weeksAbove50pct < 2', () => {
    const result = buildLadderResult({ ...BASE_INPUTS, cursorSummary: makeCursorSummary({ weeksAbove50pct: 0, daysAbove50pct: 0, recentDauPct: 0 }), adoMembers, baseline: makeBaseline() });
    expect(result.bars.find(b => b.bar === 'bar1')!.criteria.find(c => c.id === 'b1-dau')!.status).toBe('not-met');
  });

  it('includes developers without Cursor activity in result', () => {
    const result = buildLadderResult({ ...BASE_INPUTS, cursorSummary: makeCursorSummary(), adoMembers, baseline: makeBaseline() });
    expect(result.developersWithoutCursorActivity.some(d => d.name === 'Eve')).toBe(true);
  });

  it('shows unknown for seat criterion when Cursor API unavailable', () => {
    const result = buildLadderResult({
      ...BASE_INPUTS,
      cursorDataAvailable: false,
      cursorApiError: 'Cursor API 401',
      cursorSummary: makeCursorSummary({ teamSize: 0, activeSeats: 0, developers: [] }),
      adoMembers,
      baseline: makeBaseline(),
    });
    expect(result.cursorApiError).toBeTruthy();
    expect(result.bars.find(b => b.bar === 'bar1')!.criteria.find(c => c.id === 'b1-seats')!.status).toBe('unknown');
    expect(result.bars.find(b => b.bar === 'bar1')!.criteria.find(c => c.id === 'b1-dau')!.status).toBe('unknown');
    expect(result.developersWithoutCursorActivity).toHaveLength(0);
  });
});

// ── Bar 2 outcomes ─────────────────────────────────────────────────────────────

describe('buildLadderResult - Bar 2 outcomes', () => {
  it('uses timeframe-scoped ai-code work item adoption for the Bar 2 practice threshold', () => {
    const result = buildLadderResult({
      ...BASE_INPUTS,
      cursorSummary: makeCursorSummary(),
      adoMembers: ['Alice', 'Bob'],
      aiCodeWorkItemAdoption: {
        totalAssignedWorkItems: 10,
        aiCodeWorkItems: 4,
        adoptionRate: 0.4,
        developerAdoption: [
          { developer: 'Alice', totalAssignedWorkItems: 5, aiCodeWorkItems: 4, adoptionRate: 0.8 },
          { developer: 'Bob', totalAssignedWorkItems: 5, aiCodeWorkItems: 0, adoptionRate: 0 },
        ],
      },
      baseline: makeBaseline(),
    });
    const criterion = result.bars.find(b => b.bar === 'bar2')!.criteria.find(c => c.id === 'b2-orchestrator')!;
    expect(criterion.status).toBe('not-met');
    expect(criterion.currentDisplay).toBe('40% (4/10)');
    expect(criterion.developersNeedingLift).toEqual([
      expect.objectContaining({ name: 'Bob', currentDisplay: '0/5 (0%) ai-code tagged' }),
    ]);
  });

  it('cycle time met when current is 20% better than baseline', () => {
    const result = buildLadderResult({
      ...BASE_INPUTS,
      cursorSummary: makeCursorSummary({ weeksAbove80pct: 4 }),
      adoMembers: [],
      kickoffCount: 6, totalEligibleFeatures: 10,
      avgPrCycleTimeDays: 4.0, avgLeadTimeDays: 8.5, avgDefectRatePerPbi: 0.25,
      baseline: makeBaseline({ prCycleTimeDays: 5.0 }),
    });
    expect(result.bars.find(b => b.bar === 'bar2')!.criteria.find(c => c.id === 'b2-cycle')!.status).toBe('met');
  });

  it('cycle time not-met when improvement is below threshold', () => {
    const result = buildLadderResult({
      ...BASE_INPUTS,
      cursorSummary: makeCursorSummary(),
      adoMembers: [],
      avgPrCycleTimeDays: 4.9,
      baseline: makeBaseline({ prCycleTimeDays: 5.0 }),
    });
    expect(result.bars.find(b => b.bar === 'bar2')!.criteria.find(c => c.id === 'b2-cycle')!.status).toBe('not-met');
  });
});

// ── Bar 3 contribution ─────────────────────────────────────────────────────────

describe('buildLadderResult - Bar 3 contribution', () => {
  it('skills-contributed not-met when fewer than 2 in shared registry', () => {
    const result = buildLadderResult({
      ...BASE_INPUTS,
      cursorSummary: makeCursorSummary(),
      adoMembers: [],
      baseline: makeBaseline({ skillContributions: [{ developer: 'Alice', skillName: 'foo', sharedRegistry: true }] }),
    });
    const skills = result.bars.find(b => b.bar === 'bar3')!.criteria.find(c => c.id === 'b3-skills')!;
    expect(skills.status).toBe('at-risk');
    expect(skills.currentValue).toBe(1);
  });

  it('skills-contributed met with 2 shared contributions', () => {
    const result = buildLadderResult({
      ...BASE_INPUTS,
      cursorSummary: makeCursorSummary(),
      adoMembers: [],
      baseline: makeBaseline({
        skillContributions: [
          { developer: 'Alice', skillName: 'foo', sharedRegistry: true },
          { developer: 'Bob',   skillName: 'bar', sharedRegistry: true },
        ],
      }),
    });
    expect(result.bars.find(b => b.bar === 'bar3')!.criteria.find(c => c.id === 'b3-skills')!.status).toBe('met');
  });
});

// ── Top gaps ───────────────────────────────────────────────────────────────────

describe('buildLadderResult - topGaps', () => {
  it('topGaps contains only not-met and at-risk criteria', () => {
    const result = buildLadderResult({
      ...BASE_INPUTS,
      cursorSummary: makeCursorSummary({ weeksAbove50pct: 0, weeksAbove80pct: 0, activeSeats: 3 }),
      adoMembers: ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'],
      avgPrCycleTimeDays: 5.0, avgLeadTimeDays: 10.0, avgDefectRatePerPbi: 0.4,
      deployFrequencyPerMonth: 1,
      baseline: makeBaseline(),
    });
    for (const gap of result.topGaps) {
      expect(['not-met', 'at-risk']).toContain(gap.status);
    }
    expect(result.topGaps.length).toBeLessThanOrEqual(5);
  });
});
