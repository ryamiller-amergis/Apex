const mockFindFirst = jest.fn();
const mockOnConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
const mockValues = jest.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockAcquire = jest.fn();
const mockSerialize = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: { userAdoCredentials: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    insert: () => ({ values: mockValues }),
  },
}));
jest.mock('../services/adoUserToken', () => ({
  ADO_SCOPE: 'ado/.default',
  DEV_MOCK_REFRESH_TOKEN: 'mock-refresh-token',
  getMsalClient: () => ({
    acquireTokenByRefreshToken: (...args: unknown[]) => mockAcquire(...args),
    getTokenCache: () => ({ serialize: () => mockSerialize() }),
  }),
}));

import {
  getStoredAdoTokenForUser,
  saveAdoRefreshToken,
} from '../services/adoStoredUserToken';
import {
  decryptMcpServerCredential,
  encryptMcpServerCredential,
} from '../services/mcpServerCredentialCrypto';

const binding = { project: 'user-ado-credential', connectionId: 'user-1' };

describe('adoStoredUserToken', () => {
  const previousSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SESSION_SECRET = 'test-session-secret';
  });

  afterAll(() => {
    process.env.SESSION_SECRET = previousSecret;
  });

  it('saves the refresh token encrypted for that user', async () => {
    await saveAdoRefreshToken('user-1', 'refresh-1');

    const row = (mockValues.mock.calls[0] as unknown as [{ userId: string; encryptedRefreshToken: never }])[0];
    expect(row.userId).toBe('user-1');
    expect(JSON.stringify(row)).not.toContain('refresh-1');
    expect(decryptMcpServerCredential(row.encryptedRefreshToken, binding)).toBe('refresh-1');
  });

  it('does not save the dev-login token or an anonymous user', async () => {
    await saveAdoRefreshToken('user-1', 'mock-refresh-token');
    await saveAdoRefreshToken('anonymous', 'refresh-1');

    expect(mockValues).not.toHaveBeenCalled();
  });

  it('returns null when the user has no saved token', async () => {
    mockFindFirst.mockResolvedValue(undefined);

    await expect(getStoredAdoTokenForUser('user-1')).resolves.toBeNull();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('redeems the saved token and keeps the rotated one', async () => {
    mockFindFirst.mockResolvedValue({
      userId: 'user-1',
      encryptedRefreshToken: encryptMcpServerCredential('refresh-1', binding),
    });
    mockAcquire.mockResolvedValue({ accessToken: 'access-1', account: { homeAccountId: 'home-1' } });
    mockSerialize.mockReturnValue(JSON.stringify({
      RefreshToken: {
        other: { home_account_id: 'home-2', secret: 'someone-else' },
        mine: { home_account_id: 'home-1', secret: 'refresh-2' },
      },
    }));

    await expect(getStoredAdoTokenForUser('user-1')).resolves.toBe('access-1');
    expect(mockAcquire).toHaveBeenCalledWith({ refreshToken: 'refresh-1', scopes: ['ado/.default'] });
    const saved = (mockValues.mock.calls[0] as unknown as [{ encryptedRefreshToken: never }])[0];
    expect(decryptMcpServerCredential(saved.encryptedRefreshToken, binding)).toBe('refresh-2');
  });

  it('returns null when the saved token no longer redeems', async () => {
    mockFindFirst.mockResolvedValue({
      userId: 'user-1',
      encryptedRefreshToken: encryptMcpServerCredential('refresh-1', binding),
    });
    mockAcquire.mockRejectedValue(new Error('AADSTS700082: The refresh token has expired'));

    await expect(getStoredAdoTokenForUser('user-1')).resolves.toBeNull();
  });

  it('returns null when the token was saved for another user', async () => {
    mockFindFirst.mockResolvedValue({
      userId: 'user-1',
      encryptedRefreshToken: encryptMcpServerCredential('refresh-1', { ...binding, connectionId: 'user-2' }),
    });

    await expect(getStoredAdoTokenForUser('user-1')).resolves.toBeNull();
    expect(mockAcquire).not.toHaveBeenCalled();
  });
});
