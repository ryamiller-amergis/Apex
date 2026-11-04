/**
 * S3 + S7 — Revision prompt builders and 3-question budget hook tests (PBI-030 AC-2, PBI-031 AC-1 / VT-09, VT-10).
 */
import {
  buildRevisionAgentPrompt,
  buildRevisionKickoffPrompt,
  prepareRevisionTurn,
} from '../services/buildRevisionPrompts';

describe('buildRevisionPrompts & prepareRevisionTurn (PBI-030 AC-2, PBI-031 AC-1 / VT-09, VT-10)', () => {
  it('VT-09 PBI-030 AC-2 kickoff prompt includes budget of 3, retired IDs with never reuse rule, feedback inside <<<FEEDBACK>>> markers, and instruction to ask 0 questions when clear', () => {
    const prompt = buildRevisionKickoffPrompt({
      revisionNumber: 2,
      feedback: 'Change the button label to Submit request',
      requirements: [
        { id: 'AC-1', kind: 'ac', text: 'Show form', retired: false },
        { id: 'AC-2', kind: 'ac', text: 'Old label', retired: true },
      ],
    });

    expect(prompt).toContain('3');
    expect(prompt).toContain('AC-2');
    expect(prompt).toMatch(/never reuse/i);
    expect(prompt).toContain('<<<FEEDBACK>>>');
    expect(prompt).toContain('Change the button label to Submit request');
    expect(prompt).toMatch(/ask no questions|0 questions|none when/i);
  });

  it('VT-10 PBI-030 AC-2 / TBI-026 prepareRevisionTurn returns null under 3 questions and returns Do not ask a question internalContext at 3 questions', () => {
    const twoQuestions = [
      { role: 'assistant' as const, content: 'Question 1?', hidden: false },
      { role: 'user' as const, content: 'Answer 1', hidden: false },
      { role: 'assistant' as const, content: 'Question 2?', hidden: false },
    ];
    expect(prepareRevisionTurn(twoQuestions)).toBeNull();

    const threeQuestions = [
      ...twoQuestions,
      { role: 'user' as const, content: 'Answer 2', hidden: false },
      { role: 'assistant' as const, content: 'Question 3?', hidden: false },
    ];
    const context = prepareRevisionTurn(threeQuestions);
    expect(context).toContain('Do not ask a question');
  });

  it('VT-29, VT-30 PBI-031 AC-1 includes catch-up conflict instruction only when catchUpConflict is true', () => {
    const cleanPrompt = buildRevisionAgentPrompt({
      revisionNumber: 2,
      defaultBranch: 'main',
      integrationBranch: 'apex/build/run-1',
      changedAndAddedIds: ['AC-2'],
      catchUpConflict: false,
    });
    expect(cleanPrompt).not.toMatch(/resolve conflicts/i);

    const conflictPrompt = buildRevisionAgentPrompt({
      revisionNumber: 2,
      defaultBranch: 'main',
      integrationBranch: 'apex/build/run-1',
      changedAndAddedIds: ['AC-2'],
      catchUpConflict: true,
    });
    expect(conflictPrompt).toMatch(/resolve conflicts/i);
    expect(conflictPrompt).toContain('main');
  });
});
