import { describe, expect, it } from 'vitest';
import { createAppQueryClient } from './queryClient';

describe('query client', () => {
  it('TBI-022 mutations do not retry and queries keep the library default', () => {
    const client = createAppQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(0);
    expect(client.getDefaultOptions().queries?.retry).toBeUndefined();
  });
});
