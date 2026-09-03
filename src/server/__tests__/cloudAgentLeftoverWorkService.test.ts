const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockReturning = jest.fn();
const mockLogMyWorkSession = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    update: () => ({
      set: (...setArgs: unknown[]) => {
        mockUpdateSet(...setArgs);
        return {
          where: (...whereArgs: unknown[]) => {
            mockUpdateWhere(...whereArgs);
            return { returning: (...retArgs: unknown[]) => mockReturning(...retArgs) };
          },
        };
      },
    }),
  },
}));
jest.mock('../services/myWorkSessionLogger', () => ({
  logMyWorkSession: (...args: unknown[]) => mockLogMyWorkSession(...args),
}));

import type { RunCheckResult } from '../../shared/types/agentRunLifecycle';
import {
  computeLeftoverWorkSummary,
  formatLeftoverWorkForAdoComment,
  formatLeftoverWorkForResumePrompt,
  persistLeftoverWork,
  writeLeftoverWorkToAdo,
} from '../services/cloudAgentLeftoverWorkService';

const passed = (kind: RunCheckResult['kind']): RunCheckResult => ({
  kind,
  outcome: 'passed',
});
const failed = (kind: RunCheckResult['kind']): RunCheckResult => ({
  kind,
  outcome: 'failed',
});

