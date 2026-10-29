export const QUICK_LINK_LABEL_MAX_LENGTH = 80;
export const QUICK_LINK_CATEGORY_MAX_LENGTH = 60;
export const QUICK_LINK_URL_MAX_LENGTH = 2048;

export interface ProjectQuickLink {
  id: string;
  project: string;
  label: string;
  url: string;
  category: string | null;
  sortOrder: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectQuickLinkInput {
  label: string;
  url: string;
  category?: string | null;
  sortOrder?: number;
}

export type UpdateProjectQuickLinkInput = Partial<CreateProjectQuickLinkInput>;

export interface ReorderProjectQuickLinksInput {
  /** Link ids in display order; each link's sortOrder becomes its index. */
  ids: string[];
}

export interface ProjectQuickLinksListResponse {
  items: ProjectQuickLink[];
}

/** Personal links each user may keep per project. */
export const USER_QUICK_LINKS_MAX_PER_PROJECT = 1000;
/** Shared links a project may have, however they are added (single add, move, or import). */
export const PROJECT_QUICK_LINKS_MAX_PER_PROJECT = 200;
/**
 * Most items one import request may carry. Equal to the personal cap, so a user can fill their
 * links in one import. At ~2.2 KB per worst-case item this stays well under the server's 10 MB
 * JSON body limit.
 */
export const QUICK_LINKS_IMPORT_MAX_ITEMS = USER_QUICK_LINKS_MAX_PER_PROJECT;
export const BOOKMARK_IMPORT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export const USER_QUICK_LINKS_LIMIT_MESSAGE =
  `You can keep up to ${USER_QUICK_LINKS_MAX_PER_PROJECT.toLocaleString('en-US')} personal links per project`;
export const PROJECT_QUICK_LINKS_LIMIT_MESSAGE =
  `A project can have up to ${PROJECT_QUICK_LINKS_MAX_PER_PROJECT.toLocaleString('en-US')} shared links`;

/** Where a link is saved: private to its creator, or shared with everyone in the project. */
export type QuickLinkScope = 'personal' | 'project';

/** A personal link. Visible only to its owner, and only while its project is selected. */
export interface UserQuickLink {
  id: string;
  project: string;
  label: string;
  url: string;
  category: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateUserQuickLinkInput = Omit<CreateProjectQuickLinkInput, 'sortOrder'>;
export type UpdateUserQuickLinkInput = Partial<CreateUserQuickLinkInput>;

export interface UserQuickLinksListResponse {
  items: UserQuickLink[];
}

export interface ImportQuickLinksInput {
  items: CreateUserQuickLinkInput[];
}

export interface RejectedQuickLinkImport {
  /** Position of the item in the request. */
  index: number;
  label: string;
  url: string;
  reason: string;
}

export interface ImportQuickLinksResult {
  created: number;
  skippedDuplicates: number;
  rejected: RejectedQuickLinkImport[];
}

export type ProjectQuickLinkErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'DUPLICATE' | 'LIMIT_REACHED';

export class ProjectQuickLinkError extends Error {
  readonly code: ProjectQuickLinkErrorCode;

  constructor(message: string, code: ProjectQuickLinkErrorCode = 'VALIDATION') {
    super(message);
    this.name = 'ProjectQuickLinkError';
    this.code = code;
  }
}
