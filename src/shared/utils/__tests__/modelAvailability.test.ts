import { resolveAvailableModelId } from '../modelAvailability';

const AVAILABLE = [
  { id: 'auto-smart' },
  { id: 'default' },
  { id: 'grok-4.7' },
  { id: 'composer-2.5' },
  { id: 'claude-opus-5-5' },
  { id: 'gpt-5.6-sol' },
];

describe('resolveAvailableModelId', () => {
  it('keeps a model the SDK offers', () => {
    expect(resolveAvailableModelId('composer-2.5', AVAILABLE)).toBe('composer-2.5');
  });

  it('maps a retired model to the newest listed model in its family', () => {
    expect(resolveAvailableModelId('claude-opus-4-6', AVAILABLE)).toBe('claude-opus-5-5');
    expect(resolveAvailableModelId('gpt-5.5', AVAILABLE)).toBe('gpt-5.6-sol');
  });

  it('falls back to default when no model in the family is listed', () => {
    expect(resolveAvailableModelId('claude-sonnet-4-6', AVAILABLE)).toBe('default');
  });

  it('keeps the requested model when the catalog is empty', () => {
    expect(resolveAvailableModelId('claude-opus-4-6', [])).toBe('claude-opus-4-6');
  });
});
