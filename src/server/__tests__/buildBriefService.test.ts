/**
 * FEAT-006 S4 — build brief service.
 *
 * VT-13 admin approval records approver and onBehalfOf. VT-14 repeat approve writes one event key.
 * VT-15 the approval hook writes classification and the approved version. VT-16 no AC → 400.
 * VT-18 draft numbers rows, rates decisions and redacts a token. VT-19 edit keeps IDs and lists changes.
 * VT-22 empty decisions still classify. VT-23 approval failure → 500 plain message. VT-24 stale revision repaired.
 */
const mockApprove = jest.fn();
const mockSave = jest.fn();
const mockGetBrief = jest.fn();
jest.mock('../services/interviewBriefService', () => {
  const actual = jest.requireActual('../services/interviewBriefService');
  return {
    ...actual,
    approveInterviewBrief: (...args: unknown[]) => mockApprove(...args),
    saveInterviewBrief: (...args: unknown[]) => mockSave(...args),
    getInterviewBrief: (...args: unknown[]) => mockGetBrief(...args),
  };
});

const mockDraft = jest.fn();
jest.mock('../services/interviewOrchestratorService', () => {
  class BuildIntakeDraftError extends Error {
    constructor(readonly reason: string) { super(reason); }
  }
  return {
    BuildIntakeDraftError,
    draftBuildIntakeBrief: (...args: unknown[]) => mockDraft(...args),
  };
});

const mockAppendEvent = jest.fn();
jest.mock('../services/buildEventsService', () => ({
  appendBuildEvent: (...args: unknown[]) => mockAppendEvent(...args),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isProjectAdmin: jest.fn(),
  isPlatformAdmin: jest.fn(),
}));

const mockSelect = jest.fn();
const mockInsert = jest.fn();
jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

import type { InterviewBriefRecord, InterviewBriefSections } from '../../shared/types/interview';
import type { BuildRequirement, BuildRiskDecision } from '../../shared/types/build';
import { isPlatformAdmin, isProjectAdmin } from '../utils/rbacHelpers';
import { InterviewBriefError } from '../services/interviewBriefService';
import {
  approveBuildBrief,
  BUILD_BRIEF_APPROVE_FAILED_MESSAGE,
  BUILD_BRIEF_CHANGED_MESSAGE,
  BUILD_BRIEF_DRAFT_FAILED_MESSAGE,
  BUILD_BRIEF_NO_AC_MESSAGE,
  BUILD_BRIEF_RESUME_FAILED_MESSAGE,
  BuildBriefError,
  draftBuildBrief,
  getBuildBriefAnalysis,
  renderBriefSections,
  saveBuildBrief,
} from '../services/buildBriefService';

const { BuildIntakeDraftError } = jest.requireMock('../services/interviewOrchestratorService') as {
  BuildIntakeDraftError: new (reason: string) => Error;
};

const TOKEN = 'abcdefghijklmnop1234567890';

const sections: InterviewBriefSections = {
  problemAndOutcome: 'Export builds',
  users: 'Members',
  scope: 'Export only',
  businessRules: '',
  scenarios: 'A member exports',
  acceptanceCriteria: '',
  assumptions: 'CSV is enough',
  unresolvedItems: [],
};

const interviewRow = { id: 'iv-1', project: 'proj-a', authorId: 'requester', playbookProfileKey: 'build-intake' };

interface Tables {
  interviews: unknown[];
  build_runs: unknown[];
  build_revisions: unknown[];
  build_events: unknown[];
  app_users: unknown[];
}

let tables: Tables;
const upserts: Array<Record<string, unknown>> = [];

function tableName(table: unknown): string {
  return (table as { [key: symbol]: string })[Symbol.for('drizzle:Name')] ?? '';
}

function installDb() {
  mockSelect.mockImplementation(() => {
    let name = '';
    const result = () => Promise.resolve((tables as unknown as Record<string, unknown[]>)[name] ?? []);
    const chain = {
      from: (table: unknown) => { name = tableName(table); return chain; },
      where: () => chain,
      orderBy: () => chain,
      limit: () => result(),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => result().then(resolve, reject),
    };
    return chain;
  });
  mockInsert.mockImplementation(() => ({
    values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: () => ({
        returning: () => {
          upserts.push(values);
          return Promise.resolve([{ id: 'rev-1' }]);
        },
      }),
    }),
  }));
}

