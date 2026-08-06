/**
 * FEAT-004 S5 integration coverage for live linked-context generation handoffs.
 * Uses the public pipeline propagation and materializer APIs with real workspaces.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const mockInterviewFindFirst = jest.fn();
const mockPrdFindFirst = jest.fn();
const mockDesignDocFindFirst = jest.fn();
const mockChatThreadFindFirst = jest.fn();
const mockGetLinkedContext = jest.fn();
const mockGetAdr = jest.fn();
const mockGetModuleById = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: {
        findFirst: (...args: unknown[]) => mockInterviewFindFirst(...args),
      },
      prds: {
        findFirst: (...args: unknown[]) => mockPrdFindFirst(...args),
      },
      designDocs: {
        findFirst: (...args: unknown[]) => mockDesignDocFindFirst(...args),
      },
      chatThreads: {
        findFirst: (...args: unknown[]) => mockChatThreadFindFirst(...args),
      },
    },
  },
}));

jest.mock('../services/interviewLinkService', () => ({
  getLinkedContext: (...args: unknown[]) => mockGetLinkedContext(...args),
}));

jest.mock('../services/adrService', () => ({
  getAdr: (...args: unknown[]) => mockGetAdr(...args),
}));

jest.mock('../services/designModuleService', () => ({
  getModuleById: (...args: unknown[]) => mockGetModuleById(...args),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { propagatePipelineGrounding } from '../services/runGroundingService';
import { LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH } from '../services/linkedContextMaterializerService';
import type { RunRef } from '../../shared/types/runGrounding';

const PROJECT = 'Apex';
const USER_ID = 'user-product-owner';
const INTERVIEW_ID = 'interview-live-context';
const PRD_ID = 'prd-live-context';
const DESIGN_ID = 'design-live-context';
const ADR_ID = 'adr-accepted-then-superseded';
const MODULE_ID = 'module-live-docs';
const RAW_SOURCE_BODY = 'export const RAW_SOURCE_SECRET = "must never be supplied";';
const FAILURE_ARTIFACT_BODY = 'private ADR body from failed resolution';

const interviewRun: RunRef = {
  runType: 'chat',
  runId: 'interview-thread',
  project: PROJECT,
};
const prdRun: RunRef = {
  runType: 'chat',
  runId: 'prd-thread',
  project: PROJECT,
};
const designRun: RunRef = {
  runType: 'chat',
  runId: 'design-thread',
  project: PROJECT,
};

const temporaryDirectories: string[] = [];

function makeWorkspace(label: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  temporaryDirectories.push(workspace);
  return workspace;
}

function linkedContextPath(workspaceDir: string): string {
  return path.join(
    workspaceDir,
    ...LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH.split('/'),
  );
}

function arrangeInterviewToPrd(workspaceDir: string): void {
  mockInterviewFindFirst.mockResolvedValue({
    id: INTERVIEW_ID,
    project: PROJECT,
  });
  mockPrdFindFirst.mockResolvedValue({
    id: PRD_ID,
    interviewId: INTERVIEW_ID,
    project: PROJECT,
  });
  mockChatThreadFindFirst.mockResolvedValue({ workspaceDir });
}

function arrangePrdToDesign(workspaceDir: string): void {
  mockInterviewFindFirst.mockResolvedValue(null);
  mockPrdFindFirst.mockResolvedValue({
    id: PRD_ID,
    interviewId: INTERVIEW_ID,
    project: PROJECT,
  });
  mockDesignDocFindFirst.mockResolvedValue({
    id: DESIGN_ID,
    prdId: PRD_ID,
    project: PROJECT,
  });
  mockChatThreadFindFirst.mockResolvedValue({ workspaceDir });
}

function expectBodyFreePropagationEvents(
  expected: Array<{ surface: 'prd' | 'design'; outcome: string }>,
): void {
  const events = mockTrackEvent.mock.calls.filter(
    ([name]) => name === 'grounding.linked-context.propagate',
  );
  expect(events).toHaveLength(expected.length);
  expected.forEach((item, index) => {
    const [, properties, measurements] = events[index];
    expect(properties).toEqual(item);
    expect(Object.keys(properties).sort()).toEqual(['outcome', 'surface']);
    expect(Object.keys(measurements)).toEqual(['durationMs']);
    expect(measurements.durationMs).toEqual(expect.any(Number));
    expect(measurements.durationMs).toBeLessThan(2_000);
  });
}

beforeEach(() => {
  jest.clearAllMocks();

  mockGetLinkedContext.mockResolvedValue({
    interviewId: INTERVIEW_ID,
    adrLinks: [
      {
        adrId: ADR_ID,
        title: 'Accepted architecture',
        isAccepted: true,
        linkedBy: USER_ID,
        linkedAt: '2026-08-06T12:00:00.000Z',
      },
    ],
    designModuleLinks: [
      {
        designModuleId: MODULE_ID,
        name: 'Generation boundary',
        linkedBy: USER_ID,
        linkedAt: '2026-08-06T12:00:00.000Z',
      },
    ],
    count: 2,
    capacity: 10,
  });
  mockGetAdr.mockResolvedValue({
    id: ADR_ID,
    title: 'Accepted architecture',
    status: 'accepted',
    content: 'Accepted ADR body v1',
  });
  mockGetModuleById.mockResolvedValue({
    id: MODULE_ID,
    label: 'Generation boundary',
    description: 'Original module description',
    content: 'Original generated module documentation',
    sourceGlobs: ['src/server/generation/**/*.ts'],
  });
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('FEAT-004 S5 generation handoff integration', () => {
  it('TBI-006 DoD-0 / DoD-1 / DoD-3 / PBI-006 AC-0 / AC-2 / AC-3 / VT-02 / VT-04 Given artifacts change across Interview→PRD→design, When both handoffs run, Then each destination receives current eligible context without stale ADR or raw source bodies', async () => {
    // Arrange
    const prdWorkspace = makeWorkspace('linked-prd-handoff');
    const designWorkspace = makeWorkspace('linked-design-handoff');
    const sourceWorkspace = makeWorkspace('linked-source-files');
    const rawSourcePath = path.join(sourceWorkspace, 'src/server/generation/raw.ts');
    fs.mkdirSync(path.dirname(rawSourcePath), { recursive: true });
    fs.writeFileSync(rawSourcePath, RAW_SOURCE_BODY, 'utf8');
    arrangeInterviewToPrd(prdWorkspace);

    const isFeatureEnabledForPrd = jest.fn(async () => {
      expect(fs.existsSync(linkedContextPath(prdWorkspace))).toBe(true);
      return false;
    });

    // Act
    await expect(
      propagatePipelineGrounding(interviewRun, prdRun, USER_ID, {
        isFeatureEnabled: isFeatureEnabledForPrd,
      }),
    ).resolves.toBeNull();

    // Assert
    const prdBody = fs.readFileSync(linkedContextPath(prdWorkspace), 'utf8');
    expect(prdBody).toContain('# Linked Interview Grounding Context');
    expect(prdBody).toContain(`Interview-Id: ${INTERVIEW_ID}`);
    expect(prdBody).toContain('## Linked ADRs (accepted)');
    expect(prdBody).toContain('Accepted ADR body v1');
    expect(prdBody).toContain('Original module description');
    expect(prdBody).toContain('Original generated module documentation');
    expect(prdBody).toContain('src/server/generation/**/*.ts');
    expect(isFeatureEnabledForPrd).toHaveBeenCalledWith(
      'repo-grounding-workspace-profile',
      { userId: USER_ID, project: PROJECT },
    );

    // Arrange the next handoff after the live artifacts change.
    mockGetAdr.mockResolvedValue({
      id: ADR_ID,
      title: 'Accepted architecture',
      status: 'superseded',
      content: 'Superseded ADR body must not reach design',
    });
    mockGetModuleById.mockResolvedValue({
      id: MODULE_ID,
      label: 'Generation boundary',
      description: 'Current module description',
      content: 'Current generated module documentation',
      sourceGlobs: ['src/server/generation/raw.ts'],
      rawFileContents: { [rawSourcePath]: RAW_SOURCE_BODY },
    });
    arrangePrdToDesign(designWorkspace);

    // Act
    await expect(
      propagatePipelineGrounding(prdRun, designRun, USER_ID, {
        isFeatureEnabled: jest.fn().mockResolvedValue(false),
      }),
    ).resolves.toBeNull();

    // Assert
    const designBody = fs.readFileSync(linkedContextPath(designWorkspace), 'utf8');
    expect(designBody).toContain('Current module description');
    expect(designBody).toContain('Current generated module documentation');
    expect(designBody).toContain('src/server/generation/raw.ts');
    expect(designBody).not.toContain('Original module description');
    expect(designBody).not.toContain('Original generated module documentation');
    expect(designBody).not.toContain('Accepted ADR body v1');
    expect(designBody).not.toContain('Superseded ADR body');
    expect(designBody).not.toContain(RAW_SOURCE_BODY);
    expect(designBody).not.toContain('rawFileContents');
    expectBodyFreePropagationEvents([
      { surface: 'prd', outcome: 'materialized' },
      { surface: 'design', outcome: 'materialized' },
    ]);
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain(RAW_SOURCE_BODY);
  });

  it('TBI-006 DoD-2 / PBI-006 AC-1 / VT-03 Given an applicable handoff has no effective links, When generation runs, Then stale context is removed and generation continues', async () => {
    // Arrange
    const prdWorkspace = makeWorkspace('linked-empty-handoff');
    const target = linkedContextPath(prdWorkspace);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'stale linked context that must be removed', 'utf8');
    arrangeInterviewToPrd(prdWorkspace);
    mockGetLinkedContext.mockResolvedValue({
      interviewId: INTERVIEW_ID,
      adrLinks: [
        {
          adrId: ADR_ID,
          title: 'No longer accepted',
          isAccepted: false,
          staleReason: 'no_longer_accepted',
          linkedBy: USER_ID,
          linkedAt: '2026-08-06T12:00:00.000Z',
        },
      ],
      designModuleLinks: [],
      count: 1,
      capacity: 10,
    });

    // Act
    await expect(
      propagatePipelineGrounding(interviewRun, prdRun, USER_ID, {
        isFeatureEnabled: jest.fn().mockResolvedValue(false),
      }),
    ).resolves.toBeNull();

    // Assert
    expect(fs.existsSync(target)).toBe(false);
    expect(mockGetAdr).not.toHaveBeenCalled();
    expectBodyFreePropagationEvents([{ surface: 'prd', outcome: 'empty' }]);
  });

  it('Security NFR / PBI-006 AC-1 / VT-07 Given actual materialization fails with an artifact body in the error, When generation runs, Then it fails open, removes stale context, and emits body-free diagnostics', async () => {
    // Arrange
    const designWorkspace = makeWorkspace('linked-failed-handoff');
    const target = linkedContextPath(designWorkspace);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `stale ${FAILURE_ARTIFACT_BODY}`, 'utf8');
    arrangePrdToDesign(designWorkspace);
    mockGetLinkedContext.mockRejectedValue(
      new Error(`resolution failed while reading ${FAILURE_ARTIFACT_BODY}`),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      // Act
      await expect(
        propagatePipelineGrounding(prdRun, designRun, USER_ID, {
          isFeatureEnabled: jest.fn().mockResolvedValue(false),
        }),
      ).resolves.toBeNull();

      // Assert
      expect(fs.existsSync(target)).toBe(false);
      expectBodyFreePropagationEvents([
        { surface: 'design', outcome: 'unavailable' },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        FAILURE_ARTIFACT_BODY,
      );
      expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain(
        FAILURE_ARTIFACT_BODY,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
