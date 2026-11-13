import { checkJudgeOutput } from '../services/workflowEvaluationJudgeOutput';

/** Same shape as the judge_output_schema seeded for every v1 definition. */
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    missedRequirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, evidence: { type: 'string' } },
        required: ['description'],
        additionalProperties: false,
      },
    },
    inventedRequirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, evidence: { type: 'string' } },
        required: ['description'],
        additionalProperties: false,
      },
    },
    alignmentScore: { type: 'number', minimum: 1, maximum: 5 },
    recommendedImprovements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, criterion: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['missedRequirements', 'inventedRequirements', 'recommendedImprovements', 'confidence'],
  additionalProperties: false,
};

const VALID = {
  missedRequirements: [{ description: 'CSV export', evidence: 'user: we need CSV' }],
  inventedRequirements: [],
  alignmentScore: 3,
  recommendedImprovements: [{ text: 'Add the export story', criterion: 'requirements_coverage' }],
  confidence: 'medium',
};

describe('checkJudgeOutput', () => {
  it('accepts output that matches the seeded schema', () => {
    expect(checkJudgeOutput(JSON.stringify(VALID), SCHEMA)).toEqual({ ok: true, output: VALID });
  });

  it.each([
    ['a missing required field', { ...VALID, confidence: undefined }, "must have required property 'confidence'"],
    ['an extra field', { ...VALID, verdict: 'pass' }, 'must NOT have additional properties'],
    ['a score out of range', { ...VALID, alignmentScore: 7 }, '/alignmentScore must be <= 5'],
    ['an unknown confidence', { ...VALID, confidence: 'certain' }, '/confidence must be equal to one of the allowed values'],
    [
      'a finding without a description',
      { ...VALID, missedRequirements: [{ evidence: 'x' }] },
      "/missedRequirements/0 must have required property 'description'",
    ],
  ])('rejects %s', (_label, output, message) => {
    const result = checkJudgeOutput(JSON.stringify(output), SCHEMA);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join('\n')).toContain(message);
  });

  it('rejects text that is not JSON, and a top-level array', () => {
    expect(checkJudgeOutput('```json\n{}\n```', SCHEMA)).toMatchObject({ ok: false });
    expect(checkJudgeOutput('[]', { type: 'array' })).toEqual({ ok: false, errors: ['/ must be an object'] });
  });

  it('reports a schema that does not compile instead of throwing', () => {
    expect(checkJudgeOutput('{}', { type: 'not-a-type' })).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('Output schema does not compile')],
    });
  });
});
