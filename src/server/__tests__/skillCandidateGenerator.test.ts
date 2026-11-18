import {
  CANDIDATE_OUTPUT_SCHEMA,
  SkillCandidateError,
  buildCandidateInput,
  parseCandidateResult,
} from '../services/skillCandidateGenerator';

const BASELINE = `# to-prd\n\n${'Write each acceptance criterion as a testable statement.\n'.repeat(20)}`;

function result(skillContent: unknown, changeNotes: unknown = 'Tightened acceptance criteria.'): unknown {
  return { skillContent, changeNotes };
}

describe('buildCandidateInput', () => {
  const evidence = {
    caseKey: 'c1',
    lowCriteria: ['acceptance_criteria' as const],
    reviewerComment: 'Vague criteria',
    reasonCodes: ['unclear'],
    correctionChanges: '+ Each criterion names a threshold',
    correctedExcerpt: 'full corrected text',
  };

  it('sends what the reviewer changed rather than the whole corrected text', () => {
    const input = buildCandidateInput({ skillPath: 'to-prd', baselineContent: BASELINE, evidence: [evidence] });
    expect(input.cases).toEqual([expect.objectContaining({ correctionChanges: '+ Each criterion names a threshold' })]);
    expect((input.cases as Array<Record<string, unknown>>)[0].correctedExcerpt).toBeUndefined();
  });

  it('needs at least one failed case', () => {
    expect(() => buildCandidateInput({ skillPath: 'to-prd', baselineContent: BASELINE, evidence: [] })).toThrow(SkillCandidateError);
  });

  it('asks for exactly the Skill text and change notes', () => {
    expect(CANDIDATE_OUTPUT_SCHEMA).toEqual(expect.objectContaining({ additionalProperties: false, required: ['skillContent', 'changeNotes'] }));
  });
});

describe('parseCandidateResult', () => {
  it('reads the draft', () => {
    const draft = parseCandidateResult(result(`${BASELINE}\nName the owner of every PBI.\n`), BASELINE);
    expect(draft.skillContent).toContain('Name the owner of every PBI.');
    expect(draft.changeNotes).toBe('Tightened acceptance criteria.');
  });

  it('fills in missing change notes', () => {
    expect(parseCandidateResult(result(`${BASELINE}\nMore.`, ''), BASELINE).changeNotes).toBe('No change notes were given.');
  });

  it.each([
    ['no result', null],
    ['no Skill text', result('')],
    ['an unchanged Skill', result(BASELINE.replace(/\n/g, '\r\n'))],
    ['a Skill that grew too much', result(BASELINE.repeat(8))],
    ['a Skill that lost most of its text', result('# to-prd')],
  ])('refuses %s', (_label, value) => {
    expect(() => parseCandidateResult(value, BASELINE)).toThrow(SkillCandidateError);
  });
});
