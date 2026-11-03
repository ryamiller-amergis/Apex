/**
 * FEAT-003 TBI-007 — artifact version store.
 * Covers VT-01, VT-03, VT-04, VT-09, VT-10, VT-11, VT-15, VT-16, VT-19, VT-21, VT-42.
 */
import fs from 'fs';
import path from 'path';
import {
  BrainstormArtifactError,
  createArtifactVersionStore,
  type ArtifactPersistence,
  type ArtifactRow,
  type ArtifactTx,
  type NewVersion,
  type VersionRow,
} from '../services/brainstormArtifactVersionStore';
import { BRAINSTORM_ARTIFACT_MAX_BYTES, type BrainstormArtifactFailureCode } from '../../shared/types/brainstormArtifact';

const SESSION = '20000000-0000-4000-8000-000000000001';
const PROJECT = 'alpha';
const CREATOR = 'creator-1';
const RUN = '30000000-0000-4000-8000-000000000001';
const ctx = { sessionId: SESSION, project: PROJECT, authorId: CREATOR };

interface MemoryState {
  sessionState: string;
  artifact: ArtifactRow | null;
  versions: (NewVersion & { createdAt: string })[];
  failure: { code: BrainstormArtifactFailureCode; at: string } | null;
}

function memoryPersistence(initial?: Partial<MemoryState>) {
  let state: MemoryState = { sessionState: 'active', artifact: null, versions: [], failure: null, ...initial };
  let clock = 0;
  const stamp = () => `2026-10-29T12:00:${String(clock++).padStart(2, '0')}.000Z`;
  const toRow = (v: MemoryState['versions'][number]): VersionRow => ({
    sequence: v.sequence,
    markdown: v.markdown,
    changeOrigin: v.changeOrigin,
    checkpointName: v.checkpointName,
    artifactType: v.artifactType,
    authorId: v.authorId,
    createdAt: v.createdAt,
  });
  const tx: ArtifactTx = {
    async lockSession(sessionId, project) {
      return sessionId === SESSION && project === PROJECT ? { state: state.sessionState } : null;
    },
    async readArtifact() {
      return state.artifact ? { ...state.artifact } : null;
    },
    async insertFirstArtifact(input) {
      if (state.artifact) return null;
      state.artifact = {
        id: 'artifact-1',
        sessionId: input.sessionId,
        project: input.project,
        artifactType: input.type,
        markdown: input.markdown,
        version: 1,
        updatedAt: stamp(),
      };
      return { ...state.artifact };
    },
    async bumpArtifact(input) {
      if (!state.artifact || state.artifact.version !== input.expectedVersion) return null;
      state.artifact = {
        ...state.artifact,
        version: state.artifact.version + 1,
        markdown: input.markdown,
        artifactType: input.type,
        updatedAt: stamp(),
      };
      return state.artifact.version;
    },
    async insertVersion(row) {
      if (state.versions.some((v) => v.sequence === row.sequence)) throw new Error('unique violation');
      const stored = { ...row, createdAt: stamp() };
      state.versions.push(stored);
      return toRow(stored);
    },
    async findVersion(_artifactId, sequence) {
      const found = state.versions.find((v) => v.sequence === sequence);
      return found ? toRow(found) : null;
    },
    async checkpointNameTaken(_artifactId, name) {
      return state.versions.some((v) => v.checkpointName?.toLowerCase() === name.toLowerCase());
    },
    async nameVersion(_artifactId, sequence, name) {
      const found = state.versions.find((v) => v.sequence === sequence);
      if (!found || found.checkpointName !== null) return false;
      found.checkpointName = name;
      return true;
    },
    async latestSequenceForRun(_artifactId, runId) {
      const mine = state.versions.filter((v) => v.runId === runId).map((v) => v.sequence);
      return mine.length > 0 ? Math.max(...mine) : null;
    },
    async touchSession() {},
  };
  const persistence: ArtifactPersistence = {
    async transaction(work) {
      const snapshot = JSON.parse(JSON.stringify(state)) as MemoryState;
      try {
        return await work(tx);
      } catch (err) {
        state = snapshot;
        throw err;
      }
    },
    async getArtifact() {
      return state.artifact ? { ...state.artifact } : null;
    },
    async findArtifactById(id) {
      return state.artifact?.id === id ? { sessionId: SESSION, project: PROJECT } : null;
    },
    async listVersions(_artifactId, { limit, before }) {
      return [...state.versions]
        .filter((v) => before === null || v.sequence < before)
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, limit)
        .map((v) => ({ ...toRow(v), sizeBytes: Buffer.byteLength(v.markdown) }));
    },
    async getVersion(_artifactId, sequence) {
      const found = state.versions.find((v) => v.sequence === sequence);
      return found ? toRow(found) : null;
    },
    async countVersions() {
      return state.versions.length;
    },
    async latestArtifactFailure() {
      return state.failure;
    },
  };
  return { persistence, get state() { return state; }, setSessionState(value: string) { state.sessionState = value; } };
}

