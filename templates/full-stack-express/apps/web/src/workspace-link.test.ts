import { CONTRACTS_STUB } from '@project-scope/contracts';
import { UI_STUB } from '@project-scope/ui';
import { describe, expect, it } from 'vitest';

describe('workspace-link', () => {
  it('TBI-001 DoD-1 / VT-13 reads @project-scope/contracts and @project-scope/ui', () => {
    expect(CONTRACTS_STUB).toBe('contracts-stub');
    expect(UI_STUB).toBe('ui-stub');
  });
});
