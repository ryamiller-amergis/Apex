import {
  DIAGRAM_MAX_SCENE_BYTES,
  DIAGRAM_MAX_THUMBNAIL_BYTES,
  DiagramForbiddenError,
  DiagramNotFoundError,
  DiagramValidationError,
  DiagramVersionConflictError,
  diagramShareDeepLink,
  diagramShareDedupeKey,
  type ExcalidrawScene,
} from '../../shared/types/diagram';
import * as repository from '../services/diagramRepository';
import * as notificationService from '../services/notificationService';
import * as rbacService from '../services/rbacService';
import * as service from '../services/diagramService';

jest.mock('../services/diagramRepository');
jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));
jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

const repo = repository as jest.Mocked<typeof repository>;
const createNotification = notificationService.createNotification as jest.MockedFunction<
  typeof notificationService.createNotification
>;
const getUserPermissions = rbacService.getUserPermissions as jest.MockedFunction<
  typeof rbacService.getUserPermissions
>;
const NOW = '2026-08-06T00:00:00.000Z';

function pngDataUrl(byteLength = 8): string {
  const bytes = Buffer.alloc(byteLength);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function sceneWithSerializedBytes(targetBytes: number): ExcalidrawScene {
  const empty: ExcalidrawScene = {
    elements: [],
    appState: { payload: '' },
    files: {},
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(empty), 'utf8');
  return {
    ...empty,
    appState: { payload: 'x'.repeat(targetBytes - baseBytes) },
  };
}

const scene: ExcalidrawScene = { elements: [], appState: {}, files: {} };
const row = {
  id: 'diagram-1',
  projectId: 'project-a',
  ownerId: 'owner-1',
  title: 'Untitled diagram',
  scene,
  thumbnail: pngDataUrl(),
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function memberPerms(...extra: string[]): Set<string> {
  return new Set(['diagram:view', 'diagram:create', 'diagram:edit', 'diagram:delete', 'diagram:share', ...extra]);
}

function viewerPerms(): Set<string> {
  return new Set(['diagram:view']);
}

beforeEach(() => {
  jest.clearAllMocks();
  getUserPermissions.mockResolvedValue(memberPerms());
  repo.findShare.mockResolvedValue(null);
  createNotification.mockResolvedValue({
    id: 'notif-1',
    userId: 'user-2',
    type: 'user-action',
    title: 'Diagram shared with you',
    body: null,
    link: '/diagrams/diagram-1',
    read: false,
    createdAt: NOW,
  });
});

describe('diagramService CRUD and access', () => {
  it('TBI-002 DoD-1 VT-04 creates an owner-private project Diagram and returns detail', async () => {
    repo.createDiagram.mockResolvedValue(row);
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-1', 'Owner One']]));

    const result = await service.createDiagram(
      'project-a',
      { scene, thumbnail: row.thumbnail },
      'owner-1',
    );

    expect(repo.createDiagram).toHaveBeenCalledWith(
      'project-a',
      'owner-1',
      expect.objectContaining({ title: 'Untitled diagram', scene }),
    );
    expect(result).toEqual(expect.objectContaining({
      projectId: 'project-a',
      ownerId: 'owner-1',
      ownerName: 'Owner One',
      effectiveAccess: 'owner',
      version: 1,
      scene,
    }));
  });

  it('TBI-002 DoD-1 / PBI-004 AC-2 returns scene only from detail, never summaries, and includes ownerName', async () => {
    repo.listOwnedDiagrams.mockResolvedValue([row]);
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-1', 'Owner One']]));

    const result = await service.listDiagrams(
      'project-a',
      { scope: 'owned', limit: 50, offset: 0 },
      'owner-1',
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty('scene');
    expect(result.items[0].effectiveAccess).toBe('owner');
    expect(result.items[0].ownerName).toBe('Owner One');
    expect(repo.getDisplayNamesByIds).toHaveBeenCalledWith(['owner-1']);
  });

  it('TBI-002 DoD-1 returns 404 for cross-project ids and 403 for ungranted access', async () => {
    repo.findDiagram.mockResolvedValueOnce(null);
    await expect(service.getDiagram('project-a', 'other-project-id', 'owner-1'))
      .rejects.toBeInstanceOf(DiagramNotFoundError);

    repo.findDiagram.mockResolvedValueOnce({ ...row, ownerId: 'owner-2' });
    repo.findShare.mockResolvedValueOnce(null);
    await expect(service.getDiagram('project-a', row.id, 'owner-1'))
      .rejects.toBeInstanceOf(DiagramForbiddenError);
  });

  it('TBI-002 DoD-2 VT-05 rejects a stale version without a second write', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.updateDiagramWithVersion.mockResolvedValue(null);

    await expect(service.updateDiagram(
      'project-a',
      row.id,
      { version: 1, title: 'Changed', scene, thumbnail: row.thumbnail },
      'owner-1',
    )).rejects.toBeInstanceOf(DiagramVersionConflictError);

    expect(repo.updateDiagramWithVersion).toHaveBeenCalledTimes(1);
  });

  it('TBI-002 DoD-1 permits an edit grantee but not a view grantee to update', async () => {
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-2', 'Owner Two']]));
    repo.findShare.mockResolvedValueOnce({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-1',
      access: 'view',
      createdAt: NOW,
    });
    await expect(service.updateDiagram(
      'project-a',
      row.id,
      { version: 1, scene, thumbnail: row.thumbnail },
      'user-1',
    )).rejects.toBeInstanceOf(DiagramForbiddenError);

    repo.findShare.mockResolvedValueOnce({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-1',
      access: 'edit',
      createdAt: NOW,
    });
    repo.updateDiagramWithVersion.mockResolvedValue({ ...row, ownerId: 'owner-2', version: 2 });
    await expect(service.updateDiagram(
      'project-a',
      row.id,
      { version: 1, scene, thumbnail: row.thumbnail },
      'user-1',
    )).resolves.toEqual(expect.objectContaining({
      effectiveAccess: 'edit',
      version: 2,
      ownerName: 'Owner Two',
    }));
  });

  it('PBI-006 AC-3 / VT-12: delete by view/edit grantee is forbidden and preserves the Diagram', async () => {
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });

    await expect(service.deleteDiagram('project-a', row.id, 'view-grantee'))
      .rejects.toBeInstanceOf(DiagramForbiddenError);
    await expect(service.deleteDiagram('project-a', row.id, 'edit-grantee'))
      .rejects.toBeInstanceOf(DiagramForbiddenError);
    expect(repo.deleteDiagram).not.toHaveBeenCalled();
  });

  it('PBI-006 AC-2 / VT-11: owner delete with no grants succeeds without touching shares', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.deleteDiagram.mockResolvedValue(true);

    await expect(service.deleteDiagram('project-a', row.id, 'owner-1')).resolves.toBeUndefined();
    expect(repo.deleteDiagram).toHaveBeenCalledWith('project-a', row.id);
    expect(repo.deleteShare).not.toHaveBeenCalled();
  });
});

