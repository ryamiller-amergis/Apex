const findFirst = jest.fn();
const updateWhere = jest.fn().mockResolvedValue(undefined);
const updateSet = jest.fn(() => ({ where: updateWhere }));

jest.mock('../db/drizzle', () => ({
  db: {
    query: { adrs: { findFirst: (...args: unknown[]) => findFirst(...args) } },
    update: jest.fn(() => ({ set: updateSet })),
  },
}));

jest.mock('../services/chatAgentService', () => ({
  cancelRun: jest.fn(),
  hydrateThread: jest.fn().mockResolvedValue(undefined),
  markAsInterviewThread: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn(),
  readOutputAdr: jest.fn(),
  sendMessage: jest.fn(),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn().mockResolvedValue(undefined),
  runGroundingService: {
    getGroundings: jest.fn().mockResolvedValue([]),
    persistThenMarkTerminalInactive: jest.fn(
      async (_run: unknown, persist: () => Promise<void>) => persist(),
    ),
  },
}));

jest.mock('../services/projectSettingsService', () => ({
  getApproverUserIdsForProject: jest.fn(),
  getSkillSettingsName: jest.fn(),
}));
jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn(),
  isApprovalComplete: jest.fn(),
}));
jest.mock('../services/reviewCommentService', () => ({ getUnresolvedCount: jest.fn() }));
jest.mock('../services/ownerApprovalService', () => ({ recordOwnerApproval: jest.fn() }));

import * as adrService from '../services/adrService';
import { applyAdrGenerationResult } from '../services/adrService';
import { routeAdrGenerationKickoff } from '../services/adrGenerationService';
import { routeBackgroundWorkflow } from '../services/backgroundWorkflowRouter';
import { sendMessage } from '../services/chatAgentService';
import { createNotification } from '../services/notificationService';
import { propagatePipelineGrounding } from '../services/runGroundingService';

const generatingAdr = {
  id: 'adr-1',
  authorId: 'author-1',
  title: 'Use Service Bus',
  status: 'generating',
};

const kickoff = {
  adrId: 'adr-1',
  userId: 'author-1',
  project: 'Apex',
  threadId: 'thread-finalize',
  sourceThreadId: 'thread-interview',
  kickoffMessage: 'Generate the ADR.',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('applyAdrGenerationResult', () => {
  it('returns false when the thread does not generate an ADR', async () => {
    findFirst.mockResolvedValue(undefined);

    await expect(applyAdrGenerationResult('thread-other', null)).resolves.toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('leaves an ADR alone once it is no longer generating', async () => {
    findFirst.mockResolvedValue({ ...generatingAdr, status: 'in_progress' });

    await expect(applyAdrGenerationResult('thread-finalize', null, 'boom')).resolves.toBe(true);
    expect(updateSet).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('resets a generating ADR and notifies the author when no ADR file was produced', async () => {
    findFirst.mockResolvedValue(generatingAdr);

    await expect(
      applyAdrGenerationResult('thread-finalize', null, 'the agent did not produce an ADR file'),
    ).resolves.toBe(true);

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_progress' }));
    expect(createNotification).toHaveBeenCalledWith('author-1', expect.objectContaining({
      type: 'ai',
      title: 'ADR generation failed',
      link: '/adr/adr-1',
    }));
  });

  it('stores the generated ADR and notifies the author', async () => {
    findFirst.mockResolvedValue(generatingAdr);

    await applyAdrGenerationResult(
      'thread-finalize',
      '---\nstatus: proposed\nslug: use-service-bus\n---\n# ADR',
    );

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('# ADR'),
    }));
    expect(createNotification).toHaveBeenCalledWith('author-1', expect.objectContaining({
      title: 'ADR generated',
    }));
  });
});

describe('routeAdrGenerationKickoff', () => {
  it('copies interview grounding before routing the adr workflow', async () => {
    const order: string[] = [];
    (propagatePipelineGrounding as jest.Mock).mockImplementation(async () => {
      order.push('propagate');
    });
    (routeBackgroundWorkflow as jest.Mock).mockImplementation(async () => {
      order.push('route');
    });

    await routeAdrGenerationKickoff(kickoff);

    expect(propagatePipelineGrounding).toHaveBeenCalledWith(
      { runType: 'chat', runId: 'thread-interview', project: 'Apex' },
      { runType: 'chat', runId: 'thread-finalize', project: 'Apex' },
      'author-1',
      { deferMaterialization: true },
    );
    expect(routeBackgroundWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowClass: 'adr',
      threadId: 'thread-finalize',
    }));
    expect(order).toEqual(['propagate', 'route']);
  });

  it('does not watch the App Service workspace when the V2 lane takes the run', async () => {
    const watcher = jest.spyOn(adrService, 'startAdrWatcher').mockImplementation(() => undefined);
    (routeBackgroundWorkflow as jest.Mock).mockResolvedValue(undefined);

    await routeAdrGenerationKickoff(kickoff);

    expect(watcher).not.toHaveBeenCalled();
    watcher.mockRestore();
  });

  it('watches the App Service workspace when the run stays in process', async () => {
    const watcher = jest.spyOn(adrService, 'startAdrWatcher').mockImplementation(() => undefined);
    (routeBackgroundWorkflow as jest.Mock).mockImplementation(
      async (input: { runInProcess: () => Promise<void> }) => input.runInProcess(),
    );
    (sendMessage as jest.Mock).mockResolvedValue(undefined);

    await routeAdrGenerationKickoff(kickoff);

    expect(watcher).toHaveBeenCalledWith('adr-1', 'thread-finalize');
    expect(sendMessage).toHaveBeenCalledWith(
      'thread-finalize',
      'Generate the ADR.',
      undefined,
      [],
      { hidden: true },
    );
    watcher.mockRestore();
  });

  it('resets the ADR and notifies the author when routing throws', async () => {
    (routeBackgroundWorkflow as jest.Mock).mockRejectedValue(new Error('worker queue unavailable'));
    findFirst.mockResolvedValue(generatingAdr);

    await routeAdrGenerationKickoff(kickoff);

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_progress' }));
    expect(createNotification).toHaveBeenCalledWith('author-1', expect.objectContaining({
      title: 'ADR generation failed',
      body: expect.stringContaining('worker queue unavailable'),
    }));
  });
});