function storeWith(memory = memoryPersistence()) {
  const events: string[] = [];
  const store = createArtifactVersionStore({ persistence: memory.persistence, track: (event) => events.push(event) });
  return { store, memory, events };
}

async function seedVersions(store: ReturnType<typeof storeWith>['store'], count: number, runPrefix = 'run') {
  for (let i = 0; i < count; i += 1) {
    await store.applyAiChange({ ...ctx, runId: `${runPrefix}-${i}`, baseVersion: i, markdown: `# Doc\n\nv${i + 1}` });
  }
}

async function expectCode(promise: Promise<unknown>, code: string, status?: number) {
  await expect(promise).rejects.toBeInstanceOf(BrainstormArtifactError);
  await promise.catch((err: BrainstormArtifactError) => {
    expect(err.code).toBe(code);
    if (status) expect(err.status).toBe(status);
  });
}

describe('TBI-007 DoD-0 / PBI-011 AC-0 — an AI-requested change writes a version', () => {
  it('VT-01: applies at once as the next version and leaves earlier versions unchanged', async () => {
    const { store, memory, events } = storeWith();
    await seedVersions(store, 3);
    const before = memory.state.versions.map((v) => ({ ...v }));
    const written = await store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 3, markdown: '# Doc\n\n## New section' });
    expect(written).toMatchObject({ sequence: 4, origin: 'ai_change' });
    expect(memory.state.artifact?.version).toBe(4);
    expect(memory.state.artifact?.markdown).toBe('# Doc\n\n## New section');
    expect(memory.state.versions.slice(0, 3)).toEqual(before);
    expect(events).toContain('brainstorm.artifact.version_written');
  });

  it('lets a second change in the same run build on the version that run wrote', async () => {
    const { store } = storeWith();
    await store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 0, markdown: 'one' });
    const second = await store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 0, markdown: 'two' });
    expect(second.sequence).toBe(2);
  });
});

describe('PBI-011 AC-2 — first draft without a type', () => {
  it('VT-03: creates the artifact row and version 1 with no type', async () => {
    const { store, memory } = storeWith();
    const written = await store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 0, markdown: '# Idea' });
    expect(written.sequence).toBe(1);
    expect(written.artifactType).toBeNull();
    expect(memory.state.artifact).toMatchObject({ version: 1, artifactType: null });
  });
});

describe('TBI-007 DoD-3 / PBI-011 AC-1 — a stale write is rejected and changes nothing', () => {
  it('rejects a change built on an older version with the current version and writes nothing', async () => {
    const { store, memory, events } = storeWith();
    await seedVersions(store, 5);
    const snapshot = JSON.stringify(memory.state);
    const err = await store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 4, markdown: 'late' }).catch((e) => e);
    expect(err).toBeInstanceOf(BrainstormArtifactError);
    expect(err).toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT', status: 409, details: { currentVersion: 5 } });
    expect(JSON.stringify(memory.state)).toBe(snapshot);
    expect(events).toContain('brainstorm.artifact.stale_write_rejected');
  });

  it('rejects a first draft when another write created the artifact first', async () => {
    const { store } = storeWith();
    await store.applyAiChange({ ...ctx, runId: 'other', baseVersion: 0, markdown: 'first' });
    await expectCode(store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 0, markdown: 'second' }), 'ARTIFACT_VERSION_CONFLICT');
  });

  it('refuses every write once the session is no longer active', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 1);
    memory.setSessionState('ended');
    await expectCode(store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 1, markdown: 'x' }), 'SESSION_NOT_ACTIVE', 409);
    await expectCode(store.rollback({ ...ctx, expectedVersion: 1, toSequence: 1 }), 'SESSION_NOT_ACTIVE');
    await expectCode(store.labelCheckpoint({ ...ctx, expectedVersion: 1, name: 'x' }), 'SESSION_NOT_ACTIVE');
  });

  it('rejects Markdown over 256 KiB and keeps the last version', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 1);
    const huge = 'a'.repeat(BRAINSTORM_ARTIFACT_MAX_BYTES + 1);
    await expectCode(store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 1, markdown: huge }), 'ARTIFACT_TOO_LARGE', 413);
    expect(memory.state.artifact?.version).toBe(1);
  });
});

