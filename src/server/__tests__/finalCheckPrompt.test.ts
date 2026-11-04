/**
 * S5 — Final check prompt builder and skill/standards contract tests (TBI-023 DoD-0..1, PBI-025 AC-0..3 / VT-16, VT-17).
 */
import fs from 'fs';
import path from 'path';
import { buildFinalCheckPrompt } from '../services/build/finalCheckPrompt';

describe('finalCheckPrompt (TBI-023 DoD-0..1, PBI-025 AC-0..3 / VT-16, VT-17)', () => {
  it('VT-16 TBI-023 DoD-0, DoD-2 builds prompt with 4 quality commands, base commit, integration branch, 3 standards paths+hashes, remaining budget, and redacted prior summary', () => {
    const promptWithOneLeft = buildFinalCheckPrompt({
      integrationBranch: 'apex/build/run-123',
      baseCommit: '1'.repeat(40),
      qualityManifest: {
        unitSuite: 'npm run test:unit',
        relatedTests: 'npx jest --findRelatedTests {files}',
        typeCheck: 'npx tsc --noEmit',
        lint: 'npm run lint:check',
      },
      standardsContract: {
        designSystemFile: { path: '.cursor/skills/design-system/SKILL.md', hash: 'sha256-ds' },
        codingRules: { path: '.cursor/rules/react-coding-standards.mdc', hash: 'sha256-cr' },
        codeMap: { path: '.cursor/CODEMAP.md', hash: 'sha256-cm' },
      },
      contextNotesPath: '.ai-pilot/build-context-notes.md',
      repairAttemptsUsed: 1,
      priorReportSummary: 'Failed test with Bearer secretBearerToken999999',
    });

    expect(promptWithOneLeft).toContain('apex/build/run-123');
    expect(promptWithOneLeft).toContain('1'.repeat(40));
    expect(promptWithOneLeft).toContain('npm run test:unit');
    expect(promptWithOneLeft).toContain('npx jest --findRelatedTests {files}');
    expect(promptWithOneLeft).toContain('npx tsc --noEmit');
    expect(promptWithOneLeft).toContain('npm run lint:check');
    expect(promptWithOneLeft).toContain('.cursor/skills/design-system/SKILL.md');
    expect(promptWithOneLeft).toContain('sha256-ds');
    expect(promptWithOneLeft).toContain('.cursor/rules/react-coding-standards.mdc');
    expect(promptWithOneLeft).toContain('sha256-cr');
    expect(promptWithOneLeft).toContain('.cursor/CODEMAP.md');
    expect(promptWithOneLeft).toContain('sha256-cm');
    expect(promptWithOneLeft).toContain('1 repair attempt left');
    expect(promptWithOneLeft).not.toContain('secretBearerToken999999');
    expect(promptWithOneLeft).toContain('[REDACTED:bearer-token]');

    const reportOnlyPrompt = buildFinalCheckPrompt({
      integrationBranch: 'apex/build/run-123',
      baseCommit: '1'.repeat(40),
      qualityManifest: {
        unitSuite: 'npm run test:unit',
        relatedTests: 'npx jest --findRelatedTests {files}',
        typeCheck: 'npx tsc --noEmit',
        lint: 'npm run lint:check',
      },
      standardsContract: {
        designSystemFile: { path: '.cursor/skills/design-system/SKILL.md', hash: 'sha256-ds' },
        codingRules: { path: '.cursor/rules/react-coding-standards.mdc', hash: 'sha256-cr' },
        codeMap: { path: '.cursor/CODEMAP.md', hash: 'sha256-cm' },
      },
      contextNotesPath: null,
      repairAttemptsUsed: 2,
    });

    expect(reportOnlyPrompt).toMatch(/report-only/i);
    expect(reportOnlyPrompt).toContain('0 repair attempts left');
  });

  it('VT-17 PBI-025 AC-0..3, TBI-023 DoD-1 verifies .cursor/skills/build-final-check/SKILL.md and standards-review.md contracts', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const skillPath = path.join(repoRoot, '.cursor/skills/build-final-check/SKILL.md');
    const standardsPath = path.join(repoRoot, '.cursor/skills/build-final-check/standards-review.md');

    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const standardsContent = fs.readFileSync(standardsPath, 'utf8');

    expect(skillContent).toMatch(/full unit suite/i);
    expect(skillContent).toMatch(/related tests/i);
    expect(skillContent).toMatch(/type-check/i);
    expect(skillContent).toMatch(/lint/i);
    expect(skillContent).toMatch(/never delete, skip or weaken a test/i);
    expect(skillContent).toMatch(/report-only/i);
    expect(skillContent).toMatch(/re-run/i);
    expect(skillContent).toContain('apex-final-check-report');
    expect(skillContent).toContain('unreadable_input');

    expect(standardsContent).toContain('duplicate_helper');
    expect(standardsContent).toContain('hard_coded_colour');
    expect(standardsContent).toContain('off_library_component');
    expect(standardsContent).toContain('missing_accessibility');
    expect(standardsContent).toContain('exceptionReason');
  });
});
