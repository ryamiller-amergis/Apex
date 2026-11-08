import {
  BUILD_INTAKE_CONFIRM_MARKER,
  BUILD_INTAKE_QUESTION_MARKER,
  countQuestionMarkers,
  extraQuestionReasons,
  extraReasonMarker,
  hasConfirmMarker,
  isBuildIntakeConfirmation,
  lastVisibleAgentText,
  stripBuildIntakeMarkers,
  warningClasses,
} from '../../shared/utils/buildIntakeMarkers';

describe('extra-question reason markers', () => {
  it('reads known reasons once each and drops unknown ones', () => {
    const text = `${extraReasonMarker('access')} [[build-intake:reason:colour]] ${extraReasonMarker('access')} ${extraReasonMarker('workflow')}`;
    expect(extraQuestionReasons(text)).toEqual(['access', 'workflow']);
  });

  it('is stripped before display', () => {
    expect(stripBuildIntakeMarkers(`${BUILD_INTAKE_QUESTION_MARKER}${extraReasonMarker('integration')} Which system?`)).toBe('Which system?');
  });

  it('finds the latest visible agent message', () => {
    const messages = [
      { role: 'agent', text: 'first' },
      { role: 'user', text: 'reply' },
      { role: 'agent', text: 'hidden', hidden: true },
    ];
    expect(lastVisibleAgentText(messages)).toBe('first');
    expect(lastVisibleAgentText([])).toBeNull();
  });
});

describe('VT-01 — build-intake markers (TBI-009 DoD-1)', () => {
  it('counts question markers in visible agent messages only', () => {
    const messages = [
      { role: 'user', text: `I typed ${BUILD_INTAKE_QUESTION_MARKER} myself` },
      { role: 'agent', text: `${BUILD_INTAKE_QUESTION_MARKER} Who uses it?\n${BUILD_INTAKE_QUESTION_MARKER} Where?` },
      { role: 'agent', text: `${BUILD_INTAKE_QUESTION_MARKER} hidden`, hidden: true },
      { role: 'system', text: BUILD_INTAKE_QUESTION_MARKER },
    ];
    expect(countQuestionMarkers(messages)).toBe(2);
  });

  it('counts only questions asked since the last confirm message when asked to', () => {
    const messages = [
      { role: 'agent', text: `${BUILD_INTAKE_QUESTION_MARKER} One?` },
      { role: 'agent', text: `Summary ${BUILD_INTAKE_CONFIRM_MARKER}` },
      { role: 'agent', text: `${BUILD_INTAKE_QUESTION_MARKER} Two?` },
    ];
    expect(countQuestionMarkers(messages)).toBe(2);
    expect(countQuestionMarkers(messages, { sinceLastConfirm: true })).toBe(1);
  });

  it('detects the confirm marker and warning classes', () => {
    expect(hasConfirmMarker(`Done. ${BUILD_INTAKE_CONFIRM_MARKER}`)).toBe(true);
    expect(hasConfirmMarker('Done.')).toBe(false);
    expect(warningClasses(
      'Sensitive data warning [[build-intake:warning:access_token]] [[build-intake:warning:personal_email]] [[build-intake:warning:bogus]]',
    )).toEqual(['access_token', 'personal_email']);
  });

  it('strips complete markers and a marker cut off by streaming', () => {
    const text = `${BUILD_INTAKE_QUESTION_MARKER} Who uses it?\nPick one ${BUILD_INTAKE_CONFIRM_MARKER}\n[[build-intake:warning:access_token]] Remove it.\n[[build-int`;
    const stripped = stripBuildIntakeMarkers(text);
    expect(stripped).not.toContain('[[');
    expect(stripped).toContain('Who uses it?');
    expect(stripped).toContain('Remove it.');
  });

  it('leaves text without markers unchanged', () => {
    expect(stripBuildIntakeMarkers('Plain [link] text')).toBe('Plain [link] text');
  });
});

describe('FEAT-006 U1 — isBuildIntakeConfirmation', () => {
  const confirmPrompt = { role: 'agent', text: `Summary.\n${BUILD_INTAKE_CONFIRM_MARKER}\na. Confirm\nb. Change it` };

  it('is true when the answer picks Confirm on a confirm-marked agent message', () => {
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Answer: A — Confirm')).toBe(true);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Q1 · Is this right?\nAnswer: A — Confirm')).toBe(true);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'confirm')).toBe(true);
  });

  it('is false for "Change it" or when the latest agent message has no confirm marker', () => {
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Answer: B — Change it')).toBe(false);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Q1 · Is this right?\nAnswer: B — Change it')).toBe(false);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Change the title\na lot')).toBe(false);
  });

  it('is false for an ordinary sentence that starts with "a" or "confirm", or a free-text pick', () => {
    expect(isBuildIntakeConfirmation([confirmPrompt], 'a manager should approve it too')).toBe(false);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Confirm it only works on mobile?')).toBe(false);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Q1 · Is this right?\nAnswer: a few changes first')).toBe(false);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Answer: A\nNotes: wait')).toBe(false);
  });

  it('accepts a bare "a." or "Confirm!" reply', () => {
    expect(isBuildIntakeConfirmation([confirmPrompt], ' a. ')).toBe(true);
    expect(isBuildIntakeConfirmation([confirmPrompt], 'Confirm!')).toBe(true);
    expect(isBuildIntakeConfirmation([confirmPrompt, { role: 'agent', text: 'What should change?' }], 'a')).toBe(false);
  });

  it('ignores hidden agent messages', () => {
    expect(isBuildIntakeConfirmation([confirmPrompt, { role: 'agent', text: 'internal', hidden: true }], 'a')).toBe(true);
  });
});
