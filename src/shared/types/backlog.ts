export type BacklogStatus = 'Draft' | 'Approved' | 'Rejected' | string;

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
