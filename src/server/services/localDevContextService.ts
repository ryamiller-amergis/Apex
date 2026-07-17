import { db } from '../db/drizzle';
import { prds, designDocs, designPrototypes, testCases } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { AzureDevOpsService } from './azureDevOps';
import { normalizeAdoHtml } from '../utils/adoRichText';
import { sanitizeSlug, resolveFeatureIndex } from './devContextService';
import type { LocalDevContextFile, LocalDevContextResponse } from '../../shared/types/devWorkbench';

export interface BuildLocalDevContextInput {
  project: string;
  prdId?: string;
  featureId?: string;
  workItemId?: number;
}

/**
 * Maps a raw ADO attachment file name to the canonical design-spec file name,
 * or returns null if the attachment is not a design doc / prototype.
 * Mirrors canonicalizeDesignAttachmentName in the dev-workbench route.
 */
function canonicalizeDesignAttachmentName(rawName: string): string | null {
  const base = (rawName.split(/[\\/]/).pop() ?? '').toLowerCase().trim();
  if (!base) return null;
  if (base.endsWith('design.md')) return 'design.md';
  if (base.endsWith('tech-spec.md') || base.endsWith('techspec.md')) return 'tech-spec.md';
  if (
    base.endsWith('assumptions.md') || base.endsWith('assumption.md') ||
    base.endsWith('asumptions.md') || base.endsWith('asumption.md')
  ) {
    return 'assumptions.md';
  }
  if (base.endsWith('prototype.html') || base.endsWith('prototype.htm')) return 'prototype.html';
  return null;
}

function packRoot(slug: string): string {
  return `.ai-pilot/local-dev/${slug}`;
}

function buildReadme(slug: string, title: string): string {
  return `# Local Development Context — ${title}

These files belong under your **repository root** at:

\`\`\`
.ai-pilot/local-dev/${slug}/
\`\`\`

If you used **Write into repo** in Apex, they were placed there automatically. Otherwise extract the ZIP into the repo root.

Open the repo in Cursor or VS Code and use the kickoff prompt (also saved as \`KICKOFF-PROMPT.md\` in this folder).

This pack is for local development only — it does not create a cloud My Work session.
`;
}

function buildPrompt(args: {
  title: string;
  slug: string;
  idLabel: string;
  typeLabel?: string;
  filePaths: string[];
  prototypePath?: string;
}): string {
  const { title, slug, idLabel, typeLabel, filePaths, prototypePath } = args;
  const lines = [
    `Implement the following work item locally in this repository.`,
    ``,
    `Title: ${title}`,
    `ID: ${idLabel}`,
  ];
  if (typeLabel) {
    lines.push(`Type: ${typeLabel}`);
  }
  lines.push(
    ``,
    `Context files have been extracted under \`.ai-pilot/local-dev/${slug}/\`. Read them before coding:`,
    ``,
  );
  for (const p of filePaths) {
    if (p.endsWith('KICKOFF-PROMPT.md') || p.endsWith('README.md')) continue;
    lines.push(`- \`${p}\``);
  }
  if (prototypePath) {
    lines.push(
      ``,
      `The file \`${prototypePath}\` is the approved UI prototype HTML — treat it as the intended visual/UX reference when implementing UI.`,
    );
  }
  lines.push(
    ``,
    `Implement according to the acceptance criteria and design docs. Follow this repository's coding conventions, patterns, and existing architecture. Prefer minimal, focused changes.`,
  );
  return lines.join('\n');
}

