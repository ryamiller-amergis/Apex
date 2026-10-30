import {
  canDeleteBrainstormSession,
  canMutateBrainstormSession,
  decideBrainstormAccess,
  type BrainstormSessionFacts,
  type BrainstormViewer,
} from '../services/brainstormAccessPolicy';

const ALL = new Set(['brainstorm:view', 'brainstorm:create']);

function viewer(overrides: Partial<BrainstormViewer> = {}): BrainstormViewer {
  return { id: 'creator', isSuperAdmin: false, isProjectMember: true, permissions: ALL, ...overrides };
}

const session: BrainstormSessionFacts = { project: 'alpha', creatorId: 'creator', state: 'active' };

describe('decideBrainstormAccess', () => {
  it.each([
    ['creator reads', viewer(), session, 'read', { kind: 'read' }],
    ['creator mutates an active session', viewer(), session, 'mutate', { kind: 'mutate' }],
    ['member reads', viewer({ id: 'member' }), session, 'read', { kind: 'read' }],
    ['member cannot mutate', viewer({ id: 'member' }), session, 'mutate', { kind: 'refuse', reason: 'not_creator' }],
    ['missing session', viewer(), null, 'read', { kind: 'refuse', reason: 'not_found' }],
    ['other project', viewer(), { ...session, project: 'beta' }, 'read', { kind: 'refuse', reason: 'not_found' }],
    ['non-member', viewer({ id: 'outsider', isProjectMember: false }), session, 'read', { kind: 'refuse', reason: 'not_found' }],
    ['no view permission', viewer({ permissions: new Set() }), session, 'read', { kind: 'refuse', reason: 'forbidden' }],
    ['creator without create permission', viewer({ permissions: new Set(['brainstorm:view']) }), session, 'mutate', { kind: 'refuse', reason: 'forbidden' }],
    ['ended session', viewer(), { ...session, state: 'ended' }, 'mutate', { kind: 'refuse', reason: 'session_not_active' }],
    ['failed session', viewer(), { ...session, state: 'failed' }, 'mutate', { kind: 'refuse', reason: 'session_not_active' }],
    ['ended session still readable', viewer({ id: 'member' }), { ...session, state: 'ended' }, 'read', { kind: 'read' }],
    [
      'Super Admin reads another member\'s session',
      viewer({ id: 'admin', isSuperAdmin: true, isProjectMember: false, permissions: new Set() }),
      session,
      'read',
      { kind: 'read' },
    ],
    [
      'Super Admin cannot change another member\'s session',
      viewer({ id: 'admin', isSuperAdmin: true }),
      session,
      'mutate',
      { kind: 'refuse', reason: 'not_creator' },
    ],
    [
      'Super Admin changes their own session',
      viewer({ id: 'creator', isSuperAdmin: true, permissions: new Set() }),
      session,
      'mutate',
      { kind: 'mutate' },
    ],
  ] as const)('%s', (_label, who, target, mode, expected) => {
    expect(decideBrainstormAccess({ viewer: who, project: 'alpha', session: target }, mode)).toEqual(expected);
  });

  it('reports canMutate only for the creator of an active session', () => {
    expect(canMutateBrainstormSession({ viewer: viewer(), project: 'alpha', session })).toBe(true);
    expect(canMutateBrainstormSession({ viewer: viewer({ id: 'member' }), project: 'alpha', session })).toBe(false);
  });

  it('allows the creator or Super Admin to delete active, ended, or failed sessions', () => {
    expect(canDeleteBrainstormSession({ viewer: viewer(), project: 'alpha', session })).toBe(true);
    expect(canDeleteBrainstormSession({ viewer: viewer(), project: 'alpha', session: { ...session, state: 'ended' } })).toBe(true);
    expect(canDeleteBrainstormSession({ viewer: viewer(), project: 'alpha', session: { ...session, state: 'failed' } })).toBe(true);
    expect(canDeleteBrainstormSession({ viewer: viewer({ id: 'admin', isSuperAdmin: true }), project: 'alpha', session: { ...session, state: 'ended' } })).toBe(true);
    expect(canDeleteBrainstormSession({ viewer: viewer({ id: 'member' }), project: 'alpha', session })).toBe(false);
  });
});
