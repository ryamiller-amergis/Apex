import {
  decryptInteractiveToolGrant,
  encryptInteractiveToolGrant,
} from '../services/interactiveToolGrantCrypto';

const USER_ID = '40000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'project-1';
const SECRET = 'unit-test-session-secret-with-sufficient-entropy';
const TOKEN = 'delegated-ado-token-value';
const EXPIRES_AT = '2026-09-23T18:00:00.000Z';
const BEFORE_EXPIRY = new Date('2026-09-23T17:00:00.000Z');

function encryptedGrant() {
  return encryptInteractiveToolGrant(
    {
      userId: USER_ID,
      projectId: PROJECT_ID,
      allowedOperations: ['ado:read', 'ado:write'],
      delegatedAdoToken: TOKEN,
      expiresAt: EXPIRES_AT,
    },
    { secret: SECRET },
  );
}

function changeBase64(value: string): string {
  const first = value[0] === 'A' ? 'B' : 'A';
  return `${first}${value.slice(1)}`;
}

describe('interactive tool grant crypto', () => {
  it('round trips an exact run-bound delegated token without storing plaintext', () => {
    const grant = encryptedGrant();

    expect(JSON.stringify(grant)).not.toContain(TOKEN);
    expect(grant).toMatchObject({
      userId: USER_ID,
      projectId: PROJECT_ID,
      allowedOperations: ['ado:read', 'ado:write'],
      expiresAt: EXPIRES_AT,
      encryptedAdoToken: {
        algorithm: 'aes-256-gcm',
      },
    });
    expect(
      decryptInteractiveToolGrant(
        grant,
        {
          userId: USER_ID,
          projectId: PROJECT_ID,
          now: BEFORE_EXPIRY,
        },
        { secret: SECRET },
      ),
    ).toBe(TOKEN);
  });

  it('supports a grant with no delegated token', () => {
    const grant = encryptInteractiveToolGrant(
      {
        userId: USER_ID,
        projectId: PROJECT_ID,
        allowedOperations: ['ado:read'],
        delegatedAdoToken: null,
        expiresAt: EXPIRES_AT,
      },
      { secret: SECRET },
    );

    expect(grant.encryptedAdoToken).toBeNull();
    expect(
      decryptInteractiveToolGrant(
        grant,
        {
          userId: USER_ID,
          projectId: PROJECT_ID,
          now: BEFORE_EXPIRY,
        },
        { secret: SECRET },
      ),
    ).toBeNull();
  });

  it('rejects expired or incorrectly bound grants', () => {
    const grant = encryptedGrant();

    expect(() =>
      decryptInteractiveToolGrant(
        grant,
        {
          userId: USER_ID,
          projectId: PROJECT_ID,
          now: new Date(EXPIRES_AT),
        },
        { secret: SECRET },
      ),
    ).toThrow('INTERACTIVE_V2_TOOL_GRANT_INVALID');
    expect(() =>
      decryptInteractiveToolGrant(
        grant,
        {
          userId: '40000000-0000-4000-8000-000000000002',
          projectId: PROJECT_ID,
          now: BEFORE_EXPIRY,
        },
        { secret: SECRET },
      ),
    ).toThrow('INTERACTIVE_V2_TOOL_GRANT_INVALID');
    expect(() =>
      decryptInteractiveToolGrant(
        grant,
        {
          userId: USER_ID,
          projectId: 'other-project',
          now: BEFORE_EXPIRY,
        },
        { secret: SECRET },
      ),
    ).toThrow('INTERACTIVE_V2_TOOL_GRANT_INVALID');
  });

  it.each(['iv', 'ciphertext', 'authTag'] as const)(
    'rejects a changed %s through GCM authentication',
    (field) => {
      const grant = encryptedGrant();
      const encrypted = grant.encryptedAdoToken!;
      const changed = {
        ...grant,
        encryptedAdoToken: {
          ...encrypted,
          [field]: changeBase64(encrypted[field]),
        },
      };

      expect(() =>
        decryptInteractiveToolGrant(
          changed,
          {
            userId: USER_ID,
            projectId: PROJECT_ID,
            now: BEFORE_EXPIRY,
          },
          { secret: SECRET },
        ),
      ).toThrow('INTERACTIVE_V2_TOOL_GRANT_INVALID');
    },
  );

  it('returns the stable 503 code when SESSION_SECRET is unavailable', () => {
    expect(() =>
      encryptInteractiveToolGrant(
        {
          userId: USER_ID,
          projectId: PROJECT_ID,
          allowedOperations: ['ado:read'],
          delegatedAdoToken: null,
          expiresAt: EXPIRES_AT,
        },
        { secret: '' },
      ),
    ).toThrow(
      expect.objectContaining({
        status: 503,
        code: 'INTERACTIVE_V2_TOOL_GRANT_UNAVAILABLE',
      }),
    );
  });
});
