import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookDefinitionVersions, playbookDefinitions } from '../../db/schema';
import { publishDraft } from '../playbookDefinitionService';
import { installPlaybookTemplate } from '../playbookTemplateService';

export const BUILD_FROM_PROMPT_TEMPLATE_KEY = 'build-from-prompt';

export interface PublishedBuildPlaybook {
  definitionId: string;
  versionId: string;
}

/**
 * Installs and publishes the Build from prompt Playbook the first time a project starts a build.
 * A later template version does not replace a definition that is already published.
 */
export async function ensurePublished(project: string, userId: string): Promise<PublishedBuildPlaybook> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`build-from-prompt:${project}`}))`);
    const existing = await publishedVersion(tx, project);
    if (existing) return existing;

    const installed = await installPlaybookTemplate({
      project,
      templateKey: BUILD_FROM_PROMPT_TEMPLATE_KEY,
      createdByUserId: userId,
    });
    if (installed.detail.currentPublishedVersionId) {
      return {
        definitionId: installed.detail.definition.id,
        versionId: installed.detail.currentPublishedVersionId,
      };
    }
    const published = await publishDraft({
      project,
      definitionId: installed.detail.definition.id,
      publishedByUserId: userId,
      expectedDraftUpdatedAt: installed.detail.draft.updatedAt,
      sampleRunInput: {
        buildRunId: '00000000-0000-4000-8000-000000000001',
        prompt: 'sample',
        skillSettingsId: '00000000-0000-4000-8000-000000000002',
      },
    });
    return {
      definitionId: installed.detail.definition.id,
      versionId: published.currentPublishedVersionId,
    };
  });
}

async function publishedVersion(
  tx: Pick<typeof db, 'select'>,
  project: string,
): Promise<PublishedBuildPlaybook | null> {
  const [row] = await tx
    .select({
      definitionId: playbookDefinitions.id,
      versionId: playbookDefinitionVersions.id,
    })
    .from(playbookDefinitions)
    .innerJoin(
      playbookDefinitionVersions,
      eq(playbookDefinitionVersions.definitionId, playbookDefinitions.id),
    )
    .where(and(
      eq(playbookDefinitions.project, project),
      eq(playbookDefinitions.templateKey, BUILD_FROM_PROMPT_TEMPLATE_KEY),
      eq(playbookDefinitionVersions.status, 'published'),
    ))
    .limit(1);
  return row ?? null;
}
