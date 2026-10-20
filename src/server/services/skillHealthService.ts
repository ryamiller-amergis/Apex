/**
 * Skill Health Service — loads the rows Skill Health aggregates and hands them to
 * `skillHealthMetrics`. Read-only.
 */

import { and, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  aiUsageEvents,
  designDocs,
  prds,
  projectSkillSettings,
  reviewComments,
  workflowEvaluationEvents,
  workflowEvaluationJobs,
} from '../db/schema';
import type { SkillHealthArtifactKind, SkillHealthOverview } from '../../shared/types/skillHealth';
import { WORKFLOW_HUMAN_EVALUATION_FLAG } from '../../shared/types/featureFlags';
import { isFeatureEnabled, isFeatureOperational } from './featureFlagService';
import { buildSkillHealthProjects, type SkillHealthInputs } from './skillHealthMetrics';

const DAY_MS = 24 * 60 * 60 * 1000;

const USAGE_ENTITY_TO_KIND: Record<string, SkillHealthArtifactKind> = {
  prd: 'prd',
  'design-doc': 'design_doc',
};

export const SKILL_HEALTH_CAVEATS: readonly string[] = [
  'Only PRDs and design docs are scored today; other Skills appear once they have a judge.',
  'Each document is tied to the Skill path its project settings point at now. Its version is the SKILL.md content that generated it; documents saved before versions were recorded show as unversioned.',
  'Acceptance rate uses each document’s current status, so a document approved after a revision counts as approved.',
  'Cost covers AI usage events linked to the document, including validation and assistant runs.',
  'Human feedback appears only for projects with Workflow evaluations turned on. Promptfoo and judge results are diagnostic; human scores are authoritative.',
];

async function loadEvaluationJobs(eventIds: string[]) {
  if (eventIds.length === 0) return [];
  return db
    .select({
      eventId: workflowEvaluationJobs.eventId,
      evaluatorKey: workflowEvaluationJobs.evaluatorKey,
      status: workflowEvaluationJobs.status,
      summary: workflowEvaluationJobs.summary,
    })
    .from(workflowEvaluationJobs)
    .where(inArray(workflowEvaluationJobs.eventId, eventIds));
}

async function evaluationEnabledProjects(userId: string, projects: Iterable<string>): Promise<string[]> {
  if (!(await isFeatureOperational(WORKFLOW_HUMAN_EVALUATION_FLAG))) return [];
  const unique = [...new Set(projects)];
  const enabled = await Promise.all(
    unique.map((project) => isFeatureEnabled(WORKFLOW_HUMAN_EVALUATION_FLAG, { userId, project })),
  );
  return unique.filter((_, i) => enabled[i]);
}

