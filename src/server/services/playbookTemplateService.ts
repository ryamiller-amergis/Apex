/**
 * Installs a shipped Playbook template as a project-owned draft.
 *
 * The catalog is source files, not a shared definition row. Install copies a
 * graph into the target project and records which template version that copy
 * came from. It does not publish. Apply replaces the draft graph only after
 * an explicit confirmation, and it does not touch a published version or a run.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { PlaybookDefinitionDetail } from '../../shared/types/playbook';
import type {
  PlaybookTemplateDetail,
  PlaybookTemplateInstallState,
  PlaybookTemplateSummary,
} from '../../shared/types/playbookTemplates';
import { db } from '../db/drizzle';
import { playbookDefinitionVersions, playbookDefinitions } from '../db/schema';
import {
  PlaybookDefinitionNotFoundError,
  PlaybookDraftConflictError,
  PlaybookDraftNotFoundError,
  createDefinition,
  getDefinitionDetail,
} from './playbookDefinitionService';
import {
  getShippedPlaybookTemplate,
  loadPlaybookTemplateCatalog,
  type ShippedPlaybookTemplate,
} from './playbookTemplateCatalogService';
import { isFeatureEnabled } from './featureFlagService';

export const CORE_INTERVIEW_TEMPLATE_KEY = 'core-interview';

export class PlaybookTemplateNotFoundError extends Error {
  constructor(templateKey: string) {
    super(`Playbook template "${templateKey}" was not found.`);
    this.name = 'PlaybookTemplateNotFoundError';
  }
}

export class PlaybookTemplateInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookTemplateInvalidError';
  }
}

/** A later install must not create a version or touch a published graph or a run. */
export class PlaybookTemplateAlreadyPublishedError extends Error {
  constructor(project: string, templateKey: string) {
    super(
      `Playbook template "${templateKey}" is already published in project ${project}. ` +
        'Install does not change a published version or a running run.',
    );
    this.name = 'PlaybookTemplateAlreadyPublishedError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function loadShippedTemplate(templateKey: string): ShippedPlaybookTemplate {
  const template = getShippedPlaybookTemplate(templateKey);
  if (!template) throw new PlaybookTemplateNotFoundError(templateKey);
  return template;
}

export class PlaybookTemplatePrerequisiteError extends Error {
  constructor(readonly missingFlags: string[]) {
    super(`This template needs ${missingFlags.join(', ')} before it can be installed.`);
    this.name = 'PlaybookTemplatePrerequisiteError';
  }
}

export class PlaybookTemplateConfirmationRequiredError extends Error {
  constructor() {
    super('Replacing the draft requires confirmation.');
    this.name = 'PlaybookTemplateConfirmationRequiredError';
  }
}

export class PlaybookTemplateVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookTemplateVersionError';
  }
}

export function recordPlaybookTemplateEvent(
  event: 'browse' | 'install' | 'update-offered' | 'update-accepted',
  fields: Record<string, unknown>,
): void {
  console.info('[playbook-template]', JSON.stringify({ event, ...fields }));
}

export async function assertTemplatePrerequisites(input: {
  templateKey: string;
  userId: string | undefined;
  project: string;
}): Promise<void> {
  const template = loadShippedTemplate(input.templateKey);
  const missing: string[] = [];
  for (const flag of template.requiredFlags) {
    const enabled = await isFeatureEnabled(flag, { userId: input.userId ?? '', project: input.project });
    if (!enabled) missing.push(flag);
  }
  if (missing.length > 0) throw new PlaybookTemplatePrerequisiteError(missing);
}

function installStateFor(input: {
  installedVersion: number | null;
  catalogVersion: number;
  hasPublished: boolean;
}): PlaybookTemplateInstallState {
  if (input.installedVersion == null) return 'not-installed';
  if (input.installedVersion < input.catalogVersion) return 'update-available';
  if (input.hasPublished) return 'published';
  return 'draft-only';
}

export async function listPlaybookTemplates(project: string): Promise<PlaybookTemplateSummary[]> {
  const catalog = loadPlaybookTemplateCatalog();
  const installed = await db
    .select()
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.project, project));
  const byKey = new Map(
    installed.filter((row) => row.templateKey).map((row) => [row.templateKey as string, row]),
  );
  const ids = [...byKey.values()].map((row) => row.id);
  const versions = ids.length === 0
    ? []
    : await db
      .select({
        definitionId: playbookDefinitionVersions.definitionId,
        status: playbookDefinitionVersions.status,
      })
      .from(playbookDefinitionVersions)
      .where(inArray(playbookDefinitionVersions.definitionId, ids));
  const publishedIds = new Set(
    versions.filter((row) => row.status === 'published').map((row) => row.definitionId),
  );

  recordPlaybookTemplateEvent('browse', { project, count: catalog.length });

  return catalog.map((entry) => {
    const row = byKey.get(entry.templateKey);
    const state = installStateFor({
      installedVersion: row?.templateVersion ?? null,
      catalogVersion: entry.templateVersion,
      hasPublished: row ? publishedIds.has(row.id) : false,
    });
    if (state === 'update-available' && row) {
      recordPlaybookTemplateEvent('update-offered', {
        project,
        templateKey: entry.templateKey,
        installedTemplateVersion: row.templateVersion,
        templateVersion: entry.templateVersion,
      });
    }
    return {
      templateKey: entry.templateKey,
      templateVersion: entry.templateVersion,
      displayName: entry.displayName,
      summary: entry.summary,
      category: entry.category,
      tags: entry.tags,
      graphFile: entry.graphFile,
      requiredFlags: entry.requiredFlags,
      requiredPermissions: entry.requiredPermissions,
      installPolicy: entry.installPolicy,
      ...(entry.estimatedCostBand ? { estimatedCostBand: entry.estimatedCostBand } : {}),
      installState: state,
      installedDefinitionId: row?.id ?? null,
      installedTemplateVersion: row?.templateVersion ?? null,
      stepSummary: entry.graph.nodes.map((node) => node.stepType),
    };
  });
}

