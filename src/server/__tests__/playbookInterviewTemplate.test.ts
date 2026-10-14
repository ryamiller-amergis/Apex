/**
 * VT-TEMPLATE-1..4 and VT-TEMPLATE-7 — shipped core-interview template,
 * project-owned install, and publish-time profile key checks.
 */
import fs from 'node:fs';
import path from 'node:path';

const selectResults: unknown[][] = [];
const insertResults: Array<unknown[] | Error> = [];
const updateResults: Array<unknown[] | Error> = [];
const committedWrites: Array<{ kind: 'insert' | 'update'; table: unknown; values: unknown }> = [];

const selectMock = jest.fn();
const insertMock = jest.fn();
const updateMock = jest.fn();
const transactionMock = jest.fn();

function nextResult(queue: Array<unknown[] | Error>): unknown[] {
  const result = queue.shift() ?? [];
  if (result instanceof Error) throw result;
  return result;
}

function selectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit', 'for']) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.then = (
    resolve: (rows: unknown[]) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
  return chain;
}

function makeTransactionDb() {
  return {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (table: unknown) => {
      insertMock(table);
      return {
        values: (values: unknown) => ({
          returning: async () => {
            committedWrites.push({ kind: 'insert', table, values });
            return nextResult(insertResults);
          },
        }),
      };
    },
    update: (table: unknown) => {
      updateMock(table);
      return {
        set: (values: unknown) => ({
          where: () => ({
            returning: async () => {
              committedWrites.push({ kind: 'update', table, values });
              return nextResult(updateResults);
            },
          }),
        }),
      };
    },
  };
}

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

const resolveSkillConfig = jest.fn();
jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: (...args: unknown[]) => resolveSkillConfig(...args),
}));

import { publishDraft } from '../services/playbookDefinitionService';
import {
  PlaybookTemplateAlreadyPublishedError,
  installPlaybookTemplate,
} from '../services/playbookTemplateService';

const TEMPLATE_PATH = path.resolve(
  process.cwd(),
  'src/server/playbookTemplates/interview.json',
);
const AUTHOR = 'author-1';
const REVISION = '2026-10-07T12:00:00.000Z';

const INTERVIEW_GRAPH = {
  nodes: [
    {
      id: 'interview',
      stepType: 'interview',
      config: {
        mode: 'human_led',
        profileKey: '${input.interviewProfileKey}',
      },
    },
  ],
  edges: [],
};

const NOTIFY_GRAPH = {
  nodes: [{ id: 'notify', stepType: 'notify', config: { title: 'Done' } }],
  edges: [],
};

function definitionRow(project: string, id: string) {
  return {
    id,
    project,
    name: 'Core interview',
    description: 'One human-led interview. The profile key comes from the run input.',
    createdBy: AUTHOR,
    createdAt: REVISION,
    updatedAt: REVISION,
    templateKey: 'core-interview',
    templateVersion: 1,
  };
}

function draftRow(definitionId: string, graph: unknown = INTERVIEW_GRAPH) {
  return {
    id: `${definitionId}-draft`,
    definitionId,
    versionNumber: 1,
    graph,
    status: 'draft' as const,
    publishedBy: null,
    publishedAt: null,
    createdAt: REVISION,
    updatedAt: REVISION,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  selectResults.length = 0;
  insertResults.length = 0;
  updateResults.length = 0;
  committedWrites.length = 0;
  selectMock.mockImplementation(() => selectChain());
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback(makeTransactionDb());
    return result;
  });
  resolveSkillConfig.mockResolvedValue({ interviewSkillOptions: [] });
});

describe('VT-TEMPLATE-1 — shipped core-interview source', () => {
  it('is version 1 with one human-led interview node and no project or database ids', () => {
    const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const template = JSON.parse(raw) as {
      templateKey: string;
      templateVersion: number;
      graph: {
        nodes: Array<{ stepType: string; config: { mode: string; profileKey: string } }>;
      };
    };

    expect(template.templateKey).toBe('core-interview');
    expect(template.templateVersion).toBe(1);
    expect(template.graph.nodes).toHaveLength(1);
    expect(template.graph.nodes[0].stepType).toBe('interview');
    expect(template.graph.nodes[0].config.mode).toBe('human_led');
    expect(template.graph.nodes[0].config.profileKey).toBe('${input.interviewProfileKey}');
    expect(raw).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(raw).not.toMatch(/"project"\s*:/);
  });
});