describe('cloudAgentLeftoverWorkService (PBI-008 / TBI-007)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReturning.mockResolvedValue([]);
  });

  it('PBI-008 AC-0: maps terminal failing unit/e2e/WCAG outcomes to failingChecks', () => {
    expect(computeLeftoverWorkSummary({
      checkResults: [failed('unit'), passed('e2e'), failed('wcag')],
      prUrl: 'https://example/pr/1',
    })).toEqual({
      failingChecks: ['unit', 'wcag'],
      missingPr: false,
      incompleteAcceptanceCriteria: [],
    });
  });

  it('PBI-008 AC-1: records a run with no PR as missingPr', () => {
    expect(computeLeftoverWorkSummary({
      checkResults: [passed('unit'), passed('e2e'), passed('wcag')],
      prUrl: null,
    })).toEqual({
      failingChecks: [],
      missingPr: true,
      incompleteAcceptanceCriteria: [],
    });
  });

  it('TBI-007 DoD-0: composes failing checks, missing PR, and incomplete criteria', () => {
    expect(computeLeftoverWorkSummary({
      checkResults: [failed('e2e')],
      prUrl: null,
      incompleteAcceptanceCriteria: ['AC-4 keyboard focus is not complete'],
    })).toEqual({
      failingChecks: ['e2e'],
      missingPr: true,
      incompleteAcceptanceCriteria: ['AC-4 keyboard focus is not complete'],
    });
  });

  it('PBI-008 AC-2: returns null for a PR with all reported checks passing and no incomplete criteria', () => {
    expect(computeLeftoverWorkSummary({
      checkResults: [passed('unit'), passed('e2e'), passed('wcag')],
      prUrl: 'https://example/pr/2',
      incompleteAcceptanceCriteria: [],
    })).toBeNull();
  });

  it('PBI-008 AC-1: formatters use the exact no-PR copy and identify the run', () => {
    const summary = {
      failingChecks: ['unit'],
      missingPr: true,
      incompleteAcceptanceCriteria: ['AC-2'],
    };

    const ado = formatLeftoverWorkForAdoComment(summary, {
      runId: 'run-42',
      completedAt: new Date('2026-09-02T12:00:00.000Z'),
    });
    const resume = formatLeftoverWorkForResumePrompt(summary);

    expect(ado).toContain('run run-42');
    expect(ado).toContain('2026-09-02T12:00:00.000Z');
    expect(ado).toContain('No pull request was opened');
    expect(resume).toContain('No pull request was opened');
    expect(resume).toContain('Failing check: unit');
    expect(resume).toContain('Incomplete acceptance criterion: AC-2');
  });

  it('PBI-008 AC-2: clean formatter input returns empty text', () => {
    expect(formatLeftoverWorkForAdoComment(null, { runId: 'run-clean' })).toBe('');
    expect(formatLeftoverWorkForResumePrompt(null)).toBe('');
  });

  it('TBI-007 DoD-0: persists stored arrays and logs counts only on a first write', async () => {
    const write = jest.fn().mockResolvedValue({ firstWrite: true });
    const log = jest.fn();
    const summary = {
      failingChecks: ['e2e'],
      missingPr: false,
      incompleteAcceptanceCriteria: ['AC-3'],
    };

    const result = await persistLeftoverWork(
      { sessionId: 'session-1', project: 'MaxView', summary },
      { write, log },
    );

    expect(result).toEqual({ firstWrite: true });
    expect(write).toHaveBeenCalledWith('session-1', summary);
    expect(log).toHaveBeenCalledWith('leftover_work.persisted', {
      sessionId: 'session-1',
      project: 'MaxView',
      failingCheckCount: 1,
      missingPr: false,
      incompleteAcCount: 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('AC-3');
  });

  it('PBI-008 AC-2: clean persist writes null, logs counts, and never reports firstWrite', async () => {
    const write = jest.fn().mockResolvedValue({ firstWrite: false });
    const log = jest.fn();

    const result = await persistLeftoverWork(
      { sessionId: 'session-1', project: 'MaxView', summary: null },
      { write, log },
    );

    expect(result).toEqual({ firstWrite: false });
    expect(write).toHaveBeenCalledWith('session-1', null);
    expect(log).toHaveBeenCalledWith('leftover_work.persisted', expect.objectContaining({
      failingCheckCount: 0,
      missingPr: false,
      incompleteAcCount: 0,
    }));
  });

  it('TBI-007 DoD-2: a lost leftover_work IS NULL write is not firstWrite and does not log persist', async () => {
    const write = jest.fn().mockResolvedValue({ firstWrite: false });
    const log = jest.fn();

    const result = await persistLeftoverWork({
      sessionId: 'session-1',
      project: 'MaxView',
      summary: {
        failingChecks: ['unit'],
        missingPr: false,
        incompleteAcceptanceCriteria: [],
      },
    }, { write, log });

    expect(result).toEqual({ firstWrite: false });
    expect(log).not.toHaveBeenCalled();
  });

  it('TBI-007 DoD-2: non-clean default persist is leftover_work IS NULL + RETURNING', async () => {
    mockReturning.mockResolvedValue([{ id: 'session-1' }]);
    const summary = {
      failingChecks: ['e2e'],
      missingPr: false,
      incompleteAcceptanceCriteria: [],
    };

    const result = await persistLeftoverWork({
      sessionId: 'session-1',
      project: 'MaxView',
      summary,
    });

    expect(result).toEqual({ firstWrite: true });
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ leftoverWork: summary }));
    expect(mockUpdateWhere).toHaveBeenCalled();
    expect(mockReturning).toHaveBeenCalled();
    const whereSql = JSON.stringify(mockUpdateWhere.mock.calls[0]);
    expect(whereSql).toMatch(/leftover_work/i);
    expect(whereSql).toMatch(/IS NULL/i);
  });

  it('TBI-007 DoD-2: a zero-row IS NULL update is not firstWrite', async () => {
    mockReturning.mockResolvedValue([]);

    const result = await persistLeftoverWork({
      sessionId: 'session-1',
      project: 'MaxView',
      summary: {
        failingChecks: ['unit'],
        missingPr: false,
        incompleteAcceptanceCriteria: [],
      },
    });

    expect(result).toEqual({ firstWrite: false });
  });

  it('PBI-008 AC-2: clean default persist writes leftoverWork null without claiming firstWrite', async () => {
    mockReturning.mockResolvedValue([{ id: 'session-1' }]);

    const result = await persistLeftoverWork({
      sessionId: 'session-1',
      project: 'MaxView',
      summary: null,
    });

    expect(result).toEqual({ firstWrite: false });
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ leftoverWork: null }));
    expect(mockReturning).not.toHaveBeenCalled();
  });

  it('TBI-007 DoD-2: only one concurrent non-clean persist reports firstWrite', async () => {
    let held: unknown = null;
    const write = jest.fn(async (_sessionId: string, summary: unknown) => {
      if (!summary) {
        held = null;
        return { firstWrite: false };
      }
      if (held) return { firstWrite: false };
      held = summary;
      return { firstWrite: true };
    });
    const log = jest.fn();
    const input = {
      sessionId: 'session-1',
      project: 'MaxView' as const,
      summary: {
        failingChecks: ['e2e'],
        missingPr: false,
        incompleteAcceptanceCriteria: [],
      },
    };

    const [first, second] = await Promise.all([
      persistLeftoverWork(input, { write, log }),
      persistLeftoverWork(input, { write, log }),
    ]);

    expect([first.firstWrite, second.firstWrite].filter(Boolean)).toHaveLength(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('TBI-007 DoD-2: ADO failure is non-fatal and logs no item text', async () => {
    const addWorkItemComment = jest.fn().mockRejectedValue(new Error('ADO unavailable'));
    const log = jest.fn();

    await expect(writeLeftoverWorkToAdo({
      sessionId: 'session-1',
      project: 'MaxView',
      workItemId: 42,
      runId: 'run-42',
      summary: {
        failingChecks: ['wcag'],
        missingPr: false,
        incompleteAcceptanceCriteria: ['secret criterion text'],
      },
    }, {
      createAdoService: () => ({ addWorkItemComment }),
      log,
    })).resolves.toBeUndefined();

    expect(addWorkItemComment).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('leftover_work.ado_write_failed', {
      sessionId: 'session-1',
      project: 'MaxView',
      runId: 'run-42',
    }, 'warn');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/wcag|secret criterion text/);
  });

  it('PBI-008 AC-2: clean runs make no ADO call', async () => {
    const createAdoService = jest.fn();

    await writeLeftoverWorkToAdo({
      sessionId: 'session-1',
      project: 'MaxView',
      workItemId: 42,
      runId: 'run-clean',
      summary: null,
    }, {
      createAdoService,
      log: jest.fn(),
    });

    expect(createAdoService).not.toHaveBeenCalled();
  });
});
import {
  isLeftoverWorkClean,
  type LeftoverWorkSummary,
} from '../../shared/types/devWorkbench';