export async function getPlaybookTemplateDetail(
  project: string,
  templateKey: string,
): Promise<PlaybookTemplateDetail> {
  const summaries = await listPlaybookTemplates(project);
  const summary = summaries.find((entry) => entry.templateKey === templateKey);
  if (!summary) throw new PlaybookTemplateNotFoundError(templateKey);
  const shipped = loadShippedTemplate(templateKey);
  return { ...summary, graph: structuredClone(shipped.graph) };
}

async function findInstalledTemplate(project: string, templateKey: string) {
  const [row] = await db
    .select()
    .from(playbookDefinitions)
    .where(
      and(
        eq(playbookDefinitions.project, project),
        eq(playbookDefinitions.templateKey, templateKey),
      ),
    )
    .limit(1);
  return row;
}

async function installExisting(
  project: string,
  templateKey: string,
  definitionId: string,
): Promise<{ created: false; detail: PlaybookDefinitionDetail }> {
  const detail = await getDefinitionDetail(project, definitionId);
  if (detail.versions.length > 0) {
    throw new PlaybookTemplateAlreadyPublishedError(project, templateKey);
  }
  return { created: false, detail };
}

/**
 * Copies the shipped template into the project as an unpublished draft.
 * A second install returns the existing unpublished definition. A definition
 * that already has a published, deprecated, or archived version is left as it is.
 */
export async function installPlaybookTemplate(input: {
  project: string;
  templateKey: string;
  createdByUserId: string;
}): Promise<{ created: boolean; detail: PlaybookDefinitionDetail }> {
  const template = loadShippedTemplate(input.templateKey);
  const existing = await findInstalledTemplate(input.project, template.templateKey);
  if (existing) {
    return installExisting(input.project, template.templateKey, existing.id);
  }

  try {
    const detail = await createDefinition({
      project: input.project,
      name: template.name,
      description: template.description,
      graph: structuredClone(template.graph),
      createdByUserId: input.createdByUserId,
      templateKey: template.templateKey,
      templateVersion: template.templateVersion,
    });
    recordPlaybookTemplateEvent('install', {
      project: input.project,
      templateKey: template.templateKey,
      templateVersion: template.templateVersion,
      definitionId: detail.definition.id,
      actorUserId: input.createdByUserId,
    });
    return { created: true, detail };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findInstalledTemplate(input.project, template.templateKey);
    if (!raced) throw error;
    return installExisting(input.project, template.templateKey, raced.id);
  }
}

/**
 * Replaces the retained draft graph with a newer shipped template.
 * Published versions and runs are not updated.
 */
export async function applyPlaybookTemplate(input: {
  project: string;
  definitionId: string;
  templateKey: string;
  templateVersion: number;
  expectedDraftUpdatedAt: string;
  confirmed: boolean;
  actorUserId: string;
}): Promise<PlaybookDefinitionDetail> {
  if (input.confirmed !== true) throw new PlaybookTemplateConfirmationRequiredError();
  const template = loadShippedTemplate(input.templateKey);
  if (template.templateVersion !== input.templateVersion) {
    throw new PlaybookTemplateVersionError(
      `Template ${input.templateKey} is at version ${template.templateVersion}.`,
    );
  }

  await db.transaction(async (tx) => {
    const [definition] = await tx
      .select()
      .from(playbookDefinitions)
      .where(and(
        eq(playbookDefinitions.id, input.definitionId),
        eq(playbookDefinitions.project, input.project),
      ))
      .for('update');
    if (!definition) throw new PlaybookDefinitionNotFoundError(input.definitionId);
    if (definition.templateKey !== template.templateKey) {
      throw new PlaybookTemplateVersionError(
        'Apply only updates a definition installed from the same template.',
      );
    }
    const [draft] = await tx
      .select()
      .from(playbookDefinitionVersions)
      .where(and(
        eq(playbookDefinitionVersions.definitionId, definition.id),
        eq(playbookDefinitionVersions.status, 'draft'),
      ))
      .for('update');
    if (!draft) throw new PlaybookDraftNotFoundError(input.definitionId);
    if (draft.updatedAt !== input.expectedDraftUpdatedAt) {
      throw new PlaybookDraftConflictError(input.definitionId);
    }

    const now = new Date().toISOString();
    const [updatedDraft] = await tx
      .update(playbookDefinitionVersions)
      .set({ graph: structuredClone(template.graph), updatedAt: now })
      .where(and(
        eq(playbookDefinitionVersions.id, draft.id),
        eq(playbookDefinitionVersions.status, 'draft'),
        eq(playbookDefinitionVersions.updatedAt, input.expectedDraftUpdatedAt),
      ))
      .returning({ id: playbookDefinitionVersions.id });
    if (!updatedDraft) throw new PlaybookDraftConflictError(input.definitionId);

    await tx
      .update(playbookDefinitions)
      .set({ templateVersion: template.templateVersion, updatedAt: now })
      .where(eq(playbookDefinitions.id, definition.id))
      .returning({ id: playbookDefinitions.id });
  });

  recordPlaybookTemplateEvent('update-accepted', {
    project: input.project,
    definitionId: input.definitionId,
    templateKey: template.templateKey,
    templateVersion: template.templateVersion,
    actorUserId: input.actorUserId,
  });
  return getDefinitionDetail(input.project, input.definitionId);
}
