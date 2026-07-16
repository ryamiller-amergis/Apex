export type AdrStatus =
  | 'in_progress'
  | 'generating'
  | 'proposed'
  | 'accepted'
  | 'superseded';

export interface Adr {
  id: string;
  chatThreadId: string;
  authorId: string;
  title: string;
  project: string;
  repo: string;
  model?: string;
  skillSettingsId?: string | null;
  skillSettingsName?: string | null;
  status: AdrStatus;
  content: string;
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
