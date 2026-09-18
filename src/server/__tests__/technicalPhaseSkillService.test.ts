import fs from 'node:fs';
import path from 'node:path';

jest.mock('../db/drizzle', () => ({
  db: {
    query: { interviews: { findFirst: jest.fn() } },
    update: jest.fn(),
  },
}));
jest.mock('../services/chatThreadRepository', () => ({
  loadFullThread: jest.fn(),
}));
jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  sendMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/phaseLifecycleService', () => ({
  getPhaseSummary: jest.fn(),
  editPhaseSummary: jest.fn(),
  amendRequirementsSummary: jest.fn(),
}));
jest.mock('../services/projectSettingsService', () => ({
  resolveSkillConfig: jest.fn(),
}));
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

import { db } from '../db/drizzle';
import { createThread } from '../services/chatAgentService';
import { loadFullThread } from '../services/chatThreadRepository';
import {
  amendRequirementsSummary,
  editPhaseSummary,
  getPhaseSummary,
} from '../services/phaseLifecycleService';
import { resolveSkillConfig } from '../services/projectSettingsService';
import { getDefaultModel } from '../services/appSettingsService';
import {
  getTechnicalPhaseState,
  handoffToTechnicalPhase,
  startTechnicalPhase,
  syncTechnicalPhaseArtifacts,
} from '../services/technicalPhaseSkillService';

const mockDb = db as unknown as {
  query: { interviews: { findFirst: jest.Mock } };
  update: jest.Mock;
};
const mockCreateThread = createThread as jest.Mock;
const mockLoadFullThread = loadFullThread as jest.Mock;
const mockGetPhaseSummary = getPhaseSummary as jest.Mock;
const mockEditPhaseSummary = editPhaseSummary as jest.Mock;
const mockAmendRequirementsSummary = amendRequirementsSummary as jest.Mock;
const mockResolveSkillConfig = resolveSkillConfig as jest.Mock;
const mockGetDefaultModel = getDefaultModel as jest.Mock;

const approvedInterview = {
  id: 'interview-1',
  title: 'Technical Flow',
  project: 'Apex',
  repo: 'org/apex',
  chatThreadId: 'requirements-thread',
  technicalPhaseChatThreadId: null,
  skillSettingsId: 'settings-1',
  phaseFlow: 'both_sequential',
  requirementsPhaseStatus: 'approved',
  technicalPhaseStatus: 'draft',
  requirementsApprovedAt: '2026-09-17T12:00:00.000Z',
  technicalOwnerId: 'technical-owner',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.interviews.findFirst.mockResolvedValue(approvedInterview);
  mockLoadFullThread.mockResolvedValue({
    id: 'requirements-thread',
    messages: [
      { role: 'system', text: 'internal', hidden: true },
      { role: 'user', text: 'Build phase interviews', ts: '1' },
    ],
  });
  mockGetPhaseSummary.mockResolvedValue({
    phase: 'requirements',
    status: 'approved',
    content: '# Requirements\nApproved scope.',
    approvedAt: approvedInterview.requirementsApprovedAt,
  });
  mockResolveSkillConfig.mockResolvedValue({
    id: 'settings-1',
    project: 'Apex',
    skillRepo: 'org/skills',
    skillBranch: 'wave-2',
    skillProvider: 'github',
    technicalPhaseSkillPath: '.cursor/skills/custom-technical/SKILL.md',
    technicalPhaseModel: 'technical-model',
    technicalPhaseEffort: 'high',
  });
  mockGetDefaultModel.mockResolvedValue('default-model');
  mockCreateThread.mockResolvedValue({ id: 'technical-thread' });
  const returning = jest.fn().mockResolvedValue([{ id: 'interview-1' }]);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  mockDb.update.mockReturnValue({ set });
});