describe('TBI-007 DoD-4 / PBI-011 AC-3 — sanitization on write', () => {
  it('VT-04: stores no unsafe markup and keeps a mermaid fence byte-identical', async () => {
    const { store, memory } = storeWith();
    const fence = '```mermaid\ngraph TD\n  A --> B\n```\n';
    await store.applyAiChange({
      ...ctx,
      runId: RUN,
      baseVersion: 0,
      markdown: `# T\n<script>alert(1)</script><iframe src=x></iframe><img src=x onerror=alert(1)>\n[x](javascript:alert(1))\n\n${fence}`,
    });
    const stored = memory.state.artifact?.markdown ?? '';
    expect(stored).not.toMatch(/<script|<iframe|onerror=|javascript:/i);
    expect(stored).toContain(fence);
    expect(memory.state.versions[0].markdown).toBe(stored);
  });
});

describe('TBI-007 DoD-2 / PBI-012 — type switch writes a checkpoint and keeps history', () => {
  it('VT-09: labels the previous version, writes a type_switch version and sets the type', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 4);
    const written = await store.applyTypeSwitch({
      ...ctx,
      runId: RUN,
      baseVersion: 4,
      newType: 'technical_design',
      markdown: '# Technical design',
    });
    expect(memory.state.versions[3].checkpointName).toBe('Before switch to Technical design');
    expect(written).toMatchObject({ sequence: 5, origin: 'type_switch', artifactType: 'technical_design' });
    expect(memory.state.artifact?.artifactType).toBe('technical_design');
  });

  it('VT-10: a switch that fails leaves type, version and labels unchanged', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 2);
    const snapshot = JSON.stringify(memory.state);
    const huge = 'b'.repeat(BRAINSTORM_ARTIFACT_MAX_BYTES + 10);
    await expectCode(store.applyTypeSwitch({ ...ctx, runId: RUN, baseVersion: 2, newType: 'adr', markdown: huge }), 'ARTIFACT_TOO_LARGE');
    await memory.persistence.transaction(async () => undefined);
    const err = await store.applyTypeSwitch({ ...ctx, runId: RUN, baseVersion: 1, newType: 'adr', markdown: 'x' }).catch((e) => e);
    expect(err.code).toBe('ARTIFACT_VERSION_CONFLICT');
    expect(JSON.stringify(memory.state)).toBe(snapshot);
  });

  it('VT-11 (1): the first type on an empty artifact writes version 1 with a checkpoint and no turn', async () => {
    const { store, memory } = storeWith();
    const written = await store.setTypeOnEmpty({ ...ctx, expectedVersion: 0, type: 'adr' });
    expect(written).toMatchObject({ sequence: 1, origin: 'type_switch', checkpointName: 'Type set: ADR', artifactType: 'adr' });
    expect(memory.state.artifact).toMatchObject({ markdown: '', artifactType: 'adr', version: 1 });
  });

  it('VT-11 (1b): a second type choice on still-empty content writes the next version without a turn', async () => {
    const { store, memory } = storeWith();
    await store.setTypeOnEmpty({ ...ctx, expectedVersion: 0, type: 'adr' });
    const written = await store.setTypeOnEmpty({ ...ctx, expectedVersion: 1, type: 'technical_design' });
    expect(written).toMatchObject({ sequence: 2, checkpointName: 'Type set: Technical design' });
    expect(memory.state.artifact).toMatchObject({ artifactType: 'technical_design', version: 2 });
    await expect(store.setTypeOnEmpty({ ...ctx, expectedVersion: 1, type: 'adr' })).rejects.toMatchObject({
      code: 'ARTIFACT_VERSION_CONFLICT',
    });
  });

  it('VT-11 (2): content with no type is labeled before the reshaped version', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 1);
    await store.applyTypeSwitch({ ...ctx, runId: RUN, baseVersion: 1, newType: 'discovery_brief', markdown: '# Brief' });
    expect(memory.state.versions[0].checkpointName).toBe('Before switch to Discovery brief');
    expect(memory.state.artifact?.artifactType).toBe('discovery_brief');
  });

  it('keeps a user-named checkpoint and does not rename it on a switch', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 1);
    await store.labelCheckpoint({ ...ctx, expectedVersion: 1, name: 'Mine' });
    await store.applyTypeSwitch({ ...ctx, runId: RUN, baseVersion: 1, newType: 'adr', markdown: '# ADR' });
    expect(memory.state.versions[0].checkpointName).toBe('Mine');
  });
});

