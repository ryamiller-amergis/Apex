import {
  parseBoardDeliberationAgenda,
  parseBoardDeliberationResponse,
  sanitizeDeliberationResult,
  selectBoardDeliberationEntries,
  shouldRunBoardRebuttal,
  turnPrompt,
} from '../services/boardDeliberationService';

const response = {
  role: 'operations',
  topicId: 'T1',
  position: 'Keep one owner.',
  evidence: [],
  challenges: [],
  revisions: [],
  confidence: 0.7,
  newEvidence: false,
};

describe('board deliberation limits', () => {
  it('reserves one inquiry for synthesis', () => {
    expect(selectBoardDeliberationEntries(['a', 'b', 'c'], 4, 2)).toEqual([
      'a',
    ]);
    expect(selectBoardDeliberationEntries(['a'], 4, 3)).toEqual([]);
  });

  it('stops after responses when no challenge or new evidence exists', () => {
    expect(shouldRunBoardRebuttal([response], 2)).toBe(false);
  });

  it('runs one rebuttal round for a challenge, but never exceeds maxRounds', () => {
    const challenged = { ...response, challenges: ['Compliance disagrees.'] };
    expect(shouldRunBoardRebuttal([challenged], 2)).toBe(true);
    expect(shouldRunBoardRebuttal([challenged], 1)).toBe(false);
  });

  it('rejects duplicate topic ids and duplicate participants', () => {
    const topic = {
      id: 'T1',
      title: 'Ownership',
      question: 'Who owns the workflow?',
      participants: ['operations', 'product'],
      evidenceNeeded: [],
    };
    expect(() =>
      parseBoardDeliberationAgenda({
        role: 'moderator',
        noMaterialDisagreement: false,
        topics: [topic, { ...topic, title: 'Duplicate' }],
      })
    ).toThrow(/Duplicate deliberation topic id/);
    expect(() =>
      parseBoardDeliberationAgenda({
        role: 'moderator',
        noMaterialDisagreement: false,
        topics: [{ ...topic, participants: ['operations', 'operations'] }],
      })
    ).toThrow(/Duplicate participant/);
  });

  it('builds the synthesis prompt for a turn that has no topic', () => {
    const session = {
      charter: 'Phase 1 charter',
      sourceReports: {},
      maxTopics: 5,
      agenda: {
        role: 'moderator',
        noMaterialDisagreement: false,
        topics: [{
          id: 'T1',
          title: 'Ownership',
          question: 'Who owns intake?',
          participants: ['operations', 'product'],
          evidenceNeeded: [],
        }],
      },
    } as unknown as Parameters<typeof turnPrompt>[0];
    const synthesis = { phase: 'synthesis', specialist: 'moderator', topicId: null } as unknown as Parameters<typeof turnPrompt>[1];
    const response = {
      phase: 'response',
      specialist: 'operations',
      topicId: 'T1',
      result: { position: 'Operations owns intake.' },
    } as unknown as Parameters<typeof turnPrompt>[1];

    const prompt = turnPrompt(session, synthesis, [response]);
    expect(prompt).toContain('Synthesize the bounded ATS board discussion.');
    expect(prompt).toContain('Operations owns intake.');
  });

  it('flattens object evidence, challenges, and revisions into readable strings', () => {
    const response = parseBoardDeliberationResponse({
      role: 'client',
      topicId: 'T1',
      position: 'Clients approve submittals in the portal.',
      evidence: [
        { claim: 'Portal approval cuts email.', source: 'charter', corroboration: 'one source' },
        'Plain evidence stays as written.',
      ],
      challenges: [{ target: 'operations', claim: 'Recruiters still need email fallback.' }],
      revisions: [{ text: 'Keep email as a fallback.', reason: null }],
      confidence: 0.6,
      newEvidence: false,
    });
    expect(response.evidence).toEqual([
      'Portal approval cuts email. — source: charter — corroboration: one source',
      'Plain evidence stays as written.',
    ]);
    expect(response.challenges).toEqual([
      'target: operations — Recruiters still need email fallback.',
    ]);
    expect(response.revisions).toEqual(['Keep email as a fallback.']);
  });

  it('accepts moderator audit fields on agenda and response', () => {
    const agenda = parseBoardDeliberationAgenda({
      role: 'moderator',
      noMaterialDisagreement: false,
      topics: [],
      evidenceGaps: ['Missing SLA baseline'],
      singleSourceClaims: ['Vendor pricing page only'],
      charterConflicts: [],
    });
    expect(agenda.evidenceGaps).toEqual(['Missing SLA baseline']);

    const parsed = parseBoardDeliberationResponse({
      ...response,
      citedEvidenceIds: ['E-OPS-1'],
    });
    expect(parsed.citedEvidenceIds).toEqual(['E-OPS-1']);
  });

  it('strips undocumented keys from deliberation audit payloads', () => {
    const sanitized = sanitizeDeliberationResult('response', {
      role: 'operations',
      topicId: 'T1',
      position: 'Hold',
      evidence: [],
      challenges: [],
      revisions: [],
      citedEvidenceIds: [],
      confidence: 0.5,
      newEvidence: false,
      hiddenReasoning: 'must not leak',
    });
    expect(sanitized).not.toHaveProperty('hiddenReasoning');
    expect(sanitized?.position).toBe('Hold');
  });
});
