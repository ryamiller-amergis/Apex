import fs from 'node:fs';
import path from 'node:path';

const AFFECTED_SKILLS = [
  'grill-with-docs',
  'grill-design',
  'to-prd',
  'prd-design-spec',
] as const;

const LINKED_CONTEXT_INSTRUCTION = [
  '## Linked context pre-read',
  '',
  'If `.ai-pilot/linked-context.md` is present in the workspace, read it before proceeding. Treat its provenance-labeled sections as authoritative project grounding. If it is absent, proceed normally.',
].join('\n');

const repoFile = (...segments: string[]): string =>
  path.resolve(process.cwd(), ...segments);

const readSkill = (...segments: string[]): string =>
  fs
    .readFileSync(repoFile(...segments, 'SKILL.md'), 'utf8')
    .replace(/\r\n/g, '\n');

const instructionCount = (definition: string): number =>
  definition.split(LINKED_CONTEXT_INSTRUCTION).length - 1;

describe('foundation Skill linked-context parity (TBI-005 / VT-01)', () => {
  it('DoD-0 / AC-0: includes the exact instruction once in all four canonical definitions', () => {
    for (const skill of AFFECTED_SKILLS) {
      const definition = readSkill('foundation-skills', 'foundation', skill);

      expect(definition).toContain(LINKED_CONTEXT_INSTRUCTION);
      expect(instructionCount(definition)).toBe(1);
    }
  });

  it('DoD-1 / BR-013: keeps each runtime mirror synchronized with canonical wording', () => {
    for (const skill of AFFECTED_SKILLS) {
      const canonical = readSkill('foundation-skills', 'foundation', skill);
      const runtime = readSkill('.cursor', 'skills', skill);

      expect(runtime).toContain(LINKED_CONTEXT_INSTRUCTION);
      expect(instructionCount(runtime)).toBe(1);
      expect(canonical.includes(LINKED_CONTEXT_INSTRUCTION)).toBe(
        runtime.includes(LINKED_CONTEXT_INSTRUCTION),
      );
    }
  });

  it('AC-1: explicitly proceeds normally when linked context is absent', () => {
    expect(LINKED_CONTEXT_INSTRUCTION).toContain(
      'If it is absent, proceed normally.',
    );
  });

  it('DoD-2 / AC-3 / BR-012: leaves an unrelated Skill without the instruction', () => {
    const unrelated = readSkill(
      'foundation-skills',
      'foundation',
      'ui-lab',
    );

    expect(unrelated).not.toContain(LINKED_CONTEXT_INSTRUCTION);
    expect(unrelated).not.toContain('.ai-pilot/linked-context.md');
  });

  it('DoD-3: exact-block assertions detect definition drift', () => {
    const drifted = LINKED_CONTEXT_INSTRUCTION.replace(
      'proceed normally',
      'continue',
    );

    expect(drifted).not.toContain(LINKED_CONTEXT_INSTRUCTION);
    expect(instructionCount(drifted)).toBe(0);
  });
});
