/**
 * Allocation share math — mirrors runBedrockCostAllocation token distribution.
 */
function allocateByTokens(
  amountUsd: number,
  events: Array<{ id: string; tokens: number }>,
): Array<{ id: string; costUsd: number }> {
  const totalTokens = events.reduce((s, e) => s + e.tokens, 0);
  return events.map((e) => {
    const share = totalTokens > 0 ? e.tokens / totalTokens : 1 / events.length;
    return { id: e.id, costUsd: amountUsd * share };
  });
}

describe('bedrockCostAllocation share math', () => {
  it('distributes billed USD proportional to tokens and sums to the day total', () => {
    const allocated = allocateByTokens(10, [
      { id: 'a', tokens: 100 },
      { id: 'b', tokens: 300 },
      { id: 'c', tokens: 100 },
    ]);

    expect(allocated[0].costUsd).toBeCloseTo(2);
    expect(allocated[1].costUsd).toBeCloseTo(6);
    expect(allocated[2].costUsd).toBeCloseTo(2);
    expect(allocated.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(10);
  });

  it('splits evenly when all token counts are zero', () => {
    const allocated = allocateByTokens(9, [
      { id: 'a', tokens: 0 },
      { id: 'b', tokens: 0 },
      { id: 'c', tokens: 0 },
    ]);
    expect(allocated.every((r) => Math.abs(r.costUsd - 3) < 1e-9)).toBe(true);
  });
});
