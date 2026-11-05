import { describe, expect, it } from 'vitest';
import { coverageFloors, defineTestProject } from './testing.mjs';

describe('defineTestProject', () => {
  it('VT-13 TBI-023 DoD-4 drops a thresholds field passed beside name and environment', () => {
    const project = defineTestProject({
      name: 'unit',
      environment: 'node',
      thresholds: { lines: 1, branches: 1 },
    });
    expect(project.test.name).toBe('unit');
    expect(project.test.environment).toBe('node');
    expect(JSON.stringify(project)).not.toContain('thresholds');
    expect(project.test.thresholds).toBeUndefined();
  });

  it('exports the shared floors once', () => {
    expect(coverageFloors).toEqual({
      lines: 80,
      functions: 80,
      statements: 80,
      branches: 75,
    });
  });
});
