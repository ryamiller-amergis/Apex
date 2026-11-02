import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn(), trackAgentError: jest.fn() }));

import {
  computeActions,
  createHandoffEngine,
  sha256,
  type HandoffEngineDeps,
  type HandoffPersistence,
  type HandoffRow,
  type NewHandoffRow,
} from '../services/brainstormHandoffEngine';
import {
  buildAdrContent,
  buildHandoffContext,
  outlineArtifact,
  type HandoffCapabilities,
  type TargetServices,
} from '../services/brainstormHandoffTargets';
import type { BrainstormArtifactType } from '../../shared/types/brainstormArtifact';

const SESSION_ID = '60000000-0000-4000-8000-000000000001';
const ARTIFACT_ID = '60000000-0000-4000-8000-000000000002';

const ADR_MD = [
  '# Use Postgres for queues',
  '',
  '## Context',
  'We need durable jobs.',
  '',
  '## Considered Options',
  '- Postgres',
  '- Service Bus',
  '',
  '## Decision Outcome',
  'Chosen option: Postgres.',
  '',
  '## Consequences',
  'One fewer service.',
].join('\n');

const DESIGN_MD = '# Queue design\n\n## Overview\nWorkers poll a table.';

function caps(overrides: Partial<HandoffCapabilities> = {}): HandoffCapabilities {
  return {
    isSuperAdmin: false,
    permissions: new Set(['adr:create', 'interviews:manage', 'feature-requests:submit']),
    groups: ['BA'],
    enabledMenus: new Set(['adr', 'backlog', 'feature-requests']),
    repository: { repo: 'apex', branch: 'main', provider: 'ado', settingsId: 'settings-1', interviewSkillPath: null },
    ...overrides,
  };
}

const session = { id: SESSION_ID, project: 'alpha', creatorId: 'creator', state: 'active' };

function memoryPersistence() {
  const rows: HandoffRow[] = [];
  let seq = 0;
  const persistence: HandoffPersistence = {
    async listForSession() {
      return rows.map((row) => ({ ...row }));
    },
    async findById(_sessionId, id) {
      const row = rows.find((item) => item.id === id);
      return row ? { ...row } : null;
    },
    async findLive(_sessionId, kind, version) {
      const row = rows.find((item) => item.actionKind === kind && item.artifactVersion === version && item.state !== 'failed');
      return row ? { ...row } : null;
    },
    async insert(input: NewHandoffRow) {
      if (rows.some((item) => item.actionKind === input.actionKind && item.artifactVersion === input.artifactVersion && item.state !== 'failed')) {
        return null;
      }
      seq += 1;
      const row: HandoffRow = {
        id: `h-${seq}`,
        sessionId: input.sessionId,
        project: input.project,
        actionKind: input.actionKind,
        targetModule: input.targetModule,
        state: input.state,
        previewSnapshot: input.previewSnapshot,
        confirmedAt: input.confirmedAt,
        idempotencyKey: input.idempotencyKey,
        resultRef: input.resultRef,
        artifactVersion: input.artifactVersion,
        targetThreadId: null,
        claimToken: null,
        failureCode: null,
        updatedAt: '2026-10-29T10:00:00.000Z',
      };
      rows.push(row);
      return { ...row };
    },
    async claim(id, token, at) {
      const row = rows.find((item) => item.id === id && item.state === 'previewed');
      if (!row) return false;
      Object.assign(row, { state: 'executing', claimToken: token, confirmedAt: at });
      return true;
    },
    async takeOver(id, oldToken, newToken, at, staleBefore) {
      const row = rows.find((item) => item.id === id && item.state === 'executing' && item.claimToken === oldToken);
      if (!row || Date.parse(row.confirmedAt ?? '') >= Date.parse(staleBefore)) return false;
      Object.assign(row, { claimToken: newToken, confirmedAt: at });
      return true;
    },
    async storeThread(id, token, threadId) {
      const row = rows.find((item) => item.id === id && item.claimToken === token && item.state === 'executing');
      if (!row) return false;
      row.targetThreadId = threadId;
      return true;
    },
    async complete(id, token, resultRef) {
      const row = rows.find((item) => item.id === id && item.claimToken === token && item.state === 'executing');
      if (!row) return false;
      Object.assign(row, { state: 'completed', resultRef });
      return true;
    },
    async fail(id, token, code) {
      const row = rows.find((item) => item.id === id && (token ? item.claimToken === token && item.state === 'executing' : item.state === 'previewed'));
      if (!row) return false;
      Object.assign(row, { state: 'failed', failureCode: code });
      return true;
    },
    async release(id, token) {
      const row = rows.find((item) => item.id === id && item.claimToken === token);
      if (row) row.confirmedAt = new Date(0).toISOString();
    },
  };
  return { rows, persistence };
}

