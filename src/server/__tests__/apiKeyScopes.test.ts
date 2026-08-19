/**
 * Unit tests for API key scope catalog + normalization.
 */
import {
  API_KEY_SCOPES,
  ApiKeyValidationError,
  normalizeApiKeyScopes,
} from '../../shared/types/apiKey';

describe('normalizeApiKeyScopes', () => {
  it('defaults missing scopes to an empty allow-list (ping-only)', () => {
    expect(normalizeApiKeyScopes(undefined)).toEqual([]);
    expect(normalizeApiKeyScopes(null)).toEqual([]);
  });

  it('accepts the catalog of view/submit scopes and de-dupes', () => {
    expect(
      normalizeApiKeyScopes([
        'flags:evaluate',
        'feature-requests:submit',
        'flags:evaluate',
      ]),
    ).toEqual(['flags:evaluate', 'feature-requests:submit']);
  });

  it('rejects unknown or manage-class scopes', () => {
    expect(() => normalizeApiKeyScopes(['api-keys:manage'])).toThrow(ApiKeyValidationError);
    expect(() => normalizeApiKeyScopes(['feature-requests:manage'])).toThrow(
      /Invalid API key scope/,
    );
    expect(() => normalizeApiKeyScopes('flags:evaluate')).toThrow(/must be an array/);
  });

  it('exposes only the agreed public scope catalog', () => {
    expect([...API_KEY_SCOPES]).toEqual([
      'flags:evaluate',
      'feature-requests:view',
      'feature-requests:submit',
      'standup:summary:read',
      'backlog:export',
    ]);
  });
});
