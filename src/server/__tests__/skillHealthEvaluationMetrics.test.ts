import {
  buildJudgeAgreement,
  buildProjectEvaluation,
  eventScore,
  humanStats,
  type SkillHealthEvaluationEventInput,
  type SkillHealthEvaluationJobInput,
} from '../services/skillHealthEvaluationMetrics';

const event = (overrides: Partial<SkillHealthEvaluationEventInput> = {}): SkillHealthEvaluationEventInput => ({
  id: 'event-1',
  project: 'Apex',
  subjectType: 'prd',
  subjectId: 'prd-1',
  stageKey: 'prd_human_review',
  skillPath: '.cursor/skills/to-prd/SKILL.md',
  skillVersion: 'sha-a',
  criteriaScores: {
    intent_alignment: 4,
    requirements_coverage: 3,
    scope_alignment: 4,
    acceptance_criteria: 2,
    readiness: 2,
  },
  outcome: 'accept_after_edits',
  comment: null,
  createdAt: '2026-10-15T12:00:00.000Z',
  ...overrides,
});

const judgeJob = (eventId: string, summary: unknown, status: SkillHealthEvaluationJobInput['status'] = 'ready') => ({
  eventId,
  evaluatorKey: 'llm_judge' as const,
  status,
  summary,
});

const judgeSummary = (texts: string[]) => ({
  missedRequirements: [],
  inventedRequirements: [],
  recommendedImprovements: texts.map((text) => ({ text, criterion: 'readiness' })),
  confidence: 'medium',
});

describe('eventScore and humanStats', () => {
  it('averages the five criteria of an event', () => {
    expect(eventScore(event())).toBe(3);
  });

  it('counts events and averages their scores', () => {
    expect(humanStats([event(), event({ criteriaScores: { intent_alignment: 5, readiness: 5 } })])).toEqual({
      humanEvents: 2,
      humanAverageScore: 4,
    });
    expect(humanStats([])).toEqual({ humanEvents: 0, humanAverageScore: null });
  });
});

describe('buildProjectEvaluation', () => {
  it('counts outcomes per stage in seeded order', () => {
    const result = buildProjectEvaluation('Apex', [
      event({ id: 'a', stageKey: 'interview_phase_1', subjectType: 'interview_phase', outcome: 'reject' }),
      event({ id: 'b' }),
      event({ id: 'c', outcome: 'accept_unchanged' }),
    ], []);

    expect(result.events).toBe(3);
    expect(result.stages.map((s) => [s.stageKey, s.events, s.outcomes.accept_unchanged, s.outcomes.reject])).toEqual([
      ['prd_human_review', 2, 1, 0],
      ['interview_phase_1', 1, 0, 1],
    ]);
  });

  it('lists regenerate and reject events newest first with a comment excerpt', () => {
    const result = buildProjectEvaluation('Apex', [
      event({ id: 'old', outcome: 'regenerate', createdAt: '2026-10-01T00:00:00.000Z', comment: 'x'.repeat(300) }),
      event({ id: 'new', outcome: 'reject', createdAt: '2026-10-10T00:00:00.000Z', comment: '  Missed the main flow  ' }),
      event({ id: 'fine', outcome: 'accept_unchanged' }),
    ], []);

    expect(result.flagged.map((f) => f.eventId)).toEqual(['new', 'old']);
    expect(result.flagged[0].commentExcerpt).toBe('Missed the main flow');
    expect(result.flagged[1].commentExcerpt).toHaveLength(160);
  });

  it('groups by Skill path and subject type, with criteria averages and job counts', () => {
    const result = buildProjectEvaluation(
      'Apex',
      [
        event({ id: 'a' }),
        event({ id: 'b', skillPath: '\\.cursor\\skills\\to-prd\\SKILL.md', criteriaScores: { intent_alignment: 2 } }),
        event({ id: 'c', subjectType: 'interview_phase', stageKey: 'interview_phase_1', skillPath: '.cursor/skills/grill-with-docs/SKILL.md' }),
      ],
      [
        { eventId: 'a', evaluatorKey: 'promptfoo', status: 'ready', summary: null },
        { eventId: 'b', evaluatorKey: 'promptfoo', status: 'failed', summary: null },
        judgeJob('a', null, 'pending'),
      ],
    );

    const prdSkill = result.skills.find((s) => s.subjectType === 'prd');
    expect(prdSkill).toMatchObject({
      key: 'Apex:prd:.cursor/skills/to-prd/skill.md',
      events: 2,
      promptfoo: { ready: 1, failed: 1, pending: 0, running: 0 },
      judge: { pending: 1, ready: 0, failed: 0, running: 0 },
    });
    expect(prdSkill?.criteriaAverages.intent_alignment).toBe(3);
    expect(prdSkill?.criteriaAverages.readiness).toBe(2);
    expect(result.skills.find((s) => s.subjectType === 'interview_phase')?.events).toBe(1);
  });

  it('takes recommendations only from ready judge jobs with a valid summary, newest first, five at most', () => {
    const result = buildProjectEvaluation(
      'Apex',
      [
        event({ id: 'old', createdAt: '2026-10-01T00:00:00.000Z' }),
        event({ id: 'new', createdAt: '2026-10-12T00:00:00.000Z' }),
        event({ id: 'bad', createdAt: '2026-10-13T00:00:00.000Z' }),
        event({ id: 'failed', createdAt: '2026-10-14T00:00:00.000Z' }),
      ],
      [
        judgeJob('old', judgeSummary(['o1', 'o2', 'o3'])),
        judgeJob('new', judgeSummary(['n1', 'n2', 'n3'])),
        judgeJob('bad', { recommendedImprovements: 'not a list' }),
        judgeJob('failed', judgeSummary(['f1']), 'failed'),
      ],
    );

    const [skill] = result.skills;
    expect(skill.recommendations.map((r) => r.text)).toEqual(['n1', 'n2', 'n3', 'o1', 'o2']);
    expect(skill.recommendations[0]).toMatchObject({ eventId: 'new', criterion: 'readiness' });
  });
});