function brief(overrides: Partial<InterviewBriefRecord> = {}): InterviewBriefRecord {
  return {
    id: 'brief-1',
    interviewId: 'iv-1',
    status: 'draft',
    version: 1,
    sections,
    approvedBy: null,
    approvedAt: null,
    ...overrides,
  };
}

const storedRequirements: BuildRequirement[] = [
  { id: 'AC-1', kind: 'ac', text: 'Members can export', retired: false },
  { id: 'AC-2', kind: 'ac', text: 'Export shows progress', retired: false },
  { id: 'BR-1', kind: 'br', text: 'Members only', retired: false },
];
const storedDecisions: BuildRiskDecision[] = [
  { id: 'RD-1', category: 'access', rating: 'medium', decision: 'Add builds:export', rationale: 'Own gate', reversible: false },
];
const storedState = { counters: { AC: 2, DOD: 0, BR: 1, NFR: 0, RD: 1 }, estimatedTasks: 2, needsMigration: false, reasons: [] };

function withDraftRevision(version = 1) {
  tables.build_revisions = [{ id: 'rev-1', briefVersion: version, requirements: storedRequirements, riskDecisions: storedDecisions }];
  tables.build_events = [{ eventType: 'intake.brief_drafted', detail: storedState }];
}

beforeEach(() => {
  jest.clearAllMocks();
  upserts.length = 0;
  tables = {
    interviews: [interviewRow],
    build_runs: [{ id: 'run-1' }],
    build_revisions: [],
    build_events: [],
    app_users: [{ oid: 'requester', displayName: 'Dana Lee' }, { oid: 'pa-1', displayName: 'Pat Admin' }],
  };
  installDb();
  (isProjectAdmin as jest.Mock).mockImplementation(async (userId: string, project: string) => userId === 'pa-1' && project === 'proj-a');
  (isPlatformAdmin as jest.Mock).mockImplementation(async (userId: string) => userId === 'platform-1');
  mockAppendEvent.mockResolvedValue({ inserted: true, event: null });
  mockGetBrief.mockResolvedValue(null);
  mockSave.mockImplementation(async (input: SaveInput) => {
    const saved = brief({ sections: input.sections });
    await input.inTransaction?.(TX, saved);
    return saved;
  });
});

type TxHook = (tx: unknown, saved: InterviewBriefRecord) => Promise<void>;
interface SaveInput { sections: InterviewBriefSections; expectedVersion?: number | null; inTransaction?: TxHook }
const TX = { insert: (...args: unknown[]) => mockInsert(...args) };

