const mockResolveThreadAccess = jest.fn();
const mockCanWriteThread = jest.fn();
const mockGetUserPermissions = jest.fn();
const mockAdoWriteFromToken = jest.fn();
const mockGetAdoTokenForThread = jest.fn();

jest.mock('../services/threadAccessService', () => ({
  resolveThreadAccess: (...args: unknown[]) => mockResolveThreadAccess(...args),
  canWriteThread: (...args: unknown[]) => mockCanWriteThread(...args),
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: (...args: unknown[]) => mockGetUserPermissions(...args),
}));

jest.mock('../services/adoFactory', () => ({
  adoWriteFromToken: (...args: unknown[]) => mockAdoWriteFromToken(...args),
}));

jest.mock('../services/standupTokenResolver', () => ({
  getAdoTokenForThread: (...args: unknown[]) =>
    mockGetAdoTokenForThread(...args),
}));

import {
  adoServiceForChatOrStandupWrite,
  adoServiceForChatThread,
  registerChatAdoWriteTurn,
} from '../services/chatAdoWriteAuth';

describe('chat ADO write authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveThreadAccess.mockResolvedValue({
      access: 'owner',
      thread: { kickoff: { project: 'Apex' } },
    });
    mockCanWriteThread.mockResolvedValue(true);
    mockGetUserPermissions.mockResolvedValue(
      new Set(['chat:view', 'workitems:write']),
    );
    mockAdoWriteFromToken.mockReturnValue({ kind: 'per-user-ado-service' });
    mockGetAdoTokenForThread.mockResolvedValue(null);
  });

  it('binds the current user token to the authorized thread turn', async () => {
    const release = await registerChatAdoWriteTurn({
      threadId: 'thread-1',
      userId: 'user-1',
      project: 'Apex',
      token: 'user-bearer-token',
    });

    expect(mockGetUserPermissions).toHaveBeenCalledWith('user-1', 'Apex');
    expect(adoServiceForChatThread('thread-1', 'Apex', 'Apex\\Team')).toEqual({
      kind: 'per-user-ado-service',
    });
    expect(mockAdoWriteFromToken).toHaveBeenCalledWith(
      'user-bearer-token',
      'Apex',
      'Apex\\Team',
    );

    release();
    expect(() => adoServiceForChatThread('thread-1', 'Apex')).toThrow(
      'explicit request in the current chat turn',
    );
  });

  it('rejects users without workitems:write', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['chat:view']));

    await expect(
      registerChatAdoWriteTurn({
        threadId: 'thread-2',
        userId: 'user-1',
        project: 'Apex',
        token: 'user-bearer-token',
      }),
    ).rejects.toThrow('do not have permission');
    expect(mockAdoWriteFromToken).not.toHaveBeenCalled();
  });

  it('allows existing non-owner thread write access', async () => {
    mockResolveThreadAccess.mockResolvedValue({
      access: 'read',
      thread: { kickoff: { project: 'Apex' } },
    });

    const release = await registerChatAdoWriteTurn({
      threadId: 'assistant-thread',
      userId: 'approver-1',
      project: 'Apex',
      token: 'approver-token',
    });

    expect(mockCanWriteThread).toHaveBeenCalledWith(
      'approver-1',
      'assistant-thread',
    );
    expect(() =>
      adoServiceForChatThread('assistant-thread', 'OtherProject'),
    ).toThrow('does not match');
    release();
  });

  it('passes a missing token to production-safe adoWriteFromToken', async () => {
    const authError = new Error('ADO user token required');
    authError.name = 'AdoUserAuthError';
    mockAdoWriteFromToken.mockImplementation(() => {
      throw authError;
    });
    const release = await registerChatAdoWriteTurn({
      threadId: 'thread-no-token',
      userId: 'user-1',
      project: 'Apex',
      token: null,
    });

    expect(() =>
      adoServiceForChatThread('thread-no-token', 'Apex'),
    ).toThrow('ADO user token required');
    expect(mockAdoWriteFromToken).toHaveBeenCalledWith(null, 'Apex', undefined);
    release();
  });

  it('falls back to a standup participant token when no chat turn is registered', async () => {
    mockGetAdoTokenForThread.mockResolvedValue('standup-participant-token');
    mockAdoWriteFromToken.mockReturnValue({ kind: 'standup-ado-service' });

    await expect(
      adoServiceForChatOrStandupWrite('standup-thread', 'Apex', 'Apex\\Team'),
    ).resolves.toEqual({ kind: 'standup-ado-service' });
    expect(mockGetAdoTokenForThread).toHaveBeenCalledWith('standup-thread');
    expect(mockAdoWriteFromToken).toHaveBeenCalledWith(
      'standup-participant-token',
      'Apex',
      'Apex\\Team',
    );
  });

  it('falls back to a standup participant token when the chat turn has no user token', async () => {
    mockGetAdoTokenForThread.mockResolvedValue('standup-participant-token');
    mockAdoWriteFromToken.mockReturnValue({ kind: 'standup-ado-service' });
    const release = await registerChatAdoWriteTurn({
      threadId: 'standup-null-token',
      userId: 'user-1',
      project: 'Apex',
      token: null,
    });

    await expect(
      adoServiceForChatOrStandupWrite(
        'standup-null-token',
        'Apex',
        'Apex\\Team',
      ),
    ).resolves.toEqual({ kind: 'standup-ado-service' });
    expect(mockGetAdoTokenForThread).toHaveBeenCalledWith('standup-null-token');
    expect(mockAdoWriteFromToken).toHaveBeenCalledWith(
      'standup-participant-token',
      'Apex',
      'Apex\\Team',
    );
    expect(mockAdoWriteFromToken).not.toHaveBeenCalledWith(
      null,
      'Apex',
      'Apex\\Team',
    );
    release();
  });

  it('keeps denying home-chat writes when neither a turn nor standup token exists', async () => {
    await expect(
      adoServiceForChatOrStandupWrite('home-thread', 'Apex'),
    ).rejects.toThrow('explicit request in the current chat turn');
    expect(mockAdoWriteFromToken).not.toHaveBeenCalled();
  });
});
