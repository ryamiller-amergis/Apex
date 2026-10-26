import {
  decryptMcpServerCredential,
  encryptMcpServerCredential,
  maskMcpServerCredential,
} from '../services/mcpServerCredentialCrypto';

const SECRET = 'integration-test-secret';

describe('integration credential crypto (SC-3)', () => {
  it('SC-3 encrypts with AES-256-GCM and decrypts only for the same binding', () => {
    const encrypted = encryptMcpServerCredential(
      'sk_live_supersecret',
      { project: 'MaxView', connectionId: 'conn-1' },
      { secret: SECRET },
    );

    expect(encrypted.algorithm).toBe('aes-256-gcm');
    expect(encrypted.ciphertext).not.toContain('sk_live_supersecret');
    expect(encrypted.iv).not.toBe(encrypted.ciphertext);

    expect(
      decryptMcpServerCredential(encrypted, { project: 'MaxView', connectionId: 'conn-1' }, { secret: SECRET }),
    ).toBe('sk_live_supersecret');

    expect(() =>
      decryptMcpServerCredential(
        encrypted,
        { project: 'MatterWorx', connectionId: 'conn-1' },
        { secret: SECRET },
      ),
    ).toThrow();
  });

  it('SC-3 masks the credential and does not reveal the secret', () => {
    const hint = maskMcpServerCredential('sk_live_supersecret');
    expect(hint).toBe('••••cret');
    expect(hint).not.toContain('sk_live');
    expect(maskMcpServerCredential('ab')).toBe('••••');
  });
});
