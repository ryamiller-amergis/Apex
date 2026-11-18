import { listPlaybookStepPaletteItems } from '../services/playbookStepPaletteService';

describe('listPlaybookStepPaletteItems', () => {
  it('lists every registered production step type with JSON schemas', () => {
    const items = listPlaybookStepPaletteItems();
    const stepTypes = items.map((item) => item.stepType).sort();
    expect(stepTypes).toEqual(
      [
        'apex-action',
        'approval-gate',
        'branch',
        'build',
        'cloud-agent',
        'connector',
        'cursor-agent',
        'foreach',
        'ingest-artifact',
        'interview',
        'join',
        'notify',
        'until',
      ].sort()
    );
    for (const item of items) {
      expect(item.inputJsonSchema).toBeTruthy();
      expect(item.outputJsonSchema).toBeTruthy();
      expect(item.requiredPermissions.length).toBeGreaterThan(0);
    }
  });

  it('keeps interview and build out of the library', () => {
    const items = listPlaybookStepPaletteItems();
    const notAddable = items.filter((item) => !item.addable).map((item) => item.stepType).sort();
    expect(notAddable).toEqual(['build', 'interview']);
  });
});
