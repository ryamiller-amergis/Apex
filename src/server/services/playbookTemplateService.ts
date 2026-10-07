/**
 * Installs the one shipped Playbook template as a project-owned draft.
 *
 * The source file is not a shared definition row. Install copies its graph into
 * the target project and records which template version that copy came from.
 * It does not publish, and it does not rewrite a definition that already has
 * history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { PlaybookDefinitionDetail, PlaybookGraph } from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import { playbookDefinitions } from '../db/schema';
import { createDefinition, getDefinitionDetail } from './playbookDefinitionService';

export const CORE_INTERVIEW_TEMPLATE_KEY = 'core-interview';

interface ShippedPlaybookTemplate {
  templateKey: string;
  templateVersion: number;
  name: string;
  description: string | null;
  graph: PlaybookGraph;
}

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

const TEMPLATE_FILES: Record<string, string> = {
  [CORE_INTERVIEW_TEMPLATE_KEY]: 'interview.json',
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function loadShippedTemplate(templateKey: string): ShippedPlaybookTemplate {
  const fileName = TEMPLATE_FILES[templateKey];
  if (!fileName) throw new PlaybookTemplateNotFoundError(templateKey);

  const filePath = path.join(__dirname, '..', 'playbookTemplates', fileName);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ShippedPlaybookTemplate>;
  if (parsed.templateKey !== templateKey) {
    throw new PlaybookTemplateInvalidError(
      `Shipped template file ${fileName} does not declare templateKey ${templateKey}.`,
    );
  }
  if (!Number.isInteger(parsed.templateVersion) || (parsed.templateVersion ?? 0) < 1) {
    throw new PlaybookTemplateInvalidError(
      `Shipped template ${templateKey} has no monotonic templateVersion.`,
    );
  }
  if (!parsed.name?.trim() || !parsed.graph || !Array.isArray(parsed.graph.nodes)) {
    throw new PlaybookTemplateInvalidError(
      `Shipped template ${templateKey} is missing a name or graph.`,
    );
  }

  return {
    templateKey,
    templateVersion: parsed.templateVersion!,
    name: parsed.name.trim(),
    description: typeof parsed.description === 'string' ? parsed.description : null,
    graph: structuredClone(parsed.graph),
  };
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
    return { created: true, detail };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findInstalledTemplate(input.project, template.templateKey);
    if (!raced) throw error;
    return installExisting(input.project, template.templateKey, raced.id);
  }
}
