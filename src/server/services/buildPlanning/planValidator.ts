/**
 * Pure build-plan checks. No database and no clock.
 * Shape failures come from the shared schema. Meaning (cycles, files, coverage) is checked here.
 */
import type { BuildPlan, PlanValidationResult, PlanViolation } from '../../../shared/buildPlanSchema';
import {
  BUILD_PLAN_VIOLATION_CODES,
  buildPlanIssueCode,
  buildPlanSchema,
} from '../../../shared/buildPlanSchema';
import type { z } from 'zod';
import type { BuildRequirement, BuildRiskDecision } from '../../../shared/types/build';

const RESERVED_TASK_KEY = 'planner';

export interface ValidateBuildPlanInput {
  plan: unknown;
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
  coverageScope?: {
    requirementIds?: string[];
    riskDecisionIds?: string[];
  };
}

export function validateBuildPlan(input: ValidateBuildPlanInput): PlanValidationResult {
  const parsed = buildPlanSchema.safeParse(input.plan);
  if (!parsed.success) {
    return { ok: false, violations: schemaViolations(input.plan, parsed.error) };
  }
  const violations = semanticViolations(parsed.data, input);
  if (violations.length === 0) return { ok: true };
  return { ok: false, violations: sortViolations(violations) };
}

function schemaViolations(plan: unknown, error: z.ZodError): PlanViolation[] {
  const seen = new Set<string>();
  const violations: PlanViolation[] = [];
  for (const issue of error.issues) {
    const taskKey = taskKeyAt(plan, issue.path);
    const issueCode = buildPlanIssueCode(issue) ?? 'invalid_value';
    const key = `${issueCode}:${taskKey ?? issue.path.join('.')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push(schemaViolation(issueCode, taskKey, issue.path));
  }
  if (violations.length === 0) violations.push(schemaViolation('invalid_value', undefined, []));
  return sortViolations(violations);
}

function schemaViolation(
  code: PlanViolation['code'],
  taskKey: string | undefined,
  path: readonly PropertyKey[],
): PlanViolation {
  const taskKeys = taskKey ? [taskKey] : undefined;
  switch (code) {
    case 'empty_reuse':
      return {
        code,
        taskKeys,
        message: taskKey
          ? `Task ${taskKey} names no reuse and no justification`
          : 'A task names no reuse and no justification',
      };
    case 'unknown_property':
      return { code, taskKeys, message: 'The plan has a property the schema does not allow' };
    case 'missing_field':
      return { code, taskKeys, message: 'The plan is missing a required field' };
    case 'invalid_value':
      return {
        code,
        taskKeys,
        path: path.map(String).join('.'),
        message: 'A plan value is not valid',
      };
    case 'cycle':
    case 'duplicate_task_key':
    case 'unknown_blocker':
    case 'overlapping_owned_file':
    case 'uncovered_requirement':
    case 'uncovered_risk_decision':
      return { code, taskKeys, message: 'The plan does not match the build-plan schema' };
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function semanticViolations(plan: BuildPlan, input: ValidateBuildPlanInput): PlanViolation[] {
  const violations: PlanViolation[] = [];
  const knownKeys = new Set(plan.tasks.map((task) => task.key));
  const carried = new Set(plan.delta?.carriedOverTaskKeys ?? []);

  const keyCounts = new Map<string, number>();
  for (const task of plan.tasks) keyCounts.set(task.key, (keyCounts.get(task.key) ?? 0) + 1);
  for (const [key, count] of keyCounts) {
    if (count > 1) {
      violations.push({
        code: 'duplicate_task_key',
        taskKeys: [key],
        message: `Task key ${key} is used more than once`,
      });
    }
    if (key === RESERVED_TASK_KEY) {
      violations.push({
        code: 'invalid_value',
        taskKeys: [key],
        message: 'Task key planner is reserved',
      });
    }
  }

  for (const task of plan.tasks) {
    for (const blocker of task.blockers) {
      if (!knownKeys.has(blocker) && !carried.has(blocker)) {
        violations.push({
          code: 'unknown_blocker',
          taskKeys: [task.key, blocker].sort(),
          message: `Task ${task.key} blocks on ${blocker}, which is not in the plan`,
        });
      }
    }
  }

  for (const component of cycleComponents(plan.tasks)) {
    const taskKeys = [...component].sort();
    violations.push({
      code: 'cycle',
      taskKeys,
      message: `Tasks block each other in a loop: ${taskKeys.join(' and ')}`,
    });
  }

  const owners = new Map<string, string[]>();
  for (const task of plan.tasks) {
    for (const file of task.ownedFiles) {
      const path = normalizeOwnedPath(file);
      const list = owners.get(path) ?? [];
      list.push(task.key);
      owners.set(path, list);
    }
  }
  for (const [path, keys] of owners) {
    const unique = [...new Set(keys)].sort();
    if (unique.length > 1) {
      violations.push({
        code: 'overlapping_owned_file',
        path,
        taskKeys: unique,
        message: `Two tasks both own \`${path}\`: ${unique.join(' and ')}`,
      });
    }
  }

  const requirementIds = new Set(input.requirements.map((row) => row.id));
  const riskIds = new Set(input.riskDecisions.map((row) => row.id));
  const tested = new Set(plan.tests.map((row) => row.subjectId));

  for (const subjectId of tested) {
    if (requirementIds.has(subjectId) || riskIds.has(subjectId)) continue;
    if (subjectId.startsWith('RD-')) {
      violations.push({
        code: 'invalid_value',
        riskDecisionId: subjectId,
        message: `Risk decision ${subjectId} is not on this revision`,
      });
    } else {
      violations.push({
        code: 'invalid_value',
        requirementId: subjectId,
        message: `Requirement ${subjectId} is not on this revision`,
      });
    }
  }

  const requirementScope = input.coverageScope?.requirementIds
    ? new Set(input.coverageScope.requirementIds)
    : null;
  const riskScope = input.coverageScope?.riskDecisionIds
    ? new Set(input.coverageScope.riskDecisionIds)
    : null;

  for (const requirement of input.requirements) {
    if (requirement.retired) continue;
    if (requirementScope && !requirementScope.has(requirement.id)) continue;
    if (!tested.has(requirement.id)) {
      violations.push({
        code: 'uncovered_requirement',
        requirementId: requirement.id,
        message: `Requirement ${requirement.id} has no test`,
      });
    }
  }
  for (const risk of input.riskDecisions) {
    if (riskScope && !riskScope.has(risk.id)) continue;
    if (!tested.has(risk.id)) {
      violations.push({
        code: 'uncovered_risk_decision',
        riskDecisionId: risk.id,
        message: `Risk decision ${risk.id} has no test`,
      });
    }
  }

  return violations;
}

