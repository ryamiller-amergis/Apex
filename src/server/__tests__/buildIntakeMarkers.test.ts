import {
  BUILD_INTAKE_CONFIRM_MARKER,
  BUILD_INTAKE_QUESTION_MARKER,
  countQuestionMarkers,
  hasConfirmMarker,
  stripBuildIntakeMarkers,
  warningClasses,
} from '../../shared/utils/buildIntakeMarkers';

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
