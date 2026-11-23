/**
 * The Teams webhook URL is a secret: stored encrypted per project, shown only masked.
 */
import {
  decryptWebhookUrl,
  encryptWebhookUrl,
  isTeamsWorkflowsWebhookUrl,
  maskWebhookUrl,
  readMaskedWebhook,
} from '../services/incidentTriageWebhookCrypto';

const URL_WITH_SECRET =
  'https://prod-12.westus.logic.azure.com:443/workflows/abc123/triggers/manual/paths/invoke?sig=Zk9s-secret-wxyz';
const PLAIN_URL = 'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=wxyz';

let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'unit-test-session-secret';
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});

describe('encryptWebhookUrl', () => {
  it('round-trips', () => {
    const envelope = encryptWebhookUrl('Apex', PLAIN_URL);

    expect(decryptWebhookUrl('Apex', envelope as unknown as Record<string, unknown>)).toBe(PLAIN_URL);
  });

  it('keeps the URL out of the stored envelope', () => {
    const envelope = encryptWebhookUrl('Apex', PLAIN_URL);

    const stored = JSON.stringify(envelope);
    expect(stored).not.toContain('workflows');
    expect(stored).not.toContain('sig=');
    expect(envelope.algorithm).toBe('aes-256-gcm');
  });

  it('wrong project fails to decrypt', () => {
    const envelope = encryptWebhookUrl('Apex', PLAIN_URL);

    expect(() => decryptWebhookUrl('Other', envelope as unknown as Record<string, unknown>)).toThrow();
  });

  it('refuses an envelope with missing fields', () => {
    expect(() => decryptWebhookUrl('Apex', { iv: 'x' })).toThrow();
  });

  it('throws without the session secret', () => {
    delete process.env.SESSION_SECRET;

    expect(() => encryptWebhookUrl('Apex', PLAIN_URL)).toThrow();
  });
});

describe('maskWebhookUrl', () => {
  it('mask shows the host and nothing from the path or signature', () => {
    const masked = maskWebhookUrl(URL_WITH_SECRET);

    expect(masked).toBe('prod-12.westus.logic.azure.com…');
    expect(masked).not.toContain('workflows');
    expect(masked).not.toContain('secret');
    expect(masked).not.toContain('wxyz');
  });

  it('returns a fixed placeholder for text that is not a URL', () => {
    const masked = maskWebhookUrl('not a url 1234');

    expect(masked).toBe('Webhook saved');
    expect(masked).not.toContain('1234');
  });

  it('is stored with the envelope and read back without decrypting', () => {
    const envelope = encryptWebhookUrl('Apex', PLAIN_URL);

    expect(readMaskedWebhook(envelope as unknown as Record<string, unknown>)).toBe('prod-12.westus.logic.azure.com…');
    expect(readMaskedWebhook(null)).toBeNull();
    expect(readMaskedWebhook({ iv: 'x' })).toBeNull();
  });
});

describe('isTeamsWorkflowsWebhookUrl', () => {
  it.each([
    'https://prod-12.westus.logic.azure.com/workflows/abc?sig=1',
    'https://default123.12.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x',
    'https://x.powerautomate.com/flow',
    'https://X.Logic.Azure.Com/workflows/abc',
  ])('accepts %s', (value) => {
    expect(isTeamsWorkflowsWebhookUrl(value)).toBe(true);
  });

  it.each([
    ['http scheme', 'http://prod-12.westus.logic.azure.com/workflows/abc'],
    ['another host', 'https://example.com/workflows/abc'],
    ['a look-alike host', 'https://logic.azure.com.evil.example/workflows/abc'],
    ['the bare suffix', 'https://logic.azure.com/workflows/abc'],
    ['credentials in the URL', 'https://user:pw@prod-12.westus.logic.azure.com/workflows/abc'],
    ['a port', 'https://prod-12.westus.logic.azure.com:8443/workflows/abc'],
    ['not a URL', 'prod-12.westus.logic.azure.com'],
    ['a very long URL', `https://x.logic.azure.com/${'a'.repeat(3000)}`],
  ])('rejects %s', (_label, value) => {
    expect(isTeamsWorkflowsWebhookUrl(value)).toBe(false);
  });
});
