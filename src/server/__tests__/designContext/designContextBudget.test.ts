import { applyDesignContextBudget } from '../../services/designContext/designContextBudget';

const file = (path: string, size: number) => ({ path, content: 'x'.repeat(size) });

describe('designContextBudget', () => {
  it('fills the budget and names what it left out', () => {
    const result = applyDesignContextBudget([file('/a', 60), file('/b', 60)], 100);

    expect(result.included.map((f) => f.path)).toEqual(['/a']);
    expect(result.omitted).toEqual(['/b']);
    expect(result.usedBytes).toBe(60);
  });

  it('keeps everything when the budget allows', () => {
    const result = applyDesignContextBudget([file('/a', 10), file('/b', 10)], 100);

    expect(result.omitted).toEqual([]);
    expect(result.included).toHaveLength(2);
  });

  it('keeps later files that still fit after an oversized one is skipped', () => {
    const result = applyDesignContextBudget(
      [file('/big', 200), file('/small', 10)],
      100,
    );

    expect(result.included.map((f) => f.path)).toEqual(['/small']);
    expect(result.omitted).toEqual(['/big']);
  });
});