describe('diagramService validation and pagination', () => {
  it('TBI-002 5 MB NFR VT-06 accepts exactly 5 MB and rejects one byte over', async () => {
    repo.createDiagram.mockResolvedValue(row);
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-1', null]]));
    const exact = sceneWithSerializedBytes(DIAGRAM_MAX_SCENE_BYTES);
    await expect(service.createDiagram(
      'project-a',
      { scene: exact, thumbnail: row.thumbnail },
      'owner-1',
    )).resolves.toBeDefined();

    repo.createDiagram.mockClear();
    const oversized = sceneWithSerializedBytes(DIAGRAM_MAX_SCENE_BYTES + 1);
    await expect(service.createDiagram(
      'project-a',
      { scene: oversized, thumbnail: row.thumbnail },
      'owner-1',
    )).rejects.toBeInstanceOf(DiagramValidationError);
    expect(repo.createDiagram).not.toHaveBeenCalled();
  });

  it('resolved thumbnail contract accepts 512 KB decoded PNG and rejects one byte over', async () => {
    repo.createDiagram.mockResolvedValue(row);
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-1', null]]));
    await expect(service.createDiagram(
      'project-a',
      { scene, thumbnail: pngDataUrl(DIAGRAM_MAX_THUMBNAIL_BYTES) },
      'owner-1',
    )).resolves.toBeDefined();

    repo.createDiagram.mockClear();
    await expect(service.createDiagram(
      'project-a',
      { scene, thumbnail: pngDataUrl(DIAGRAM_MAX_THUMBNAIL_BYTES + 1) },
      'owner-1',
    )).rejects.toMatchObject({ code: 'DIAGRAM_THUMBNAIL_TOO_LARGE' });
    expect(repo.createDiagram).not.toHaveBeenCalled();
  });

  it('PBI-004 AC-3 / VT-03: returns page of 50 with nextOffset when more exist', async () => {
    repo.listOwnedDiagrams.mockResolvedValue(
      Array.from({ length: 51 }, (_, index) => ({ ...row, id: `diagram-${index}` })),
    );
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-1', 'Owner One']]));

    const result = await service.listDiagrams(
      'project-a',
      { scope: 'owned', limit: 50, offset: 0 },
      'owner-1',
    );

    expect(repo.listOwnedDiagrams).toHaveBeenCalledWith('project-a', 'owner-1', 51, 0);
    expect(result.items).toHaveLength(50);
    expect(result.nextOffset).toBe(50);
    expect(result.items.every((item) => item.ownerName === 'Owner One')).toBe(true);
    expect(result.items.every((item) => !('scene' in item))).toBe(true);
    expect(repo.getDisplayNamesByIds).toHaveBeenCalledWith(['owner-1']);
  });

  it('PBI-004 AC-2 / VT-04: other-project and ungranted Diagrams are absent from owned/shared lists', async () => {
    repo.listOwnedDiagrams.mockResolvedValue([]);
    repo.listSharedDiagrams.mockResolvedValue([]);
    repo.getDisplayNamesByIds.mockResolvedValue(new Map());

    const owned = await service.listDiagrams(
      'project-a',
      { scope: 'owned', limit: 50, offset: 0 },
      'owner-1',
    );
    const shared = await service.listDiagrams(
      'project-a',
      { scope: 'shared', limit: 50, offset: 0 },
      'owner-1',
    );

    expect(repo.listOwnedDiagrams).toHaveBeenCalledWith('project-a', 'owner-1', 51, 0);
    expect(repo.listSharedDiagrams).toHaveBeenCalledWith('project-a', 'owner-1', 51, 0);
    expect(owned.items).toEqual([]);
    expect(shared.items).toEqual([]);
    expect(owned).not.toHaveProperty('nextOffset');
    expect(shared).not.toHaveProperty('nextOffset');
  });
});

