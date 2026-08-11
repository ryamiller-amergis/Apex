import type {
  FoundationSkillCatalogEntry,
  FoundationSkillReleaseValidationIssue,
  FoundationSkillReleaseValidationIssueType,
} from './types/foundationSkills';
import { isAlwaysInstallCatalogSkill } from './types/foundationSkills';

type DependencySkill = Pick<FoundationSkillCatalogEntry, 'name'> & {
  dependsOn?: string[];
  summary?: string;
  tier?: string;
  alwaysInstall?: boolean;
};

export interface ResolvedFoundationSkillSelection {
  explicitSelectedSkills: string[];
  effectiveSelectedSkills: string[];
  dependencyOrder: string[];
  requiredBy: Record<string, string[]>;
  unknownDependencies: Array<{ skill: string; dependency: string }>;
  cycles: string[][];
}

export class FoundationSkillReleaseValidationError extends Error {
  readonly code = 'release_validation_failed' as const;
  readonly issues: FoundationSkillReleaseValidationIssue[];
  readonly status?: number;

  constructor(
    issues: FoundationSkillReleaseValidationIssue[],
    message = 'Release validation failed',
    status?: number,
  ) {
    super(message);
    this.name = 'FoundationSkillReleaseValidationError';
    this.issues = issues;
    this.status = status;
  }
}

export function isFoundationSkillReleaseValidationError(
  value: unknown,
): value is FoundationSkillReleaseValidationError {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { code?: unknown }).code === 'release_validation_failed' &&
    Array.isArray((value as { issues?: unknown }).issues),
  );
}

export function resolveFoundationSkillSelection(
  skills: DependencySkill[],
  explicitSelectedSkills: string[],
): ResolvedFoundationSkillSelection {
  const indexByName = new Map(skills.map((skill, index) => [skill.name, index]));
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const explicit = dedupe(explicitSelectedSkills).filter((name) => skillByName.has(name));
  const effective = new Set<string>();
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();
  const unknownDependencies: Array<{ skill: string; dependency: string }> = [];
  const unknownKeys = new Set<string>();

  const visit = (name: string, path: string[]) => {
    if (path.includes(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      const key = cycle.join('>');
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key);
        cycles.push(cycle);
      }
      effective.add(name);
      return;
    }

    const skill = skillByName.get(name);
    if (!skill) return;
    effective.add(name);

    for (const dependency of skill.dependsOn ?? []) {
      if (!skillByName.has(dependency)) {
        const key = `${name}->${dependency}`;
        if (!unknownKeys.has(key)) {
          unknownKeys.add(key);
          unknownDependencies.push({ skill: name, dependency });
        }
        continue;
      }
      visit(dependency, [...path, name]);
    }
  };

  for (const name of explicit) {
    visit(name, []);
  }

  // Always-install skills are part of every release selection, even when omitted
  // from the explicit checklist (draft UI / API cannot drop them).
  for (const skill of skills) {
    if (isAlwaysInstallCatalogSkill(skill)) {
      visit(skill.name, []);
    }
  }

  const effectiveSelectedSkills = skills
    .map((skill) => skill.name)
    .filter((name) => effective.has(name));

  const dependencyOrder = topologicalDependencyOrder(skills, effectiveSelectedSkills);
  const requiredBy = buildRequiredByMap(skills, effectiveSelectedSkills, indexByName);

  return {
    explicitSelectedSkills: explicit,
    effectiveSelectedSkills,
    dependencyOrder,
    requiredBy,
    unknownDependencies,
    cycles,
  };
}

export function filterSkillTargetsToSelection<T extends Record<string, string[]>>(
  skillTargets: T | undefined,
  selectedSkills: string[],
): Record<string, string[]> {
  if (!skillTargets) return {};
  const selected = new Set(selectedSkills);
  return Object.fromEntries(
    Object.entries(skillTargets).filter(([name]) => selected.has(name)),
  );
}