describe('judge agreement', () => {
  const blind = (scores: Record<string, number>) => ({ ...judgeSummary([]), criteriaScores: scores });
  const human = {
    intent_alignment: 4,
    requirements_coverage: 3,
    scope_alignment: 4,
    acceptance_criteria: 2,
    readiness: 2,
  };

  it('pairs human scores with blind judge scores and reports kappa per criterion', () => {
    const events = Array.from({ length: 4 }, (_, i) => event({ id: `e${i}`, criteriaScores: human }));
    const jobs = events.map((e) => judgeJob(e.id, blind(human)));
    const [skill] = buildProjectEvaluation('Apex', events, jobs).skills;
    expect(skill.judgeAgreement.reviews).toBe(4);
    expect(skill.judgeAgreement.kappa).toBeCloseTo(1);
    expect(skill.judgeAgreement.criteria.readiness.pairs).toBe(4);
    expect(skill.judgeAgreement.band).toBe('insufficient_data');
  });

  it('ignores version 1 judge results that carry no criteria scores', () => {
    const events = [event({ id: 'e1' })];
    const [skill] = buildProjectEvaluation('Apex', events, [judgeJob('e1', judgeSummary(['x']))]).skills;
    expect(skill.judgeAgreement).toMatchObject({ reviews: 0, kappa: null, band: 'insufficient_data' });
  });

  it('ignores judge jobs that are not ready', () => {
    const events = [event({ id: 'e1' })];
    const [skill] = buildProjectEvaluation('Apex', events, [judgeJob('e1', blind(human), 'failed')]).skills;
    expect(skill.judgeAgreement.reviews).toBe(0);
  });

  it('lists far-apart and low-confidence reviews to recheck, largest gap first', () => {
    const events = [
      event({ id: 'far', criteriaScores: human }),
      event({ id: 'unsure', criteriaScores: human }),
      event({ id: 'close', criteriaScores: human }),
    ];
    const jobs = [
      judgeJob('far', blind({ ...human, readiness: 5 })),
      judgeJob('unsure', { ...blind(human), confidence: 'low' }),
      judgeJob('close', blind({ ...human, readiness: 3 })),
    ];
    const [skill] = buildProjectEvaluation('Apex', events, jobs).skills;
    expect(skill.judgeAgreement.recheck.map((r) => [r.eventId, r.reason, r.largestGap])).toEqual([
      ['far', 'disagreement', 3],
      ['unsure', 'low_confidence', 0],
    ]);
  });

  it('flags drift when recent agreement falls well below earlier agreement', () => {
    const now = Date.parse('2026-11-09T00:00:00Z');
    const scale = [1, 2, 3, 4, 5];
    const make = (prefix: string, createdAt: string, offset: number) => scale.flatMap((s, i) => [0, 1].map((n) => {
      const id = `${prefix}${i}${n}`;
      const scores = Object.fromEntries(Object.keys(human).map((k) => [k, s]));
      const judged = Object.fromEntries(Object.keys(human).map((k) => [k, ((s - 1 + offset) % 5) + 1]));
      return { e: event({ id, createdAt, criteriaScores: scores }), j: judgeJob(id, blind(judged)) };
    }));
    const rows = [...make('old', '2026-09-01T00:00:00Z', 0), ...make('new', '2026-11-01T00:00:00Z', 2)];
    const agreement = buildJudgeAgreement(rows.map((r) => r.e), new Map(rows.map((r) => [r.e.id, [r.j]])), now);
    expect(agreement.drift).toMatchObject({ recentReviews: 10, earlierReviews: 10, drifting: true });
    expect(agreement.drift.earlierKappa).toBeCloseTo(1);
  });
});