describe('VT-TEMPLATE-2 / VT-TEMPLATE-3 — project-owned unpublished installs', () => {
  it('installs separate drafts into two projects and stores template metadata', async () => {
    const defA = definitionRow('Project A', 'def-a');
    const defB = definitionRow('Project B', 'def-b');
    selectResults.push([], []);
    insertResults.push([defA], [draftRow('def-a')], [defB], [draftRow('def-b')]);

    const installedA = await installPlaybookTemplate({
      project: 'Project A',
      templateKey: 'core-interview',
      createdByUserId: AUTHOR,
    });
    const installedB = await installPlaybookTemplate({
      project: 'Project B',
      templateKey: 'core-interview',
      createdByUserId: AUTHOR,
    });

    expect(installedA.created).toBe(true);
    expect(installedB.created).toBe(true);
    expect(installedA.detail.definition.id).not.toBe(installedB.detail.definition.id);
    expect(installedA.detail.definition.project).toBe('Project A');
    expect(installedB.detail.definition.project).toBe('Project B');
    expect(installedA.detail.definition.templateKey).toBe('core-interview');
    expect(installedA.detail.definition.templateVersion).toBe(1);
    expect(installedA.detail.currentPublishedVersionId).toBeNull();
    expect(installedB.detail.currentPublishedVersionId).toBeNull();
    expect(installedA.detail.versions).toEqual([]);
    expect(installedB.detail.versions).toEqual([]);
    expect(committedWrites.map((write) => write.kind)).toEqual([
      'insert',
      'insert',
      'insert',
      'insert',
    ]);
    expect(committedWrites.some((write) => (write.values as { status?: string }).status === 'published')).toBe(
      false,
    );

    const definitionInserts = committedWrites.filter(
      (write) => (write.values as { templateKey?: string }).templateKey === 'core-interview',
    );
    expect(definitionInserts.map((write) => (write.values as { project: string }).project)).toEqual([
      'Project A',
      'Project B',
    ]);
    expect(definitionInserts.every((write) => (write.values as { templateVersion: number }).templateVersion === 1)).toBe(
      true,
    );

    const graphs = committedWrites
      .map((write) => (write.values as { graph?: { nodes: unknown[] } }).graph)
      .filter((graph) => graph);
    expect(graphs).toHaveLength(2);
    expect(graphs[0]).toEqual(graphs[1]);
    expect(graphs[0]).not.toBe(graphs[1]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('VT-TEMPLATE-3 stores null template metadata for an ordinary definition', async () => {
    const { createDefinition } = await import('../services/playbookDefinitionService');
    insertResults.push(
      [
        {
          id: 'plain-def',
          project: 'Project A',
          name: 'Notify only',
          description: null,
          createdBy: AUTHOR,
          createdAt: REVISION,
          updatedAt: REVISION,
          templateKey: null,
          templateVersion: null,
        },
      ],
      [draftRow('plain-def', NOTIFY_GRAPH)],
    );

    const created = await createDefinition({
      project: 'Project A',
      name: 'Notify only',
      description: null,
      graph: NOTIFY_GRAPH,
      createdByUserId: AUTHOR,
    });

    expect(created.definition.templateKey).toBeNull();
    expect(created.definition.templateVersion).toBeNull();
    expect(committedWrites[0].values).toEqual(
      expect.objectContaining({ templateKey: null, templateVersion: null }),
    );
  });
});

describe('VT-TEMPLATE-4 — duplicate install is idempotent and does not rewrite history', () => {
  it('returns an unpublished template definition without writing again', async () => {
    const existing = definitionRow('Project A', 'def-a');
    selectResults.push([existing], [existing], [draftRow('def-a')]);

    const installed = await installPlaybookTemplate({
      project: 'Project A',
      templateKey: 'core-interview',
      createdByUserId: AUTHOR,
    });

    expect(installed.created).toBe(false);
    expect(installed.detail.definition.id).toBe('def-a');
    expect(installed.detail.definition.templateKey).toBe('core-interview');
    expect(installed.detail.versions).toEqual([]);
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(committedWrites).toEqual([]);
  });

  it('does not rewrite a published version or insert another definition', async () => {
    const existing = definitionRow('Project A', 'def-a');
    const publishedGraph = {
      nodes: [
        {
          id: 'interview',
          stepType: 'interview',
          config: { mode: 'human_led', profileKey: 'original-key' },
        },
      ],
      edges: [],
    };
    const published = {
      ...draftRow('def-a', publishedGraph),
      id: 'published-1',
      status: 'published' as const,
      publishedBy: AUTHOR,
      publishedAt: REVISION,
    };
    selectResults.push([existing], [existing], [draftRow('def-a'), published]);

    await expect(
      installPlaybookTemplate({
        project: 'Project A',
        templateKey: 'core-interview',
        createdByUserId: 'someone-else',
      }),
    ).rejects.toThrow(PlaybookTemplateAlreadyPublishedError);

    expect(published.graph).toEqual(publishedGraph);
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(committedWrites).toEqual([]);
  });
});

describe('VT-TEMPLATE-7 — publish-time interview profile keys', () => {
  const draft = {
    ...draftRow('def-a'),
    graph: INTERVIEW_GRAPH,
  };

  function queuePublish(graph: unknown = INTERVIEW_GRAPH) {
    selectResults.push([{ ...draft, graph }]);
  }

  it('rejects a missing bound key before copying the graph', async () => {
    queuePublish();
    resolveSkillConfig.mockResolvedValue({
      interviewSkillOptions: [{ key: 'grill', path: '/skills/grill', friendlyName: 'Grill', enabled: true }],
    });

    await expect(
      publishDraft({
        project: 'Project A',
        definitionId: 'def-a',
        publishedByUserId: AUTHOR,
        expectedDraftUpdatedAt: REVISION,
        sampleRunInput: {},
      }),
    ).rejects.toThrow(/\$\{input\.interviewProfileKey\}/);

    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(resolveSkillConfig).toHaveBeenCalledWith({ project: 'Project A' });
  });

  it('rejects a direct key that is missing or disabled before copying the graph', async () => {
    const direct = {
      nodes: [
        {
          id: 'interview',
          stepType: 'interview',
          config: { mode: 'human_led', profileKey: 'paused' },
        },
      ],
      edges: [],
    };
    queuePublish(direct);
    resolveSkillConfig.mockResolvedValue({
      interviewSkillOptions: [
        { friendlyName: 'paused', path: '/skills/legacy', enabled: true },
        { key: 'paused', path: '/skills/paused', friendlyName: 'Paused', enabled: false },
        { key: '   ', path: '/skills/blank', friendlyName: 'Blank', enabled: true },
      ],
    });

    await expect(
      publishDraft({
        project: 'Project A',
        definitionId: 'def-a',
        publishedByUserId: AUTHOR,
        expectedDraftUpdatedAt: REVISION,
      }),
    ).rejects.toThrow(/paused/);

    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('publishes when the binding resolves to an enabled profile key', async () => {
    queuePublish();
    resolveSkillConfig.mockResolvedValue({
      interviewSkillOptions: [{ key: 'grill', path: '/skills/grill', friendlyName: 'Grill' }],
    });
    const advanced = { ...draft, versionNumber: 2, updatedAt: '2026-10-07T12:01:00.000Z' };
    const published = {
      ...draft,
      id: 'published-1',
      status: 'published',
      versionNumber: 1,
      publishedBy: AUTHOR,
      publishedAt: '2026-10-07T12:01:00.000Z',
    };
    updateResults.push([advanced]);
    insertResults.push([published]);

    const result = await publishDraft({
      project: 'Project A',
      definitionId: 'def-a',
      publishedByUserId: AUTHOR,
      expectedDraftUpdatedAt: REVISION,
      sampleRunInput: { interviewProfileKey: 'grill' },
    });

    expect(result.publishedVersion.id).toBe('published-1');
    expect(committedWrites[0]).toEqual(
      expect.objectContaining({ kind: 'update', values: expect.objectContaining({ versionNumber: 2 }) }),
    );
    expect(committedWrites[1]).toEqual(
      expect.objectContaining({
        kind: 'insert',
        values: expect.objectContaining({ status: 'published', graph: INTERVIEW_GRAPH }),
      }),
    );
  });

  it('publishes a direct profile key without sample run input', async () => {
    const direct = {
      nodes: [
        {
          id: 'interview',
          stepType: 'interview',
          config: { mode: 'human_led', profileKey: 'grill' },
        },
      ],
      edges: [],
    };
    queuePublish(direct);
    resolveSkillConfig.mockResolvedValue({
      interviewSkillOptions: [{ key: 'grill', path: '/skills/grill', friendlyName: 'Grill', enabled: true }],
    });
    updateResults.push([{ ...draft, graph: direct, versionNumber: 2, updatedAt: '2026-10-07T12:01:00.000Z' }]);
    insertResults.push([{ ...draft, id: 'published-direct', graph: direct, status: 'published', versionNumber: 1 }]);

    const result = await publishDraft({
      project: 'Project A',
      definitionId: 'def-a',
      publishedByUserId: AUTHOR,
      expectedDraftUpdatedAt: REVISION,
    });

    expect(result.publishedVersion.id).toBe('published-direct');
    expect(insertMock).toHaveBeenCalled();
  });

  it('keeps publish behavior for a definition with no interview node', async () => {
    selectResults.push([draftRow('def-notify', NOTIFY_GRAPH)]);
    updateResults.push([
      {
        ...draftRow('def-notify', NOTIFY_GRAPH),
        versionNumber: 2,
        updatedAt: '2026-10-07T12:01:00.000Z',
      },
    ]);
    insertResults.push([
      {
        ...draftRow('def-notify', NOTIFY_GRAPH),
        id: 'published-notify',
        status: 'published',
        versionNumber: 1,
      },
    ]);

    const result = await publishDraft({
      project: 'Project A',
      definitionId: 'def-notify',
      publishedByUserId: AUTHOR,
      expectedDraftUpdatedAt: REVISION,
    });

    expect(result.publishedVersion.id).toBe('published-notify');
    expect(resolveSkillConfig).not.toHaveBeenCalled();
    expect(committedWrites).toHaveLength(2);
  });
});
