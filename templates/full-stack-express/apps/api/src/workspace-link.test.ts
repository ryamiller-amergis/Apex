import { CONTRACTS_STUB } from '@project-scope/contracts';
import { describe, expect, it } from 'vitest';

describe('workspace-link', () => {
  it('TBI-001 DoD-1 / VT-13 reads @project-scope/contracts', () => {
    expect(CONTRACTS_STUB).toBe('contracts-stub');
  });
});
