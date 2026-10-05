const isFeatureEnabled = jest.fn();
const getDesignDoc = jest.fn();
const startRun = jest.fn();
const findFirstDefinition = jest.fn();
const selectLimit = jest.fn();
const updateWhere = jest.fn();
const createThread = jest.fn();
const getThread = jest.fn();
const stopDocumentValidationWatcher = jest.fn();
const resolveSkillConfig = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      playbookDefinitions: { findFirst: (...args: unknown[]) => findFirstDefinition(...args) },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: () => selectLimit() }),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: (...args: unknown[]) => updateWhere(...args) }) }),
  },
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
}));
jest.mock('../services/designDocService', () => ({
  getDesignDoc: (...args: unknown[]) => getDesignDoc(...args),
}));
jest.mock('../services/playbookRunService', () => ({
  startRun: (...args: unknown[]) => startRun(...args),
}));
jest.mock('../services/chatAgentService', () => ({
  createThread: (...args: unknown[]) => createThread(...args),
  getThread: (...args: unknown[]) => getThread(...args),
}));
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));
jest.mock('../services/documentValidationService', () => ({
  stopDocumentValidationWatcher: (...args: unknown[]) => stopDocumentValidationWatcher(...args),
}));
jest.mock('../services/playbookDefinitionService', () => ({
  createDefinition: jest.fn(),
  publishDraft: jest.fn(),
}));
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
  resolveSkillConfig: (...args: unknown[]) => resolveSkillConfig(...args),
}));

import {
  DesignDocValidationPlaybookForbiddenError,
  startDesignDocValidationPlaybook,
} from '../services/designDocValidationPlaybookService';

describe('FEAT-014 owner start path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isFeatureEnabled.mockResolvedValue(true);
    getDesignDoc.mockResolvedValue({
      id: 'doc-1',
      project: 'Apex',
      ownerId: 'owner-1',
      validationThreadId: 'thread-1',
      status: 'validating',
    });
    getThread.mockResolvedValue({ id: 'thread-1', status: 'idle' });
    findFirstDefinition.mockResolvedValue({ id: 'def-1', name: 'Design-Doc Validation' });
    selectLimit.mockResolvedValue([]);
    startRun.mockResolvedValue({
      runId: 'run-1',
      definitionVersionId: 'version-1',
      status: 'running',
    });
  });

  it('VT-10 refuses a non-owner and does not start a run', async () => {
    await expect(startDesignDocValidationPlaybook({
      designDocId: 'doc-1',
      project: 'Apex',
      callerUserId: 'other-user',
    })).rejects.toBeInstanceOf(DesignDocValidationPlaybookForbiddenError);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('VT-11 returns the existing run for the same validation thread', async () => {
    selectLimit.mockResolvedValue([{ id: 'run-existing', definitionVersionId: 'version-9' }]);

    await expect(startDesignDocValidationPlaybook({
      designDocId: 'doc-1',
      project: 'Apex',
      callerUserId: 'owner-1',
    })).resolves.toEqual({
      runId: 'run-existing',
      definitionVersionId: 'version-9',
      outcome: 'already-running',
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('starts as the document owner and binds run input', async () => {
    await expect(startDesignDocValidationPlaybook({
      designDocId: 'doc-1',
      project: 'Apex',
      callerUserId: 'owner-1',
    })).resolves.toEqual({
      runId: 'run-1',
      definitionVersionId: 'version-1',
      outcome: 'started',
    });
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      initiatorUserId: 'owner-1',
      spendAdmissionEnabled: true,
      runInput: expect.objectContaining({
        documentType: 'design_doc',
        documentId: 'doc-1',
        validationThreadId: 'thread-1',
        ownerUserId: 'owner-1',
      }),
    }));
    expect(createThread).not.toHaveBeenCalled();
  });

  it('starts a fresh validation thread when the saved one is closed', async () => {
    getThread.mockResolvedValue({ id: 'thread-1', status: 'closed' });
    resolveSkillConfig.mockResolvedValue({
      id: 'settings-1',
      skillRepo: 'ryamiller-amergis/Apex',
      skillProvider: 'github',
      designDocValidationSkillPath: '/.cursor/skills/design-doc-validation/SKILL.md',
    });
    createThread.mockResolvedValue({ id: 'thread-2' });

    await startDesignDocValidationPlaybook({
      designDocId: 'doc-1',
      project: 'Apex',
      callerUserId: 'owner-1',
    });

    expect(createThread).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ skillPath: '/.cursor/skills/design-doc-validation/SKILL.md' }),
      { skipAutoKickoff: true },
    );
    expect(updateWhere).toHaveBeenCalled();
    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      runInput: expect.objectContaining({ validationThreadId: 'thread-2' }),
    }));
  });
});