function fakeServices() {
  const records = {
    adr: new Map<string, string>(),
    interview: new Map<string, string>(),
    'feature-request': new Map<string, string>(),
  };
  let threads = 0;
  const services = {
    createThread: jest.fn(async () => {
      threads += 1;
      return `thread-${threads}`;
    }),
    findRecordByThread: jest.fn(async (module: 'adr' | 'interview' | 'feature-request', threadId: string) => records[module].get(threadId) ?? null),
    createAdrFromContent: jest.fn(async (input: { chatThreadId: string }) => {
      const id = `adr-${records.adr.size + 1}`;
      records.adr.set(input.chatThreadId, id);
      return id;
    }),
    createInterview: jest.fn(async (input: { chatThreadId: string }) => {
      const id = `interview-${records.interview.size + 1}`;
      records.interview.set(input.chatThreadId, id);
      return id;
    }),
    createFeatureRequestFromPlan: jest.fn(async (input: { title: string }) => {
      const id = `fr-${records['feature-request'].size + 1}`;
      records['feature-request'].set(input.title, id);
      return id;
    }),
    markInterviewThread: jest.fn(async () => {}),
  };
  return { records, services };
}

function setup(options: {
  type?: BrainstormArtifactType | null;
  markdown?: string;
  version?: number;
  capabilities?: HandoffCapabilities;
} = {}) {
  const state = {
    type: options.type === undefined ? 'adr' : options.type,
    markdown: options.markdown ?? ADR_MD,
    version: options.version ?? 3,
    capabilities: options.capabilities ?? caps(),
    clock: new Date('2026-10-29T12:00:00.000Z'),
  };
  const memory = memoryPersistence();
  const fake = fakeServices();
  let ids = 0;
  const deps: HandoffEngineDeps = {
    persistence: memory.persistence,
    artifacts: {
      getArtifact: async () => ({ id: ARTIFACT_ID, type: state.type, version: state.version, markdown: state.markdown }),
      getVersion: async () => ({ markdown: state.markdown, artifactType: state.type }),
    },
    loadCapabilities: async () => state.capabilities,
    listCitations: async () => [],
    services: fake.services as unknown as TargetServices,
    now: () => state.clock,
    newId: () => `id-${++ids}`,
    track: jest.fn(),
  };
  return { state, memory, fake, engine: createHandoffEngine(deps) };
}

function actionsFor(type: BrainstormArtifactType | null, markdown: string, overrides: Partial<Parameters<typeof computeActions>[0]> = {}) {
  return computeActions({
    sessionState: 'active',
    isCreator: true,
    artifact: { type, version: 2, markdown },
    capabilities: caps(),
    handoffs: [],
    ...overrides,
  });
}

