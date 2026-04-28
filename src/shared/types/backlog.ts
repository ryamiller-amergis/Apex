export type BacklogStatus = 'Draft' | 'Approved' | 'Rejected' | string;

/* ── UI Mock types ─────────────────────────────────────────── */

export type UiMockDecision = 'new-page' | 'update-page' | 'no-ui';

export interface UiMockHistoryEntry {
  version: number;
  decision: UiMockDecision;
  rationale: string;
  targetPageRoute?: string;
  targetPageTitle?: string;
  mockHtml?: string;
  feedback?: string;
  createdAt: string;
}

export interface UiMock {
  decision: UiMockDecision;
  rationale: string;
  targetPageRoute?: string;
  targetPageTitle?: string;
  mockHtml?: string;
  mockVersion: number;
  status: 'draft' | 'approved';
  history: UiMockHistoryEntry[];
  /** Sub-tab labels defined for this page, e.g. ["Recurring Requests", "Calendar View"].
   *  Persisted so PBI-view generation can read the established tab structure. */
  targetPageSubTabs?: string[];
  /** Which version number was explicitly approved. When set, mockHtml holds that version's HTML. */
  approvedVersion?: number;
  /** Set to true on approval so the Cursor agent can auto-push to Figma */
  pendingFigmaExport?: boolean;
  /** Figma page URL created by generate_figma_design after export */
  figmaUrl?: string;
  /** ISO timestamp of when the Figma design was created */
  figmaCreatedAt?: string;
  /** Set to true by the UX designer once the Figma design is polished and ready for dev */
  designReady?: boolean;
  /** ISO timestamp of when the design was marked ready */
  designReadyAt?: string;
  /** Per-PBI view mocks — each PBI that requires a distinct screen gets its own entry */
  views?: UiMockView[];
}

/** A UI mock scoped to a single PBI — independently generated, versioned, and approved. */
export interface UiMockView {
  pbiId: string;
  pbiTitle: string;
  decision: UiMockDecision;
  rationale: string;
  targetPageRoute?: string;
  targetPageTitle?: string;
  mockHtml?: string;
  mockVersion: number;
  status: 'draft' | 'approved';
  history: UiMockHistoryEntry[];
  /** Which version number was explicitly approved. When set, mockHtml holds that version's HTML. */
  approvedVersion?: number;
  pendingFigmaExport?: boolean;
  figmaUrl?: string;
  figmaCreatedAt?: string;
  designReady?: boolean;
  designReadyAt?: string;
}

export interface BacklogEpic {
  id: string;
  workItemType: 'Epic';
  status: BacklogStatus;
  title: string;
  description?: string;
  priority?: string;
  tags?: string[];
  confidence?: string;
  sourceEvidence?: string;
  clarificationNeeded?: string;
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

export interface FeatureFlag {
  enabled: boolean;
  name?: string;
}

export interface BacklogFeature {
  id: string;
  parentId: string;
  workItemType: 'Feature';
  status: BacklogStatus;
  title: string;
  description?: string;
  priority?: string;
  tags?: string[];
  confidence?: string;
  sourceEvidence?: string;
  clarificationNeeded?: string;
  featureFlag?: FeatureFlag;
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
  uiMock?: UiMock;
}

export interface BacklogPBI {
  id: string;
  parentId: string;
  workItemType: 'PBI';
  status: BacklogStatus;
  title: string;
  description?: string;
  priority?: string;
  tags?: string[];
  confidence?: string;
  sourceEvidence?: string;
  clarificationNeeded?: string;
  acceptanceCriteria?: string[];
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
}

export type BacklogNode = BacklogEpic | BacklogFeature | BacklogPBI;

export interface BacklogDocumentPayload {
  epics: BacklogEpic[];
  features: BacklogFeature[];
  pbis: BacklogPBI[];
}

export interface BacklogDocument {
  id: number;
  title: string;
  path: string;
  url?: string;
  document: BacklogDocumentPayload;
}
