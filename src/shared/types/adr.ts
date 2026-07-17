export type AdrStatus =
  | 'in_progress'
  | 'generating'
  | 'proposed'
  | 'accepted'
  | 'superseded';

export interface AdrReviewer {
  id: string;
  displayName: string;
}

export interface AdrReviewerCandidate extends AdrReviewer {
  email?: string | null;
}

export interface Adr {
  id: string;
  chatThreadId: string;
  adrAssistantThreadId?: string | null;
  authorId: string;
  ownerName: string;
  reviewerIds: string[];
  reviewers: AdrReviewer[];
  title: string;
  project: string;
  repo: string;
  model?: string;
  skillSettingsId?: string | null;
  skillSettingsName?: string | null;
  status: AdrStatus;
  content: string;
  proposedContent?: string | null;
  fixCommentId?: string | null;
  slug?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AdrSummary = Omit<Adr, 'content'>;

export interface CreateAdrRequest {
  project: string;
  repo: string;
  title: string;
  chatThreadId: string;
  model?: string;
  skillSettingsId?: string;
  reviewerIds?: string[];
}

export interface CreateAdrResponse {
  adrId: string;
  threadId: string;
}

export interface GenerateAdrResponse {
  adrId: string;
  threadId: string;
}

export interface UpdateAdrRequest {
  title?: string;
  status?: Extract<AdrStatus, 'in_progress' | 'accepted' | 'superseded'>;
}
