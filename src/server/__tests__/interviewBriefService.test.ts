/**
 * Brief save and approval.
 *
 * VT-BRIEF-4 appends an immutable revision and keeps one draft current row.
 * VT-BRIEF-5 freezes a new approved version and resumes the Playbook only when that resume moves.
 * VT-BRIEF-6 treats a second approval as the same version and does not resume again.
 * VT-BRIEF-7 approves an interview that has no Playbook step without calling resume.
 */
const mockResumeStepRun = jest.fn();
jest.mock('../services/playbookSteps/stepRuns', () => ({
  resumeStepRun: (...args: unknown[]) => mockResumeStepRun(...args),
}));

const mockAdvanceRun = jest.fn();
jest.mock('../services/playbookAdvanceService', () => ({
  advanceRun: (...args: unknown[]) => mockAdvanceRun(...args),
}));

const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import { INTERVIEW_BRIEF_SECTIONS } from '../../shared/types/interview';
import type { InterviewBriefSections } from '../../shared/types/interview';
import { interviewBriefRevisions, interviewBriefs, interviews } from '../db/schema';
import {
  approveInterviewBrief,
  formatInterviewBriefForPrd,
  saveInterviewBrief,
} from '../services/interviewBriefService';

const NOW = '2026-10-07T16:00:00.000Z';

const sections: InterviewBriefSections = {
  problemAndOutcome: 'Ship a shorter interview',
  users: 'Business analysts',
  scope: 'One Playbook interview node',
  businessRules: 'Approval resumes the run once',
  scenarios: 'The BA approves the brief',
  acceptanceCriteria: 'The approved version is frozen',
  assumptions: 'One interviewer faces the BA',
  unresolvedItems: ['Deadline default', 'Cost cap'],
};

const linkedInterview = {
  id: 'interview-1',
  playbookRunId: 'run-1',
  playbookStepRunId: 'step-run-1',
};

const plainInterview = {
  id: 'interview-1',
  playbookRunId: null,
  playbookStepRunId: null,
};

it('formats every approved brief section as deterministic PRD grounding', () => {
  const transcript = formatInterviewBriefForPrd({
    id: 'brief-1',
    interviewId: 'interview-1',
    status: 'approved',
    version: 3,
    sections,
    approvedBy: 'user-ba',
    approvedAt: NOW,
  });

  expect(transcript).toContain('# Approved Interview Brief');
  expect(transcript).toContain('Brief version: 3');
  expect(transcript).toContain('## Acceptance Criteria');
  expect(transcript).toContain('- Deadline default');
});

const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const updates: Array<{ table: unknown; set: Record<string, unknown> }> = [];

function tableName(table: unknown): string | undefined {
  return (table as { [key: symbol]: string } | undefined)?.[Symbol.for('drizzle:Name')];
}

