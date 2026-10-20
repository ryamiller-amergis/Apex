/**
 * Skill Health — read-only quality metrics per generating Skill.
 *
 * v0 covers the two artifact kinds Apex already scores (PRDs and design docs). A Skill is
 * identified by its project and the path that project's settings row points at today; outputs do not yet record
 * the Skill version that produced them, so a settings change mid-period is not visible here.
 */

export type SkillHealthArtifactKind = 'prd' | 'design_doc';

export type SkillHealthStatus = 'good' | 'fair' | 'poor' | 'insufficient_data';

/** How a document was tied to a Skill path. */
export type SkillAttributionSource = 'document-settings' | 'project-default' | 'unattributed';

export const SKILL_HEALTH_PERIOD_OPTIONS = [30, 90, 180] as const;
export type SkillHealthPeriodDays = (typeof SKILL_HEALTH_PERIOD_OPTIONS)[number];

/** Fewer scored documents than this and the status is `insufficient_data`. */
export const SKILL_HEALTH_MIN_SCORED_DOCUMENTS = 5;

/** The project whose Skills are the Apex foundation; its work items go to the Apex Backlog. */
export const SKILL_HEALTH_FOUNDATION_PROJECT = 'Apex';

/** Where a Skill Health work item is filed. */
export type SkillHealthWorkItemDestination = 'apex-backlog' | 'project-ado';

/** Apex Skills file to the Apex Backlog; every other project files to its own Azure DevOps project. */
export function defaultWorkItemDestination(project: string): SkillHealthWorkItemDestination {
  return project === SKILL_HEALTH_FOUNDATION_PROJECT ? 'apex-backlog' : 'project-ado';
}

/** Apex has no project ADO target; other projects may also send a shared-Skill finding to the Apex Backlog. */
export function allowedWorkItemDestinations(project: string): SkillHealthWorkItemDestination[] {
  return project === SKILL_HEALTH_FOUNDATION_PROJECT ? ['apex-backlog'] : ['project-ado', 'apex-backlog'];
}

export const SKILL_HEALTH_WORK_ITEM_TITLE_MAX = 255;
export const SKILL_HEALTH_WORK_ITEM_DESCRIPTION_MAX = 20000;

export interface SkillHealthTrendPoint {
  /** ISO date (YYYY-MM-DD) of the Monday starting the week. */
  weekStart: string;
  documents: number;
  averageScore: number | null;
}

/** Review comments left on one section of this Skill's documents. */
export interface SkillHealthSectionCell {
  sectionKey: string;
  commentCount: number;
}

/** A validation gap section that recurs across this Skill's documents. */
export interface SkillHealthRecurringGap {
  section: string;
  occurrences: number;
  documentCount: number;
  /** Up to three gap descriptions, verbatim from the judge, as evidence. */
  sampleDescriptions: string[];
  exampleDocumentIds: string[];
}

export interface SkillHealthSkill {
  /** Stable key: `${project}:${artifactKind}:${skillPath}`. */
  key: string;
  project: string;
  artifactKind: SkillHealthArtifactKind;
  /** Normalized path inside the project's Skill repo, or null when the project uses the app default. */
  skillPath: string | null;
  status: SkillHealthStatus;
  documents: number;
  scoredDocuments: number;
  averageScore: number | null;
  /** Share of scored documents at or above their project's threshold. */
  passRate: number | null;
  /** approved / (approved + revision_requested), from current status. */
  acceptanceRate: number | null;
  revisionRequested: number;
  /** Documents whose validation gate was overridden by a person. */
  overrides: number;
  generationFailures: number;
  reviewComments: number;
  commentsPerDocument: number | null;
  costUsd: number;
  costPerDocument: number | null;
  attribution: Record<SkillAttributionSource, number>;
  trend: SkillHealthTrendPoint[];
  sections: SkillHealthSectionCell[];
  recurringGaps: SkillHealthRecurringGap[];
}

/** One project's Skills. The same path in two projects is two Skills: each lives in its own repo. */
export interface SkillHealthProject {
  project: string;
  /** Repo of the project's default Skill settings row, or null when the project has none. */
  skillRepo: string | null;
  isFoundation: boolean;
  skills: SkillHealthSkill[];
}

export interface SkillHealthOverview {
  periodDays: number;
  periodFrom: string;
  generatedAt: string;
  /** Foundation project first, then alphabetical. */
  projects: SkillHealthProject[];
  /** Plain-language limits of this data, shown with the results. */
  caveats: string[];
}

export interface CreateSkillHealthWorkItemRequest {
  /** Project whose Skill the finding is about. */
  project: string;
  destination: SkillHealthWorkItemDestination;
  artifactKind: SkillHealthArtifactKind;
  skillPath: string | null;
  title: string;
  description: string;
}

export interface SkillHealthWorkItemResult {
  destination: SkillHealthWorkItemDestination;
  /** Project the item was filed in: the foundation project for the Apex Backlog, else the ADO project. */
  project: string;
  id: string;
  /** ADO work item URL; null for Apex Backlog items. */
  url: string | null;
}
