import { mapCostExplorerResults } from '../services/bedrockBillingSyncService';

describe('bedrockBillingSyncService', () => {
  describe('mapCostExplorerResults', () => {
    it('maps grouped UnblendedCost into daily USD totals', () => {
      const mapped = mapCostExplorerResults([
        {
          TimePeriod: { Start: '2026-08-01', End: '2026-08-02' },
          Groups: [
            { Keys: ['Amazon Bedrock'], Metrics: { UnblendedCost: { Amount: '1.25', Unit: 'USD' } } },
            { Keys: ['Amazon Bedrock'], Metrics: { UnblendedCost: { Amount: '0.75', Unit: 'USD' } } },
          ],
        },
      ]);

      expect(mapped).toHaveLength(1);
      expect(mapped[0].usageDate).toBe('2026-08-01');
      expect(mapped[0].amountUsd).toBeCloseTo(2.0);
    });

    it('falls back to Total when Groups is empty', () => {
      const mapped = mapCostExplorerResults([
        {
          TimePeriod: { Start: '2026-08-03T00:00:00Z', End: '2026-08-04T00:00:00Z' },
          Total: { UnblendedCost: { Amount: '3.50', Unit: 'USD' } },
        },
      ]);

      expect(mapped[0].usageDate).toBe('2026-08-03');
      expect(mapped[0].amountUsd).toBeCloseTo(3.5);
    });

    it('returns empty array for undefined results', () => {
      expect(mapCostExplorerResults(undefined)).toEqual([]);
    });
  });
});
