import { listPlaybookStepPaletteItems } from '../services/playbookStepPaletteService';

describe('listPlaybookStepPaletteItems', () => {
  it('lists every registered production step type with JSON schemas', () => {
    const items = listPlaybookStepPaletteItems();
    const stepTypes = items.map((item) => item.stepType).sort();
    expect(stepTypes).toEqual(
      ['approval-gate', 'branch', 'cursor-agent', 'ingest-artifact', 'interview', 'notify'].sort()
    );
    for (const item of items) {
      expect(item.inputJsonSchema).toBeTruthy();
      expect(item.outputJsonSchema).toBeTruthy();
      expect(item.requiredPermissions.length).toBeGreaterThan(0);
    }
  });
});
