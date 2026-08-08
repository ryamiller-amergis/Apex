import type { ExcalidrawScene } from '../../shared/types/diagram';
import * as repository from '../services/diagramRepository';
import { db } from '../db/drizzle';

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

const returning = jest.fn();
const where = jest.fn(() => ({ returning }));
const set = jest.fn(() => ({ where }));
const update = db.update as jest.Mock;
const deleteWhere = jest.fn(() => ({ returning }));
const deleteFrom = db.delete as jest.Mock;
const onConflictDoUpdate = jest.fn(() => ({ returning }));
const values = jest.fn(() => ({ returning, onConflictDoUpdate }));
const insert = db.insert as jest.Mock;
const offset = jest.fn();
const limit = jest.fn(() => ({ offset }));
const orderBy = jest.fn(() => ({ limit }));
const selectWhere = jest.fn(() => ({ orderBy, limit }));
const innerJoin = jest.fn(() => ({ where: selectWhere }));
const from = jest.fn(() => ({ where: selectWhere, innerJoin }));
const select = db.select as jest.Mock;

const scene: ExcalidrawScene = { elements: [], appState: {}, files: {} };
const row = {
  id: 'diagram-1',
  projectId: 'project-a',
  ownerId: 'owner-1',
  title: 'Diagram',
  scene,
  thumbnail: 'data:image/png;base64,iVBORw0KGgo=',
  version: 1,
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};

describe('diagramRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    update.mockReturnValue({ set });
    deleteFrom.mockReturnValue({ where: deleteWhere });
    insert.mockReturnValue({ values });
    select.mockReturnValue({ from });
  });

  it('TBI-001 DoD-3 VT-02 deletes only a project-scoped Diagram and relies on cascade', async () => {
    returning.mockResolvedValueOnce([{ id: row.id }]);

    await expect(repository.deleteDiagram('project-a', row.id)).resolves.toBe(true);
    expect(deleteFrom).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
  });

  it('TBI-001 DoD-3 atomic-version NFR performs one conditional update and returns null on stale', async () => {
    returning.mockResolvedValueOnce([]);

    await expect(
      repository.updateDiagramWithVersion('project-a', row.id, 4, {
        title: 'Updated',
        scene,
        thumbnail: row.thumbnail,
      }),
    ).resolves.toBeNull();

    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Updated',
      version: expect.anything(),
      updatedAt: expect.anything(),
    }));
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('TBI-001 DoD-3 returns the atomically incremented row on success', async () => {
    returning.mockResolvedValueOnce([{ ...row, version: 5 }]);

    await expect(
      repository.updateDiagramWithVersion('project-a', row.id, 4, {
        title: 'Updated',
        scene,
        thumbnail: row.thumbnail,
      }),
    ).resolves.toEqual({ ...row, version: 5 });
  });

  it('TBI-001 DoD-3 VT-03 upserts one unique Diagram/grantee grant', async () => {
    const share = {
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'edit' as const,
      createdAt: row.createdAt,
    };
    returning.mockResolvedValueOnce([share]);

    await expect(repository.upsertShare(row.id, 'user-2', 'edit')).resolves.toEqual(share);
    expect(onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.any(Array),
      set: { access: 'edit' },
    }));
  });

  it('TBI-001 DoD-3 applies pagination to project-filtered owned queries', async () => {
    offset.mockResolvedValueOnce([row]);

    await expect(repository.listOwnedDiagrams('project-a', 'owner-1', 51, 50))
      .resolves.toEqual([row]);
    expect(limit).toHaveBeenCalledWith(51);
    expect(offset).toHaveBeenCalledWith(50);
  });

  it('PBI-004 AC-2 batch-looks up owner display names by oid', async () => {
    const whereResolved = jest.fn().mockResolvedValueOnce([
      { oid: 'owner-1', displayName: 'Owner One' },
      { oid: 'owner-2', displayName: null },
    ]);
    from.mockReturnValueOnce({ where: whereResolved, innerJoin });

    await expect(repository.getDisplayNamesByIds(['owner-1', 'owner-2', 'owner-1']))
      .resolves.toEqual(new Map([
        ['owner-1', 'Owner One'],
        ['owner-2', null],
      ]));
    expect(select).toHaveBeenCalled();
    expect(whereResolved).toHaveBeenCalled();
  });

  it('PBI-004 AC-2 returns an empty map for an empty owner id batch', async () => {
    await expect(repository.getDisplayNamesByIds([])).resolves.toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
  });
});
