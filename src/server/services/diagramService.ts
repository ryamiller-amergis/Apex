import {
  DIAGRAM_DEFAULT_TITLE,
  DIAGRAM_MAX_SCENE_BYTES,
  DIAGRAM_MAX_THUMBNAIL_BYTES,
  DIAGRAM_SHARE_NOTIFICATION_TYPE,
  DiagramForbiddenError,
  DiagramNotFoundError,
  DiagramValidationError,
  DiagramVersionConflictError,
  diagramShareDeepLink,
  diagramShareDedupeKey,
  isDiagramShareAccess,
  type CreateDiagramInput,
  type DiagramDetail,
  type DiagramEffectiveAccess,
  type DiagramListInput,
  type DiagramListResponse,
  type DiagramShare,
  type DiagramShareAccess,
  type DiagramShareTarget,
  type DiagramSummary,
  type ExcalidrawScene,
  type UpsertDiagramShareInput,
  type UpdateDiagramInput,
} from '../../shared/types/diagram';
import * as repository from './diagramRepository';
import type {
  DiagramRow,
  DiagramShareRow,
} from './diagramRepository';
import { createNotification } from './notificationService';
import { getUserPermissions } from './rbacService';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Derive effective access from a stored grant + live RBAC (BR-008, BR-009).
 * Returns null when the grant is inert (no diagram:view).
 */
export function resolveEffectiveShareAccess(
  grantAccess: DiagramShareAccess,
  permissions: ReadonlySet<string>,
): DiagramShareAccess | null {
  if (!permissions.has('diagram:view')) return null;
  if (grantAccess === 'edit' && permissions.has('diagram:edit')) return 'edit';
  return 'view';
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DiagramValidationError(`${field} is required`);
  }
  return value.trim();
}

