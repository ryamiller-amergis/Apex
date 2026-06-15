import { db } from '../db/drizzle';
import {
  appGroups,
  projectMenuSettings,
  projectSkillSettings,
  userProjectAssignments,
} from '../db/schema';
import { AzureDevOpsService } from './azureDevOps';

export interface ProjectCatalogItem {
  id: string;
  name: string;
  description: string;
}

export const APEX_VIRTUAL_PROJECT: ProjectCatalogItem = {
  id: 'apex-virtual',
  name: 'Apex',
  description: 'AI Pilot self-development - requirement flows & orchestration',
};

type ProjectRefRow = {
  project: string | null;
};

function stableProjectId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `project-${slug || 'unnamed'}`;
}

function fromProjectName(name: string): ProjectCatalogItem {
  if (name.trim().toLowerCase() === APEX_VIRTUAL_PROJECT.name.toLowerCase()) {
    return APEX_VIRTUAL_PROJECT;
  }

  return {
    id: stableProjectId(name),
    name: name.trim(),
    description: '',
  };
}

export function mergeProjectCatalogItems(items: ProjectCatalogItem[]): ProjectCatalogItem[] {
  const byName = new Map<string, ProjectCatalogItem>();

  for (const item of items) {
    const name = item.name.trim();
    if (!name) continue;

    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        id: item.id || stableProjectId(name),
        name,
        description: item.description ?? '',
      });
      continue;
    }

    byName.set(key, {
      id: existing.id || item.id || stableProjectId(name),
      name: existing.name,
      description: existing.description || item.description || '',
    });
  }

  return [...byName.values()].sort((a, b) => (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  ));
}

export function filterProjectCatalogByNames(
  catalog: ProjectCatalogItem[],
  projectNames: string[],
): ProjectCatalogItem[] {
  const requestedNames = projectNames.map((project) => project.trim()).filter(Boolean);
  const requested = new Set(requestedNames.map((project) => project.toLowerCase()));
  const matchedNames = new Set<string>();

  const matched = catalog.filter((project) => {
    const key = project.name.toLowerCase();
    const isMatch = requested.has(key);
    if (isMatch) matchedNames.add(key);
    return isMatch;
  });

  const missing = requestedNames
    .filter((project) => !matchedNames.has(project.toLowerCase()))
    .map(fromProjectName);

  return mergeProjectCatalogItems([...matched, ...missing]);
}

async function listDatabaseProjectNames(): Promise<string[]> {
  const [
    assignmentRows,
    menuRows,
    skillRows,
    groupRows,
  ] = await Promise.all([
    db.select({ project: userProjectAssignments.project }).from(userProjectAssignments),
    db.select({ project: projectMenuSettings.project }).from(projectMenuSettings),
    db.select({ project: projectSkillSettings.project }).from(projectSkillSettings),
    db.select({ project: appGroups.project }).from(appGroups),
  ]) as [ProjectRefRow[], ProjectRefRow[], ProjectRefRow[], ProjectRefRow[]];

  return [
    ...assignmentRows,
    ...menuRows,
    ...skillRows,
    ...groupRows,
  ]
    .map((row) => row.project?.trim() ?? '')
    .filter(Boolean);
}

export async function listProjectCatalog(): Promise<ProjectCatalogItem[]> {
  const adoService = new AzureDevOpsService();
  const [adoProjects, databaseProjectNames] = await Promise.all([
    adoService.getProjects(),
    listDatabaseProjectNames(),
  ]);

  return mergeProjectCatalogItems([
    ...adoProjects,
    APEX_VIRTUAL_PROJECT,
    ...databaseProjectNames.map(fromProjectName),
  ]);
}
