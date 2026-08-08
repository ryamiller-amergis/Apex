export const DIAGRAM_DEFAULT_TITLE = 'Untitled diagram';
export const DIAGRAM_MAX_SCENE_BYTES = 5 * 1024 * 1024;
export const DIAGRAM_MAX_THUMBNAIL_BYTES = 512 * 1024;
export const DIAGRAM_SHARE_ACCESS_VALUES = ['view', 'edit'] as const;

export type DiagramShareAccess = (typeof DIAGRAM_SHARE_ACCESS_VALUES)[number];
/** Alias used by FEAT-005 share contracts (same as DiagramShareAccess). */
export type ShareAccess = DiagramShareAccess;
export type DiagramEffectiveAccess = DiagramShareAccess | 'owner';
export type DiagramListScope = 'owned' | 'shared';

export type ExcalidrawScene = {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

export interface DiagramSummary {
  id: string;
  projectId: string;
  ownerId: string;
  ownerName: string | null;
  title: string;
  thumbnail: string;
  version: number;
  effectiveAccess: DiagramEffectiveAccess;
  createdAt: string;
  updatedAt: string;
}

export interface DiagramDetail extends DiagramSummary {
  scene: ExcalidrawScene;
}

export interface DiagramShare {
  id: string;
  diagramId: string;
  granteeId: string;
  granteeName: string | null;
  access: DiagramShareAccess;
  createdAt: string;
}

export interface DiagramShareTarget {
  userId: string;
  displayName: string | null;
  email: string | null;
  /** Existing grant on this Diagram, if any (`null` = none). */
  existingAccess: DiagramShareAccess | null;
}

/** @deprecated Prefer DiagramShareTarget — kept as tech-spec alias. */
export type ShareTarget = DiagramShareTarget;

export interface CreateDiagramInput {
  title?: string;
  scene: ExcalidrawScene;
  thumbnail: string;
}

export interface UpdateDiagramInput {
  version: number;
  title?: string;
  scene: ExcalidrawScene;
  thumbnail: string;
}

export interface UpsertDiagramShareInput {
  granteeId: string;
  access: DiagramShareAccess;
}

export interface ChangeDiagramShareAccessInput {
  access: DiagramShareAccess;
}

export interface DiagramListInput {
  scope: DiagramListScope;
  limit?: number;
  offset?: number;
}

export interface DiagramListResponse {
  items: DiagramSummary[];
  nextOffset?: number;
}

export interface DiagramSharesResponse {
  shares: DiagramShare[];
}

export interface DiagramShareTargetsResponse {
  members: DiagramShareTarget[];
}

export class DiagramServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DiagramServiceError';
  }
}

export class DiagramNotFoundError extends DiagramServiceError {
  constructor(message = 'Diagram not found') {
    super(message, 'DIAGRAM_NOT_FOUND', 404);
    this.name = 'DiagramNotFoundError';
  }
}

export class DiagramForbiddenError extends DiagramServiceError {
  constructor(message = 'Forbidden') {
    super(message, 'DIAGRAM_FORBIDDEN', 403);
    this.name = 'DiagramForbiddenError';
  }
}

export class DiagramValidationError extends DiagramServiceError {
  constructor(message: string, code = 'DIAGRAM_VALIDATION_ERROR') {
    super(message, code, 422);
    this.name = 'DiagramValidationError';
  }
}

export class DiagramVersionConflictError extends DiagramServiceError {
  constructor(message = 'Diagram was updated by another editor') {
    super(message, 'DIAGRAM_VERSION_CONFLICT', 409);
    this.name = 'DiagramVersionConflictError';
  }
}

export function isDiagramShareAccess(value: unknown): value is DiagramShareAccess {
  return (
    typeof value === 'string'
    && DIAGRAM_SHARE_ACCESS_VALUES.includes(value as DiagramShareAccess)
  );
}

/** Notification type for new Diagram share grants (BR-010 / PBI-009). */
export const DIAGRAM_SHARE_NOTIFICATION_TYPE = 'user-action' as const;

/** Durable dedupe identity keyed on the created diagram_shares row (TBI-007). */
export function diagramShareDedupeKey(shareId: string): string {
  return `diagram-share:${shareId}`;
}

/** Authorized deep link into the shared Diagram editor (live access check on open). */
export function diagramShareDeepLink(diagramId: string): string {
  return `/diagrams/${diagramId}`;
}

/** True when a notification link targets a Diagram detail route (not browse). */
export function isDiagramShareNotificationLink(link: string | null | undefined): boolean {
  if (!link) return false;
  return /^\/diagrams\/[^/?#]+$/.test(link);
}