export function normalizeOwnedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

function cycleComponents(tasks: BuildPlan['tasks']): string[][] {
  const nodes = [...new Set(tasks.map((task) => task.key))];
  const edges = new Map<string, string[]>();
  const self = new Set<string>();
  for (const task of tasks) {
    const next = edges.get(task.key) ?? [];
    for (const blocker of task.blockers) {
      if (blocker === task.key) self.add(task.key);
      else if (nodes.includes(blocker)) next.push(blocker);
    }
    edges.set(task.key, next);
  }

  const components = tarjan(nodes, edges).filter((component) => component.length > 1);
  for (const key of self) {
    if (!components.some((component) => component.includes(key))) components.push([key]);
  }
  return components;
}

function tarjan(nodes: string[], edges: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const components: string[][] = [];
  type Frame = { node: string; next: number };
  for (const start of nodes) {
    if (indices.has(start)) continue;
    const frames: Frame[] = [{ node: start, next: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const node = frame.node;
      if (!indices.has(node)) {
        indices.set(node, index);
        low.set(node, index);
        index += 1;
        stack.push(node);
        onStack.add(node);
      }
      const neighbors = edges.get(node) ?? [];
      if (frame.next < neighbors.length) {
        const next = neighbors[frame.next];
        frame.next += 1;
        if (!indices.has(next)) {
          frames.push({ node: next, next: 0 });
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node) ?? index, indices.get(next) ?? index));
        }
      } else {
        frames.pop();
        if (low.get(node) === indices.get(node)) {
          const component: string[] = [];
          let popped = '';
          do {
            popped = stack.pop() ?? '';
            onStack.delete(popped);
            component.push(popped);
          } while (popped !== node);
          components.push(component);
        }
        const parent = frames[frames.length - 1];
        if (parent) {
          const parentLow = low.get(parent.node) ?? index;
          const childLow = low.get(node) ?? index;
          low.set(parent.node, Math.min(parentLow, childLow));
        }
      }
    }
  }
  return components;
}

function taskKeyAt(plan: unknown, path: readonly PropertyKey[]): string | undefined {
  const tasksIndex = path.indexOf('tasks');
  if (tasksIndex < 0 || typeof path[tasksIndex + 1] !== 'number') return undefined;
  if (!plan || typeof plan !== 'object' || !('tasks' in plan)) return undefined;
  const tasks = (plan as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return undefined;
  const task = tasks[path[tasksIndex + 1] as number];
  if (!task || typeof task !== 'object' || !('key' in task)) return undefined;
  return typeof task.key === 'string' ? task.key : undefined;
}

function sortViolations(violations: PlanViolation[]): PlanViolation[] {
  const order = new Map(BUILD_PLAN_VIOLATION_CODES.map((code, index) => [code, index]));
  return [...violations].sort((left, right) => {
    const byCode = (order.get(left.code) ?? 0) - (order.get(right.code) ?? 0);
    if (byCode !== 0) return byCode;
    return sortKey(left).localeCompare(sortKey(right));
  });
}

function sortKey(violation: PlanViolation): string {
  return violation.taskKeys?.[0]
    ?? violation.requirementId
    ?? violation.riskDecisionId
    ?? violation.path
    ?? violation.message;
}