describe('diagramService grants', () => {
  it('PBI-007 AC-0 / VT-01: createShare stores one view grant for a current project member', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'view',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['user-2', 'User Two']]));

    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'user-2', access: 'view' },
      'owner-1',
    )).resolves.toMatchObject({
      granteeId: 'user-2',
      granteeName: 'User Two',
      access: 'view',
    });
    expect(repo.upsertShare).toHaveBeenCalledTimes(1);
  });

  it('TBI-006 DoD-0 / PBI-007 AC-3: owner-only management; sharee cannot re-share', async () => {
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'user-2', access: 'view' },
      'owner-1',
    )).rejects.toBeInstanceOf(DiagramForbiddenError);
    expect(repo.upsertShare).not.toHaveBeenCalled();
  });

  it('TBI-006 DoD-1 / PBI-007 AC-3 / VT-05: non-member target is rejected with no row written', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(false);
    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'outsider', access: 'view' },
      'owner-1',
    )).rejects.toBeInstanceOf(DiagramValidationError);
    expect(repo.upsertShare).not.toHaveBeenCalled();
  });

  it('PBI-007 AC-0 edge: self-share is rejected as validation', async () => {
    repo.findDiagram.mockResolvedValue(row);
    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'owner-1', access: 'view' },
      'owner-1',
    )).rejects.toMatchObject({ code: 'DIAGRAM_INVALID_SHARE_TARGET' });
    expect(repo.upsertShare).not.toHaveBeenCalled();
  });

  it('PBI-007 AC-2 / VT-04 / TBI-006 DoD-3: changeShareAccess updates unique grant without duplicate', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'edit',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['user-2', 'User Two']]));

    await service.changeShareAccess(
      'project-a',
      row.id,
      'user-2',
      { access: 'edit' },
      'owner-1',
    );

    expect(repo.upsertShare).toHaveBeenCalledWith(row.id, 'user-2', 'edit');
    expect(repo.upsertShare).toHaveBeenCalledTimes(1);
  });

  it('TBI-006 DoD-2 / VT-06: edit grant without diagram:edit resolves to view (RBAC ceiling)', async () => {
    getUserPermissions.mockResolvedValue(viewerPerms());
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    repo.findShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-1',
      access: 'edit',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-2', 'Owner Two']]));

    await expect(service.getDiagram('project-a', row.id, 'user-1')).resolves.toEqual(
      expect.objectContaining({ effectiveAccess: 'view' }),
    );
  });

  it('TBI-006 DoD-3 / VT-07: grant without diagram:view is inert; stored grant untouched', async () => {
    getUserPermissions.mockResolvedValue(new Set());
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    repo.findShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-1',
      access: 'edit',
      createdAt: NOW,
    });

    await expect(service.getDiagram('project-a', row.id, 'user-1'))
      .rejects.toBeInstanceOf(DiagramForbiddenError);
    expect(repo.deleteShare).not.toHaveBeenCalled();
    expect(repo.findShare).not.toHaveBeenCalled();
  });

  it('TBI-006 DoD-0: listShares is owner-only', async () => {
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    await expect(service.listShares('project-a', row.id, 'user-1'))
      .rejects.toBeInstanceOf(DiagramForbiddenError);
    expect(repo.listShares).not.toHaveBeenCalled();
  });

  it('annotates share targets with existingAccess (view/edit/none)', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.listShareTargets.mockResolvedValue([
      { userId: 'user-2', displayName: 'User Two', email: 'two@example.com' },
      { userId: 'user-3', displayName: 'User Three', email: 'three@example.com' },
    ]);
    repo.listShares.mockResolvedValue([
      {
        id: 'share-1',
        diagramId: row.id,
        granteeId: 'user-2',
        access: 'view',
        createdAt: NOW,
      },
    ]);

    const targets = await service.listShareTargets(
      'project-a',
      row.id,
      '',
      'owner-1',
    );

    expect(targets).toEqual([
      expect.objectContaining({ userId: 'user-2', existingAccess: 'view' }),
      expect.objectContaining({ userId: 'user-3', existingAccess: null }),
    ]);
  });

  it('resolved grant scope permits only owners sharing with current project members', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'edit',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['user-2', null]]));

    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'user-2', access: 'edit' },
      'owner-1',
    )).resolves.toMatchObject({ granteeId: 'user-2', access: 'edit' });

    repo.isCurrentProjectMember.mockResolvedValue(false);
    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'outsider', access: 'view' },
      'owner-1',
    )).rejects.toBeInstanceOf(DiagramValidationError);

    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'user-2', access: 'view' },
      'owner-1',
    )).rejects.toBeInstanceOf(DiagramForbiddenError);
  });

  it('VT-09 changes the unique grant rather than creating a duplicate', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'view',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['user-2', null]]));

    await service.updateShare(
      'project-a',
      row.id,
      'user-2',
      { access: 'view' },
      'owner-1',
    );

    expect(repo.upsertShare).toHaveBeenCalledWith(row.id, 'user-2', 'view');
  });
});

