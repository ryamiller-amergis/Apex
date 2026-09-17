import fs from 'node:fs';
import path from 'node:path';

const SKILL_PATH = ['.cursor', 'skills', 'technical-phase', 'SKILL.md'];
const REQUIREMENTS_PHASE_PATH = ['.cursor', 'skills', 'requirements-phase', 'SKILL.md'];
const GRILL_WITH_DOCS_PATH = ['.cursor', 'skills', 'grill-with-docs', 'SKILL.md'];

/** Seeded phase context the app writes before the phase agent runs (TBI-005 DoD-1). */
const KICKOFF_CONTEXT_PATH = '.ai-pilot/kickoff-context.md';

/** Stable marker path the app lifecycle consumes after every completed turn (AC-1 / DoD-3). */
const AMENDMENT_OUTPUT_PATH = '.ai-pilot/output/requirements-amendment.md';

/** Stable phase output path the app lifecycle consumes after every completed turn (DoD-2). */
const SUMMARY_OUTPUT_PATH =
  '.ai-pilot/output/{interview-slug}.technical-phase-summary.md';

const SUMMARY_SECTIONS = [
  'Architecture decisions',
  'Module boundaries and design',
  'Data and integration',
  'Quality, security, and operability',
  'Rollout',
  'Implementation sequence',
  'Unresolved technical questions',
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

describe('technical-phase Skill content (FEAT-005 / PBI-008 / TBI-005)', () => {
  const skill = readRepoFile(SKILL_PATH);

  it('DoD-0: exists at the exact path as a loadable project Skill named technical-phase', () => {
    expect(fs.existsSync(path.resolve(process.cwd(), ...SKILL_PATH))).toBe(true);

    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^name: technical-phase$/m);
    expect(frontmatter?.[1]).toMatch(/^description: .+/m);
  });

  it('DoD-0: stays under the 500-line authoring limit', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
  });

  it('AC-0 / DoD-1: reads the original prompt and approved Requirements summary from the seeded kickoff context before the first technical question', () => {
    const preRead = sectionBody(skill, '## Pre-read');

    expect(preRead).toContain(KICKOFF_CONTEXT_PATH);
    expect(preRead).toMatch(/original prompt/i);
    expect(preRead).toMatch(/approved Requirements/i);
    expect(preRead).toMatch(/do not ask the first .*question/i);
  });

  it('AC-2 / AC-3: states it runs only after phase eligibility and only as the assigned Technical owner', () => {
    const whenToLoad = sectionBody(skill, '## When to load this skill');

    expect(whenToLoad).toMatch(/eligib/i);
    expect(whenToLoad).toMatch(/Requirements phase .*approved|approved Requirements/i);
    expect(whenToLoad).toMatch(/assigned Technical owner/i);
  });

  it('AC-0: covers the six technical question areas', () => {
    const questions = sectionBody(skill, '## Question set');

    expect(questions).toMatch(/architecture/i);
    expect(questions).toMatch(/module boundaries/i);
    expect(questions).toMatch(/data and integration/i);
    expect(questions).toMatch(/security/i);
    expect(questions).toMatch(/operability/i);
    expect(questions).toMatch(/rollout/i);
    expect(questions).toMatch(/implementation sequencing/i);
  });

  it('AC-0: asks one question per message using the AskQuestion tool', () => {
    const style = sectionBody(skill, '## Conversation style');

    expect(style).toContain('AskQuestion');
    expect(style).toMatch(/one question per message/i);
  });

  it('AC-1: writes the complete replacement Requirements summary to the stable amendment path', () => {
    const amend = sectionBody(skill, '## Amending the approved Requirements summary');

    expect(amend).toContain(AMENDMENT_OUTPUT_PATH);
    expect(amend).toMatch(/complete/i);
    expect(amend).toMatch(/not a patch/i);
  });

  it('AC-1: confirms the amendment and continues the Technical conversation', () => {
    const amend = sectionBody(skill, '## Amending the approved Requirements summary');

    expect(amend).toMatch(/confirm/i);
    expect(amend).toMatch(/continue/i);
  });

  it('DoD-3 / NFR: amends only through the marker file the app consumes after each turn, never the database or storage', () => {
    const amend = sectionBody(skill, '## Amending the approved Requirements summary');
    expect(amend).toMatch(/after every completed turn/i);

    const notDone = sectionBody(skill, '## What this skill does NOT do');
    expect(notDone).toMatch(/database/i);
    expect(notDone).toMatch(/storage/i);
  });

  it('AC-0: resumes from the existing transcript instead of restarting the question sequence', () => {
    const resume = sectionBody(skill, '## Resuming an unfinished phase');

    expect(resume).toMatch(/transcript/i);
    expect(resume).toMatch(/skip/i);
    expect(resume).toMatch(/do not restart/i);
  });

  it('DoD-2: writes a reviewable Technical Phase Summary at the stable output path', () => {
    expect(skill).toContain(SUMMARY_OUTPUT_PATH);

    for (const section of SUMMARY_SECTIONS) {
      expect(skill).toContain(section);
    }
  });

  it('PBI-008 out of scope: never generates a PRD and never reopens the Requirements phase', () => {
    const notDone = sectionBody(skill, '## What this skill does NOT do');

    expect(notDone).toMatch(/does not generate.*PRD/i);
    expect(notDone).toMatch(/reopen/i);
  });

  it('DoD-3: leaves the existing requirements-phase Skill untouched', () => {
    const requirementsPhase = readRepoFile(REQUIREMENTS_PHASE_PATH);

    expect(requirementsPhase).toMatch(/^name: requirements-phase$/m);
    expect(requirementsPhase).not.toContain(AMENDMENT_OUTPUT_PATH);
    expect(requirementsPhase).not.toContain('technical-phase-summary');
  });

  it('DoD-3: leaves the existing feature-interview Skill untouched', () => {
    const grillWithDocs = readRepoFile(GRILL_WITH_DOCS_PATH);

    expect(grillWithDocs).toMatch(/^name: grill-with-docs$/m);
    expect(grillWithDocs).not.toMatch(/technical-phase/i);
    expect(grillWithDocs).not.toContain(AMENDMENT_OUTPUT_PATH);
  });
});
