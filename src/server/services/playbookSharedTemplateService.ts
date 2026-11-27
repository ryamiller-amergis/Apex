/**
 * Shared Playbook templates: a published graph a platform admin copies so other projects can use it.
 *
 * Sharing takes a snapshot of the latest published version and removes settings that only mean
 * something in the source project (project skills, named people, frozen agent policy). The copy has
 * no link back to the original. Installing creates a new, unpublished definition with no template
 * key, so the install is an ordinary Playbook the project can rename, edit, and publish.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { PlaybookDefinitionDetail, PlaybookGraph } from '../../shared/types/playbook';
import type {
  PlaybookTemplateDetail,
  PlaybookTemplateSummary,
} from '../../shared/types/playbookTemplates';
import { db } from '../db/drizzle';
import {
  appUsers,
  playbookDefinitionVersions,
  playbookDefinitions,
  playbookSharedTemplates,
} from '../db/schema';
import { createDefinition } from './playbookDefinitionService';
import { projectSkillVersionIdFromPath } from './playbookProjectSkillService';

export const SHARED_TEMPLATE_KEY_PREFIX = 'shared:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 500;
const MAX_INSTALL_NAME_ATTEMPTS = 50;

/** Step types that only run when a feature flag is on for the project that uses them. */
const FLAG_BY_STEP_TYPE: Record<string, string> = {
  interview: 'playbook-interview-step',
  build: 'build-from-prompt',
};

export class PlaybookSharedTemplateNotFoundError extends Error {
  constructor(templateKey: string) {
    super(`Playbook template "${templateKey}" was not found.`);
    this.name = 'PlaybookSharedTemplateNotFoundError';
  }
}

export class PlaybookSharedTemplateInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookSharedTemplateInvalidError';
  }
}

export class PlaybookSharedTemplateNameTakenError extends Error {
  constructor(name: string) {
    super(`A shared template named "${name}" already exists. Pick another name or remove that one first.`);
    this.name = 'PlaybookSharedTemplateNameTakenError';
  }
}

export function isSharedTemplateKey(templateKey: string): boolean {
  return templateKey.startsWith(SHARED_TEMPLATE_KEY_PREFIX);
}

export function sharedTemplateKey(id: string): string {
  return `${SHARED_TEMPLATE_KEY_PREFIX}${id}`;
}

/** Returns the row id for a `shared:<uuid>` key, or null for any other string. */
export function sharedTemplateIdFromKey(templateKey: string): string | null {
  if (!isSharedTemplateKey(templateKey)) return null;
  const id = templateKey.slice(SHARED_TEMPLATE_KEY_PREFIX.length);
  return UUID.test(id) ? id : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === '23505'
  );
}

export function requiredFlagsForGraph(graph: PlaybookGraph): string[] {
  const flags = new Set<string>();
  for (const node of graph.nodes) {
    const flag = FLAG_BY_STEP_TYPE[node.stepType];
    if (flag) flags.add(flag);
  }
  return [...flags];
}

