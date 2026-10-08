import { applyBacklogEdits, flattenBacklogForPrompt, readBacklogEdits } from '../services/backlogEdits';

const backlog = {
  epics: [
    {
      title: 'Super Admin console',
      features: [
        {
          title: 'Roles',
          acceptanceCriteria: ['Super Admin can assign roles', 'Audit log entry'],
          tags: [],
        },
      ],
    },
  ],
};

describe('flattenBacklogForPrompt', () => {
  it('renders one path = value line per leaf', () => {
    expect(flattenBacklogForPrompt(backlog).split('\n')).toEqual([
      'epics[0].title = "Super Admin console"',
      'epics[0].features[0].title = "Roles"',
      'epics[0].features[0].acceptanceCriteria[0] = "Super Admin can assign roles"',
      'epics[0].features[0].acceptanceCriteria[1] = "Audit log entry"',
      'epics[0].features[0].tags = []',
    ]);
  });
});

describe('readBacklogEdits', () => {
  it('reads set and remove edits, treating a missing op as set', () => {
    expect(
      readBacklogEdits({ edits: [{ path: 'a', value: 1 }, { op: 'remove', path: 'b' }] }),
    ).toEqual([
      { op: 'set', path: 'a', value: 1 },
      { op: 'remove', path: 'b' },
    ]);
  });

  it('returns null for a reply that is not an edit list', () => {
    expect(readBacklogEdits(null)).toBeNull();
    expect(readBacklogEdits(backlog)).toBeNull();
    expect(readBacklogEdits({ edits: [{ op: 'set', path: 'a' }] })).toBeNull();
    expect(readBacklogEdits({ edits: [{ op: 'rename', path: 'a', value: 1 }] })).toBeNull();
  });
});

describe('applyBacklogEdits', () => {
  it('replaces existing values without touching the original', () => {
    const revised = applyBacklogEdits(backlog, [
      { op: 'set', path: 'epics[0].title', value: 'System Admin console' },
      {
        op: 'set',
        path: 'epics[0].features[0].acceptanceCriteria[0]',
        value: 'System Admin can assign roles',
      },
    ]) as typeof backlog;

    expect(revised.epics[0].title).toBe('System Admin console');
    expect(revised.epics[0].features[0].acceptanceCriteria).toEqual([
      'System Admin can assign roles',
      'Audit log entry',
    ]);
    expect(backlog.epics[0].title).toBe('Super Admin console');
  });

  it('appends at the next index and removes using the original indices', () => {
    const revised = applyBacklogEdits(backlog, [
      { op: 'set', path: 'epics[0].features[0].acceptanceCriteria[2]', value: 'Email sent' },
      { op: 'remove', path: 'epics[0].features[0].acceptanceCriteria[0]' },
      { op: 'remove', path: 'epics[0].features[0].tags' },
    ]) as { epics: { features: Record<string, unknown>[] }[] };

    expect(revised.epics[0].features[0]).toEqual({
      title: 'Roles',
      acceptanceCriteria: ['Audit log entry', 'Email sent'],
    });
  });

  it('returns null when any edit targets a path that does not exist', () => {
    expect(applyBacklogEdits(backlog, [])).toBeNull();
    expect(applyBacklogEdits(backlog, [{ op: 'set', path: 'epics[3].title', value: 'x' }])).toBeNull();
    expect(applyBacklogEdits(backlog, [{ op: 'set', path: 'epics[0].owner', value: 'x' }])).toBeNull();
    expect(applyBacklogEdits(backlog, [{ op: 'set', path: 'epics.title', value: 'x' }])).toBeNull();
    expect(applyBacklogEdits(backlog, [{ op: 'set', path: 'epics[0]..title', value: 'x' }])).toBeNull();
    expect(applyBacklogEdits(backlog, [{ op: 'remove', path: 'epics[1]' }])).toBeNull();
    expect(
      applyBacklogEdits(backlog, [
        { op: 'set', path: 'epics[0].title', value: 'ok' },
        { op: 'set', path: 'epics[0].missing', value: 'x' },
      ]),
    ).toBeNull();
  });

  it('rejects removing the same item twice', () => {
    expect(
      applyBacklogEdits(backlog, [
        { op: 'remove', path: 'epics[0].features[0].acceptanceCriteria[0]' },
        { op: 'remove', path: 'epics[0].features[0].acceptanceCriteria[0]' },
      ]),
    ).toBeNull();
  });
});