function summary(overrides: Partial<LeftoverWorkSummary> = {}): LeftoverWorkSummary {
  return {
    failingChecks: [],
    missingPr: false,
    incompleteAcceptanceCriteria: [],
    ...overrides,
  };
}

describe('isLeftoverWorkClean', () => {
  it('treats null and undefined as clean so the UI shows no leftover-work summary', () => {
    expect(isLeftoverWorkClean(null)).toBe(true);
    expect(isLeftoverWorkClean(undefined)).toBe(true);
  });

  it('treats empty arrays and missingPr false as clean', () => {
    expect(isLeftoverWorkClean(summary())).toBe(true);
  });

  it('is not clean when failing checks are listed', () => {
    expect(isLeftoverWorkClean(summary({ failingChecks: ['unit', 'wcag'] }))).toBe(false);
  });

  it('is not clean when a missing PR is recorded', () => {
    expect(isLeftoverWorkClean(summary({ missingPr: true }))).toBe(false);
  });

  it('is not clean when incomplete acceptance criteria are listed', () => {
    expect(
      isLeftoverWorkClean(summary({ incompleteAcceptanceCriteria: ['Given a saved session'] })),
    ).toBe(false);
  });

  it('captures all three leftover-work leaf types as unclean', () => {
    expect(
      isLeftoverWorkClean(
        summary({
          failingChecks: ['e2e'],
          missingPr: true,
          incompleteAcceptanceCriteria: ['AC-0'],
        }),
      ),
    ).toBe(false);
  });
});