export function collectFoundationSkillValidationIssues(input: {
  skills: DependencySkill[];
  selectedSkills: string[];
  targetProjects?: string[];
  skillTargets?: Record<string, string[]>;
}): FoundationSkillReleaseValidationIssue[] {
  const { skills, selectedSkills } = input;
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const selected = new Set(selectedSkills);
  const issues: FoundationSkillReleaseValidationIssue[] = [];

  for (const skill of skills) {
    if (!selected.has(skill.name)) continue;

    for (const dependency of skill.dependsOn ?? []) {
      if (!selected.has(dependency)) {
        issues.push(buildIssue({
          type: 'missing_dependency',
          dependentSkill: skill.name,
          dependency,
          dependentProjects: effectiveAudience(input.targetProjects, input.skillTargets, skill.name),
          dependencyProjects: [],
        }));
        continue;
      }

      const dependencySkill = skillByName.get(dependency);
      if (!dependencySkill) continue;

      const dependencyProjects = effectiveAudience(
        input.targetProjects,
        input.skillTargets,
        dependencySkill.name,
      );
      const dependentProjects = effectiveAudience(
        input.targetProjects,
        input.skillTargets,
        skill.name,
      );

      if (!audienceContains(dependencyProjects, dependentProjects)) {
        issues.push(buildIssue({
          type: 'audience_gap',
          dependentSkill: skill.name,
          dependency,
          dependentProjects,
          dependencyProjects,
        }));
      }
    }
  }

  return issues;
}

function topologicalDependencyOrder(
  skills: DependencySkill[],
  selectedSkills: string[],
): string[] {
  const selected = new Set(selectedSkills);
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (name: string) => {
    if (!selected.has(name) || visited.has(name)) return;
    if (visiting.has(name)) return;

    visiting.add(name);
    for (const dependency of skillByName.get(name)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  for (const skill of skills) {
    visit(skill.name);
  }

  return order;
}

function buildRequiredByMap(
  skills: DependencySkill[],
  selectedSkills: string[],
  indexByName: Map<string, number>,
): Record<string, string[]> {
  const selected = new Set(selectedSkills);
  const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
  const requiredBy = new Map<string, Set<string>>();

  const collectDependencies = (dependentSkill: string, current: string, seen: Set<string>) => {
    const skill = skillByName.get(current);
    if (!skill) return;

    for (const dependency of skill.dependsOn ?? []) {
      if (!selected.has(dependency) || seen.has(dependency)) continue;
      seen.add(dependency);
      if (!requiredBy.has(dependency)) {
        requiredBy.set(dependency, new Set());
      }
      requiredBy.get(dependency)!.add(dependentSkill);
      collectDependencies(dependentSkill, dependency, seen);
    }
  };

  for (const name of selectedSkills) {
    collectDependencies(name, name, new Set());
  }

  return Object.fromEntries(
    [...requiredBy.entries()]
      .sort(([left], [right]) => compareCatalogOrder(left, right, indexByName))
      .map(([name, dependents]) => [
        name,
        [...dependents].sort((left, right) => compareCatalogOrder(left, right, indexByName)),
      ]),
  );
}

function buildIssue(input: {
  type: FoundationSkillReleaseValidationIssueType;
  dependentSkill: string;
  dependency: string;
  dependentProjects: string[];
  dependencyProjects: string[];
}): FoundationSkillReleaseValidationIssue {
  if (input.type === 'missing_dependency') {
    return {
      ...input,
      message: `Skill "${input.dependentSkill}" requires dependency "${input.dependency}".`,
      remediation: `Add "${input.dependency}" to this release or remove "${input.dependentSkill}".`,
    };
  }

  const missingProjects =
    input.dependencyProjects.length === 0
      ? []
      : input.dependentProjects.filter(
          (project) =>
            !new Set(input.dependencyProjects.map((value) => value.toLowerCase())).has(
              project.toLowerCase(),
            ),
        );

  const dependencyAudience = formatAudience(input.dependencyProjects);
  const dependentAudience = formatAudience(input.dependentProjects);
  const missingText = missingProjects.length > 0 ? missingProjects.join(', ') : dependentAudience;

  return {
    ...input,
    message:
      `Skill "${input.dependentSkill}" targets ${dependentAudience}, but dependency ` +
      `"${input.dependency}" only targets ${dependencyAudience}.`,
    remediation:
      `Expand "${input.dependency}" to cover ${missingText} or narrow ` +
      `"${input.dependentSkill}" to projects already covered by "${input.dependency}".`,
  };
}

function effectiveAudience(
  targetProjects: string[] | undefined,
  skillTargets: Record<string, string[]> | undefined,
  skillName: string,
): string[] {
  return skillTargets?.[skillName] ?? targetProjects ?? [];
}

function audienceContains(container: string[], contained: string[]): boolean {
  if (container.length === 0) return true;
  if (contained.length === 0) return false;
  const allowed = new Set(container.map((project) => project.toLowerCase()));
  return contained.every((project) => allowed.has(project.toLowerCase()));
}

function formatAudience(projects: string[]): string {
  return projects.length === 0 ? 'all projects' : projects.join(', ');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function compareCatalogOrder(
  left: string,
  right: string,
  indexByName: Map<string, number>,
): number {
  return (indexByName.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (indexByName.get(right) ?? Number.MAX_SAFE_INTEGER);
}
