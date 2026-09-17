import fs from 'node:fs';
import path from 'node:path';

const SKILL_PATH = ['.cursor', 'skills', 'requirements-phase', 'SKILL.md'];
const GRILL_WITH_DOCS_PATH = ['.cursor', 'skills', 'grill-with-docs', 'SKILL.md'];

const REDIRECT_SENTENCE =
  "That's an implementation choice — the Technical phase will cover it. Sticking to what the feature needs to do: …";

const SUMMARY_OUTPUT_PATH =
  '.ai-pilot/output/{interview-slug}.requirements-phase-summary.md';

const SUMMARY_SECTIONS = [
  'Feature intent',
  'Users and stakeholders',
  'In scope',
  'Out of scope',
  'Business rules and constraints',
  'Success criteria',
  'Unresolved requirements questions',
];

/** Terms that would presuppose a technical implementation (TBI-004 NFR). */
const TECHNICAL_TERMS = [
  'database',
  'schema',
  'migration',
  'endpoint',
  'API',
  'architecture',
  'data model',
  'component',
  'table',
  'deployment',
  'repository',
];

const readRepoFile = (segments: string[]): string =>
  fs.readFileSync(path.resolve(process.cwd(), ...segments), 'utf8').replace(/\r\n/g, '\n');

/** Return the body of a `## ` section, excluding the heading itself. */
const sectionBody = (definition: string, heading: string): string => {
  const start = definition.indexOf(`${heading}\n`);
  if (start === -1) return '';
  const after = start + heading.length;
  const next = definition.indexOf('\n## ', after);
  return next === -1 ? definition.slice(after) : definition.slice(after, next);
};

describe('requirements-phase Skill content (FEAT-004 / PBI-007 / TBI-004)', () => {
  const skill = readRepoFile(SKILL_PATH);

  it('DoD-0: exists at the exact path as a loadable project Skill named requirements-phase', () => {
    expect(fs.existsSync(path.resolve(process.cwd(), ...SKILL_PATH))).toBe(true);

    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^name: requirements-phase$/m);
    expect(frontmatter?.[1]).toMatch(/^description: .+/m);
  });

  it('DoD-0: stays under the 500-line authoring limit', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  it('DoD-0: pre-reads context.md and AGENTS.md before the first question', () => {
    const preRead = sectionBody(skill, '## Pre-read');

    expect(preRead).toContain('context.md');
    expect(preRead).toContain('AGENTS.md');
  });

  it('AC-0 / DoD-2: covers the five feature-level question areas', () => {
    const questions = sectionBody(skill, '## Question set');

    expect(questions).toMatch(/feature intent/i);
    expect(questions).toMatch(/target users/i);
    expect(questions).toMatch(/in-scope behavior/i);
    expect(questions).toMatch(/success criteria/i);
    expect(questions).toMatch(/non-goals/i);
  });

  it('DoD-2 / NFR: asks no question that presupposes a technical implementation', () => {
    const questions = sectionBody(skill, '## Question set');

    for (const term of TECHNICAL_TERMS) {
      expect(questions).not.toMatch(new RegExp(`\\b${term}\\b`, 'i'));
    }
  });

  it('AC-1: redirects implementation detail back to feature intent with the exact wording', () => {
    expect(skill).toContain(REDIRECT_SENTENCE);
  });

  it('AC-2: resumes from the existing transcript instead of restarting the question sequence', () => {
    const resume = sectionBody(skill, '## Resuming an unfinished phase');

    expect(resume).toMatch(/transcript/i);
    expect(resume).toMatch(/skip/i);
    expect(resume).toMatch(/do not restart/i);
  });

  it('AC-0 / DoD-1: writes a reviewable Requirements Phase Summary at session end', () => {
    expect(skill).toContain(SUMMARY_OUTPUT_PATH);

    for (const section of SUMMARY_SECTIONS) {
      expect(skill).toContain(section);
    }
  });

  it('PBI-007 out of scope: never generates a PRD', () => {
    const notDone = sectionBody(skill, '## What this skill does NOT do');

    expect(notDone).toMatch(/does not generate.*PRD/i);
  });

  it('BR-010 / DoD-3: leaves the existing feature-interview Skill untouched', () => {
    const grillWithDocs = readRepoFile(GRILL_WITH_DOCS_PATH);

    expect(grillWithDocs).toMatch(/^name: grill-with-docs$/m);
    expect(grillWithDocs).not.toMatch(/requirements-phase/i);
    expect(grillWithDocs).not.toContain(SUMMARY_OUTPUT_PATH);
  });
});
