/**
 * Shared Playbook templates: snapshot sanitising, share, list, install, and unshare.
 * The database is a queue of canned results; the assertions are about what the service decides.
 */
import type { PlaybookGraph } from '../../shared/types/playbook';

jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const selectResults: unknown[] = [];
const insertResults: Array<unknown | Error> = [];
const updateResults: unknown[] = [];
const insertedValues: unknown[] = [];

function chain(next: () => unknown | Promise<unknown>) {
  const handler: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'orderBy', 'leftJoin', 'limit', 'values', 'set', 'returning']) {
    handler[method] = (...args: unknown[]) => {
      if (method === 'values') insertedValues.push(args[0]);
      return handler;
    };
  }
  handler.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve()
      .then(next)
      .then(resolve, reject);
  return handler;
}

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => chain(() => selectResults.shift() ?? []),
    insert: () => chain(() => {
      const result = insertResults.shift();
      if (result instanceof Error) throw result;
      return result ?? [];
    }),
    update: () => chain(() => updateResults.shift() ?? []),
  },
}));

const createDefinition = jest.fn();
jest.mock('../services/playbookDefinitionService', () => ({
  createDefinition: (...args: unknown[]) => createDefinition(...args),
}));

import {
  PlaybookSharedTemplateInvalidError,
  PlaybookSharedTemplateNameTakenError,
  PlaybookSharedTemplateNotFoundError,
  archiveSharedTemplate,
  getSharedTemplateDetail,
  installSharedTemplate,
  isSharedTemplateKey,
  listSharedTemplates,
  requiredFlagsForGraph,
  requiredFlagsForSharedTemplate,
  sanitizeGraphForSharing,
  sharePlaybookAsTemplate,
  sharedTemplateIdFromKey,
  sharedTemplateKey,
} from '../services/playbookSharedTemplateService';

const ID = '11111111-2222-4333-8444-555555555555';
const SKILL_VERSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function unique(): Error {
  return Object.assign(new Error('duplicate'), { code: '23505' });
}

function graphWithProjectSettings(): PlaybookGraph {
  return {
    nodes: [
      {
        id: 'agent',
        stepType: 'cursor-agent',
        title: 'Review',
        stepTypeVersion: 1,
        agentPolicy: { skillPath: 'x' } as never,
        config: {
          prompt: 'Review the doc',
          skillPath: `project-skills/${SKILL_VERSION_ID}/SKILL.md`,
          assigneeUserId: 'oid-1',
          assigneeEmail: 'a@b.c',
          outcomes: ['pass', 'fail'],
        },
      },
      {
        id: 'tell',
        stepType: 'notify',
        title: 'Tell',
        config: { title: 'Done', recipientUserId: 'oid-2' },
      },
      {
        id: 'talk',
        stepType: 'interview',
        title: 'Interview',
        config: { mode: 'human_led', profileKey: 'p', skillSettingsId: 'row-9' },
      },
    ],
    edges: [{ from: 'agent', to: 'tell' }, { from: 'tell', to: 'talk' }],
  };
}

function sharedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: 'Review flow',
    summary: 'Reviews things',
    category: 'shared',
    graph: { nodes: [{ id: 'a', stepType: 'notify', config: { title: 'x' } }], edges: [] },
    sourceProject: 'Project A',
    sourceDefinitionId: 'def-1',
    sourceVersionNumber: 3,
    createdBy: 'admin',
    createdAt: '2026-11-23T00:00:00.000Z',
    updatedAt: '2026-11-23T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  selectResults.length = 0;
  insertResults.length = 0;
  updateResults.length = 0;
  insertedValues.length = 0;
  createDefinition.mockReset();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('template keys', () => {
  it('round-trips a shared key and rejects anything else', () => {
    expect(sharedTemplateKey(ID)).toBe(`shared:${ID}`);
    expect(isSharedTemplateKey(`shared:${ID}`)).toBe(true);
    expect(isSharedTemplateKey('core-interview')).toBe(false);
    expect(sharedTemplateIdFromKey(`shared:${ID}`)).toBe(ID);
    expect(sharedTemplateIdFromKey('shared:not-a-uuid')).toBeNull();
    expect(sharedTemplateIdFromKey('core-interview')).toBeNull();
  });
});