async function buildApexContext(prdId: string, featureId: string): Promise<LocalDevContextResponse> {
  const prdRow = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prdRow) {
    throw Object.assign(new Error('PRD not found'), { status: 404 });
  }

  const slug = sanitizeSlug(prdRow.title);
  const root = packRoot(slug);
  const files: LocalDevContextFile[] = [];
  const filePaths: string[] = [];
  let prototypePath: string | undefined;
  let featureTitle = featureId;

  const push = (name: string, content: string) => {
    files.push({ name, content });
    filePaths.push(name);
  };

  if (prdRow.content) {
    push(`${root}/${slug}.prd.md`, prdRow.content);
  }
  if (prdRow.backlogJson) {
    push(`${root}/${slug}.backlog.json`, JSON.stringify(prdRow.backlogJson, null, 2));
  }

  const testCaseRow = await db.query.testCases.findFirst({
    where: eq(testCases.prdId, prdId),
  });
  if (testCaseRow?.testCasesJson) {
    push(`${root}/${slug}.test-cases.json`, JSON.stringify(testCaseRow.testCasesJson, null, 2));
  }

  const featureIndex = resolveFeatureIndex(prdRow.backlogJson, featureId);
  if (featureIndex !== null) {
    const docRow = await db.query.designDocs.findFirst({
      where: and(eq(designDocs.prdId, prdId), eq(designDocs.featureIndex, featureIndex)),
    });

    if (docRow) {
      featureTitle = docRow.title || featureTitle;
      const featureSlug = sanitizeSlug(docRow.title);
      const specDir = `${root}/${slug}-design-spec`;

      if (docRow.designContent) {
        push(`${specDir}/${featureSlug}-design.md`, docRow.designContent);
      }
      if (docRow.techSpecContent) {
        push(`${specDir}/${featureSlug}-tech-spec.md`, docRow.techSpecContent);
      }
      if (docRow.assumptionsContent) {
        push(`${specDir}/${featureSlug}-assumptions.md`, docRow.assumptionsContent);
      }

      let prototypeHtml: string | null = null;
      if (docRow.designPrototypeId) {
        const proto = await db.query.designPrototypes.findFirst({
          where: eq(designPrototypes.id, docRow.designPrototypeId),
        });
        prototypeHtml = proto?.mockHtml ?? null;
      }
      if (!prototypeHtml) {
        const fallback = await db.query.designPrototypes.findFirst({
          where: and(
            eq(designPrototypes.prdId, prdId),
            eq(designPrototypes.featureIndex, featureIndex),
          ),
        });
        prototypeHtml = fallback?.mockHtml ?? null;
      }
      if (prototypeHtml) {
        prototypePath = `${specDir}/${featureSlug}-prototype.html`;
        push(prototypePath, prototypeHtml);
      }
    }
  }

  const title = featureTitle !== featureId
    ? `${prdRow.title} — ${featureTitle}`
    : prdRow.title;

  const prompt = buildPrompt({
    title,
    slug,
    idLabel: `feature ${featureId} (PRD ${prdId})`,
    typeLabel: 'Apex Feature',
    filePaths,
    prototypePath,
  });

  push(`${root}/KICKOFF-PROMPT.md`, prompt);
  push(`${root}/README.md`, buildReadme(slug, title));

  return { slug, title, files, prompt };
}