describe('computeActions', () => {
  it('VT-22: a complete ADR offers create and keep', () => {
    const result = actionsFor('adr', ADR_MD);
    expect(result.viewerCanAct).toBe(true);
    expect(result.actions.map((action) => [action.id, action.state])).toEqual([
      ['create-adr', 'available'],
      ['keep-standalone', 'available'],
    ]);
  });

  it('VT-23: an ADR without Decision Outcome lists it as missing', () => {
    const markdown = ADR_MD.replace(/## Decision Outcome\nChosen option: Postgres.\n\n/, '');
    const create = actionsFor('adr', markdown).actions.find((action) => action.id === 'create-adr')!;
    expect(create.state).toBe('unavailable');
    expect(create.missingInformation).toEqual(['Decision Outcome']);
    expect(create.reasons[0].text).toContain('Decision Outcome');
  });

  it('VT-23: Considered Options needs at least one option', () => {
    const markdown = ADR_MD.replace('- Postgres\n- Service Bus', 'We looked around.');
    const create = actionsFor('adr', markdown).actions.find((action) => action.id === 'create-adr')!;
    expect(create.missingInformation).toEqual(['Considered Options']);
  });

  it('ignores headings inside fenced code', () => {
    const markdown = ADR_MD.replace('## Consequences\nOne fewer service.', '```\n## Consequences\n```');
    expect(outlineArtifact(markdown).sections.has('consequences')).toBe(false);
  });

  it('VT-24: an action the creator may not take is omitted', () => {
    const noAdr = actionsFor('adr', ADR_MD, { capabilities: caps({ permissions: new Set(['interviews:manage']) }) });
    expect(noAdr.actions.map((action) => action.id)).toEqual(['keep-standalone']);
    const menuOff = actionsFor('discovery_brief', DESIGN_MD, { capabilities: caps({ enabledMenus: new Set(['adr']) }) });
    expect(menuOff.actions.map((action) => action.id)).toEqual(['keep-standalone']);
    const noGroup = actionsFor('technical_design', DESIGN_MD, { capabilities: caps({ groups: [] }) });
    expect(noGroup.actions.map((action) => action.id)).toEqual(['keep-standalone']);
  });

  it('VT-24: admin:roles and Super Admins pass the Interview group rule', () => {
    const admin = actionsFor('technical_design', DESIGN_MD, {
      capabilities: caps({ groups: [], permissions: new Set(['interviews:manage', 'admin:roles']) }),
    });
    expect(admin.actions.map((action) => action.id)).toContain('start-interview');
    const superAdmin = actionsFor('technical_design', DESIGN_MD, {
      capabilities: caps({ groups: [], permissions: new Set(), isSuperAdmin: true }),
    });
    expect(superAdmin.actions.map((action) => action.id)).toContain('start-interview');
  });

  it('a missing project repository is listed as missing information', () => {
    const create = actionsFor('adr', ADR_MD, { capabilities: caps({ repository: null }) }).actions[0];
    expect(create.missingInformation).toEqual(['Project repository']);
  });

  it.each([
    ['adr', ADR_MD, ['create-adr', 'keep-standalone']],
    ['technical_design', DESIGN_MD, ['start-interview', 'keep-standalone']],
    ['discovery_brief', DESIGN_MD, ['start-interview', 'keep-standalone']],
    ['implementation_plan', DESIGN_MD, ['create-feature-request', 'keep-standalone']],
    [null, DESIGN_MD, ['keep-standalone']],
  ] as const)('VT-27 / VT-30 / VT-34: type %s offers %j', (type, markdown, expected) => {
    expect(actionsFor(type, markdown).actions.map((action) => action.id)).toEqual(expected);
  });

  it.each(['ended', 'failed'])('VT-27: a %s session offers nothing', (state) => {
    const result = actionsFor('adr', ADR_MD, { sessionState: state });
    expect(result).toMatchObject({ viewerCanAct: false, actions: [] });
  });

  it('VT-27: version 0 leaves keep as standalone unavailable', () => {
    const result = computeActions({
      sessionState: 'active',
      isCreator: true,
      artifact: { type: null, version: 0, markdown: '' },
      capabilities: caps(),
      handoffs: [],
    });
    expect(result.actions).toEqual([expect.objectContaining({ id: 'keep-standalone', state: 'unavailable', reasons: [expect.objectContaining({ code: 'NO_ARTIFACT' })] })]);
  });

  it('VT-25: a non-creator sees no actions and only completed handoffs', () => {
    const base = { previewSnapshot: { actionId: 'create-adr', contentSha256: '', plan: null, preview: null } } as unknown as HandoffRow;
    const handoffs = [
      { ...base, id: 'a', state: 'completed', actionKind: 'create_direct', artifactVersion: 2 },
      { ...base, id: 'b', state: 'previewed', actionKind: 'create_direct', artifactVersion: 3 },
    ] as HandoffRow[];
    const result = computeActions({
      sessionState: 'active',
      isCreator: false,
      artifact: { type: 'adr', version: 3, markdown: ADR_MD },
      capabilities: null,
      handoffs,
    });
    expect(result.viewerCanAct).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.handoffs.map((handoff) => handoff.handoffId)).toEqual(['a']);
  });
});

