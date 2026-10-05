export type UiLabStatus =
  | 'generating'
  | 'streaming'
  | 'ready'
  | 'generation_failed';

/** Effective access derived from UI/UX workspace membership or a live named share. */
export type UiLabEffectiveAccess = 'manage' | 'workspace' | 'shared';

export interface UiLabHistoryEntry {
  version: number;
  html: string;
  prompt?: string;
  feedback?: string;
  selectedSelector?: string;
  createdAt: string;
}

export interface UiLabCapabilities {
  canManage: boolean;
  canShare: boolean;
  canComment: boolean;
  canResolveComments: boolean;
  canEditBoundary: boolean;
  canRegenerate: boolean;
  canDelete: boolean;
  canViewSource: boolean;
}

export interface UiLabDesign {
  id: string;
  project: string;
  authorId: string;
  title: string;
  prompt: string;
  targetRoute?: string | null;
  model?: string | null;
  status: UiLabStatus;
  html?: string | null;
  version: number;
  history: UiLabHistoryEntry[];
  generationError?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on detail responses that go through access resolution. */
  effectiveAccess?: UiLabEffectiveAccess;
  capabilities?: UiLabCapabilities;
}

export interface UiLabDesignSummary {
  id: string;
  project: string;
  authorId: string;
  title: string;
  prompt: string;
  targetRoute?: string | null;
  status: UiLabStatus;
  version: number;
  generationError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UiLabComment {
  id: string;
  designId: string;
  authorId: string;
  text: string;
  pinX?: number | null;
  pinY?: number | null;
  version: number;
  resolved: boolean;
  resolvedBy?: string | null;
  createdAt: string;
}

export interface UiLabShare {
  id: string;
  designId: string;
  granteeId: string;
  granteeName: string | null;
  createdBy: string;
  createdAt: string;
  /** Absolute-path deep link the client can copy or open. */
  link: string;
}

export interface UiLabShareTarget {
  userId: string;
  displayName: string | null;
  email: string | null;
  /** True when this member already has a live grant for the design. */
  alreadyShared: boolean;
}

export interface CreateUiLabDesignRequest {
  title: string;
  prompt: string;
  targetRoute?: string | null;
}

export interface RegenerateUiLabDesignRequest {
  feedback: string;
  /** CSS selector of the element to scope edits to — omit for whole-design regen */
  selectedSelector?: string | null;
  /** outerHTML of the selected element for context */
  selectedHtml?: string | null;
}

export interface AddUiLabCommentRequest {
  text: string;
  pinX?: number | null;
  pinY?: number | null;
  version: number;
}

export interface CreateUiLabShareRequest {
  granteeId: string;
}

export interface UiLabStreamChunk {
  type: 'token' | 'complete' | 'error';
  text?: string;
  error?: string;
}

export const UI_LAB_SHARE_NOTIFICATION_TYPE = 'user-action' as const;

export function uiLabShareDedupeKey(shareId: string): string {
  return `ui-lab-share:${shareId}`;
}

/** Authorized deep link into a shared UI Lab design (live access check on open). */
export function uiLabShareDeepLink(designId: string, project: string): string {
  const params = new URLSearchParams({ project });
  return `/ui-lab/${encodeURIComponent(designId)}?${params.toString()}`;
}

export function isUiLabShareNotificationLink(link: string | null | undefined): boolean {
  if (!link) return false;
  return /^\/ui-lab\/[^/?#]+(?:\?.*)?$/.test(link);
}

export function capabilitiesForAccess(access: UiLabEffectiveAccess): UiLabCapabilities {
  const canManage = access === 'manage';
  return {
    canManage,
    canShare: canManage,
    canComment: true,
    canResolveComments: canManage,
    canEditBoundary: canManage,
    canRegenerate: canManage,
    canDelete: canManage,
    canViewSource: true,
  };
}

export type UiLabRouteAccess = 'allow' | 'deny' | 'wait';

/**
 * Client route decision for `/ui-lab` and `/ui-lab/:id`.
 *
 * `wait` means a required input is still unresolved (target project not
 * selected yet, or the shared-with-me list has not returned). The caller
 * must not redirect to a fallback in that state.
 */
export function resolveUiLabRouteAccess(input: {
  isSuperAdmin: boolean;
  menuEnabled: boolean;
  canView: boolean;
  inUiUxGroup: boolean;
  isDesignDeepLink: boolean;
  hasShares: boolean;
  sharesPending: boolean;
  projectSwitchPending: boolean;
}): UiLabRouteAccess {
  if (input.isSuperAdmin) return 'allow';
  if (input.projectSwitchPending) return 'wait';
  if (!input.menuEnabled || !input.canView) return 'deny';
  if (input.inUiUxGroup || input.isDesignDeepLink) return 'allow';
  if (input.sharesPending) return 'wait';
  return input.hasShares ? 'allow' : 'deny';
}