function validateScene(scene: unknown): asserts scene is ExcalidrawScene {
  if (
    !scene
    || typeof scene !== 'object'
    || !Array.isArray((scene as ExcalidrawScene).elements)
    || !(scene as ExcalidrawScene).appState
    || typeof (scene as ExcalidrawScene).appState !== 'object'
    || !(scene as ExcalidrawScene).files
    || typeof (scene as ExcalidrawScene).files !== 'object'
  ) {
    throw new DiagramValidationError(
      'scene must contain elements, appState, and files',
      'DIAGRAM_INVALID_SCENE',
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(scene);
  } catch {
    throw new DiagramValidationError(
      'scene must be JSON serializable',
      'DIAGRAM_INVALID_SCENE',
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > DIAGRAM_MAX_SCENE_BYTES) {
    throw new DiagramValidationError(
      'scene exceeds the 5 MB limit',
      'DIAGRAM_SCENE_TOO_LARGE',
    );
  }
}

function validateThumbnail(thumbnail: unknown): asserts thumbnail is string {
  if (typeof thumbnail !== 'string') {
    throw new DiagramValidationError(
      'thumbnail must be a PNG data URL',
      'DIAGRAM_INVALID_THUMBNAIL',
    );
  }
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(thumbnail);
  if (!match) {
    throw new DiagramValidationError(
      'thumbnail must be a PNG data URL',
      'DIAGRAM_INVALID_THUMBNAIL',
    );
  }

  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.length < PNG_SIGNATURE.length || !decoded.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new DiagramValidationError(
      'thumbnail must contain PNG data',
      'DIAGRAM_INVALID_THUMBNAIL',
    );
  }
  if (decoded.length > DIAGRAM_MAX_THUMBNAIL_BYTES) {
    throw new DiagramValidationError(
      'thumbnail exceeds the 512 KB limit',
      'DIAGRAM_THUMBNAIL_TOO_LARGE',
    );
  }
}

function validateWrite(scene: unknown, thumbnail: unknown): asserts scene is ExcalidrawScene {
  validateScene(scene);
  validateThumbnail(thumbnail);
}

function toSummary(
  row: DiagramRow,
  effectiveAccess: DiagramEffectiveAccess,
  ownerName: string | null,
): DiagramSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    ownerId: row.ownerId,
    ownerName,
    title: row.title,
    thumbnail: row.thumbnail,
    version: row.version,
    effectiveAccess,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(
  row: DiagramRow,
  effectiveAccess: DiagramEffectiveAccess,
  ownerName: string | null,
): DiagramDetail {
  return {
    ...toSummary(row, effectiveAccess, ownerName),
    scene: row.scene,
  };
}

async function resolveOwnerNames(
  ownerIds: string[],
): Promise<Map<string, string | null>> {
  return repository.getDisplayNamesByIds([...new Set(ownerIds)]);
}

async function toDetailWithOwnerName(
  row: DiagramRow,
  effectiveAccess: DiagramEffectiveAccess,
): Promise<DiagramDetail> {
  const names = await resolveOwnerNames([row.ownerId]);
  return toDetail(row, effectiveAccess, names.get(row.ownerId) ?? null);
}

function toShare(row: DiagramShareRow, granteeName: string | null = null): DiagramShare {
  return {
    id: row.id,
    diagramId: row.diagramId,
    granteeId: row.granteeId,
    granteeName,
    access: row.access,
    createdAt: row.createdAt,
  };
}

async function loadAccessibleDiagram(
  projectId: string,
  diagramId: string,
  actorUserId: string,
): Promise<{ row: DiagramRow; effectiveAccess: DiagramEffectiveAccess }> {
  const row = await repository.findDiagram(projectId, diagramId);
  if (!row) throw new DiagramNotFoundError();

  const permissions = await getUserPermissions(actorUserId, projectId);
  if (!permissions.has('diagram:view')) {
    // Stored ownership/grants remain; access is inert without diagram:view (BR-009).
    throw new DiagramForbiddenError();
  }

  if (row.ownerId === actorUserId) return { row, effectiveAccess: 'owner' };

  const share = await repository.findShare(row.id, actorUserId);
  if (!share) throw new DiagramForbiddenError();

  const effective = resolveEffectiveShareAccess(share.access, permissions);
  if (!effective) throw new DiagramForbiddenError();
  return { row, effectiveAccess: effective };
}

async function loadOwnedDiagram(
  projectId: string,
  diagramId: string,
  actorUserId: string,
): Promise<DiagramRow> {
  const row = await repository.findDiagram(projectId, diagramId);
  if (!row) throw new DiagramNotFoundError();
  if (row.ownerId !== actorUserId) throw new DiagramForbiddenError();
  return row;
}

function normalizePagination(input: DiagramListInput): {
  scope: DiagramListInput['scope'];
  limit: number;
  offset: number;
} {
  if (input.scope !== 'owned' && input.scope !== 'shared') {
    throw new DiagramValidationError(
      'scope must be owned or shared',
      'DIAGRAM_INVALID_SCOPE',
    );
  }
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new DiagramValidationError(
      'limit must be an integer from 1 to 50',
      'DIAGRAM_INVALID_PAGINATION',
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DiagramValidationError(
      'offset must be a non-negative integer',
      'DIAGRAM_INVALID_PAGINATION',
    );
  }
  return { scope: input.scope, limit, offset };
}

export async function createDiagram(
  projectId: string,
  input: CreateDiagramInput,
  actorUserId: string,
): Promise<DiagramDetail> {
  requireNonEmpty(projectId, 'projectId');
  requireNonEmpty(actorUserId, 'actorUserId');
  validateWrite(input?.scene, input?.thumbnail);
  const title = input.title === undefined
    ? DIAGRAM_DEFAULT_TITLE
    : requireNonEmpty(input.title, 'title');
  const created = await repository.createDiagram(projectId, actorUserId, {
    title,
    scene: input.scene,
    thumbnail: input.thumbnail,
  });
  return toDetailWithOwnerName(created, 'owner');
}

export async function listDiagrams(
  projectId: string,
  input: DiagramListInput,
  actorUserId: string,
): Promise<DiagramListResponse> {
  requireNonEmpty(projectId, 'projectId');
  requireNonEmpty(actorUserId, 'actorUserId');
  const { scope, limit, offset } = normalizePagination(input);
  const probeLimit = limit + 1;

  if (scope === 'owned') {
    const rows = await repository.listOwnedDiagrams(
      projectId,
      actorUserId,
      probeLimit,
      offset,
    );
    const page = rows.slice(0, limit);
    const names = await resolveOwnerNames(page.map((row) => row.ownerId));
    const hasMore = rows.length > limit;
    return {
      items: page.map((row) => toSummary(row, 'owner', names.get(row.ownerId) ?? null)),
      ...(hasMore ? { nextOffset: offset + limit } : {}),
    };
  }

  const rows = await repository.listSharedDiagrams(
    projectId,
    actorUserId,
    probeLimit,
    offset,
  );
  const permissions = await getUserPermissions(actorUserId, projectId);
  const withAccess = rows
    .map(({ diagram, access }) => {
      const effective = resolveEffectiveShareAccess(access, permissions);
      return effective ? { diagram, access: effective } : null;
    })
    .filter((entry): entry is { diagram: DiagramRow; access: DiagramShareAccess } => entry != null);

  // Re-probe after RBAC filtering is best-effort; pagination remains repository-driven.
  const page = withAccess.slice(0, limit);
  const names = await resolveOwnerNames(page.map(({ diagram }) => diagram.ownerId));
  const hasMore = rows.length > limit;
  return {
    items: page.map(({ diagram, access }) => (
      toSummary(diagram, access, names.get(diagram.ownerId) ?? null)
    )),
    ...(hasMore ? { nextOffset: offset + limit } : {}),
  };
}

export async function getDiagram(
  projectId: string,
  diagramId: string,
  actorUserId: string,
): Promise<DiagramDetail> {
  const { row, effectiveAccess } = await loadAccessibleDiagram(
    projectId,
    diagramId,
    actorUserId,
  );
  return toDetailWithOwnerName(row, effectiveAccess);
}

export async function updateDiagram(
  projectId: string,
  diagramId: string,
  input: UpdateDiagramInput,
  actorUserId: string,
): Promise<DiagramDetail> {
  if (!Number.isInteger(input?.version) || input.version < 1) {
    throw new DiagramValidationError(
      'version must be a positive integer',
      'DIAGRAM_INVALID_VERSION',
    );
  }
  validateWrite(input.scene, input.thumbnail);

  const { row, effectiveAccess } = await loadAccessibleDiagram(
    projectId,
    diagramId,
    actorUserId,
  );
  if (effectiveAccess === 'view') throw new DiagramForbiddenError();
  const title = input.title === undefined ? row.title : requireNonEmpty(input.title, 'title');

  const updated = await repository.updateDiagramWithVersion(
    projectId,
    diagramId,
    input.version,
    { title, scene: input.scene, thumbnail: input.thumbnail },
  );
  if (!updated) throw new DiagramVersionConflictError();
  return toDetailWithOwnerName(updated, effectiveAccess);
}

export async function deleteDiagram(
  projectId: string,
  diagramId: string,
  actorUserId: string,
): Promise<void> {
  await loadOwnedDiagram(projectId, diagramId, actorUserId);
  const deleted = await repository.deleteDiagram(projectId, diagramId);
  if (!deleted) throw new DiagramNotFoundError();
}

export async function listShares(
  projectId: string,
  diagramId: string,
  actorUserId: string,
): Promise<DiagramShare[]> {
  const row = await loadOwnedDiagram(projectId, diagramId, actorUserId);
  const shares = await repository.listShares(row.id);
  const names = await resolveOwnerNames(shares.map((share) => share.granteeId));
  return shares.map((share) => toShare(share, names.get(share.granteeId) ?? null));
}

async function upsertOwnedShare(
  projectId: string,
  diagramId: string,
  granteeId: string,
  access: unknown,
  actorUserId: string,
): Promise<{ share: DiagramShare; created: boolean; diagram: DiagramRow }> {
  const row = await loadOwnedDiagram(projectId, diagramId, actorUserId);
  const normalizedGranteeId = requireNonEmpty(granteeId, 'granteeId');
  if (normalizedGranteeId === actorUserId) {
    throw new DiagramValidationError(
      'owners cannot create a share for themselves',
      'DIAGRAM_INVALID_SHARE_TARGET',
    );
  }
  if (!isDiagramShareAccess(access)) {
    throw new DiagramValidationError(
      'access must be view or edit',
      'DIAGRAM_INVALID_SHARE_ACCESS',
    );
  }
  if (!await repository.isCurrentProjectMember(projectId, normalizedGranteeId)) {
    throw new DiagramValidationError(
      'grantee must be a current member of the Diagram project',
      'DIAGRAM_SHARE_TARGET_NOT_MEMBER',
    );
  }
  const existing = await repository.findShare(row.id, normalizedGranteeId);
  const saved = await repository.upsertShare(row.id, normalizedGranteeId, access);
  const names = await resolveOwnerNames([saved.granteeId]);
  return {
    share: toShare(saved, names.get(saved.granteeId) ?? null),
    created: !existing,
    diagram: row,
  };
}

/**
 * Notify the grantee of a genuine new share after the grant is committed.
 * Failures are isolated so they never roll back or fail the share result (PBI-009 (b)).
 */
async function notifyNewShare(
  diagram: DiagramRow,
  share: DiagramShare,
): Promise<void> {
  try {
    const names = await resolveOwnerNames([diagram.ownerId]);
    const ownerName = names.get(diagram.ownerId) ?? 'A teammate';
    const accessLabel = share.access === 'edit' ? 'edit' : 'view';
    await createNotification(
      share.granteeId,
      {
        type: DIAGRAM_SHARE_NOTIFICATION_TYPE,
        title: 'Diagram shared with you',
        body: `${ownerName} shared "${diagram.title}" with ${accessLabel} access`,
        link: diagramShareDeepLink(diagram.id),
      },
      { dedupeKey: diagramShareDedupeKey(share.id) },
    );
  } catch (err) {
    console.error('[diagramService] new-share notification failed (share preserved):', err);
  }
}

export async function createShare(
  projectId: string,
  diagramId: string,
  input: UpsertDiagramShareInput,
  actorUserId: string,
): Promise<DiagramShare> {
  const { share, created, diagram } = await upsertOwnedShare(
    projectId,
    diagramId,
    input?.granteeId,
    input?.access,
    actorUserId,
  );
  // Emit only for genuine new inserts — not retries that update an existing grant (BR-010).
  if (created) {
    await notifyNewShare(diagram, share);
  }
  return share;
}

/** Tech-spec alias for updateShare (change view↔edit on the unique grant). */
export async function changeShareAccess(
  projectId: string,
  diagramId: string,
  granteeId: string,
  input: Pick<UpsertDiagramShareInput, 'access'>,
  actorUserId: string,
): Promise<DiagramShare> {
  return updateShare(projectId, diagramId, granteeId, input, actorUserId);
}

export async function updateShare(
  projectId: string,
  diagramId: string,
  granteeId: string,
  input: Pick<UpsertDiagramShareInput, 'access'>,
  actorUserId: string,
): Promise<DiagramShare> {
  // Access changes must not emit a new-share notification (PBI-009 (d) / TBI-007 DoD-2).
  const { share } = await upsertOwnedShare(
    projectId,
    diagramId,
    granteeId,
    input?.access,
    actorUserId,
  );
  return share;
}

export async function revokeShare(
  projectId: string,
  diagramId: string,
  granteeId: string,
  actorUserId: string,
): Promise<void> {
  const row = await loadOwnedDiagram(projectId, diagramId, actorUserId);
  const removed = await repository.deleteShare(
    row.id,
    requireNonEmpty(granteeId, 'granteeId'),
  );
  if (!removed) throw new DiagramNotFoundError('Diagram share not found');
}

export async function listShareTargets(
  projectId: string,
  diagramId: string,
  query: string,
  actorUserId: string,
): Promise<DiagramShareTarget[]> {
  const row = await loadOwnedDiagram(projectId, diagramId, actorUserId);
  const members = await repository.listShareTargets(projectId, query ?? '', actorUserId);
  const shares = await repository.listShares(row.id);
  const byGrantee = new Map(shares.map((share) => [share.granteeId, share.access]));
  return members.map((member) => ({
    userId: member.userId,
    displayName: member.displayName,
    email: member.email,
    existingAccess: byGrantee.get(member.userId) ?? null,
  }));
}