describe('TBI-007 DoD-1 / PBI-013 — checkpoints, compare and rollback', () => {
  it('VT-15: names the current version, compares two versions and rolls back by adding a version', async () => {
    const { store, memory, events } = storeWith();
    await seedVersions(store, 5);
    const named = await store.labelCheckpoint({ ...ctx, expectedVersion: 5, name: '  Release candidate  ' });
    expect(named.checkpointName).toBe('Release candidate');
    expect(memory.state.artifact?.version).toBe(5);

    const compared = await store.compareVersions(SESSION, PROJECT, 4, 2);
    expect(compared.from.sequence).toBe(2);
    expect(compared.to.sequence).toBe(4);
    expect(compared.from.markdown).toContain('v2');

    const rolled = await store.rollback({ ...ctx, expectedVersion: 5, toSequence: 2 });
    expect(rolled).toMatchObject({ sequence: 6, origin: 'rollback' });
    expect(memory.state.artifact?.markdown).toBe(memory.state.versions[1].markdown);
    expect(memory.state.versions.map((v) => v.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events).toContain('brainstorm.artifact.rolled_back');
  });

  it('VT-16: a rollback prepared on an older version is rejected and writes nothing', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 6);
    const snapshot = JSON.stringify(memory.state);
    const err = await store.rollback({ ...ctx, expectedVersion: 5, toSequence: 2 }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT', details: { currentVersion: 6 } });
    expect(JSON.stringify(memory.state)).toBe(snapshot);
  });

  it('PBI-013 AC-2: comparison with one version reports nothing to compare', async () => {
    const { store } = storeWith();
    await seedVersions(store, 1);
    await expectCode(store.compareVersions(SESSION, PROJECT, 1, 1), 'NOTHING_TO_COMPARE', 409);
    await expectCode(storeWith().store.compareVersions(SESSION, PROJECT, 1, 2), 'NOTHING_TO_COMPARE');
  });

  it('VT-19: rejects blank, too-long, duplicate and already-named checkpoints and changes nothing', async () => {
    const { store, memory } = storeWith();
    await seedVersions(store, 2);
    await expectCode(store.labelCheckpoint({ ...ctx, expectedVersion: 2, name: '   ' }), 'INVALID_CHECKPOINT_NAME', 400);
    await expectCode(store.labelCheckpoint({ ...ctx, expectedVersion: 2, name: 'x'.repeat(81) }), 'INVALID_CHECKPOINT_NAME', 400);
    await expectCode(store.labelCheckpoint({ ...ctx, expectedVersion: 2, name: 'bad\u0007' }), 'INVALID_CHECKPOINT_NAME');
    await store.labelCheckpoint({ ...ctx, expectedVersion: 2, name: 'Draft' });
    await expectCode(store.labelCheckpoint({ ...ctx, expectedVersion: 2, name: 'Other' }), 'CHECKPOINT_EXISTS', 409);
    await store.applyAiChange({ ...ctx, runId: RUN, baseVersion: 2, markdown: 'v3' });
    await expectCode(store.labelCheckpoint({ ...ctx, expectedVersion: 3, name: 'draft' }), 'CHECKPOINT_NAME_TAKEN', 409);
    await expectCode(store.labelCheckpoint({ ...ctx, expectedVersion: 2, name: 'Late' }), 'ARTIFACT_VERSION_CONFLICT');
    expect(memory.state.versions.map((v) => v.checkpointName)).toEqual([null, 'Draft', null]);
  });

  it('VT-21: rollback across a type switch restores the earlier type', async () => {
    const { store, memory } = storeWith();
    await store.setTypeOnEmpty({ ...ctx, expectedVersion: 0, type: 'adr' });
    await store.applyAiChange({ ...ctx, runId: 'r2', baseVersion: 1, markdown: '# ADR body' });
    await store.applyTypeSwitch({ ...ctx, runId: 'r3', baseVersion: 2, newType: 'technical_design', markdown: '# Design' });
    await store.rollback({ ...ctx, expectedVersion: 3, toSequence: 2 });
    expect(memory.state.artifact).toMatchObject({ artifactType: 'adr', markdown: '# ADR body', version: 4 });
  });
});