describe('preview and confirm', () => {
  it('VT-37: creates one Proposed ADR, whatever the artifact says about status', async () => {
    const accepted = `---\nstatus: Accepted\n---\n${ADR_MD.replace('# Use Postgres for queues', '# Use Postgres for queues\n\n## Status\n\nAccepted')}`;
    const { engine, fake } = setup({ markdown: accepted });
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    expect(preview).toMatchObject({ state: 'previewed', artifactVersion: 3, target: { module: 'adr' } });
    expect(preview.summary).toEqual(expect.arrayContaining([{ label: 'Status', value: 'Proposed' }]));
    expect(preview.notes.join(' ')).toMatch(/No reviewers are assigned/);

    const done = await engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey });
    expect(done).toEqual({
      handoffId: preview.handoffId,
      state: 'completed',
      resultRef: { module: 'adr', id: 'adr-1', link: '/adr/adr-1' },
      replayed: false,
    });
    expect(fake.services.createAdrFromContent).toHaveBeenCalledTimes(1);
    const content = (fake.services.createAdrFromContent.mock.calls[0] as unknown as [{ content: string }])[0].content;
    expect(content).toMatch(/^---\nadr-number: ADR-pending\nstatus: Proposed\ndate: 2026-10-29\nslug: use-postgres-for-queues\n---/);
    expect(content).not.toMatch(/status: Accepted/);
    expect(content).toMatch(/## Status\n\nProposed/);
  });

  it('a repeated preview returns the same row and key', async () => {
    const { engine, memory } = setup();
    const first = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    const second = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    expect(second.handoffId).toBe(first.handoffId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(memory.rows).toHaveLength(1);
  });

  it('a repeated confirmation replays the stored result', async () => {
    const { engine, fake } = setup();
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    await engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey });
    const again = await engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey });
    expect(again).toMatchObject({ state: 'completed', replayed: true, resultRef: { id: 'adr-1' } });
    expect(fake.services.createAdrFromContent).toHaveBeenCalledTimes(1);
  });

  it('VT-32: a discovery brief starts one interview with the artifact in the thread context', async () => {
    const { engine, fake } = setup({ type: 'discovery_brief', markdown: DESIGN_MD });
    const preview = await engine.preview(session, 'creator', { actionId: 'start-interview', expectedVersion: 3 });
    expect(preview.summary).toEqual(expect.arrayContaining([{ label: 'Interview skill', value: '.agents/skills/grill-with-docs/SKILL.md' }]));
    const done = await engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey });
    expect(done).toMatchObject({ state: 'completed', resultRef: { module: 'interview', link: '/backlog/interview/interview-1' } });
    const thread = (fake.services.createThread.mock.calls[0] as unknown as [{ freeformContext: string; skillPath: string; module: string }])[0];
    expect(thread.module).toBe('interview');
    expect(thread.freeformContext).toContain('# Queue design');
    expect(thread.freeformContext).toContain(SESSION_ID);
    expect(fake.services.createInterview).toHaveBeenCalledTimes(1);
  });

  it('VT-34: a technical design interviews with grill-design and offers no Design Doc', async () => {
    const { engine } = setup({ type: 'technical_design', markdown: DESIGN_MD });
    const listed = await engine.listActions(session, 'creator');
    expect(listed.actions.map((action) => action.targetModule)).toEqual(['interview', 'standalone']);
    const preview = await engine.preview(session, 'creator', { actionId: 'start-interview', expectedVersion: 3 });
    expect(preview.summary).toEqual(expect.arrayContaining([{ label: 'Interview skill', value: '.agents/skills/grill-design/SKILL.md' }]));
  });

  it("uses the project's interview skill for a discovery brief when one is set", async () => {
    const { engine } = setup({
      type: 'discovery_brief',
      markdown: DESIGN_MD,
      capabilities: caps({ repository: { repo: 'apex', branch: 'main', provider: 'ado', settingsId: 's', interviewSkillPath: '.agents/skills/kick-off/SKILL.md' } }),
    });
    const preview = await engine.preview(session, 'creator', { actionId: 'start-interview', expectedVersion: 3 });
    expect(preview.summary).toEqual(expect.arrayContaining([{ label: 'Interview skill', value: '.agents/skills/kick-off/SKILL.md' }]));
  });

  it('creates a Feature Request from an implementation_plan artifact on confirm', async () => {
    const planMd = '# Automated repo drift notifications\n\n## Steps\n1. Check remote HEAD.\n2. Surface badge.';
    const { engine, fake } = setup({ type: 'implementation_plan', markdown: planMd });
    const preview = await engine.preview(session, 'creator', {
      actionId: 'create-feature-request',
      expectedVersion: 3,
    });
    expect(preview).toMatchObject({
      state: 'previewed',
      artifactVersion: 3,
      target: { module: 'feature-request', label: 'Create Feature Request' },
    });
    expect(preview.summary).toEqual(expect.arrayContaining([
      { label: 'Destination', value: 'Feature Request' },
      { label: 'Title', value: 'Automated repo drift notifications' },
      { label: 'Status', value: 'New' },
    ]));

    const done = await engine.confirm(session, 'creator', {
      handoffId: preview.handoffId,
      idempotencyKey: preview.idempotencyKey,
    });
    expect(done).toEqual({
      handoffId: preview.handoffId,
      state: 'completed',
      resultRef: { module: 'feature-request', id: 'fr-1', link: '/feature-requests?selected=fr-1' },
      replayed: false,
    });
    expect(fake.services.createFeatureRequestFromPlan).toHaveBeenCalledTimes(1);
    expect(fake.services.createFeatureRequestFromPlan).toHaveBeenCalledWith(expect.objectContaining({
      project: 'alpha',
      title: 'Automated repo drift notifications',
    }));
  });

  it('VT-36: an artifact change after preview makes the confirmation stale', async () => {
    const { engine, state, fake } = setup();
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    state.version = 4;
    state.markdown = `${ADR_MD}\n\nMore.`;
    await expect(
      engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE', status: 409 });
    expect(fake.services.createThread).not.toHaveBeenCalled();
    const fresh = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 4 });
    expect(fresh.handoffId).not.toBe(preview.handoffId);
  });

  it('VT-38: losing adr:create before confirmation fails the handoff and creates nothing', async () => {
    const { engine, state, fake, memory } = setup();
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    state.capabilities = caps({ permissions: new Set() });
    await expect(
      engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey }),
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', details: { failureCode: 'PERMISSION_MISSING' } });
    expect(memory.rows[0]).toMatchObject({ state: 'failed', failureCode: 'PERMISSION_MISSING' });
    expect(fake.services.createAdrFromContent).not.toHaveBeenCalled();
  });

  it('VT-35: a wrong key or a non-creator creates nothing', async () => {
    const { engine, fake } = setup();
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    await expect(
      engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: 'other' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_MISMATCH', status: 409 });
    await expect(
      engine.confirm(session, 'member', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      engine.confirm(session, 'creator', { handoffId: 'h-missing', idempotencyKey: preview.idempotencyKey }),
    ).rejects.toMatchObject({ code: 'HANDOFF_NOT_FOUND', status: 404 });
    expect(fake.services.createThread).not.toHaveBeenCalled();
  });

  it('VT-40: create_direct is refused for a technical design and for a creator without the permission', async () => {
    const design = setup({ type: 'technical_design', markdown: DESIGN_MD });
    await expect(
      design.engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE', status: 409 });
    const noPermission = setup({ capabilities: caps({ permissions: new Set() }) });
    await expect(
      noPermission.engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' });
    expect(design.memory.rows).toHaveLength(0);
    expect(noPermission.memory.rows).toHaveLength(0);
  });

  it('a stale expected version on preview returns the current version', async () => {
    const { engine } = setup();
    await expect(
      engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT', details: { currentVersion: 3 } });
  });
});

describe('VT-33: interrupted confirmation', () => {
  it('reports executing within 60 seconds, then takes over and finds the record by thread', async () => {
    const { engine, fake, memory, state } = setup();
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    fake.services.createAdrFromContent.mockImplementationOnce(async (input: { chatThreadId: string }) => {
      fake.records.adr.set(input.chatThreadId, 'adr-1');
      throw new Error('process stopped');
    });
    await expect(
      engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey }),
    ).rejects.toMatchObject({ code: 'HANDOFF_INTERRUPTED', status: 500 });

    // Simulate a crash instead of a release: the claim stays fresh.
    memory.rows[0].confirmedAt = state.clock.toISOString();
    const pending = await engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey });
    expect(pending).toEqual({ handoffId: preview.handoffId, state: 'executing' });

    const replayed = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    expect(replayed).toMatchObject({
      handoffId: preview.handoffId,
      idempotencyKey: preview.idempotencyKey,
      state: 'previewed',
    });

    state.clock = new Date(state.clock.getTime() + 61_000);
    const done = await engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey });
    expect(done).toMatchObject({ state: 'completed', resultRef: { id: 'adr-1' }, replayed: false });
    expect(fake.records.adr.size).toBe(1);
    expect(fake.services.createThread).toHaveBeenCalledTimes(1);
    expect(fake.services.createAdrFromContent).toHaveBeenCalledTimes(1);
  });

  it('an unexpected error releases the claim so the next confirmation retries at once', async () => {
    const { engine, fake } = setup();
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    fake.services.createThread.mockRejectedValueOnce(new Error('network'));
    await expect(
      engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey }),
    ).rejects.toMatchObject({ code: 'HANDOFF_INTERRUPTED' });
    const done = await engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey });
    expect(done).toMatchObject({ state: 'completed' });
  });

  it('a target refusal fails the handoff with a code', async () => {
    const { engine, fake, memory } = setup();
    const preview = await engine.preview(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
    fake.services.createAdrFromContent.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 403 }));
    await expect(
      engine.confirm(session, 'creator', { handoffId: preview.handoffId, idempotencyKey: preview.idempotencyKey }),
    ).rejects.toMatchObject({ code: 'PERMISSION_MISSING', status: 409 });
    expect(memory.rows[0].state).toBe('failed');
  });
});

