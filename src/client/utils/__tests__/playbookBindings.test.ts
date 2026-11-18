import type { PlaybookStepTypePaletteItem } from '../../../shared/types/playbook';
import { comparableOutputFields } from '../playbookBindings';

const AGENT: PlaybookStepTypePaletteItem = {
  stepType: 'cursor-agent',
  schemaVersion: 1,
  label: 'cursor-agent',
  sideEffect: 'read',
  requiredPermissions: [],
  inputJsonSchema: {},
  outputJsonSchema: {
    type: 'object',
    required: ['agentRunId'],
    properties: {
      agentRunId: { type: 'string' },
      reportMd: { type: 'string' },
      output: { type: 'string' },
      outcome: { type: 'string' },
    },
  },
  canSuspend: true,
  addable: true,
};

describe('comparableOutputFields', () => {
  it('offers the outcomes an agent step lists as a fixed choice', () => {
    const fields = comparableOutputFields(AGENT, { config: { outcomes: ['fixed', 'no issue'] } });
    expect(fields.find((field) => field.field === 'outcome')).toEqual({
      field: 'outcome',
      label: 'Outcome',
      kind: 'choice',
      choices: ['fixed', 'no issue'],
      optional: true,
    });
  });

  it('hides outcome when the agent step lists none, and hides superseded fields', () => {
    const names = comparableOutputFields(AGENT, { config: {} }).map((field) => field.field);
    expect(names).toEqual(['agentRunId', 'output']);
  });

  it('marks fields a step may leave out as optional', () => {
    const fields = comparableOutputFields(AGENT, { config: {} });
    expect(fields.find((field) => field.field === 'agentRunId')?.optional).toBe(false);
    expect(fields.find((field) => field.field === 'output')?.optional).toBe(true);
  });
});
