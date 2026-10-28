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

export type ProjectQuickLinkErrorCode = 'VALIDATION' | 'NOT_FOUND';

export class ProjectQuickLinkError extends Error {
  readonly code: ProjectQuickLinkErrorCode;

  constructor(message: string, code: ProjectQuickLinkErrorCode = 'VALIDATION') {
    super(message);
    this.name = 'ProjectQuickLinkError';
    this.code = code;
  }
}
