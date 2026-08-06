/**
 * Unit tests for linkedContextMaterializerService (FEAT-003 / TBI-004 / PBI-005).
 * Covers VT-01..VT-06, AC-0..AC-3, DoD-0..DoD-2.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const mockGetLinkedContext = jest.fn();
const mockGetAdr = jest.fn();
const mockGetModuleById = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock('../services/interviewLinkService', () => ({
  getLinkedContext: (...a: unknown[]) => mockGetLinkedContext(...a),
}));

jest.mock('../services/adrService', () => ({
  getAdr: (...a: unknown[]) => mockGetAdr(...a),
}));

jest.mock('../services/designModuleService', () => ({
  getModuleById: (...a: unknown[]) => mockGetModuleById(...a),
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH,
  materializeLinkedContext,
  renderLinkedContextDocument,
} from '../services/linkedContextMaterializerService';
import type { LinkedContextReadModel } from '../../shared/types/interviewLinks';

const INTERVIEW_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ADR_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADR_B = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ADR_STALE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const MOD_A = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const MOD_B = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const ACTOR = { userId: 'user-mgr', isSuperAdmin: true };

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linked-ctx-'));
}

function documentPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH.split('/'));
}

function baseReadModel(overrides: Partial<LinkedContextReadModel> = {}): LinkedContextReadModel {
  return {
    interviewId: INTERVIEW_ID,
    adrLinks: [
      {
        adrId: ADR_B,
        title: 'ADR B',
        isAccepted: true,
        linkedBy: 'user-ba',
        linkedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        adrId: ADR_A,
        title: 'ADR A',
        isAccepted: true,
        linkedBy: 'user-ba',
        linkedAt: '2026-08-02T00:00:00.000Z',
      },
    ],
    designModuleLinks: [
      {
        designModuleId: MOD_B,
        name: 'Module B',
        linkedBy: 'user-ba',
        linkedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        designModuleId: MOD_A,
        name: 'Module A',
        linkedBy: 'user-ba',
        linkedAt: '2026-08-02T00:00:00.000Z',
      },
    ],
    count: 4,
    capacity: 10,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAdr.mockImplementation(async (id: string) => {
    if (id === ADR_A) {
      return { id: ADR_A, title: 'ADR A', status: 'accepted', content: 'Content of ADR A v1' };
    }
    if (id === ADR_B) {
      return { id: ADR_B, title: 'ADR B', status: 'accepted', content: 'Content of ADR B' };
    }
    if (id === ADR_STALE) {
      return { id: ADR_STALE, title: 'Stale ADR', status: 'superseded', content: 'Should never appear' };
    }
    return null;
  });
  mockGetModuleById.mockImplementation(async (id: string) => {
    if (id === MOD_A) {
      return {
        id: MOD_A,
        label: 'Module A',
        description: 'Desc A',
        content: 'Generated docs for Module A',
        sourceGlobs: ['src/server/services/foo.ts', 'src/client/components/Bar.tsx'],
      };
    }
    if (id === MOD_B) {
      return {
        id: MOD_B,
        label: 'Module B',
        description: 'Desc B',
        content: 'Generated docs for Module B',
        sourceGlobs: ['src/shared/types/baz.ts'],
      };
    }
    return null;
  });
});

describe('renderLinkedContextDocument — DoD-0 / VT-01 template', () => {
  it('DoD-0: includes provenance, Linked ADRs (accepted), and Linked Design Modules sections', () => {
    const markdown = renderLinkedContextDocument({
      interviewId: INTERVIEW_ID,
      materializedAt: '2026-08-06T12:00:00.000Z',
      adrs: [
        { id: ADR_A, title: 'ADR A', content: 'Body A' },
        { id: ADR_B, title: 'ADR B', content: 'Body B' },
      ],
      designModules: [
        {
          id: MOD_A,
          name: 'Module A',
          description: 'Desc A',
          documentation: 'Docs A',
          sourceGlobs: ['src/a.ts'],
        },
      ],
    });

    expect(markdown).toContain('# Linked Interview Grounding Context');
    expect(markdown).toContain(`Interview-Id: ${INTERVIEW_ID}`);
    expect(markdown).toContain('Materialized-At: 2026-08-06T12:00:00.000Z');
    expect(markdown).toContain('## Linked ADRs (accepted)');
    expect(markdown).toContain('## Linked Design Modules');
    expect(markdown).toContain('Body A');
    expect(markdown).toContain('Body B');
    expect(markdown).toContain('Desc A');
    expect(markdown).toContain('Docs A');
    expect(markdown).toContain('src/a.ts');
  });

  it('DoD-0: orders ADRs and modules by artifact id for deterministic output', () => {
    const markdown = renderLinkedContextDocument({
      interviewId: INTERVIEW_ID,
      materializedAt: '2026-08-06T12:00:00.000Z',
      adrs: [
        { id: ADR_B, title: 'ADR B', content: 'B' },
        { id: ADR_A, title: 'ADR A', content: 'A' },
      ],
      designModules: [
        { id: MOD_B, name: 'B', description: null, documentation: null, sourceGlobs: ['b/**'] },
        { id: MOD_A, name: 'A', description: null, documentation: null, sourceGlobs: ['a/**'] },
      ],
    });

    expect(markdown.indexOf(ADR_A)).toBeLessThan(markdown.indexOf(ADR_B));
    expect(markdown.indexOf(MOD_A)).toBeLessThan(markdown.indexOf(MOD_B));
  });
});

describe('materializeLinkedContext — PBI-005 / TBI-004', () => {
  it('AC-0 / VT-01: writes freshly generated document with provenance, ADR content, and module docs + globs', async () => {
    const workspaceDir = makeWorkspace();
    mockGetLinkedContext.mockResolvedValue(baseReadModel());

    const result = await materializeLinkedContext(INTERVIEW_ID, {
      workspaceDir,
      actor: ACTOR,
    });

    expect(result.outcome).toBe('written');
    expect(result.adrCount).toBe(2);
    expect(result.designModuleCount).toBe(2);
    expect(result.staleAdrExcluded).toBe(0);
    expect(result.documentPath).toBe(documentPath(workspaceDir));

    const body = fs.readFileSync(documentPath(workspaceDir), 'utf8');
    expect(body).toContain('## Linked ADRs (accepted)');
    expect(body).toContain('Content of ADR A v1');
    expect(body).toContain('Content of ADR B');
    expect(body).toContain('## Linked Design Modules');
    expect(body).toContain('Desc A');
    expect(body).toContain('Generated docs for Module A');
    expect(body).toContain('src/server/services/foo.ts');
    expect(body).not.toMatch(/function\s+|export\s+default|import\s+/); // no raw source
  });

  it('AC-0 / VT-02 / BR-009: second call reflects live ADR content (no snapshot)', async () => {
    const workspaceDir = makeWorkspace();
    mockGetLinkedContext.mockResolvedValue(baseReadModel({
      designModuleLinks: [],
      count: 2,
      adrLinks: [
        {
          adrId: ADR_A,
          title: 'ADR A',
          isAccepted: true,
          linkedBy: 'user-ba',
          linkedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    }));

    await materializeLinkedContext(INTERVIEW_ID, { workspaceDir, actor: ACTOR });
    const first = fs.readFileSync(documentPath(workspaceDir), 'utf8');
    expect(first).toContain('Content of ADR A v1');

    mockGetAdr.mockResolvedValueOnce({
      id: ADR_A,
      title: 'ADR A',
      status: 'accepted',
      content: 'Content of ADR A v2 LIVE',
    });

    await materializeLinkedContext(INTERVIEW_ID, { workspaceDir, actor: ACTOR });
    const second = fs.readFileSync(documentPath(workspaceDir), 'utf8');
    expect(second).toContain('Content of ADR A v2 LIVE');
    expect(second).not.toContain('Content of ADR A v1');
  });

  it('AC-1 / VT-03: on resolve failure, removes any prior doc and emits diagnostic without artifact bodies', async () => {
    const workspaceDir = makeWorkspace();
    const target = documentPath(workspaceDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'STALE PRIOR DOCUMENT with secret ADR body XYZ', 'utf8');

    mockGetLinkedContext.mockRejectedValue(new Error('read model timeout'));

    const result = await materializeLinkedContext(INTERVIEW_ID, {
      workspaceDir,
      actor: ACTOR,
    });

    expect(result.outcome).toBe('failed');
    expect(fs.existsSync(target)).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalled();
    const [eventName, props] = mockTrackEvent.mock.calls[0];
    expect(eventName).toBe('interview.linked_context.materialize');
    expect(props.outcome).toBe('failed');
    expect(props.interviewId).toBe(INTERVIEW_ID);
    const serialized = JSON.stringify(mockTrackEvent.mock.calls);
    expect(serialized).not.toContain('secret ADR body');
    expect(serialized).not.toContain('XYZ');
  });

  it('AC-2 / VT-04 / BR-011: empty effective set omits document (no empty placeholder)', async () => {
    const workspaceDir = makeWorkspace();
    const target = documentPath(workspaceDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'prior content', 'utf8');

    mockGetLinkedContext.mockResolvedValue({
      interviewId: INTERVIEW_ID,
      adrLinks: [
        {
          adrId: ADR_STALE,
          title: 'Stale',
          isAccepted: false,
          staleReason: 'no_longer_accepted',
          linkedBy: 'user-ba',
          linkedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      designModuleLinks: [],
      count: 1,
      capacity: 10,
    });

    const result = await materializeLinkedContext(INTERVIEW_ID, {
      workspaceDir,
      actor: ACTOR,
    });

    expect(result.outcome).toBe('omitted');
    expect(result.adrCount).toBe(0);
    expect(result.designModuleCount).toBe(0);
    expect(result.staleAdrExcluded).toBe(1);
    expect(result.documentPath).toBeUndefined();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('AC-3 / VT-05 / BR-008/BR-010: excludes superseded ADR and never inlines raw files', async () => {
    const workspaceDir = makeWorkspace();
    mockGetLinkedContext.mockResolvedValue({
      interviewId: INTERVIEW_ID,
      adrLinks: [
        {
          adrId: ADR_A,
          title: 'ADR A',
          isAccepted: true,
          linkedBy: 'user-ba',
          linkedAt: '2026-08-02T00:00:00.000Z',
        },
        {
          adrId: ADR_STALE,
          title: 'Stale ADR',
          isAccepted: false,
          staleReason: 'no_longer_accepted',
          linkedBy: 'user-ba',
          linkedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      designModuleLinks: [
        {
          designModuleId: MOD_A,
          name: 'Module A',
          linkedBy: 'user-ba',
          linkedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      count: 3,
      capacity: 10,
    });

    // Even if a module somehow exposed file bodies, materializer must only use stored fields.
    mockGetModuleById.mockResolvedValueOnce({
      id: MOD_A,
      label: 'Module A',
      description: 'Desc A',
      content: 'Generated docs only',
      sourceGlobs: ['src/secret.ts'],
      // Poison field — must never be read into the document as file contents
      rawFileContents: { 'src/secret.ts': 'export const SECRET = 1;' },
    });

    const result = await materializeLinkedContext(INTERVIEW_ID, {
      workspaceDir,
      actor: ACTOR,
    });

    expect(result.outcome).toBe('written');
    expect(result.staleAdrExcluded).toBe(1);
    expect(result.adrCount).toBe(1);

    const body = fs.readFileSync(documentPath(workspaceDir), 'utf8');
    expect(body).toContain('Content of ADR A v1');
    expect(body).not.toContain('Should never appear');
    expect(body).not.toContain('Stale ADR');
    expect(body).toContain('src/secret.ts'); // manifest string only
    expect(body).not.toContain('export const SECRET');
    expect(body).not.toContain('rawFileContents');
  });

  it('VT-06: atomic replace leaves no half-written observable document', async () => {
    const workspaceDir = makeWorkspace();
    mockGetLinkedContext.mockResolvedValue(baseReadModel({
      designModuleLinks: [],
      count: 2,
    }));

    const result = await materializeLinkedContext(INTERVIEW_ID, {
      workspaceDir,
      actor: ACTOR,
    });

    expect(result.outcome).toBe('written');
    const dir = path.dirname(documentPath(workspaceDir));
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp') || f.endsWith('.partial'));
    expect(leftovers).toEqual([]);
    const body = fs.readFileSync(documentPath(workspaceDir), 'utf8');
    expect(body.startsWith('# Linked Interview Grounding Context')).toBe(true);
    expect(body).toContain('## Linked ADRs (accepted)');
  });
});
