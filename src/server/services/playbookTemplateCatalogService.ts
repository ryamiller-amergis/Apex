/**
 * Loads the source-controlled Playbook template manifest.
 * A file that fails validation fails the process that imports this module.
 * Graphs are imported, not read from disk: tsc emits imported JSON into dist/ and skips loose files.
 */
import type { PlaybookGraph } from '../../shared/types/playbook';
import type { PlaybookTemplateCatalogEntry } from '../../shared/types/playbookTemplates';
import catalogFile from '../playbookTemplates/catalog.json';
import interviewTemplate from '../playbookTemplates/interview.json';
import designDocValidationTemplate from '../playbookTemplates/design-doc-validation.json';
import buildFromPromptTemplate from '../playbookTemplates/build-from-prompt.json';

const GRAPH_SOURCES: Record<string, unknown> = {
  'interview.json': interviewTemplate,
  'design-doc-validation.json': designDocValidationTemplate,
  'build-from-prompt.json': buildFromPromptTemplate,
};

export class PlaybookTemplateCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookTemplateCatalogError';
  }
}

export interface ShippedPlaybookTemplate extends PlaybookTemplateCatalogEntry {
  name: string;
  description: string | null;
  graph: PlaybookGraph;
}

const COST_BANDS = new Set(['low', 'medium', 'high']);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlaybookTemplateCatalogError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new PlaybookTemplateCatalogError(`${label} must be a list of non-blank strings.`);
  }
  return value.map((entry) => (entry as string).trim());
}

function validateEntry(raw: unknown, index: number): PlaybookTemplateCatalogEntry {
  const entry = asRecord(raw, `templates[${index}]`);
  const templateKey = entry.templateKey;
  if (typeof templateKey !== 'string' || !templateKey.trim()) {
    throw new PlaybookTemplateCatalogError(`templates[${index}] is missing templateKey.`);
  }
  const templateVersion = entry.templateVersion;
  if (!Number.isInteger(templateVersion) || (templateVersion as number) < 1) {
    throw new PlaybookTemplateCatalogError(`${templateKey} has no monotonic templateVersion.`);
  }
  for (const field of ['displayName', 'summary', 'category', 'graphFile'] as const) {
    if (typeof entry[field] !== 'string' || !(entry[field] as string).trim()) {
      throw new PlaybookTemplateCatalogError(`${templateKey} is missing ${field}.`);
    }
  }
  if (entry.installPolicy !== 'one-per-project') {
    throw new PlaybookTemplateCatalogError(`${templateKey} must use installPolicy one-per-project.`);
  }
  if (
    entry.estimatedCostBand !== undefined
    && !COST_BANDS.has(entry.estimatedCostBand as string)
  ) {
    throw new PlaybookTemplateCatalogError(`${templateKey} has an unknown cost band.`);
  }
  const graphFile = (entry.graphFile as string).trim();
  if (graphFile.includes('..') || graphFile.includes('/') || graphFile.includes('\\')) {
    throw new PlaybookTemplateCatalogError(`${templateKey} graphFile must be a file in the template directory.`);
  }
  return {
    templateKey: templateKey.trim(),
    templateVersion: templateVersion as number,
    displayName: (entry.displayName as string).trim(),
    summary: (entry.summary as string).trim(),
    category: (entry.category as string).trim(),
    tags: stringList(entry.tags, `${templateKey} tags`),
    graphFile,
    requiredFlags: stringList(entry.requiredFlags, `${templateKey} requiredFlags`),
    requiredPermissions: stringList(entry.requiredPermissions, `${templateKey} requiredPermissions`),
    installPolicy: 'one-per-project',
    ...(entry.runInputSchema && typeof entry.runInputSchema === 'object'
      ? { runInputSchema: entry.runInputSchema as Record<string, unknown> }
      : {}),
    ...(entry.estimatedCostBand
      ? { estimatedCostBand: entry.estimatedCostBand as PlaybookTemplateCatalogEntry['estimatedCostBand'] }
      : {}),
  };
}

function loadGraphFile(entry: PlaybookTemplateCatalogEntry): ShippedPlaybookTemplate {
  const source = GRAPH_SOURCES[entry.graphFile];
  if (!source) {
    throw new PlaybookTemplateCatalogError(
      `${entry.templateKey} graph file ${entry.graphFile} was not found.`,
    );
  }
  const parsed = asRecord(source, entry.graphFile);
  if (parsed.templateKey !== entry.templateKey) {
    throw new PlaybookTemplateCatalogError(
      `${entry.graphFile} does not declare templateKey ${entry.templateKey}.`,
    );
  }
  if (parsed.templateVersion !== entry.templateVersion) {
    throw new PlaybookTemplateCatalogError(
      `${entry.graphFile} templateVersion does not match the catalog.`,
    );
  }
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new PlaybookTemplateCatalogError(`${entry.templateKey} is missing a name.`);
  }
  const graph = parsed.graph as PlaybookGraph | undefined;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new PlaybookTemplateCatalogError(`${entry.templateKey} is missing a graph.`);
  }
  return {
    ...entry,
    name: parsed.name.trim(),
    description: typeof parsed.description === 'string' ? parsed.description : null,
    graph: structuredClone(graph),
  };
}

function loadCatalog(): ShippedPlaybookTemplate[] {
  const manifest = asRecord(catalogFile, 'catalog.json');
  if (!Array.isArray(manifest.templates) || manifest.templates.length === 0) {
    throw new PlaybookTemplateCatalogError('catalog.json must list at least one template.');
  }
  const entries = manifest.templates.map((entry, index) => validateEntry(entry, index));
  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.templateKey)) {
      throw new PlaybookTemplateCatalogError(`Duplicate templateKey ${entry.templateKey}.`);
    }
    keys.add(entry.templateKey);
  }
  return entries.map(loadGraphFile);
}

let cached: ShippedPlaybookTemplate[] | undefined;

export function loadPlaybookTemplateCatalog(): ShippedPlaybookTemplate[] {
  cached ??= loadCatalog();
  return cached;
}

export function getShippedPlaybookTemplate(templateKey: string): ShippedPlaybookTemplate | undefined {
  return loadPlaybookTemplateCatalog().find((entry) => entry.templateKey === templateKey);
}

loadPlaybookTemplateCatalog();