describe('technicalPhaseSkillService (FEAT-005 / PBI-008 / TBI-005)', () => {
  it('AC-0 / DoD-0 / DoD-1 / VT-01 starts with approved seed and dedicated skill config', async () => {
    const result = await startTechnicalPhase('interview-1', 'technical-owner');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'technical-owner',
      expect.objectContaining({
        project: 'Apex',
        repo: 'org/apex',
        skillPath: '.cursor/skills/custom-technical/SKILL.md',
        model: 'technical-model',
        agentModule: 'technicalPhase',
        skillSettingsId: 'settings-1',
        transcript: expect.stringContaining('Approved scope.'),
        freeformContext: expect.stringMatching(
          /Original interview prompt[\s\S]*Build phase interviews[\s\S]*Approved Requirements Phase Summary[\s\S]*Approved scope\./,
        ),
      }),
      { skipAutoKickoff: true },
    );
    expect(result.technicalPhaseChatThreadId).toBe('technical-thread');
  });

  it('AC-2 / VT-02 reports both_sequential as locked before Requirements approval', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...approvedInterview,
      requirementsPhaseStatus: 'draft',
      technicalPhaseStatus: 'locked',
    });

    await expect(getTechnicalPhaseState('interview-1')).resolves.toMatchObject({
      status: 'unavailable',
      canStart: false,
      technicalPhaseChatThreadId: null,
      unavailableReason: expect.stringMatching(/Requirements.*approved/i),
    });
  });

  it('AC-2 / VT-03 rejects a locked start with 409', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...approvedInterview,
      requirementsPhaseStatus: 'draft',
      technicalPhaseStatus: 'locked',
    });

    await expect(startTechnicalPhase('interview-1', 'technical-owner'))
      .rejects.toMatchObject({ status: 409 });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('AC-3 / VT-05 rejects a non-owner start with 403', async () => {
    await expect(startTechnicalPhase('interview-1', 'manager'))
      .rejects.toMatchObject({ status: 403 });
  });

  it('AC-2 technical_only starts immediately without a Requirements summary', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...approvedInterview,
      phaseFlow: 'technical_only',
      requirementsPhaseStatus: null,
      requirementsApprovedAt: null,
    });
    mockGetPhaseSummary.mockResolvedValue(null);

    await expect(startTechnicalPhase('interview-1', 'technical-owner')).resolves
      .toMatchObject({ technicalPhaseChatThreadId: 'technical-thread' });
    expect(mockCreateThread).toHaveBeenCalledWith(
      'technical-owner',
      expect.objectContaining({
        freeformContext: expect.stringContaining('No Requirements phase is configured'),
      }),
      expect.any(Object),
    );
  });

  it('seeds technical_only from the original thread kickoff transcript when no user message exists', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...approvedInterview,
      phaseFlow: 'technical_only',
      requirementsPhaseStatus: null,
      requirementsApprovedAt: null,
    });
    mockLoadFullThread.mockResolvedValue({
      id: 'requirements-thread',
      kickoff: { transcript: 'Design the auth service\n\n### notes.txt\n\nUse OIDC.' },
      messages: [],
    });
    mockGetPhaseSummary.mockResolvedValue(null);

    await expect(startTechnicalPhase('interview-1', 'technical-owner')).resolves
      .toMatchObject({ technicalPhaseChatThreadId: 'technical-thread' });
    expect(mockCreateThread).toHaveBeenCalledWith(
      'technical-owner',
      expect.objectContaining({
        freeformContext: expect.stringContaining('Use OIDC.'),
      }),
      expect.any(Object),
    );
  });

  it('hands off from Requirements approval by starting as the Technical owner', async () => {
    const state = await handoffToTechnicalPhase('interview-1');

    expect(mockCreateThread).toHaveBeenCalledWith(
      'technical-owner',
      expect.objectContaining({ agentModule: 'technicalPhase' }),
      { skipAutoKickoff: true },
    );
    expect(state).toMatchObject({
      status: 'in_progress',
      technicalPhaseChatThreadId: 'technical-thread',
    });
  });

  it('skips the handoff while the Technical phase is still locked', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...approvedInterview,
      requirementsPhaseStatus: 'draft',
      technicalPhaseStatus: 'locked',
    });

    await expect(handoffToTechnicalPhase('interview-1')).resolves.toBeNull();
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('returns the started thread when the handoff runs twice', async () => {
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...approvedInterview,
      technicalPhaseChatThreadId: 'technical-thread',
    });

    await expect(handoffToTechnicalPhase('interview-1')).resolves.toMatchObject({
      status: 'in_progress',
      technicalPhaseChatThreadId: 'technical-thread',
    });
    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('AC-1 / DoD-2 / DoD-3 / VT-04 applies each completed-turn artifact once through lifecycle APIs', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-technical-phase-'));
    const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'requirements-amendment.md'), 'Complete amendment');
    fs.writeFileSync(
      path.join(outputDir, 'technical-flow.technical-phase-summary.md'),
      'Technical summary',
    );
    mockDb.query.interviews.findFirst.mockResolvedValue({
      ...approvedInterview,
      technicalPhaseChatThreadId: 'technical-thread',
    });
    mockLoadFullThread.mockResolvedValue({ id: 'technical-thread', workspaceDir, messages: [] });

    await syncTechnicalPhaseArtifacts('technical-thread', 'technical-owner');
    await syncTechnicalPhaseArtifacts('technical-thread', 'technical-owner');

    expect(mockAmendRequirementsSummary).toHaveBeenCalledTimes(1);
    expect(mockAmendRequirementsSummary).toHaveBeenCalledWith(
      'interview-1',
      'technical-owner',
      'Complete amendment',
    );
    expect(mockEditPhaseSummary).toHaveBeenCalledTimes(1);
    expect(mockEditPhaseSummary).toHaveBeenCalledWith(
      'interview-1',
      'technical',
      'technical-owner',
      'Technical summary',
    );
    expect(fs.existsSync(path.join(outputDir, 'requirements-amendment.md'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'technical-flow.technical-phase-summary.md'))).toBe(false);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
});