describe('sanitizeGraphForSharing', () => {
  it('removes project-specific settings and keeps everything else', () => {
    const original = graphWithProjectSettings();
    const { graph, notes } = sanitizeGraphForSharing(original);

    const agent = graph.nodes[0];
    expect(agent.agentPolicy).toBeUndefined();
    expect(agent.stepTypeVersion).toBeUndefined();
    expect(agent.config).toEqual({ prompt: 'Review the doc', outcomes: ['pass', 'fail'] });
    expect(graph.nodes[1].config).toEqual({ title: 'Done' });
    expect(graph.nodes[2].config).toEqual({ mode: 'human_led', profileKey: 'p' });
    expect(graph.edges).toEqual(original.edges);
    expect(notes).toHaveLength(4);
    expect(notes.join('\n')).toMatch(/project skill/);
    expect(notes.join('\n')).toMatch(/assignee/);
    expect(notes.join('\n')).toMatch(/recipient/);
  });

  it('does not change the source graph', () => {
    const original = graphWithProjectSettings();
    const snapshot = structuredClone(original);
    sanitizeGraphForSharing(original);
    expect(original).toEqual(snapshot);
  });

  it('keeps a base skill path and bindings', () => {
    const { graph, notes } = sanitizeGraphForSharing({
      nodes: [
        {
          id: 'a',
          stepType: 'cursor-agent',
          config: {
            prompt: 'p',
            skillPath: '.cursor/skills/to-prd/SKILL.md',
            assigneeUserId: '${input.owner}',
          },
        },
        {
          id: 'b',
          stepType: 'interview',
          config: { mode: 'human_led', profileKey: 'p', skillSettingsId: '${input.skillSettingsId}' },
        },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    expect(graph.nodes[0].config).toMatchObject({
      skillPath: '.cursor/skills/to-prd/SKILL.md',
      assigneeUserId: '${input.owner}',
    });
    expect(graph.nodes[1].config).toMatchObject({ skillSettingsId: '${input.skillSettingsId}' });
    expect(notes).toEqual([]);
  });

  it('tolerates a node without config', () => {
    const { graph, notes } = sanitizeGraphForSharing({
      nodes: [{ id: 'a', stepType: 'join' }],
      edges: [],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(notes).toEqual([]);
  });
});

describe('requiredFlagsForGraph', () => {
  it('names the flag for each gated step type once', () => {
    expect(requiredFlagsForGraph({
      nodes: [
        { id: 'a', stepType: 'interview' },
        { id: 'b', stepType: 'interview' },
        { id: 'c', stepType: 'build' },
        { id: 'd', stepType: 'notify' },
      ],
      edges: [],
    })).toEqual(['playbook-interview-step', 'build-from-prompt']);
  });
});

describe('sharePlaybookAsTemplate', () => {
  const base = { project: 'Project A', definitionId: 'def-1', actorUserId: 'admin' };

  it('rejects a definition that does not exist in the project', async () => {
    selectResults.push([]);
    await expect(sharePlaybookAsTemplate(base)).rejects.toBeInstanceOf(
      PlaybookSharedTemplateNotFoundError,
    );
  });

  it('rejects a Playbook with no published version', async () => {
    selectResults.push([{ id: 'def-1', name: 'Flow', description: null }], []);
    await expect(sharePlaybookAsTemplate(base)).rejects.toBeInstanceOf(
      PlaybookSharedTemplateInvalidError,
    );
    expect(insertedValues).toHaveLength(0);
  });

  it('stores a sanitised snapshot of the latest published version', async () => {
    selectResults.push(
      [{ id: 'def-1', name: 'Flow', description: 'Does a thing' }],
      [{ versionNumber: 4, graph: graphWithProjectSettings() }],
      [{ displayName: 'Admin', email: 'admin@x.y' }],
    );
    insertResults.push([sharedRow({ name: 'Flow', summary: 'Does a thing', sourceVersionNumber: 4 })]);

    const { template, notes } = await sharePlaybookAsTemplate(base);

    const stored = insertedValues[0] as { graph: PlaybookGraph; name: string; sourceVersionNumber: number };
    expect(stored.name).toBe('Flow');
    expect(stored.sourceVersionNumber).toBe(4);
    expect(stored.graph.nodes[0].agentPolicy).toBeUndefined();
    expect(stored.graph.nodes[0].config).not.toHaveProperty('skillPath');
    expect(template.templateKey).toBe(`shared:${ID}`);
    expect(template.source).toBe('shared');
    expect(template.installPolicy).toBe('multiple');
    expect(template.sharedByName).toBe('Admin');
    expect(notes.length).toBeGreaterThan(0);
  });

  it('uses the supplied name and summary', async () => {
    selectResults.push(
      [{ id: 'def-1', name: 'Flow', description: null }],
      [{ versionNumber: 1, graph: graphWithProjectSettings() }],
      [],
    );
    insertResults.push([sharedRow()]);
    await sharePlaybookAsTemplate({ ...base, name: '  Team review  ', summary: ' A summary ' });
    expect(insertedValues[0]).toMatchObject({ name: 'Team review', summary: 'A summary' });
  });

  it('rejects a name that is too long', async () => {
    selectResults.push(
      [{ id: 'def-1', name: 'Flow', description: null }],
      [{ versionNumber: 1, graph: graphWithProjectSettings() }],
    );
    await expect(sharePlaybookAsTemplate({ ...base, name: 'x'.repeat(121) })).rejects.toBeInstanceOf(
      PlaybookSharedTemplateInvalidError,
    );
  });

  it('reports a taken name', async () => {
    selectResults.push(
      [{ id: 'def-1', name: 'Flow', description: null }],
      [{ versionNumber: 1, graph: graphWithProjectSettings() }],
    );
    insertResults.push(unique());
    await expect(sharePlaybookAsTemplate(base)).rejects.toBeInstanceOf(PlaybookSharedTemplateNameTakenError);
  });

  it('passes other database errors through', async () => {
    selectResults.push(
      [{ id: 'def-1', name: 'Flow', description: null }],
      [{ versionNumber: 1, graph: graphWithProjectSettings() }],
    );
    insertResults.push(new Error('connection lost'));
    await expect(sharePlaybookAsTemplate(base)).rejects.toThrow('connection lost');
  });
});

describe('listing and reading', () => {
  it('lists active shared templates as multi-install summaries', async () => {
    selectResults.push([
      { row: sharedRow(), sharedByName: null, sharedByEmail: 'admin@x.y' },
    ]);
    const list = await listSharedTemplates();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      templateKey: `shared:${ID}`,
      displayName: 'Review flow',
      source: 'shared',
      installState: 'not-installed',
      installPolicy: 'multiple',
      sharedByName: 'admin@x.y',
      sourceProject: 'Project A',
      stepSummary: ['notify'],
    });
  });

  it('returns the graph for a detail read, as a copy', async () => {
    const row = sharedRow();
    selectResults.push([{ row, sharedByName: 'Admin', sharedByEmail: null }]);
    const detail = await getSharedTemplateDetail(`shared:${ID}`);
    expect(detail.graph).toEqual(row.graph);
    expect(detail.graph).not.toBe(row.graph);
  });

  it('throws for a missing or malformed key', async () => {
    selectResults.push([]);
    await expect(getSharedTemplateDetail(`shared:${ID}`)).rejects.toBeInstanceOf(
      PlaybookSharedTemplateNotFoundError,
    );
    await expect(getSharedTemplateDetail('shared:nope')).rejects.toBeInstanceOf(
      PlaybookSharedTemplateNotFoundError,
    );
  });

  it('computes required flags from the stored graph', async () => {
    selectResults.push([{
      row: sharedRow({ graph: { nodes: [{ id: 'a', stepType: 'build' }], edges: [] } }),
      sharedByName: null,
      sharedByEmail: null,
    }]);
    await expect(requiredFlagsForSharedTemplate(`shared:${ID}`)).resolves.toEqual(['build-from-prompt']);
  });
});

describe('installSharedTemplate', () => {
  const input = { project: 'Project B', templateKey: `shared:${ID}`, createdByUserId: 'author' };

  function found(row = sharedRow()) {
    selectResults.push([{ row, sharedByName: null, sharedByEmail: null }]);
  }

  it('creates an unpublished definition with no template key', async () => {
    found();
    createDefinition.mockResolvedValue({ definition: { id: 'new-def' } });

    const detail = await installSharedTemplate(input);

    expect(detail).toEqual({ definition: { id: 'new-def' } });
    const args = createDefinition.mock.calls[0][0];
    expect(args).toMatchObject({
      project: 'Project B',
      name: 'Review flow',
      description: 'Reviews things',
      createdByUserId: 'author',
    });
    expect(args).not.toHaveProperty('templateKey');
    expect(args).not.toHaveProperty('templateVersion');
  });

  it('copies the graph so the template and the install do not share objects', async () => {
    const row = sharedRow();
    found(row);
    createDefinition.mockResolvedValue({ definition: { id: 'new-def' } });
    await installSharedTemplate(input);
    expect(createDefinition.mock.calls[0][0].graph).toEqual(row.graph);
    expect(createDefinition.mock.calls[0][0].graph).not.toBe(row.graph);
  });

  it('numbers the name when the project already uses it', async () => {
    found();
    createDefinition
      .mockRejectedValueOnce(unique())
      .mockRejectedValueOnce(unique())
      .mockResolvedValueOnce({ definition: { id: 'new-def' } });

    await installSharedTemplate(input);

    expect(createDefinition.mock.calls.map((call) => call[0].name)).toEqual([
      'Review flow',
      'Review flow (2)',
      'Review flow (3)',
    ]);
  });

  it('honours a custom name', async () => {
    found();
    createDefinition.mockResolvedValue({ definition: { id: 'new-def' } });
    await installSharedTemplate({ ...input, name: 'My copy' });
    expect(createDefinition.mock.calls[0][0].name).toBe('My copy');
  });

  it('keeps a numbered name within the length limit', async () => {
    found(sharedRow({ name: 'n'.repeat(120) }));
    createDefinition
      .mockRejectedValueOnce(unique())
      .mockResolvedValueOnce({ definition: { id: 'new-def' } });
    await installSharedTemplate(input);
    const second = createDefinition.mock.calls[1][0].name as string;
    expect(second.length).toBeLessThanOrEqual(120);
    expect(second.endsWith(' (2)')).toBe(true);
  });

  it('stops after a bounded number of name attempts', async () => {
    found();
    createDefinition.mockRejectedValue(unique());
    await expect(installSharedTemplate(input)).rejects.toBeInstanceOf(PlaybookSharedTemplateInvalidError);
    expect(createDefinition).toHaveBeenCalledTimes(50);
  });

  it('passes other errors through without retrying', async () => {
    found();
    createDefinition.mockRejectedValue(new Error('boom'));
    await expect(installSharedTemplate(input)).rejects.toThrow('boom');
    expect(createDefinition).toHaveBeenCalledTimes(1);
  });

  it('throws when the template is missing or archived', async () => {
    selectResults.push([]);
    await expect(installSharedTemplate(input)).rejects.toBeInstanceOf(PlaybookSharedTemplateNotFoundError);
    expect(createDefinition).not.toHaveBeenCalled();
  });
});

describe('archiveSharedTemplate', () => {
  it('archives an active template', async () => {
    updateResults.push([{ id: ID }]);
    await expect(archiveSharedTemplate(`shared:${ID}`, 'admin')).resolves.toBeUndefined();
  });

  it('throws when nothing was archived', async () => {
    updateResults.push([]);
    await expect(archiveSharedTemplate(`shared:${ID}`, 'admin')).rejects.toBeInstanceOf(
      PlaybookSharedTemplateNotFoundError,
    );
  });

  it('throws for a shipped template key', async () => {
    await expect(archiveSharedTemplate('core-interview', 'admin')).rejects.toBeInstanceOf(
      PlaybookSharedTemplateNotFoundError,
    );
  });
});
