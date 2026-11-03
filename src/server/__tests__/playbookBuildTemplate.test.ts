import fs from 'fs';
import path from 'path';
import { PlaybookInterviewProfilePublishError } from '../services/playbookDefinitionService';

jest.mock('../db/drizzle', () => {
  const limit = jest.fn();
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit,
  };
  return {
    db: {
      limit,
      transaction: (fn: (tx: { execute: jest.Mock; select: () => typeof chain }) => Promise<unknown>) =>
        fn({ execute: jest.fn(), select: () => chain }),
    },
  };
});

jest.mock('../services/playbookTemplateService', () => ({
  installPlaybookTemplate: jest.fn(),
}));

jest.mock('../services/playbookDefinitionService', () => {
  const actual = jest.requireActual('../services/playbookDefinitionService');
  return { ...actual, publishDraft: jest.fn() };
});

import { db } from '../db/drizzle';
import { installPlaybookTemplate } from '../services/playbookTemplateService';
import { publishDraft } from '../services/playbookDefinitionService';
import { ensurePublished } from '../services/buildOrchestrator/provisioner';

const install = installPlaybookTemplate as jest.Mock;
const publish = publishDraft as jest.Mock;
const limit = (db as unknown as { limit: jest.Mock }).limit;

const draft = {
  definition: { id: 'def-1' },
  draft: { updatedAt: '2026-10-26T00:00:00.000Z' },
  currentPublishedVersionId: null,
  versions: [],
};

describe('build-from-prompt template (VT-32)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    limit.mockResolvedValue([]);
    install.mockResolvedValue({ created: true, detail: draft });
    publish.mockResolvedValue({ currentPublishedVersionId: 'ver-1' });
  });

  it('is an interview followed by a build, with the intake message and repository placeholders', () => {
    const file = path.join(__dirname, '..', 'playbookTemplates', 'build-from-prompt.json');
    const template = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      graph: { nodes: Array<{ id: string; stepType: string; config: Record<string, string> }>; edges: unknown[] };
    };
    expect(template.graph.nodes.map((node) => node.stepType)).toEqual(['interview', 'build']);
    expect(template.graph.edges).toEqual([{ from: 'intake', to: 'build' }]);
    expect(template.graph.nodes[0].config).toMatchObject({
      mode: 'human_led',
      profileKey: 'build-intake',
      openingMessage: '${input.prompt}',
      skillSettingsId: '${input.skillSettingsId}',
    });
    expect(template.graph.nodes[1].config.buildRunId).toBe('${input.buildRunId}');
  });

  it('installs and publishes once, then returns the published version on the next start', async () => {
    const first = await ensurePublished('Apex', 'user-1');
    expect(first).toEqual({ definitionId: 'def-1', versionId: 'ver-1' });
    expect(install).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);

    limit.mockResolvedValue([{ definitionId: 'def-1', versionId: 'ver-1' }]);
    const second = await ensurePublished('Apex', 'user-1');
    expect(second).toEqual({ definitionId: 'def-1', versionId: 'ver-1' });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('surfaces a missing build-intake profile as a publish error', async () => {
    publish.mockRejectedValue(new PlaybookInterviewProfilePublishError('Apex', 'build-intake'));
    await expect(ensurePublished('Apex', 'user-1')).rejects.toBeInstanceOf(PlaybookInterviewProfilePublishError);
  });
});