describe('Reads', () => {
  it('returns version 0 and empty Markdown before the first write', async () => {
    const { store } = storeWith();
    await expect(store.getArtifact(SESSION, PROJECT)).resolves.toMatchObject({ id: null, version: 0, markdown: '', type: null });
    await expect(store.resolveArtifactContext(SESSION, PROJECT)).resolves.toEqual({ type: null, version: 0, markdown: '' });
  });

  it('lists versions newest first without Markdown and pages with a cursor', async () => {
    const { store } = storeWith();
    await seedVersions(store, 5);
    const first = await store.listVersions(SESSION, PROJECT, { limit: 2 });
    expect(first.versions.map((v) => v.sequence)).toEqual([5, 4]);
    expect(first.versions[0]).not.toHaveProperty('markdown');
    expect(first.nextCursor).toBe(4);
    const next = await store.listVersions(SESSION, PROJECT, { limit: 10, cursor: first.nextCursor });
    expect(next.versions.map((v) => v.sequence)).toEqual([3, 2, 1]);
    expect(next.nextCursor).toBeNull();
  });

  it('reports the last failed AI change on the artifact', async () => {
    const memory = memoryPersistence({ failure: { code: 'ARTIFACT_VERSION_CONFLICT', at: '2026-10-29T12:00:00.000Z' } });
    const { store } = storeWith(memory);
    const artifact = await store.getArtifact(SESSION, PROJECT);
    expect(artifact.lastChangeFailure).toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT' });
    expect(artifact.lastChangeFailure?.summary).toMatch(/not applied/);
  });

  it('throws VERSION_NOT_FOUND for an unknown sequence', async () => {
    const { store } = storeWith();
    await seedVersions(store, 1);
    await expectCode(store.getVersion(SESSION, PROJECT, 9), 'VERSION_NOT_FOUND', 404);
  });
});

describe('VT-42 — history is append-only', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/brainstormArtifactVersionStore.ts'), 'utf8');

  it('has no delete statement', () => {
    expect(source).not.toMatch(/\.delete\(/);
  });

  it('updates a version row only to set a missing checkpoint name', () => {
    const updates = source.split('.update(brainstormArtifactVersions)').slice(1);
    expect(updates).toHaveLength(1);
    const statement = updates[0].slice(0, updates[0].indexOf('.returning('));
    expect(statement).toContain('.set({ checkpointName: name })');
    expect(statement).toContain('isNull(brainstormArtifactVersions.checkpointName)');
  });

  it('exposes no operation that edits or removes a stored version', () => {
    const { store } = storeWith();
    expect(Object.keys(store).sort()).toEqual([
      'applyAiChange',
      'applyTypeSwitch',
      'compareVersions',
      'findArtifactById',
      'getArtifact',
      'getVersion',
      'labelCheckpoint',
      'listVersions',
      'resolveArtifactContext',
      'rollback',
      'setTypeOnEmpty',
    ]);
  });
});