describe('VT-30: keep as standalone', () => {
  it('writes one completed row per version and replays it', async () => {
    const { engine, memory } = setup({ type: null, markdown: DESIGN_MD });
    const first = await engine.keepStandalone(session, 'creator', { expectedVersion: 3 });
    expect(first).toMatchObject({ state: 'completed', replayed: false, resultRef: { module: 'standalone', id: ARTIFACT_ID } });
    const second = await engine.keepStandalone(session, 'creator', { expectedVersion: 3 });
    expect(second).toMatchObject({ handoffId: first.handoffId, replayed: true });
    expect(memory.rows).toHaveLength(1);
    const listed = await engine.listActions(session, 'creator');
    expect(listed.actions).toEqual([expect.objectContaining({ id: 'keep-standalone', state: 'completed' })]);
  });

  it('is refused for an empty artifact', async () => {
    const { engine } = setup({ type: null, markdown: '', version: 0 });
    await expect(engine.keepStandalone(session, 'creator', { expectedVersion: 0 })).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' });
  });
});

describe('content builders', () => {
  it('adds a Proposed status section when the ADR has none', () => {
    const content = buildAdrContent(ADR_MD, 'Use Postgres for queues', '2026-10-29');
    expect(content).toMatch(/# Use Postgres for queues\n\n## Status\n\nProposed\n/);
  });

  it('handoff context carries cited claims, not source content', () => {
    const context = buildHandoffContext({
      sessionId: SESSION_ID,
      project: 'alpha',
      artifactType: 'adr',
      version: 3,
      markdown: ADR_MD,
      citations: [{
        id: 'c1',
        messageId: 'm1',
        sourceKind: 'project-repository',
        sourceName: 'apex',
        path: 'src/queue.ts',
        mcpServerName: null,
        mcpToolId: null,
        revision: 'abc123',
        claim: 'Jobs are polled every second.',
        createdAt: '2026-10-29T10:00:00.000Z',
      }],
    });
    expect(context).toContain('- Jobs are polled every second. (apex: src/queue.ts @ abc123)');
  });

  it('hashes Markdown with SHA-256', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('VT-44: the engine writes no target table', () => {
  it.each(['brainstormHandoffEngine.ts', 'brainstormHandoffTargets.ts'])('%s imports no adrs or interviews schema object', (file) => {
    const source = readFileSync(resolve(__dirname, '../services', file), 'utf8');
    const schemaImports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/db\/schema'/g)].map((match) => match[1]);
    for (const names of schemaImports) {
      expect(names).not.toMatch(/\badrs\b|\binterviews\b/);
    }
    expect(source).not.toMatch(/from '\.\.\/db\/schema\/(adrs|interviews)'/);
  });
});
