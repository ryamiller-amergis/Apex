/**
 * Implementer prompt contract unit tests (VT-04, VT-05).
 * Owning items: TBI-020, PBI-022.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEvidenceBlock } from '../services/builds/evidenceBlockParser';
import {
  decideTaskDone,
  type OwnedRequirementSpec,
} from '../services/builds/verificationEvidenceChecker';

const SKILL_PATH = path.resolve(__dirname, '../../../.cursor/skills/build-implementer/SKILL.md');

describe('build-implementer prompt contract (.cursor/skills/build-implementer/SKILL.md)', () => {
  it('VT-04: contains red-then-green commit rules, quality manifest keys, search-before-create, standards review, small-path escalation keeping red tests, commit formats, and remains model-neutral', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');

    // YAML frontmatter
    expect(content).toMatch(/^---\r?\n[\s\S]*?name:\s*build-implementer\b[\s\S]*?---/);
    expect(content).toMatch(/disable-model-invocation:\s*true/);

    // DoD-0: Red-then-green commits per owned requirement and risk decision, with commit message formats
    expect(content).toMatch(/test\(<ID>\):/);
    expect(content).toMatch(/feat\(<ID>\):/);
    expect(content.toLowerCase()).toContain('red');
    expect(content.toLowerCase()).toContain('green');
    expect(content).toMatch(/risk decision/i);

    // DoD-1: Quality manifest keys
    expect(content).toContain('typeCheck');
    expect(content).toContain('lint');
    expect(content).toContain('relatedTests');

    // DoD-2: Search before creating new components or helpers
    expect(content).toMatch(/search[\s\S]*?before creating/i);
    expect(content).toMatch(/reuse/i);

    // Standards review against the standards contract
    expect(content).toMatch(/standards contract/i);
    expect(content).toMatch(/design-system/i);
    expect(content).toMatch(/coding rules/i);
    expect(content).toMatch(/code map/i);

    // DoD-3: Small-path escalation rule that keeps red tests on the branch
    expect(content).toMatch(/escalat/i);
    expect(content).toMatch(/keep[\s\S]*?red test|red test[\s\S]*?carry over|red test[\s\S]*?kept/i);
    expect(content).toContain('planPath');

    // NFR: Model-neutral — no model or vendor names anywhere in the skill
    expect(content).not.toMatch(/\b(claude|gpt|gemini|sonnet|opus)\b/i);
    expect(content).not.toMatch(/claude|gpt|gemini|sonnet|opus/i);
  });

  it('VT-05: includes a complete apex-evidence example block that parses with parseEvidenceBlock and passes decideTaskDone with outcome done', () => {
    const content = fs.readFileSync(SKILL_PATH, 'utf8');

    const parsed = parseEvidenceBlock(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const { block } = parsed;
    expect(block.entries.length).toBeGreaterThanOrEqual(1);
    expect(block.checks.typeCheck).not.toBeNull();
    expect(block.checks.lint).not.toBeNull();
    expect(block.checks.relatedTests).not.toBeNull();

    const ownedIds: OwnedRequirementSpec[] = block.entries.map((entry) => ({
      id: entry.requirementId,
      kind: entry.requirementId.startsWith('RD-')
        ? 'risk_decision'
        : entry.requirementId.startsWith('DOD-')
          ? 'dod'
          : entry.requirementId.startsWith('BR-')
            ? 'br'
            : entry.requirementId.startsWith('NFR-')
              ? 'nfr'
              : 'ac',
      retired: false,
    }));

    const decision = decideTaskDone({
      ownedIds,
      block,
      manifest: {
        typeCheck: block.checks.typeCheck!.command,
        lint: block.checks.lint!.command,
        relatedTests: block.checks.relatedTests!.command,
      },
      ownedFiles: null,
    });

    expect(decision.outcome).toBe('done');
    expect(decision.mayReportDone).toBe(true);
    expect(decision.violations).toEqual([]);
    expect(decision.rows.every((row) => row.status === 'pass')).toBe(true);
  });
});
