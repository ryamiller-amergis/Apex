import type { AiFeature } from '../../shared/types/aiCostAnalytics';

export interface ArtifactBedrockUsageCtx {
  feature: AiFeature;
  project: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
}

export function uniqueThreadIds(...ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

export function prototypeUsageCtx(project: string | undefined, prototypeId: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'design-prototype',
    project: project ?? 'unknown',
    entityType: 'design-prototype',
    entityId: prototypeId,
  };
}

export function designPlanUsageCtx(project: string, planId: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'design-plan',
    project,
    entityType: 'design-plan',
    entityId: planId,
  };
}

export function prdReviewUsageCtx(project: string, prdId: string, userId?: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'prd-review',
    project,
    entityType: 'prd',
    entityId: prdId,
    userId,
  };
}

export function designDocUsageCtx(project: string, designDocId: string, userId?: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'design-doc',
    project,
    entityType: 'design-doc',
    entityId: designDocId,
    userId,
  };
}

export function adrUsageCtx(project: string, adrId: string, userId?: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'adr',
    project,
    entityType: 'adr',
    entityId: adrId,
    userId,
  };
}
