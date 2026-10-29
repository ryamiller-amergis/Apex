/**
 * The deployed server runs from `dist/`, where `tsc` does not copy loose JSON files.
 * Shipped templates must load without reading `src/server/playbookTemplates/` from disk.
 */
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
  const readFileSync = (file: unknown, ...rest: unknown[]) => {
    if (String(file).includes('playbookTemplates')) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${String(file)}'`), { code: 'ENOENT' });
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  };
  return { __esModule: true, ...actual, default: { ...actual, readFileSync }, readFileSync };
});

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));

const createDefinition = jest.fn();
jest.mock('../services/playbookDefinitionService', () => ({
  createDefinition: (...args: unknown[]) => createDefinition(...args),
  getDefinitionDetail: jest.fn(),
}));

import { CORE_INTERVIEW_TEMPLATE_KEY, installPlaybookTemplate } from '../services/playbookTemplateService';

describe('shipped Playbook templates load without the source folder', () => {
  beforeEach(() => {
    createDefinition.mockReset();
    createDefinition.mockResolvedValue({ definition: { id: 'def-1' } });
  });

  it.each(['build-from-prompt', CORE_INTERVIEW_TEMPLATE_KEY])('installs %s when the JSON file is not on disk', async (templateKey) => {
    await installPlaybookTemplate({ project: 'MaxView', templateKey, createdByUserId: 'user-1' });

    expect(createDefinition).toHaveBeenCalledTimes(1);
    const input = createDefinition.mock.calls[0][0] as { templateKey: string; graph: { nodes: unknown[] } };
    expect(input.templateKey).toBe(templateKey);
    expect(input.graph.nodes.length).toBeGreaterThan(0);
  });
});