describe('VT-18 — draft (PBI-011 AC-0; PBI-013 AC-0)', () => {
  it('VT-18 saves draft v1 with numbered rows, decisions, classification and no token', async () => {
    mockDraft.mockResolvedValue({
      ...sections,
      requirements: [
        { kind: 'ac', text: 'Members can export' },
        { kind: 'ac', text: `Send Bearer ${TOKEN} with each call` },
        { kind: 'br', text: 'Members only' },
      ],
      riskCandidates: [{ category: 'access', rating: 'medium', decision: 'Add builds:export permission', rationale: 'Own gate', destructive: false }],
      estimatedTasks: 2,
      needsMigration: false,
    });

    const result = await draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'manual' });

    expect(result?.version).toBe(1);
    const saved = mockSave.mock.calls[0][0].sections as InterviewBriefSections;
    expect(saved.acceptanceCriteria.split('\n')[0]).toBe('AC-1: Members can export');
    expect(saved.businessRules).toBe('BR-1: Members only');
    expect(upserts[0]).toMatchObject({ revisionNumber: 1, briefVersion: 1, classification: 'small' });
    expect((upserts[0].riskDecisions as BuildRiskDecision[])[0]).toMatchObject({ id: 'RD-1', rating: 'medium' });
    expect(mockAppendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'intake.brief_drafted' }), { executor: TX });
    expect(mockSave.mock.calls[0][0].expectedVersion).toBeNull();
    const everything = JSON.stringify([mockSave.mock.calls, upserts, mockAppendEvent.mock.calls]);
    expect(everything).not.toContain(TOKEN);
  });

  it('VT-17 records a draft failure and returns 502 with the retry message', async () => {
    mockDraft.mockRejectedValue(new BuildIntakeDraftError('timeout'));
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);

    const error = await draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'manual' }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BuildBriefError);
    expect((error as BuildBriefError).statusCode).toBe(502);
    expect((error as BuildBriefError).message).toBe(BUILD_BRIEF_DRAFT_FAILED_MESSAGE);
    expect(mockSave).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
    expect(mockAppendEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'intake.brief_draft_failed',
      detail: { reason: 'timeout' },
    }));
    expect(info.mock.calls.flat().join(' ')).toContain('timeout');
    info.mockRestore();
  });

  it('U1 automatic draft never overwrites an existing brief', async () => {
    mockGetBrief.mockResolvedValue(brief());
    await expect(draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'auto' })).resolves.toBeNull();
    expect(mockDraft).not.toHaveBeenCalled();
  });

  describe('concurrent drafts keep one run\'s sections and rows together', () => {
    const draftReply = {
      ...sections,
      requirements: [{ kind: 'ac', text: 'Members can export' }],
      riskCandidates: [],
      estimatedTasks: 1,
      needsMigration: false,
    };
    beforeEach(() => mockDraft.mockResolvedValue(draftReply));

    it('writes revision 1 and the drafted event only inside the brief transaction', async () => {
      mockSave.mockImplementation(async (input: SaveInput) => brief({ sections: input.sections }));
      await draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'manual' });
      expect(upserts).toHaveLength(0);
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });

    it('passes the version read before the agent ran', async () => {
      mockGetBrief.mockResolvedValue(brief({ version: 4 }));
      await draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'manual' });
      expect(mockSave.mock.calls[0][0].expectedVersion).toBe(4);
    });

    it('a manual draft that lost the race returns 409 with the plain message', async () => {
      mockSave.mockRejectedValue(new InterviewBriefError('The brief changed while it was being written.', 409));
      const error = await draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'manual' }).catch((err: unknown) => err);
      expect((error as BuildBriefError).statusCode).toBe(409);
      expect((error as BuildBriefError).message).toBe(BUILD_BRIEF_CHANGED_MESSAGE);
    });

    it('an automatic draft that lost the race stops quietly', async () => {
      mockSave.mockRejectedValue(new InterviewBriefError('The brief changed while it was being written.', 409));
      await expect(draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'auto' })).resolves.toBeNull();
    });

    it('a failed revision write fails the whole draft', async () => {
      mockInsert.mockImplementation(() => { throw new Error('revision write failed'); });
      await expect(draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'manual' }))
        .rejects.toThrow('revision write failed');
      expect(mockAppendEvent).not.toHaveBeenCalled();
    });
  });

  it('PBI-011 AC-3 refuses a BA who is not the requester or an admin', async () => {
    const error = await draftBuildBrief({ interviewId: 'iv-1', actorId: 'ba-1', mode: 'manual' }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(403);
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it('A15 returns 409 and writes nothing when no build run is linked', async () => {
    tables.build_runs = [];
    const error = await draftBuildBrief({ interviewId: 'iv-1', actorId: 'requester', mode: 'manual' }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(409);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe('VT-19 — edit keeps IDs (PBI-011 AC-2; PBI-012 AC-2)', () => {
  it('VT-19 keeps AC-2, renders the text and lists only changed IDs', async () => {
    withDraftRevision();
    const requirements = storedRequirements.map(({ id, kind, text }) => ({
      id, kind, text: id === 'AC-2' ? 'Export shows a progress bar' : text,
    }));

    await saveBuildBrief({ interviewId: 'iv-1', actorId: 'pa-1', sections: { ...sections, acceptanceCriteria: 'ignored' }, requirements });

    const saved = mockSave.mock.calls[0][0];
    expect(saved.savedBy).toBe('pa-1');
    expect(saved.sections.acceptanceCriteria).toBe('AC-1: Members can export\nAC-2: Export shows a progress bar');
    const event = mockAppendEvent.mock.calls[0][0];
    expect(event.eventType).toBe('intake.brief_edited');
    expect(event.detail.changedIds).toEqual(['AC-2']);
    expect(JSON.stringify(event)).not.toContain('progress bar');
  });

  it('VT-19 rejects a forged ID with 400', async () => {
    withDraftRevision();
    const error = await saveBuildBrief({
      interviewId: 'iv-1',
      actorId: 'requester',
      sections,
      requirements: [{ id: 'AC-7', kind: 'ac', text: 'Forged' }],
    }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(400);
  });

  it('checks the version it read and writes the edit event inside the brief transaction', async () => {
    withDraftRevision(2);
    mockGetBrief.mockResolvedValue(brief({ version: 2 }));
    await saveBuildBrief({ interviewId: 'iv-1', actorId: 'requester', sections, requirements: [{ id: 'AC-1', kind: 'ac', text: 'Members can export' }] });
    expect(mockSave.mock.calls[0][0].expectedVersion).toBe(2);
    expect(mockAppendEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'intake.brief_edited' }), { executor: TX });
  });

  it('returns 409 with the plain message when a draft landed during the save', async () => {
    withDraftRevision();
    mockSave.mockRejectedValue(new InterviewBriefError('The brief changed while it was being written.', 409));
    const error = await saveBuildBrief({
      interviewId: 'iv-1',
      actorId: 'requester',
      sections,
      requirements: [{ id: 'AC-1', kind: 'ac', text: 'Members can export' }],
    }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(409);
    expect((error as BuildBriefError).message).toBe(BUILD_BRIEF_CHANGED_MESSAGE);
  });
});

describe('approve', () => {
  beforeEach(() => {
    withDraftRevision();
    mockGetBrief.mockResolvedValue(brief({ sections: renderBriefSections(sections, storedRequirements) }));
  });

  it('VT-13 / VT-15 Project Admin approval writes classification, approved version and onBehalfOf in the approval transaction', async () => {
    mockApprove.mockImplementation(async (input: { inTransaction: TxHook }) => {
      await input.inTransaction(TX, brief({ status: 'approved', version: 2, approvedBy: 'pa-1', approvedAt: 'now' }));
      return { briefId: 'brief-1', version: 2, resumed: true, alreadyApproved: false };
    });

    const result = await approveBuildBrief({ interviewId: 'iv-1', actorId: 'pa-1' });

    expect(mockApprove).toHaveBeenCalledWith(expect.objectContaining({ approvedBy: 'pa-1' }));
    expect(result.classification.value).toBe('small');
    expect(upserts[upserts.length - 1]).toMatchObject({ briefVersion: 2, classification: 'small' });
    expect(mockAppendEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'intake.brief_approved',
      actorUserId: 'pa-1',
      dedupeKey: 'brief_approved:brief-1:2',
      detail: expect.objectContaining({ onBehalfOf: 'requester' }),
    }), { executor: TX });
  });

  it('VT-14 a repeat approval writes no second event', async () => {
    mockGetBrief.mockResolvedValue(brief({ status: 'approved', version: 2, approvedBy: 'platform-1', approvedAt: 'then' }));
    mockApprove.mockResolvedValue({ briefId: 'brief-1', version: 2, resumed: false, alreadyApproved: true });

    const result = await approveBuildBrief({ interviewId: 'iv-1', actorId: 'pa-1' });

    expect(result.alreadyApproved).toBe(true);
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('VT-16 refuses approval with no acceptance criterion and does not approve', async () => {
    const noAc = storedRequirements.filter((row) => row.kind !== 'ac');
    tables.build_revisions = [{ id: 'rev-1', briefVersion: 1, requirements: noAc, riskDecisions: [] }];

    const error = await approveBuildBrief({ interviewId: 'iv-1', actorId: 'requester' }).catch((err: unknown) => err);

    expect((error as BuildBriefError).statusCode).toBe(400);
    expect((error as BuildBriefError).message).toBe(BUILD_BRIEF_NO_AC_MESSAGE);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('VT-23 turns an approval write failure into a 500 with the plain message', async () => {
    mockApprove.mockRejectedValue(new Error('connection reset'));
    const error = await approveBuildBrief({ interviewId: 'iv-1', actorId: 'requester' }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(500);
    expect((error as BuildBriefError).message).toBe(BUILD_BRIEF_APPROVE_FAILED_MESSAGE);
    expect(mockAppendEvent).not.toHaveBeenCalled();
  });

  it('says planning did not start when the approval committed but the resume failed', async () => {
    const draft = brief({ sections: renderBriefSections(sections, storedRequirements) });
    mockGetBrief
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce({ ...draft, status: 'approved', version: 2, approvedBy: 'requester', approvedAt: 'now' });
    mockApprove.mockRejectedValue(new Error('resume failed'));

    const error = await approveBuildBrief({ interviewId: 'iv-1', actorId: 'requester' }).catch((err: unknown) => err);

    expect((error as BuildBriefError).statusCode).toBe(500);
    expect((error as BuildBriefError).message).toBe(BUILD_BRIEF_RESUME_FAILED_MESSAGE);
  });

  it('VT-23 passes a 4xx brief error through unchanged', async () => {
    mockApprove.mockRejectedValue(new InterviewBriefError('The brief was no longer a draft.', 400));
    await expect(approveBuildBrief({ interviewId: 'iv-1', actorId: 'requester' })).rejects.toBeInstanceOf(InterviewBriefError);
  });

  it('VT-24 repairs a stale revision from the rendered brief before approving', async () => {
    tables.build_revisions = [{ id: 'rev-1', briefVersion: 1, requirements: [], riskDecisions: storedDecisions }];
    mockGetBrief.mockResolvedValue(brief({ version: 3, sections: renderBriefSections(sections, storedRequirements) }));
    mockApprove.mockResolvedValue({ briefId: 'brief-1', version: 4, resumed: true, alreadyApproved: false });

    await approveBuildBrief({ interviewId: 'iv-1', actorId: 'requester' });

    expect(upserts[0]).toMatchObject({ briefVersion: 3 });
    expect((upserts[0].requirements as BuildRequirement[]).map((row) => row.id)).toEqual(['AC-1', 'AC-2', 'BR-1']);
    expect(mockApprove).toHaveBeenCalled();
  });

  it('PBI-012 AC-1 refuses a Project Admin of another project', async () => {
    const error = await approveBuildBrief({ interviewId: 'iv-1', actorId: 'pa-other' }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(403);
    expect(mockApprove).not.toHaveBeenCalled();
  });
});

describe('analysis read (PBI-013)', () => {
  it('VT-21 returns decisions, classification and the takeover label for an admin', async () => {
    withDraftRevision();
    mockGetBrief.mockResolvedValue(brief());

    const analysis = await getBuildBriefAnalysis({ interviewId: 'iv-1', viewerId: 'pa-1' });

    expect(analysis.riskDecisions[0]).toMatchObject({ id: 'RD-1', rating: 'medium', rationale: 'Own gate' });
    expect(analysis.viewer).toEqual({ mayEdit: true, actingFor: 'Dana Lee' });
    expect(analysis.requester.displayName).toBe('Dana Lee');
  });

  it('VT-22 returns empty decisions and still classifies', async () => {
    tables.build_revisions = [{ id: 'rev-1', briefVersion: 1, requirements: storedRequirements, riskDecisions: [] }];
    tables.build_events = [{ eventType: 'intake.brief_drafted', detail: storedState }];
    mockGetBrief.mockResolvedValue(brief());

    const analysis = await getBuildBriefAnalysis({ interviewId: 'iv-1', viewerId: 'viewer-1' });

    expect(analysis.riskDecisions).toEqual([]);
    expect(analysis.classification.value).toBe('small');
    expect(analysis.viewer).toEqual({ mayEdit: false, actingFor: null });
  });

  it('PBI-011 AC-1 reports a failed automatic draft when no brief exists', async () => {
    tables.build_events = [{ eventType: 'intake.brief_draft_failed', detail: { reason: 'timeout' } }];
    const error = await getBuildBriefAnalysis({ interviewId: 'iv-1', viewerId: 'requester' }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(404);
    expect((error as BuildBriefError).draftFailed).toBe(true);
  });

  it('VT-21 returns 404 for a non-build interview', async () => {
    tables.interviews = [{ ...interviewRow, playbookProfileKey: 'grill-with-docs' }];
    const error = await getBuildBriefAnalysis({ interviewId: 'iv-1', viewerId: 'requester' }).catch((err: unknown) => err);
    expect((error as BuildBriefError).statusCode).toBe(404);
  });
});
