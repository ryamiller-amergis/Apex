export type DesignPrototypeStatus =
  | 'generating'
  | 'generation_failed'
  | 'pending_review'
  | 'revision_requested'
  | 'regenerating'
  | 'approved';

export interface DesignPrototypeHistoryEntry {
  version: number;
  html: string;
  feedback?: string;
  createdAt: string;
}

export interface PersonaBehavior {
  /** User-type slugs (e.g. S/I/C/E/CO) this behavior applies to. */
  userTypes: string[];
  /** What the control does for this persona group. */
  behavior: string;
}

export interface PbiRequirement {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  /** User-type slugs (e.g. S/I/C/E/CO) this requirement applies to. */
  userTypes?: string[];
  /** Same control, different behavior per persona group. */
  personaBehaviors?: PersonaBehavior[];
}

export interface DesignPrototypeSummary {
  id: string;
  prdId: string;
  prdTitle?: string;
  featureName: string;
  featureIndex: number;
  authorId: string;
  authorName?: string;
  status: DesignPrototypeStatus;
  mockVersion: number;
  reviewerId?: string;
  reviewerName?: string;
  reviewComment?: string;
  reviewedAt?: string;
  generationError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignPrototype extends DesignPrototypeSummary {
  mockHtml: string | null;
  history: DesignPrototypeHistoryEntry[];
  pbiRequirements: PbiRequirement[];
}

export interface DesignPrototypeComment {
  id: string;
  prototypeId: string;
  authorId: string;
  authorName?: string;
  text: string;
  pinX?: number | null;
  pinY?: number | null;
  mockVersion: number;
  resolved: boolean;
  resolvedBy?: string | null;
  createdAt: string;
}

export interface ReviewDesignPrototypeRequest {
  action: 'approve' | 'revision_requested';
  comment?: string;
}

/** The four UI state sections rendered in every prototype document. */
export type DesignPrototypeStateName = 'default' | 'empty' | 'error' | 'loading';

export const DESIGN_PROTOTYPE_STATE_NAMES: DesignPrototypeStateName[] = [
  'default',
  'empty',
  'error',
  'loading',
];

export interface RegeneratePrototypeRequest {
  feedback: string;
  /**
   * Optional explicit override of which state sections to regenerate.
   * Omit (or send empty) for auto mode: regenerate Default + Error and reuse
   * Empty + Loading verbatim (with content-driven opt-in for empty/loading).
   */
  targetStates?: DesignPrototypeStateName[];
}

export interface AddPrototypeCommentRequest {
  text: string;
  pinX?: number;
  pinY?: number;
  mockVersion: number;
}

export function designPrototypeStatusLabel(status: DesignPrototypeStatus): string {
  switch (status) {
    case 'generating': return 'Generating';
    case 'generation_failed': return 'Generation Failed';
    case 'pending_review': return 'Pending Review';
    case 'revision_requested': return 'Revision Requested';
    case 'regenerating': return 'Regenerating';
    case 'approved': return 'Approved';
  }
}

export function designPrototypeBadgeClass(status: DesignPrototypeStatus): string {
  switch (status) {
    case 'generating': return 'generating';
    case 'generation_failed': return 'generation-failed';
    case 'pending_review': return 'pending-review';
    case 'revision_requested': return 'revision-requested';
    case 'regenerating': return 'regenerating';
    case 'approved': return 'approved';
  }
}
