import {
  resolveFoundationSkillSelection,
} from './foundationSkillDependencies';
import type { FoundationSkillCatalogEntry } from './types/foundationSkills';

type AssignmentSkill = Pick<FoundationSkillCatalogEntry, 'name'> & {
  dependsOn?: string[];
  summary?: string;
  tier?: string;
  alwaysInstall?: boolean;
};

export interface ProjectAssignmentPerProject {
  explicit: string[];
  effective: string[];
  requiredBy: Record<string, string[]>;
}

export interface ResolvedProjectAssignment {
  /** Union of every project's effective skills, in catalog order. */
  effectiveSelectedSkills: string[];
  /** Global dependency-first order for the release payload. */
  dependencyOrder: string[];
  targetProjects: string[];
  /**
   * Per-skill project overrides. Skills assigned to every selected project are
   * omitted (they inherit the release default audience).
   */
  skillTargets: Record<string, string[]>;
  perProject: Record<string, ProjectAssignmentPerProject>;
}

/**
 * Derive release selection + skillTargets from per-project skill checklists.
 * Each project's picks get their own dependency closure so a required dependency
 * is auto-assigned to the same project (preventing audience_gap).
 */
export function resolveProjectAssignment(
  catalog: AssignmentSkill[],
  projects: string[],
  projectSkillPicks: Record<string, string[]>,
): ResolvedProjectAssignment {
  const targetProjects = dedupe(projects);
  const perProject: Record<string, ProjectAssignmentPerProject> = {};
  const assigned = new Map<string, string[]>();

  for (const project of targetProjects) {
    const explicit = dedupe(projectSkillPicks[project] ?? []);
    const resolved = resolveFoundationSkillSelection(catalog, explicit);
    perProject[project] = {
      explicit: resolved.explicitSelectedSkills,
      effective: resolved.effectiveSelectedSkills,
      requiredBy: resolved.requiredBy,
    };

    for (const skill of resolved.effectiveSelectedSkills) {
      const list = assigned.get(skill) ?? [];
      list.push(project);
      assigned.set(skill, list);
    }
  }

  const effectiveSelectedSkills = catalog
    .map((skill) => skill.name)
    .filter((name) => assigned.has(name));

  const global = resolveFoundationSkillSelection(catalog, effectiveSelectedSkills);

  const skillTargets: Record<string, string[]> = {};
  for (const skill of effectiveSelectedSkills) {
    const projectsForSkill = assigned.get(skill) ?? [];
    if (projectsForSkill.length > 0 && projectsForSkill.length < targetProjects.length) {
      skillTargets[skill] = projectsForSkill;
    }
  }

  return {
    effectiveSelectedSkills,
    dependencyOrder: global.dependencyOrder,
    targetProjects,
    skillTargets,
    perProject,
  };
}

/**
 * Invert a stored release (selectedSkills / targetProjects / skillTargets) into
 * per-project explicit picks for the group-by-project editor.
 *
 * Skills without an override inherit every project in `targetProjects`.
 * An empty `skillTargets[skill]` means "all projects" (legacy contract).
 */
export function seedProjectPicksFromRelease(release: {
  selectedSkills?: string[] | null;
  targetProjects?: string[] | null;
  skillTargets?: Record<string, string[]> | null;
}): Record<string, string[]> {
  const selectedSkills = dedupe(release.selectedSkills ?? []);
  const targetProjects = dedupe(release.targetProjects ?? []);
  const skillTargets = release.skillTargets ?? {};

  if (targetProjects.length === 0 || selectedSkills.length === 0) {
    return {};
  }

  const picks: Record<string, string[]> = {};
  for (const project of targetProjects) {
    picks[project] = [];
  }

  for (const skill of selectedSkills) {
    const override = skillTargets[skill];
    const assignedProjects =
      override === undefined
        ? targetProjects
        : override.length === 0
          ? targetProjects
          : override.filter((project) =>
              targetProjects.some((p) => p.toLowerCase() === project.toLowerCase()),
            );

    for (const project of assignedProjects) {
      const key = targetProjects.find((p) => p.toLowerCase() === project.toLowerCase());
      if (!key) continue;
      if (!picks[key].includes(skill)) {
        picks[key].push(skill);
      }
    }
  }

  return picks;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