describe('diagramService shared access — FEAT-006 / PBI-008', () => {
  it('PBI-008 AC-0 / VT-01: view grant + diagram:view returns scene with effectiveAccess view', async () => {
    getUserPermissions.mockResolvedValue(viewerPerms());
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    repo.findShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-1',
      access: 'view',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-2', 'Owner Two']]));

    await expect(service.getDiagram('project-a', row.id, 'user-1')).resolves.toEqual(
      expect.objectContaining({
        scene,
        effectiveAccess: 'view',
        title: row.title,
      }),
    );
  });

  it('PBI-008 AC-2 / VT-03: edit grant without diagram:edit is view-only; save is forbidden', async () => {
    getUserPermissions.mockResolvedValue(viewerPerms());
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    repo.findShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-1',
      access: 'edit',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['owner-2', 'Owner Two']]));

    await expect(service.getDiagram('project-a', row.id, 'user-1')).resolves.toEqual(
      expect.objectContaining({ effectiveAccess: 'view' }),
    );

    await expect(service.updateDiagram(
      'project-a',
      row.id,
      { version: 1, scene, thumbnail: row.thumbnail },
      'user-1',
    )).rejects.toBeInstanceOf(DiagramForbiddenError);
    expect(repo.updateDiagramWithVersion).not.toHaveBeenCalled();
  });

  it('PBI-008 AC-3 / VT-04: missing diagram:view denies access without deleting the grant', async () => {
    getUserPermissions.mockResolvedValue(new Set());
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    repo.findShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-1',
      access: 'edit',
      createdAt: NOW,
    });

    await expect(service.getDiagram('project-a', row.id, 'user-1'))
      .rejects.toBeInstanceOf(DiagramForbiddenError);
    expect(repo.deleteShare).not.toHaveBeenCalled();
  });

  it('PBI-008 AC-1 (service): revoked grant denies detail and save without mutating Diagram', async () => {
    getUserPermissions.mockResolvedValue(memberPerms());
    repo.findDiagram.mockResolvedValue({ ...row, ownerId: 'owner-2' });
    repo.findShare.mockResolvedValue(null);

    await expect(service.getDiagram('project-a', row.id, 'user-1'))
      .rejects.toBeInstanceOf(DiagramForbiddenError);
    await expect(service.updateDiagram(
      'project-a',
      row.id,
      { version: 1, scene, thumbnail: row.thumbnail },
      'user-1',
    )).rejects.toBeInstanceOf(DiagramForbiddenError);
    expect(repo.updateDiagramWithVersion).not.toHaveBeenCalled();
  });
});

