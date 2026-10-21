import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  maskIntegrationCredential,
} from '../services/integrationCredentialCrypto';

const SECRET = 'integration-test-secret';

describe('integration credential crypto (SC-3)', () => {
  it('SC-3 encrypts with AES-256-GCM and decrypts only for the same binding', () => {
    const encrypted = encryptIntegrationCredential(
      'sk_live_supersecret',
      { project: 'MaxView', connectionId: 'conn-1' },
      { secret: SECRET },
    );

    expect(encrypted.algorithm).toBe('aes-256-gcm');
    expect(encrypted.ciphertext).not.toContain('sk_live_supersecret');
    expect(encrypted.iv).not.toBe(encrypted.ciphertext);

    expect(
      decryptIntegrationCredential(encrypted, { project: 'MaxView', connectionId: 'conn-1' }, { secret: SECRET }),
    ).toBe('sk_live_supersecret');

    expect(() =>
      decryptIntegrationCredential(
        encrypted,
        { project: 'MatterWorx', connectionId: 'conn-1' },
        { secret: SECRET },
      ),
    ).toThrow();
  });

  it('SC-3 masks the credential and does not reveal the secret', () => {
    const hint = maskIntegrationCredential('sk_live_supersecret');
    expect(hint).toBe('••••cret');
    expect(hint).not.toContain('sk_live');
    expect(maskIntegrationCredential('ab')).toBe('••••');
  });
});
