import {
  appendReviewerConstraints,
  parseReviewerDecisionFence,
  REVIEWER_DECISION_MARKER,
} from '../../shared/utils/rfpReviewerDecision';

describe('rfpReviewerDecision parser', () => {
  it('strips the fence and reads a suggested verdict', () => {
    const raw = `A standalone SDLC build is valid if you replace Cornerstone.

:::reviewer-decision
{"verdict":"build","rationale":"Replace unused Cornerstone","constraintsToAdd":"Host outside Apex"}
:::
`;
    const parsed = parseReviewerDecisionFence(raw);
    expect(parsed.displayBody).toBe('A standalone SDLC build is valid if you replace Cornerstone.');
    expect(parsed.suggestion).toEqual({
      verdict: 'build',
      rationale: 'Replace unused Cornerstone',
      constraintsToAdd: 'Host outside Apex',
    });
  });

  it('returns no suggestion for ordinary replies', () => {
    const parsed = parseReviewerDecisionFence('Buy remains the stored call.');
    expect(parsed.suggestion).toBeNull();
    expect(parsed.displayBody).toBe('Buy remains the stored call.');
  });

  it('replaces a previous reviewer constraint block', () => {
    const first = appendReviewerConstraints('Keep PII in tenant', 'Build it', 'Replace Cornerstone');
    expect(first).toContain(REVIEWER_DECISION_MARKER);
    const second = appendReviewerConstraints(first, 'Still build', 'No Power Platform');
    expect(second.split(REVIEWER_DECISION_MARKER)).toHaveLength(2);
    expect(second).toContain('Still build');
    expect(second).toContain('Keep PII in tenant');
  });
});
