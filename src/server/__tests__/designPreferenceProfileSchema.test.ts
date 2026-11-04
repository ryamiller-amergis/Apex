import { describe, expect, it } from '@jest/globals';
import { parseDesignPreferenceProfile } from '../../shared/designPreferenceProfileSchema';
import { emptyDesignPreferenceProfile } from '../../shared/types/designPreferenceProfile';

describe('designPreferenceProfileSchema', () => {
  it('accepts a minimal profile', () => {
    const result = parseDesignPreferenceProfile(emptyDesignPreferenceProfile());
    expect(result.ok).toBe(true);
  });

  it('rejects unknown fields', () => {
    const result = parseDesignPreferenceProfile({
      ...emptyDesignPreferenceProfile(),
      extra: true,
    });
    expect(result.ok).toBe(false);
  });
});
