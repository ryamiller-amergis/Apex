import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRAINSTORM_SKILL_PATH } from '../../shared/types/brainstorm';

describe('Brainstorm skill contract (VT-17)', () => {
  const skill = readFileSync(resolve(__dirname, '../../..', BRAINSTORM_SKILL_PATH), 'utf8');

  it('declares the brainstorm skill name', () => {
    expect(skill).toMatch(/^---\r?\nname: brainstorm\r?\n/);
  });

  it('forbids a scripted one-question interview', () => {
    expect(skill).toMatch(/No scripted single question/);
    expect(skill).toMatch(/Do not run a one-question-at-a-time interview/);
  });

  it('raises only material constraints until the creator converges, then probes edge cases', () => {
    expect(skill).toMatch(/Material constraints first/);
    expect(skill).toMatch(/raise only constraints that would change the direction/);
    expect(skill).toMatch(/Edge cases when they converge/);
  });

  it('changes the artifact only through the update tool, with the whole document', () => {
    expect(skill).toMatch(/call `brainstorm_update_artifact` with the complete revised Markdown/);
    expect(skill).toMatch(/Do not paste the artifact into chat/);
  });

  it('chooses and combines attached sources before saying a fact is unavailable', () => {
    expect(skill).toMatch(/Choose the source/);
    expect(skill).toMatch(/Combine sources/);
    expect(skill).toMatch(/call the one that fits/);
    expect(skill).toMatch(/When no artifact type is selected/);
    expect(skill).toMatch(/project repository and all available project MCP servers are attached by default/);
  });

  it('tailors replies to role, expertise, tone, project and goal', () => {
    expect(skill).toMatch(/role, expertise, tone, project and stated goal/);
    expect(skill).toMatch(/Creator context/);
  });
});