async function loadInputs(periodFrom: string, userId: string): Promise<SkillHealthInputs> {
  const [prdRows, designDocRows, settingsRows, commentRows, costRows, eventRows] = await Promise.all([
    db
      .select({
        id: prds.id,
        project: prds.project,
        createdAt: prds.createdAt,
        status: prds.status,
        validationScore: prds.validationScore,
        scorecard: prds.validationScorecard,
        skillSettingsId: prds.skillSettingsId,
        skillSha256: prds.skillSha256,
        override: prds.readinessOverride,
      })
      .from(prds)
      .where(gte(prds.createdAt, periodFrom)),
    db
      .select({
        id: designDocs.id,
        project: designDocs.project,
        createdAt: designDocs.createdAt,
        status: designDocs.status,
        validationScore: designDocs.validationScore,
        scorecard: designDocs.validationScorecard,
        skillSettingsId: designDocs.skillSettingsId,
        skillSha256: designDocs.skillSha256,
        override: designDocs.validationOverride,
      })
      .from(designDocs)
      .where(gte(designDocs.createdAt, periodFrom)),
    db
      .select({
        id: projectSkillSettings.id,
        project: projectSkillSettings.project,
        skillRepo: projectSkillSettings.skillRepo,
        isDefault: projectSkillSettings.isDefault,
        prdSkillPath: projectSkillSettings.prdSkillPath,
        designDocSkillPath: projectSkillSettings.designDocSkillPath,
        prdThreshold: projectSkillSettings.prdValidationScoreThreshold,
        designDocThreshold: projectSkillSettings.designDocValidationScoreThreshold,
      })
      .from(projectSkillSettings),
    db
      .select({
        documentId: reviewComments.documentId,
        documentType: reviewComments.documentType,
        sectionKey: reviewComments.sectionKey,
      })
      .from(reviewComments)
      .where(
        and(
          gte(reviewComments.createdAt, periodFrom),
          inArray(reviewComments.documentType, ['prd', 'design_doc']),
        ),
      ),
    db
      .select({
        entityType: aiUsageEvents.entityType,
        entityId: aiUsageEvents.entityId,
        costUsd: sql<string>`COALESCE(SUM(${aiUsageEvents.costUsd}::numeric), 0)`,
      })
      .from(aiUsageEvents)
      .where(
        and(
          gte(aiUsageEvents.createdAt, periodFrom),
          inArray(aiUsageEvents.entityType, Object.keys(USAGE_ENTITY_TO_KIND)),
          isNotNull(aiUsageEvents.entityId),
        ),
      )
      .groupBy(aiUsageEvents.entityType, aiUsageEvents.entityId),
    db
      .select({
        id: workflowEvaluationEvents.id,
        project: workflowEvaluationEvents.project,
        subjectType: workflowEvaluationEvents.subjectType,
        subjectId: workflowEvaluationEvents.subjectId,
        stageKey: workflowEvaluationEvents.stageKey,
        skillPath: workflowEvaluationEvents.skillPath,
        skillVersion: workflowEvaluationEvents.skillVersion,
        criteriaScores: workflowEvaluationEvents.criteriaScores,
        outcome: workflowEvaluationEvents.outcome,
        comment: workflowEvaluationEvents.comment,
        createdAt: workflowEvaluationEvents.createdAt,
      })
      .from(workflowEvaluationEvents)
      .where(gte(workflowEvaluationEvents.createdAt, periodFrom)),
  ]);

  const [jobRows, evaluationProjects] = await Promise.all([
    loadEvaluationJobs(eventRows.map((row) => row.id)),
    evaluationEnabledProjects(userId, [
      ...prdRows.map((row) => row.project),
      ...designDocRows.map((row) => row.project),
      ...eventRows.map((row) => row.project),
    ]),
  ]);

  return {
    evaluationProjects,
    evaluationEvents: eventRows,
    evaluationJobs: jobRows,
    documents: [
      ...prdRows.map((row) => ({ ...row, kind: 'prd' as const, hasOverride: row.override !== null })),
      ...designDocRows.map((row) => ({ ...row, kind: 'design_doc' as const, hasOverride: row.override !== null })),
    ],
    settings: settingsRows,
    comments: commentRows.map((row) => ({
      documentId: row.documentId,
      documentType: row.documentType as SkillHealthArtifactKind,
      sectionKey: row.sectionKey,
    })),
    costs: costRows.flatMap((row) => {
      const documentType = row.entityType ? USAGE_ENTITY_TO_KIND[row.entityType] : undefined;
      if (!documentType || !row.entityId) return [];
      return [{ documentId: row.entityId, documentType, costUsd: parseFloat(row.costUsd) || 0 }];
    }),
  };
}

/** `userId` is the signed-in admin; the evaluation flag is checked for that user in each project. */
export async function getSkillHealthOverview(
  periodDays: number,
  userId: string,
  now = new Date(),
): Promise<SkillHealthOverview> {
  const periodFrom = new Date(now.getTime() - periodDays * DAY_MS).toISOString();
  const inputs = await loadInputs(periodFrom, userId);
  return {
    periodDays,
    periodFrom,
    generatedAt: now.toISOString(),
    projects: buildSkillHealthProjects(inputs),
    caveats: [...SKILL_HEALTH_CAVEATS],
  };
}