function installDb(rowsByTable: Record<string, unknown[]>) {
  inserts.length = 0;
  updates.length = 0;

  mockSelect.mockImplementation(() => {
    let name = '';
    const resultFor = () => Promise.resolve(rowsByTable[name] ?? []);
    const chain = {
      from: (table: unknown) => {
        name = tableName(table) ?? '';
        return chain;
      },
      where: () => chain,
      limit: () => resultFor(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        resultFor().then(resolve, reject),
    };
    return chain;
  });

  mockInsert.mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      const id = table === interviewBriefs ? 'brief-1' : 'rev-1';
      const result = Promise.resolve([{ id, ...values }]);
      return {
        returning: () => result,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          result.then(resolve, reject),
      };
    },
  }));

  mockUpdate.mockImplementation((table: unknown) => ({
    set: (set: Record<string, unknown>) => ({
      where: () => {
        updates.push({ table, set });
        const result = Promise.resolve([{ id: 'brief-1', interviewId: 'interview-1', sections, ...set }]);
        return {
          returning: () => result,
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            result.then(resolve, reject),
        };
      },
    }),
  }));

  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: mockSelect,
      insert: mockInsert,
      update: mockUpdate,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date(NOW));
  mockResumeStepRun.mockResolvedValue(true);
  mockAdvanceRun.mockResolvedValue({ advanced: true });
  installDb({
    interviews: [linkedInterview],
    interview_briefs: [],
    playbook_step_runs: [{ stepId: 'interview-node' }],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('VT-BRIEF-4 — saving a brief versions the draft and the revision', () => {
  it('VT-BRIEF-4 uses the design sections and no others', () => {
    expect(INTERVIEW_BRIEF_SECTIONS.map((section) => section.label)).toEqual([
      'problem and outcome',
      'users',
      'scope',
      'business rules',
      'scenarios',
      'acceptance criteria',
      'assumptions',
      'unresolved items',
    ]);
    expect(INTERVIEW_BRIEF_SECTIONS.map((section) => section.key)).toEqual([
      'problemAndOutcome',
      'users',
      'scope',
      'businessRules',
      'scenarios',
      'acceptanceCriteria',
      'assumptions',
      'unresolvedItems',
    ]);
  });

  it('VT-BRIEF-4 creates a draft current row and appends revision 1', async () => {
    const saved = await saveInterviewBrief({
      interviewId: 'interview-1',
      sections,
      savedBy: 'user-ba',
    });

    expect(saved).toEqual(
      expect.objectContaining({
        id: 'brief-1',
        interviewId: 'interview-1',
        status: 'draft',
        version: 1,
        sections,
        approvedBy: null,
        approvedAt: null,
      }),
    );
    expect(inserts.map((entry) => entry.table)).toEqual([interviewBriefs, interviewBriefRevisions]);
    expect(inserts[0].values).toEqual(
      expect.objectContaining({
        interviewId: 'interview-1',
        status: 'draft',
        version: 1,
        sections,
        approvedBy: null,
        approvedAt: null,
      }),
    );
    expect(inserts[1].values).toEqual(
      expect.objectContaining({
        briefId: 'brief-1',
        interviewId: 'interview-1',
        version: 1,
        status: 'draft',
        sections,
        createdBy: 'user-ba',
      }),
    );
    expect(updates).toEqual([]);
    expect(mockResumeStepRun).not.toHaveBeenCalled();
    expect(mockAdvanceRun).not.toHaveBeenCalled();
  });

  it('VT-BRIEF-4 updates the draft and appends the next revision without changing the previous one', async () => {
    const revised = {
      ...sections,
      problemAndOutcome: 'Ship a shorter interview for BAs',
    };
    installDb({
      interviews: [linkedInterview],
      interview_briefs: [
        {
          id: 'brief-1',
          interviewId: 'interview-1',
          status: 'draft',
          version: 1,
          sections,
          approvedBy: null,
          approvedAt: null,
        },
      ],
    });

    const saved = await saveInterviewBrief({
      interviewId: 'interview-1',
      sections: revised,
      savedBy: 'user-ba',
    });

    expect(saved).toEqual(expect.objectContaining({ id: 'brief-1', status: 'draft', version: 2, sections: revised }));
    expect(updates).toEqual([
      {
        table: interviewBriefs,
        set: expect.objectContaining({ version: 2, sections: revised, status: 'draft' }),
      },
    ]);
    expect(inserts).toEqual([
      {
        table: interviewBriefRevisions,
        values: expect.objectContaining({
          briefId: 'brief-1',
          version: 2,
          status: 'draft',
          sections: revised,
          createdBy: 'user-ba',
        }),
      },
    ]);
    expect(updates.map((entry) => entry.table)).not.toContain(interviewBriefRevisions);
  });

  it('VT-BRIEF-4 rejects a section set that is not the design set', async () => {
    const { assumptions: _dropped, ...missing } = sections;
    await expect(
      saveInterviewBrief({
        interviewId: 'interview-1',
        sections: missing as InterviewBriefSections,
        savedBy: 'user-ba',
      }),
    ).rejects.toThrow(/assumptions/);

    await expect(
      saveInterviewBrief({
        interviewId: 'interview-1',
        sections: { ...sections, notes: 'extra' } as InterviewBriefSections,
        savedBy: 'user-ba',
      }),
    ).rejects.toThrow(/sections/);

    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe('VT-BRIEF-5 — approving a draft resumes the Playbook when the step moves', () => {
  const draft = {
    id: 'brief-1',
    interviewId: 'interview-1',
    status: 'draft',
    version: 2,
    sections,
    approvedBy: null,
    approvedAt: null,
  };

  beforeEach(() => {
    installDb({
      interviews: [linkedInterview],
      interview_briefs: [draft],
      playbook_step_runs: [{ stepId: 'interview-node' }],
    });
  });

  it('VT-BRIEF-5 freezes a new version, counts unresolved items, and advances after a real resume', async () => {
    const result = await approveInterviewBrief({
      interviewId: 'interview-1',
      approvedBy: 'user-ba',
    });

    expect(result).toEqual({
      briefId: 'brief-1',
      version: 3,
      approvedBy: 'user-ba',
      approvedAt: NOW,
      unresolvedCount: 2,
      resumed: true,
      output: {
        interviewId: 'interview-1',
        briefId: 'brief-1',
        briefVersion: 3,
        approvedBy: 'user-ba',
        approvedAt: NOW,
        unresolvedCount: 2,
      },
    });
    expect(updates).toEqual([
      {
        table: interviewBriefs,
        set: expect.objectContaining({
          status: 'approved',
          version: 3,
          approvedBy: 'user-ba',
          approvedAt: NOW,
        }),
      },
      {
        table: interviews,
        set: expect.objectContaining({
          status: 'complete',
          updatedAt: NOW,
        }),
      },
    ]);
    expect(inserts).toEqual([
      {
        table: interviewBriefRevisions,
        values: expect.objectContaining({
          briefId: 'brief-1',
          interviewId: 'interview-1',
          version: 3,
          status: 'approved',
          sections,
          createdBy: 'user-ba',
        }),
      },
    ]);
    expect(mockResumeStepRun).toHaveBeenCalledTimes(1);
    expect(mockResumeStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      output: result.output,
    });
    expect(mockAdvanceRun).toHaveBeenCalledTimes(1);
    expect(mockAdvanceRun).toHaveBeenCalledWith('run-1', 'interview-node');
  });

  it('VT-BRIEF-5 does not advance when resume leaves the step where it was', async () => {
    mockResumeStepRun.mockResolvedValue(false);

    const result = await approveInterviewBrief({
      interviewId: 'interview-1',
      approvedBy: 'user-ba',
    });

    expect(result.version).toBe(3);
    expect(result.unresolvedCount).toBe(sections.unresolvedItems.length);
    expect(result.resumed).toBe(false);
    expect(mockResumeStepRun).toHaveBeenCalledTimes(1);
    expect(mockAdvanceRun).not.toHaveBeenCalled();
  });

  it('VT-BRIEF-5 rejects a brief whose unresolved items are not a list before resume', async () => {
    installDb({
      interviews: [linkedInterview],
      interview_briefs: [{ ...draft, sections: { ...sections, unresolvedItems: 'still open' } }],
      playbook_step_runs: [{ stepId: 'interview-node' }],
    });

    await expect(
      approveInterviewBrief({ interviewId: 'interview-1', approvedBy: 'user-ba' }),
    ).rejects.toThrow(/unresolvedItems/);

    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
    expect(mockResumeStepRun).not.toHaveBeenCalled();
    expect(mockAdvanceRun).not.toHaveBeenCalled();
  });
});

describe('VT-BRIEF-6 — a second approval is the same version', () => {
  it('VT-BRIEF-6 retries the idempotent resume and does not advance when the step already moved', async () => {
    mockResumeStepRun.mockResolvedValue(false);
    installDb({
      interviews: [linkedInterview],
      interview_briefs: [
        {
          id: 'brief-1',
          interviewId: 'interview-1',
          status: 'approved',
          version: 3,
          sections,
          approvedBy: 'user-ba',
          approvedAt: '2026-10-07T15:00:00.000Z',
        },
      ],
      playbook_step_runs: [{ stepId: 'interview-node' }],
    });

    const result = await approveInterviewBrief({
      interviewId: 'interview-1',
      approvedBy: 'user-someone-else',
    });

    expect(result).toEqual({
      briefId: 'brief-1',
      version: 3,
      approvedBy: 'user-ba',
      approvedAt: '2026-10-07T15:00:00.000Z',
      unresolvedCount: 2,
      resumed: false,
      output: {
        interviewId: 'interview-1',
        briefId: 'brief-1',
        briefVersion: 3,
        approvedBy: 'user-ba',
        approvedAt: '2026-10-07T15:00:00.000Z',
        unresolvedCount: 2,
      },
    });
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
    expect(mockResumeStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      output: result.output,
    });
    expect(mockAdvanceRun).not.toHaveBeenCalled();
  });
});

describe('VT-BRIEF-7 — an ordinary interview approves without a Playbook resume', () => {
  it('VT-BRIEF-7 saves and approves when the interview has no Playbook step', async () => {
    installDb({
      interviews: [plainInterview],
      interview_briefs: [],
    });

    const saved = await saveInterviewBrief({
      interviewId: 'interview-1',
      sections,
      savedBy: 'user-ba',
    });
    expect(saved.status).toBe('draft');
    expect(mockResumeStepRun).not.toHaveBeenCalled();

    installDb({
      interviews: [plainInterview],
      interview_briefs: [
        {
          id: 'brief-1',
          interviewId: 'interview-1',
          status: 'draft',
          version: 1,
          sections,
          approvedBy: null,
          approvedAt: null,
        },
      ],
    });

    const result = await approveInterviewBrief({
      interviewId: 'interview-1',
      approvedBy: 'user-ba',
    });

    expect(result).toEqual(
      expect.objectContaining({
        briefId: 'brief-1',
        version: 2,
        unresolvedCount: 2,
        resumed: false,
      }),
    );
    expect(result.output.unresolvedCount).toBe(sections.unresolvedItems.length);
    expect(mockResumeStepRun).not.toHaveBeenCalled();
    expect(mockAdvanceRun).not.toHaveBeenCalled();
  });
});