/** A `${input.x}` or `${steps.x.y}` binding is project-neutral; a literal value is not. */
function isBinding(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${');
}

function stepLabel(node: PlaybookGraph['nodes'][number]): string {
  return node.title?.trim() || node.id;
}

/**
 * Returns a copy of the graph with settings that belong to the source project removed, and one
 * note per removal. Skips nothing else: step order, prompts, outcomes, and edges stay as written.
 */
export function sanitizeGraphForSharing(graph: PlaybookGraph): { graph: PlaybookGraph; notes: string[] } {
  const copy = structuredClone(graph);
  const notes: string[] = [];
  for (const node of copy.nodes) {
    const label = stepLabel(node);
    // Both are stamped when a version is published. The new owner publishes again.
    delete node.agentPolicy;
    delete node.stepTypeVersion;
    const config = node.config;
    if (!config) continue;

    if (typeof config.skillPath === 'string' && projectSkillVersionIdFromPath(config.skillPath)) {
      delete config.skillPath;
      notes.push(`"${label}": the project skill was removed. Pick a skill in the new project.`);
    }
    for (const field of ['assigneeUserId', 'assigneeEmail'] as const) {
      if (config[field] !== undefined && !isBinding(config[field])) {
        delete config[field];
        if (field === 'assigneeUserId') notes.push(`"${label}": the assignee was removed. Choose one after installing.`);
      }
    }
    if (config.recipientUserId !== undefined && !isBinding(config.recipientUserId)) {
      delete config.recipientUserId;
      notes.push(`"${label}": the named recipient was removed. It notifies whoever started the run.`);
    }
    if (config.skillSettingsId !== undefined && !isBinding(config.skillSettingsId)) {
      delete config.skillSettingsId;
      notes.push(`"${label}": the repository setting was removed. It uses the project's default.`);
    }
    if (config.threadId !== undefined && !isBinding(config.threadId)) {
      delete config.threadId;
    }
  }
  return { graph: copy, notes };
}

type SharedRow = typeof playbookSharedTemplates.$inferSelect;

function toSummary(row: SharedRow, sharedByName: string | null): PlaybookTemplateSummary {
  return {
    templateKey: sharedTemplateKey(row.id),
    templateVersion: 1,
    displayName: row.name,
    summary: row.summary,
    category: row.category,
    tags: [],
    graphFile: 'shared',
    requiredFlags: requiredFlagsForGraph(row.graph),
    requiredPermissions: ['playbooks:author'],
    installPolicy: 'multiple',
    source: 'shared',
    sharedByName,
    sharedAt: row.createdAt,
    sourceProject: row.sourceProject,
    installState: 'not-installed',
    installedDefinitionId: null,
    installedTemplateVersion: null,
    stepSummary: row.graph.nodes.map((node) => node.stepType),
  };
}

async function loadSharer(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ displayName: appUsers.displayName, email: appUsers.email })
    .from(appUsers)
    .where(eq(appUsers.oid, userId))
    .limit(1);
  return user?.displayName ?? user?.email ?? null;
}