async function buildAdoContext(
  project: string,
  workItemId: number,
): Promise<LocalDevContextResponse> {
  const adoService = new AzureDevOpsService(project);

  const wiResult = await adoService.queryWorkItemsByWiql({
    wiql: `SELECT [System.Id],[System.Title],[System.WorkItemType],[System.State],[System.Description],[Microsoft.VSTS.Common.AcceptanceCriteria],[Microsoft.VSTS.TCM.ReproSteps],[Custom.Design],[System.Parent] FROM WorkItems WHERE [System.Id] = ${workItemId}`,
    fields: [
      'System.Id',
      'System.Title',
      'System.WorkItemType',
      'System.State',
      'System.Description',
      'Microsoft.VSTS.Common.AcceptanceCriteria',
      'Microsoft.VSTS.TCM.ReproSteps',
      'Custom.Design',
      'System.Parent',
    ],
    includeRelations: true,
  });

  const item = wiResult.items[0];
  if (!item) {
    throw Object.assign(new Error(`Work item #${workItemId} not found`), { status: 404 });
  }

  const title = (item.fields['System.Title'] as string | undefined) ?? `Work Item ${workItemId}`;
  const workItemType = (item.fields['System.WorkItemType'] as string | undefined) ?? '';
  const state = (item.fields['System.State'] as string | undefined) ?? '';
  const description = normalizeAdoHtml((item.fields['System.Description'] as string | undefined) ?? '');
  const acceptanceCriteria = normalizeAdoHtml(
    (item.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] as string | undefined) ?? '',
  );
  const reproSteps = normalizeAdoHtml(
    (item.fields['Microsoft.VSTS.TCM.ReproSteps'] as string | undefined) ?? '',
  );
  const design = normalizeAdoHtml((item.fields['Custom.Design'] as string | undefined) ?? '');

  const slug = sanitizeSlug(title) || `work-item-${workItemId}`;
  const root = packRoot(slug);
  const files: LocalDevContextFile[] = [];
  const filePaths: string[] = [];
  let prototypePath: string | undefined;

  const push = (name: string, content: string) => {
    files.push({ name, content });
    filePaths.push(name);
  };

  const workItemMd = [
    `# ${title}`,
    ``,
    `- **ID:** ${workItemId}`,
    `- **Type:** ${workItemType || 'Unknown'}`,
    `- **State:** ${state || 'Unknown'}`,
    `- **Project:** ${project}`,
    ``,
    `## Description`,
    ``,
    description || '_No description._',
    ``,
    `## Acceptance Criteria`,
    ``,
    acceptanceCriteria || '_No acceptance criteria._',
    ``,
    `## Repro Steps`,
    ``,
    reproSteps || '_No repro steps._',
    ``,
    `## Design`,
    ``,
    design || '_No design field._',
    ``,
  ].join('\n');
  push(`${root}/work-item.md`, workItemMd);

  // Walk to parent Feature for design-doc attachments when needed.
  let targetItem = item;
  if (workItemType !== 'Feature') {
    const parentId: number | undefined = item.fields['System.Parent'];
    if (parentId) {
      const parentResult = await adoService.queryWorkItemsByWiql({
        wiql: `SELECT [System.Id],[System.Title],[System.WorkItemType] FROM WorkItems WHERE [System.Id] = ${parentId}`,
        fields: ['System.Id', 'System.Title', 'System.WorkItemType'],
        includeRelations: true,
      });
      if (parentResult.items[0]) {
        targetItem = parentResult.items[0];
      }
    }
  }

  const featureTitle =
    (targetItem.fields['System.Title'] as string | undefined) ?? title;
  const featureSlug = sanitizeSlug(featureTitle) || slug;
  const specDir = `${root}/${featureSlug}-design-spec`;

  const relations = targetItem.relations ?? [];
  const attachments = relations
    .map((rel) => {
      if (rel.rel !== 'AttachedFile' || !rel.url) return null;
      const rawName = rel.attributes?.['name'] as string | undefined;
      if (!rawName) return null;
      const canonicalName = canonicalizeDesignAttachmentName(rawName);
      if (!canonicalName) return null;
      return { url: rel.url, rawName, canonicalName };
    })
    .filter((a): a is { url: string; rawName: string; canonicalName: string } => a !== null);

  for (const att of attachments) {
    try {
      const content = await adoService.getAttachmentText(att.url);
      if (content) {
        const path = `${specDir}/${att.canonicalName}`;
        push(path, content);
        if (att.canonicalName === 'prototype.html') {
          prototypePath = path;
        }
      }
    } catch (err) {
      console.warn(
        `[local-dev-context] failed to fetch attachment ${att.rawName}:`,
        (err as Error).message,
      );
    }
  }

  const prompt = buildPrompt({
    title,
    slug,
    idLabel: `#${workItemId}`,
    typeLabel: workItemType || undefined,
    filePaths,
    prototypePath,
  });

  push(`${root}/KICKOFF-PROMPT.md`, prompt);
  push(`${root}/README.md`, buildReadme(slug, title));

  return { slug, title, files, prompt };
}

/**
 * Builds an in-memory local-dev context pack (no disk writes, no session).
 * Exactly one of (prdId+featureId) or workItemId must be provided.
 */
export async function buildLocalDevContext(
  input: BuildLocalDevContextInput,
): Promise<LocalDevContextResponse> {
  const { project, prdId, featureId, workItemId } = input;

  const hasAdoPath = !!workItemId;
  const hasApexPath = !!prdId && !!featureId;
  const sourcePathCount = [hasAdoPath, hasApexPath].filter(Boolean).length;

  if (!project) {
    throw Object.assign(new Error('project is required'), { status: 400 });
  }
  if (sourcePathCount !== 1) {
    throw Object.assign(
      new Error('Exactly one source is required: workItemId or prdId + featureId'),
      { status: 400 },
    );
  }
  if ((prdId && !featureId) || (!prdId && featureId)) {
    throw Object.assign(
      new Error('prdId and featureId must be provided together'),
      { status: 400 },
    );
  }

  if (hasApexPath) {
    return buildApexContext(prdId!, featureId!);
  }
  return buildAdoContext(project, workItemId!);
}
