import { renderPhaseKickoffTranscript } from '../services/phaseKickoffTranscript';

describe('renderPhaseKickoffTranscript', () => {
  it('VT-04 / TBI-003 DoD-1 renders configured summaries in deterministic order', () => {
    const transcript = renderPhaseKickoffTranscript({
      interviewTitle: 'Configurable interview flow',
      originalPrompt: 'Split discovery into requirements and technical phases.',
      requirementsSummary: 'Capture personas and outcomes.',
      technicalSummary: 'Reuse the existing PRD generation pipeline.',
    });

    expect(transcript).toBe([
      '# Interview Kickoff Transcript',
      '',
      '## Interview Title',
      '',
      'Configurable interview flow',
      '',
      '## Original Prompt',
      '',
      'Split discovery into requirements and technical phases.',
      '',
      '## Requirements Phase Summary',
      '',
      'Capture personas and outcomes.',
      '',
      '## Technical Phase Summary',
      '',
      'Reuse the existing PRD generation pipeline.',
      '',
    ].join('\n'));
  });

  it('VT-05 / TBI-003 DoD-1 omits an absent Technical summary', () => {
    const transcript = renderPhaseKickoffTranscript({
      interviewTitle: 'Requirements only',
      originalPrompt: null,
      requirementsSummary: 'Define the user-visible behavior.',
      technicalSummary: null,
    });

    expect(transcript).toContain('## Requirements Phase Summary');
    expect(transcript).not.toContain('Technical Phase Summary');
    expect(transcript).not.toContain('Original Prompt');
  });
});
