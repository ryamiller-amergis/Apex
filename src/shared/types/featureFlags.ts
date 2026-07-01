export type FlagLifecycle = 'active' | 'stale' | 'archived';

export type FlagRuleType = 'everyone' | 'project' | 'user' | 'group';

export type FlagAuditAction =
  | 'created'
  | 'updated'
  | 'enabled'
  | 'disabled'
  | 'rule_added'
  | 'rule_removed'
  | 'lifecycle_changed'
  | 'deleted';

export interface FeatureFlag {
  id: string;
  key: string;
  description: string | null;
  enabled: boolean;
  lifecycle: FlagLifecycle;
  cleanupReady: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureFlagRule {
  id: string;
  flagId: string;
  type: FlagRuleType;
  value: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface FeatureFlagWithRules extends FeatureFlag {
  rules: FeatureFlagRule[];
}

export interface FlagAuditEntry {
  id: string;
  flagId: string | null;
  flagKey: string;
  action: FlagAuditAction;
  actorId: string | null;
  actorEmail: string | null;
  details: FlagAuditDetails | null;
  createdAt: string;
}

export interface FlagAuditDetails {
  previousValue?: unknown;
  newValue?: unknown;
  ruleType?: FlagRuleType;
  ruleValue?: string | null;
  [key: string]: unknown;
}

export interface EvaluateFlagsResponse {
  flags: Record<string, boolean>;
}

export interface CreateFlagRequest {
  key: string;
  description?: string;
}

export interface UpdateFlagRequest {
  description?: string;
  enabled?: boolean;
  lifecycle?: FlagLifecycle;
  cleanupReady?: boolean;
}

export interface AddRuleRequest {
  type: FlagRuleType;
  value?: string | null;
}