function cleanText(value: string | undefined, max: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new PlaybookSharedTemplateInvalidError(`${label} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/**
 * Copies the latest published version of a definition into the shared catalog.
 * Fails when the Playbook has no published version, so a template always passed publish checks.
 */
export async function sharePlaybookAsTemplate(input: {
  project: string;
  definitionId: string;
  actorUserId: string;
  name?: string;
  summary?: string;
}): Promise<{ template: PlaybookTemplateSummary; notes: string[] }> {
  const [definition] = await db
    .select()
    .from(playbookDefinitions)
    .where(and(
      eq(playbookDefinitions.id, input.definitionId),
      eq(playbookDefinitions.project, input.project),
    ))
    .limit(1);
  if (!definition) {
    throw new PlaybookSharedTemplateNotFoundError(input.definitionId);
  }

  const [version] = await db
    .select()
    .from(playbookDefinitionVersions)
    .where(and(
      eq(playbookDefinitionVersions.definitionId, definition.id),
      eq(playbookDefinitionVersions.status, 'published'),
    ))
    .orderBy(desc(playbookDefinitionVersions.versionNumber))
    .limit(1);
  if (!version) {
    throw new PlaybookSharedTemplateInvalidError(
      'Publish this Playbook before sharing it. A template is a copy of a published version.',
    );
  }

  const name = cleanText(input.name, MAX_NAME_LENGTH, 'Name') || definition.name.trim();
  const summary = cleanText(input.summary, MAX_SUMMARY_LENGTH, 'Summary')
    ?? (definition.description ?? '').trim().slice(0, MAX_SUMMARY_LENGTH);

  const { graph, notes } = sanitizeGraphForSharing(version.graph);

  let row: SharedRow;
  try {
    [row] = await db
      .insert(playbookSharedTemplates)
      .values({
        name,
        summary,
        category: 'shared',
        graph,
        sourceProject: input.project,
        sourceDefinitionId: definition.id,
        sourceVersionNumber: version.versionNumber,
        createdBy: input.actorUserId,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) throw new PlaybookSharedTemplateNameTakenError(name);
    throw error;
  }

  console.info('[playbook-template]', JSON.stringify({
    event: 'share',
    project: input.project,
    definitionId: definition.id,
    templateKey: sharedTemplateKey(row.id),
    actorUserId: input.actorUserId,
  }));
  return { template: toSummary(row, await loadSharer(input.actorUserId)), notes };
}

export async function listSharedTemplates(): Promise<PlaybookTemplateSummary[]> {
  const rows = await db
    .select({ row: playbookSharedTemplates, sharedByName: appUsers.displayName, sharedByEmail: appUsers.email })
    .from(playbookSharedTemplates)
    .leftJoin(appUsers, eq(appUsers.oid, playbookSharedTemplates.createdBy))
    .where(isNull(playbookSharedTemplates.archivedAt))
    .orderBy(desc(playbookSharedTemplates.createdAt));
  return rows.map((entry) => toSummary(entry.row, entry.sharedByName ?? entry.sharedByEmail ?? null));
}

async function findSharedRow(templateKey: string) {
  const id = sharedTemplateIdFromKey(templateKey);
  if (!id) return undefined;
  const [entry] = await db
    .select({ row: playbookSharedTemplates, sharedByName: appUsers.displayName, sharedByEmail: appUsers.email })
    .from(playbookSharedTemplates)
    .leftJoin(appUsers, eq(appUsers.oid, playbookSharedTemplates.createdBy))
    .where(and(eq(playbookSharedTemplates.id, id), isNull(playbookSharedTemplates.archivedAt)))
    .limit(1);
  return entry;
}

export async function getSharedTemplateDetail(templateKey: string): Promise<PlaybookTemplateDetail> {
  const entry = await findSharedRow(templateKey);
  if (!entry) throw new PlaybookSharedTemplateNotFoundError(templateKey);
  return {
    ...toSummary(entry.row, entry.sharedByName ?? entry.sharedByEmail ?? null),
    graph: structuredClone(entry.row.graph),
  };
}

/** Flags a shared template needs, read from its stored graph. */
export async function requiredFlagsForSharedTemplate(templateKey: string): Promise<string[]> {
  const entry = await findSharedRow(templateKey);
  if (!entry) throw new PlaybookSharedTemplateNotFoundError(templateKey);
  return requiredFlagsForGraph(entry.row.graph);
}

/** Removes the template from the gallery. Playbooks already installed from it are not touched. */
export async function archiveSharedTemplate(templateKey: string, actorUserId: string): Promise<void> {
  const id = sharedTemplateIdFromKey(templateKey);
  if (!id) throw new PlaybookSharedTemplateNotFoundError(templateKey);
  const now = new Date().toISOString();
  const archived = await db
    .update(playbookSharedTemplates)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(playbookSharedTemplates.id, id), isNull(playbookSharedTemplates.archivedAt)))
    .returning({ id: playbookSharedTemplates.id });
  if (archived.length === 0) throw new PlaybookSharedTemplateNotFoundError(templateKey);
  console.info('[playbook-template]', JSON.stringify({
    event: 'unshare',
    templateKey,
    actorUserId,
  }));
}

function numberedName(base: string, attempt: number): string {
  if (attempt === 1) return base;
  const suffix = ` (${attempt})`;
  return `${base.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length))}${suffix}`;
}

/**
 * Creates a new, unpublished Playbook in the project from a shared template. The copy records no
 * template key, so it can be installed again and never depends on the template or the original.
 * A name already used in the project gets a number added.
 */
export async function installSharedTemplate(input: {
  project: string;
  templateKey: string;
  createdByUserId: string;
  name?: string;
}): Promise<PlaybookDefinitionDetail> {
  const entry = await findSharedRow(input.templateKey);
  if (!entry) throw new PlaybookSharedTemplateNotFoundError(input.templateKey);
  const base = cleanText(input.name, MAX_NAME_LENGTH, 'Name') || entry.row.name;

  for (let attempt = 1; attempt <= MAX_INSTALL_NAME_ATTEMPTS; attempt += 1) {
    try {
      const detail = await createDefinition({
        project: input.project,
        name: numberedName(base, attempt),
        description: entry.row.summary || null,
        graph: structuredClone(entry.row.graph),
        createdByUserId: input.createdByUserId,
      });
      console.info('[playbook-template]', JSON.stringify({
        event: 'install',
        project: input.project,
        templateKey: input.templateKey,
        definitionId: detail.definition.id,
        actorUserId: input.createdByUserId,
      }));
      return detail;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new PlaybookSharedTemplateInvalidError(
    'Could not find a free name for this Playbook. Pass a different name.',
  );
}
