/**
 * Typed Interview artifact link contracts (FEAT-001).
 * Consumed by the Interview Link Service, typed API, and FEAT-002 picker.
 */

/** Workspace-relative path for the live linked-context grounding document (FEAT-003). */
export const LINKED_CONTEXT_DOCUMENT_RELATIVE_PATH = '.ai-pilot/linked-context.md' as const;

export const LINKED_CONTEXT_CAPACITY = 10 as const;

export const LINK_CANDIDATE_DEFAULT_PAGE_SIZE = 50 as const;

export type AdrStaleReason = 'no_longer_accepted';

export type LinkCandidateType = 'adr' | 'design-module';

export interface LinkedAdr {
  adrId: string;
  title: string;
  isAccepted: boolean;
  staleReason?: AdrStaleReason;
  linkedBy: string;
  linkedAt: string;
}

export interface LinkedDesignModule {
  designModuleId: string;
  name: string;
  linkedBy: string;
  linkedAt: string;
}

export interface LinkedContextReadModel {
  interviewId: string;
  adrLinks: LinkedAdr[];
  designModuleLinks: LinkedDesignModule[];
  count: number;
  capacity: typeof LINKED_CONTEXT_CAPACITY;
}

export interface AdrLinkCandidate {
  type: 'adr';
  id: string;
  title: string;
  /** Candidates are limited to accepted ADRs. */
  status: 'accepted';
}

export interface DesignModuleLinkCandidate {
  type: 'design-module';
  id: string;
  name: string;
}

export type LinkCandidate = AdrLinkCandidate | DesignModuleLinkCandidate;

export interface PaginatedCandidates<T = LinkCandidate> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface AddAdrLinkRequest {
  adrId: string;
}

export interface AddDesignModuleLinkRequest {
  designModuleId: string;
}

export interface LinkMutationResult {
  linkedContext: LinkedContextReadModel;
}

export type InterviewLinkErrorCode =
  | 'LINK_CAP_EXCEEDED'
  | 'LINK_DUPLICATE'
  | 'ADR_NOT_ACCEPTED'
  | 'ARTIFACT_CROSS_PROJECT'
  | 'INTERVIEW_NOT_IN_PROGRESS'
  | 'ARTIFACT_NOT_FOUND'
  | 'INTERVIEW_NOT_FOUND'
  | 'PROJECT_FORBIDDEN';

export class InterviewLinkError extends Error {
  readonly code: InterviewLinkErrorCode;

  constructor(code: InterviewLinkErrorCode, message: string) {
    super(message);
    this.name = 'InterviewLinkError';
    this.code = code;
  }
}