describe('diagramService share notifications — FEAT-006 / TBI-007 / PBI-009', () => {
  it('PBI-009 AC-0 / VT-05 / TBI-007 DoD-0: new grant creates one user-action notification with deep link', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.findShare.mockResolvedValue(null);
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'view',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([
      ['user-2', 'User Two'],
      ['owner-1', 'Owner One'],
    ]));

    await service.createShare(
      'project-a',
      row.id,
      { granteeId: 'user-2', access: 'view' },
      'owner-1',
    );

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({
        type: 'user-action',
        title: 'Diagram shared with you',
        link: diagramShareDeepLink(row.id),
      }),
      { dedupeKey: diagramShareDedupeKey('share-1') },
    );
    const body = (createNotification.mock.calls[0][1] as { body?: string }).body ?? '';
    expect(body).toContain(row.title);
    expect(body).not.toContain('"elements"');
    expect(body).not.toContain('data:image/png');
  });

  it('PBI-009 AC-1 / VT-06 / TBI-007 DoD-3: notification failure does not fail the share', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.findShare.mockResolvedValue(null);
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'edit',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([
      ['user-2', 'User Two'],
      ['owner-1', 'Owner One'],
    ]));
    createNotification.mockRejectedValue(new Error('Teams/dispatch unavailable'));

    await expect(service.createShare(
      'project-a',
      row.id,
      { granteeId: 'user-2', access: 'edit' },
      'owner-1',
    )).resolves.toMatchObject({ id: 'share-1', granteeId: 'user-2', access: 'edit' });
    expect(repo.upsertShare).toHaveBeenCalledTimes(1);
  });

  it('PBI-009 AC-2 / VT-07: retried createShare with existing grant emits no duplicate notification', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.findShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'view',
      createdAt: NOW,
    });
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'view',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['user-2', 'User Two']]));

    await service.createShare(
      'project-a',
      row.id,
      { granteeId: 'user-2', access: 'view' },
      'owner-1',
    );

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('PBI-009 AC-3 / VT-08 / TBI-007 DoD-2: change and revoke emit no new-share notification', async () => {
    repo.findDiagram.mockResolvedValue(row);
    repo.isCurrentProjectMember.mockResolvedValue(true);
    repo.findShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'view',
      createdAt: NOW,
    });
    repo.upsertShare.mockResolvedValue({
      id: 'share-1',
      diagramId: row.id,
      granteeId: 'user-2',
      access: 'edit',
      createdAt: NOW,
    });
    repo.getDisplayNamesByIds.mockResolvedValue(new Map([['user-2', 'User Two']]));
    repo.deleteShare.mockResolvedValue(true);

    await service.changeShareAccess(
      'project-a',
      row.id,
      'user-2',
      { access: 'edit' },
      'owner-1',
    );
    await service.revokeShare('project-a', row.id, 'user-2', 'owner-1');

    expect(createNotification).not.toHaveBeenCalled();
  });
});
