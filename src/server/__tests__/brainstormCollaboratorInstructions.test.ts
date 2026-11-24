import { BRAINSTORM_COLLABORATOR_INSTRUCTIONS } from '../services/brainstormCollaboratorInstructions';

describe('Brainstorm collaborator instructions (VT-17)', () => {
  const instructions = BRAINSTORM_COLLABORATOR_INSTRUCTIONS;

  it('starts with the collaborator heading', () => {
    expect(instructions.startsWith('# Brainstorm collaborator\n')).toBe(true);
  });

  it('forbids a scripted one-question interview', () => {
    expect(instructions).toMatch(/No scripted single question/);
    expect(instructions).toMatch(/Do not run a one-question-at-a-time interview/);
  });

  it('raises only material constraints until the creator converges, then probes edge cases', () => {
    expect(instructions).toMatch(/Material constraints first/);
    expect(instructions).toMatch(/raise only constraints that would change the direction/);
    expect(instructions).toMatch(/Edge cases when they converge/);
  });

  it('changes the artifact only through the update tool, with the whole document', () => {
    expect(instructions).toMatch(/call `brainstorm_update_artifact` with the complete revised Markdown/);
    expect(instructions).toMatch(/Do not paste the artifact into chat/);
  });

  it('chooses and combines attached sources before saying a fact is unavailable', () => {
    expect(instructions).toMatch(/Choose the source/);
    expect(instructions).toMatch(/Combine sources/);
    expect(instructions).toMatch(/call the one that fits/);
    expect(instructions).toMatch(/When no artifact type is selected/);
    expect(instructions).toMatch(/A new session includes only the Project Settings repository/);
  });

  it('tailors replies to role, expertise, tone, project and goal', () => {
    expect(instructions).toMatch(/role, expertise, tone, project and stated goal/);
    expect(instructions).toMatch(/Creator context/);
  });
});
