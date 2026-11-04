/**
 * S2 — Final check report parser, `isCheckPassed`, and `shouldRunFinalCheck` (VT-13, VT-14).
 */
import {
  isCheckPassed,
  parseFinalCheckReport,
  shouldRunFinalCheck,
} from '../services/build/finalCheckReport';

describe('finalCheckReport (TBI-023 DoD-0..1, DoD-3, PBI-025 AC-3 / VT-13, VT-14)', () => {
  it('VT-14 parses a valid fenced apex-final-check-report block and evaluates isCheckPassed', () => {
    const raw = [
      'Completed final check.',
      '```apex-final-check-report',
      JSON.stringify({
        schemaVersion: 1,
        validatedCommit: 'a'.repeat(40),
        repairedInSession: false,
        checks: [
          { kind: 'unit_full', outcome: 'passed', summary: 'All 42 unit tests passed' },
          { kind: 'unit_related', outcome: 'passed', summary: 'Related suite passed' },
          { kind: 'type_check', outcome: 'passed', summary: 'tsc passed' },
          { kind: 'lint', outcome: 'passed', summary: 'eslint passed' },
        ],
        standards: {
          status: 'reviewed',
          findings: [
            {
              rule: 'off_library_component',
              file: 'src/client/components/Foo.tsx',
              line: 14,
              resolution: 'exception',
              detail: 'Uses canvas element directly',
              exceptionReason: 'No chart primitive in shared library',
            },
          ],
          reviewSeconds: 45,
        },
        summary: 'All checks and standards passed.',
      }),
      '```',
    ].join('\n');

    const parsed = parseFinalCheckReport(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.report.validatedCommit).toBe('a'.repeat(40));
    expect(isCheckPassed(parsed.report)).toBe(true);
  });

  it('VT-14 returns no_block, invalid_json, or schema for malformed inputs and enforces exceptionReason', () => {
    expect(parseFinalCheckReport(null)).toEqual({ ok: false, reason: 'no_block' });
    expect(parseFinalCheckReport('no fenced block here')).toEqual({ ok: false, reason: 'no_block' });
    expect(parseFinalCheckReport('```apex-final-check-report\n{bad json\n```')).toEqual({
      ok: false,
      reason: 'invalid_json',
    });

    // Missing unit_full
    const missingUnitFull = JSON.stringify({
      schemaVersion: 1,
      validatedCommit: 'a'.repeat(40),
      repairedInSession: false,
      checks: [{ kind: 'unit_related', outcome: 'passed', summary: 'ok' }],
      standards: { status: 'reviewed', findings: [] },
      summary: 'ok',
    });
    expect(parseFinalCheckReport(`\`\`\`apex-final-check-report\n${missingUnitFull}\n\`\`\``)).toEqual({
      ok: false,
      reason: 'schema',
    });

    // Unknown top-level key
    const unknownKey = JSON.stringify({
      schemaVersion: 1,
      validatedCommit: 'a'.repeat(40),
      repairedInSession: false,
      checks: [
        { kind: 'unit_full', outcome: 'passed', summary: 'ok' },
        { kind: 'unit_related', outcome: 'passed', summary: 'ok' },
      ],
      standards: { status: 'reviewed', findings: [] },
      summary: 'ok',
      extraField: true,
    });
    expect(parseFinalCheckReport(`\`\`\`apex-final-check-report\n${unknownKey}\n\`\`\``)).toEqual({
      ok: false,
      reason: 'schema',
    });

    // PBI-025 AC-3: exception without exceptionReason is rejected
    const exceptionNoReason = JSON.stringify({
      schemaVersion: 1,
      validatedCommit: 'a'.repeat(40),
      repairedInSession: false,
      checks: [
        { kind: 'unit_full', outcome: 'passed', summary: 'ok' },
        { kind: 'unit_related', outcome: 'passed', summary: 'ok' },
      ],
      standards: {
        status: 'reviewed',
        findings: [
          {
            rule: 'off_library_component',
            file: 'src/client/Foo.tsx',
            resolution: 'exception',
            detail: 'Custom widget',
          },
        ],
      },
      summary: 'ok',
    });
    expect(parseFinalCheckReport(`\`\`\`apex-final-check-report\n${exceptionNoReason}\n\`\`\``)).toEqual({
      ok: false,
      reason: 'schema',
    });
  });

  it('VT-14 truncates 600-char summaries to 500 chars and 60 failedTests to 50 entries, and redacts secrets', () => {
    const longSummary = 'x'.repeat(600);
    const sixtyTests = Array.from({ length: 60 }, (_, i) => `test-${i}`);
    const payload = JSON.stringify({
      schemaVersion: 1,
      validatedCommit: 'b'.repeat(40),
      repairedInSession: true,
      checks: [
        {
          kind: 'unit_full',
          outcome: 'failed',
          failedTests: sixtyTests,
          summary: longSummary,
        },
        { kind: 'unit_related', outcome: 'passed', summary: 'Bearer secretToken123456' },
      ],
      standards: {
        status: 'reviewed',
        findings: [
          {
            rule: 'duplicate_helper',
            file: 'src/utils/date.ts',
            line: 10,
            resolution: 'fixed',
            detail: longSummary,
          },
        ],
      },
      summary: longSummary,
    });

    const parsed = parseFinalCheckReport(`\`\`\`apex-final-check-report\n${payload}\n\`\`\``);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.report.summary).toHaveLength(500);
    expect(parsed.report.checks[0].summary).toHaveLength(500);
    expect(parsed.report.checks[0].failedTests).toHaveLength(50);
    expect(parsed.report.checks[1].summary).not.toContain('secretToken123456');
    if (parsed.report.standards.status === 'reviewed') {
      expect(parsed.report.standards.findings[0].detail).toHaveLength(500);
    }
    expect(isCheckPassed(parsed.report)).toBe(false);
  });

  it('VT-13 TBI-023 DoD-3 / PBI-024 AC-2 shouldRunFinalCheck returns false for one own_agent (plus chains/omitted) and true for two own_agent tasks', () => {
    expect(
      shouldRunFinalCheck([
        { role: 'implementer', status: 'merged', runMode: 'own_agent' },
        { role: 'implementer', status: 'merged', runMode: 'chain' },
        { role: 'qa', status: 'omitted', runMode: 'own_agent' },
      ]),
    ).toBe(false);

    expect(
      shouldRunFinalCheck([
        { role: 'implementer', status: 'merged', runMode: 'own_agent' },
        { role: 'implementer', status: 'merged', runMode: 'own_agent' },
      ]),
    ).toBe(true);
  });
});
