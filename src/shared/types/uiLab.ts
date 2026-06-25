export type UiLabStatus =
  | 'generating'
  | 'streaming'
  | 'ready'
  | 'generation_failed';

export interface UiLabHistoryEntry {
  version: number;
  html: string;
  prompt?: string;
  feedback?: string;
  selectedSelector?: string;
  createdAt: string;
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

export interface UiLabStreamChunk {
  type: 'token' | 'complete' | 'error';
  text?: string;
  error?: string;
}
