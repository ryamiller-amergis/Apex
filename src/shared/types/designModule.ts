export const DESIGN_MODULE_ICON_KEYS = [
  'chat',
  'interview',
  'pdf',
  'analysis',
  'infra',
  'cicd',
  'rbac',
  'default',
] as const;

export type DesignModuleIconKey = (typeof DESIGN_MODULE_ICON_KEYS)[number];

export interface DesignModuleSummary {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  iconKey: DesignModuleIconKey;
  sourceGlobs: string[];
  sortOrder: number;
  hasContent: boolean;
  isStale: boolean;
  sourceAvailable: boolean;
  lastGeneratedAt: string | null;
  generatedByModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DesignModule extends DesignModuleSummary {
  content: string | null;
  sourceFingerprint: string | null;
  sourceCommit: string | null;
  scopingThreadId: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface CreateDesignModuleInput {
  slug: string;
  label: string;
  description?: string | null;
  iconKey: DesignModuleIconKey;
  sourceGlobs: string[];
  sortOrder?: number;
  /** Persist an AI scoping thread started before the module was saved. */
  scopingThreadId?: string | null;
  /**
   * When set on create, the server auto-starts architecture doc generation
   * for this project. Not persisted on the module row.
   */
  project?: string;
}

export type UpdateDesignModuleInput = Partial<
  Omit<CreateDesignModuleInput, 'project'>
>;

export interface RegenerateDesignModuleInput {
  project: string;
  force?: boolean;
}

export interface RegenerateDesignModuleResult {
  started: boolean;
  reason?: 'not-stale';
  threadId?: string;
  error?: string;
}

export interface CreateDesignModuleResult extends DesignModule {
  generation?: RegenerateDesignModuleResult;
}
