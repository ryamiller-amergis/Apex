/**
 * Skill Health work items — files a Skill improvement where its owner will see it.
 *
 * Foundation (Apex) Skills go to the Apex Backlog. Any other project's Skill goes to that
 * project's Azure DevOps project, created as the signed-in user: there is no PAT fallback,
 * so the ADO history always names the person who filed it.
 */

import { AzureDevOpsService } from './azureDevOps';
import { AdoUserAuthError } from './adoUserToken';
import { createFeatureRequest, resolveFeatureRequestReviewers } from './featureRequestService';
import { autoStartFeatureRequestAnalysis } from './featureRequestAnalysisService';
import { createNotification } from './notificationService';
import {
  SKILL_HEALTH_FOUNDATION_PROJECT,
  SKILL_HEALTH_WORK_ITEM_DESCRIPTION_MAX,
  SKILL_HEALTH_WORK_ITEM_TITLE_MAX,
  allowedWorkItemDestinations,
  type CreateSkillHealthWorkItemRequest,
  type SkillHealthWorkItemDestination,
  type SkillHealthWorkItemResult,
  type SkillHealthWorkItemSkillKind,
} from '../../shared/types/skillHealth';

const ARTIFACT_KINDS: readonly SkillHealthWorkItemSkillKind[] = ['prd', 'design_doc', 'interview'];
const DESTINATIONS: readonly SkillHealthWorkItemDestination[] = ['apex-backlog', 'project-ado'];
const ADO_WORK_ITEM_TYPE = 'Product Backlog Item';
const ADO_TAG = 'skill-health';

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Returns the parsed request, or an error message for a 400. */
export function parseSkillHealthWorkItemRequest(body: unknown): CreateSkillHealthWorkItemRequest | string {
  const raw = (body ?? {}) as Record<string, unknown>;
  const project = typeof raw.project === 'string' ? raw.project.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const skillPath = typeof raw.skillPath === 'string' && raw.skillPath.trim() ? raw.skillPath.trim() : null;

  if (!project) return 'project is required';
  if (!isOneOf(DESTINATIONS, raw.destination)) return 'destination must be apex-backlog or project-ado';
  if (!allowedWorkItemDestinations(project).includes(raw.destination)) {
    return `${project} Skills are filed to the Apex Backlog`;
  }
  if (!isOneOf(ARTIFACT_KINDS, raw.artifactKind)) return 'artifactKind must be prd, design_doc or interview';
  if (!title) return 'title is required';
  if (title.length > SKILL_HEALTH_WORK_ITEM_TITLE_MAX) {
    return `title must be at most ${SKILL_HEALTH_WORK_ITEM_TITLE_MAX} characters`;
  }
  if (!description) return 'description is required';
  if (description.length > SKILL_HEALTH_WORK_ITEM_DESCRIPTION_MAX) {
    return `description must be at most ${SKILL_HEALTH_WORK_ITEM_DESCRIPTION_MAX} characters`;
  }
  return { project, destination: raw.destination, artifactKind: raw.artifactKind, skillPath, title, description };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sourceLine(request: CreateSkillHealthWorkItemRequest): string {
  const skill = request.skillPath ?? 'app default Skill';
  return `Filed from Apex Skill Health — project ${request.project}, ${skill} (${request.artifactKind}).`;
}

/** ADO renders System.Description as HTML. */
export function toAdoDescriptionHtml(request: CreateSkillHealthWorkItemRequest): string {
  const paragraphs = request.description
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`);
  return [...paragraphs, `<p><em>${escapeHtml(sourceLine(request))}</em></p>`].join('');
}

async function fileToApexBacklog(
  actorId: string,
  request: CreateSkillHealthWorkItemRequest,
): Promise<SkillHealthWorkItemResult> {
  const created = await createFeatureRequest(actorId, SKILL_HEALTH_FOUNDATION_PROJECT, {
    type: 'technical',
    title: request.title,
    request: `${request.description}\n\n${sourceLine(request)}`,
  });

  const reviewers = await resolveFeatureRequestReviewers(SKILL_HEALTH_FOUNDATION_PROJECT);
  for (const reviewerId of reviewers) {
    await createNotification(reviewerId, {
      type: 'user-action',
      title: 'New technical item',
      body: created.title,
      link: '/feature-requests',
    });
  }
  autoStartFeatureRequestAnalysis(created.id).catch((err) => {
    console.error('[skill-health] autoStartFeatureRequestAnalysis failed:', err);
  });

  return { destination: 'apex-backlog', project: SKILL_HEALTH_FOUNDATION_PROJECT, id: created.id, url: null };
}

async function fileToProjectAdo(
  adoToken: string | null,
  request: CreateSkillHealthWorkItemRequest,
): Promise<SkillHealthWorkItemResult> {
  if (!adoToken) throw new AdoUserAuthError();
  // The project name is also its root area path.
  const ado = new AzureDevOpsService(request.project, request.project, { bearerToken: adoToken });
  const created = await ado.createWorkItemForPrd({
    type: ADO_WORK_ITEM_TYPE,
    title: request.title,
    description: toAdoDescriptionHtml(request),
    tags: [ADO_TAG],
  });
  return { destination: 'project-ado', project: request.project, id: String(created.id), url: created.url };
}

export async function createSkillHealthWorkItem(
  actorId: string,
  adoToken: string | null,
  request: CreateSkillHealthWorkItemRequest,
): Promise<SkillHealthWorkItemResult> {
  switch (request.destination) {
    case 'apex-backlog':
      return fileToApexBacklog(actorId, request);
    case 'project-ado':
      return fileToProjectAdo(adoToken, request);
    default: {
      const unreachable: never = request.destination;
      throw new Error(`Unknown destination ${String(unreachable)}`);
    }
  }
}
