import { z } from 'zod';
import type {
  PlaybookBranchCondition,
  PlaybookGraph,
  PlaybookGraphNode,
} from '../../../shared/types/playbook';
import { getStepTypeDescriptor } from './registry';

export class PlaybookBranchConditionError extends Error {
  constructor(nodeId: string, sourceStepId: string, field: string, reason: string) {
    super(
      `Branch step "${nodeId}" cannot use "${sourceStepId}.${field}": ${reason}.`
    );
    this.name = 'PlaybookBranchConditionError';
  }
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = (current._def as unknown as { innerType: z.ZodTypeAny }).innerType;
  }
  return current;
}

function schemaAtPath(schema: z.ZodTypeAny, field: string): z.ZodTypeAny | undefined {
  let current = unwrap(schema);
  for (const segment of field.split('.')) {
    if (!(current instanceof z.ZodObject)) return undefined;
    const shape = current.shape as Record<string, z.ZodTypeAny>;
    const next = shape[segment];
    if (!next) return undefined;
    current = unwrap(next);
  }
  return current;
}

function canReach(graph: PlaybookGraph, from: string, to: string): boolean {
  const pending = [from];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...graph.edges.filter((edge) => edge.from === id).map((edge) => edge.to));
  }
  return false;
}

export function validateBranchCondition(graph: PlaybookGraph, node: PlaybookGraphNode): void {
  const parsed = getStepTypeDescriptor('branch').inputSchema.parse(node.config ?? {}) as {
    condition: PlaybookBranchCondition;
    whenTrue: string;
    whenFalse: string;
  };
  const { sourceStepId, field } = parsed.condition;
  const source = graph.nodes.find((candidate) => candidate.id === sourceStepId);
  if (!source) {
    throw new PlaybookBranchConditionError(node.id, sourceStepId, field, 'the source step is absent');
  }
  if (source.id === node.id || !canReach(graph, source.id, node.id)) {
    throw new PlaybookBranchConditionError(
      node.id,
      sourceStepId,
      field,
      'the source is not a prior step',
    );
  }
  const fieldSchema = schemaAtPath(getStepTypeDescriptor(source.stepType).outputSchema, field);
  if (!fieldSchema) {
    throw new PlaybookBranchConditionError(
      node.id,
      sourceStepId,
      field,
      'the field is not declared by the source output schema',
    );
  }
  const { operator, value } = parsed.condition;
  const orderedComparison = ['gt', 'gte', 'lt', 'lte'].includes(operator);
  const compatible = operator === 'in'
    ? Array.isArray(value) && value.every((candidate) => fieldSchema.safeParse(candidate).success)
    : orderedComparison
      ? fieldSchema instanceof z.ZodNumber && typeof value === 'number'
      : fieldSchema.safeParse(value).success;
  if (!compatible) {
    throw new PlaybookBranchConditionError(
      node.id,
      sourceStepId,
      field,
      `operator "${operator}" and its comparison value are incompatible with the declared field`,
    );
  }

  const continuations = graph.edges
    .filter((edge) => edge.from === node.id)
    .map((edge) => edge.condition);
  if (
    continuations.length !== 2
    || new Set(continuations).size !== 2
    || parsed.whenTrue === parsed.whenFalse
  ) {
    throw new PlaybookBranchConditionError(
      node.id,
      sourceStepId,
      field,
      'a branch must have two distinct named continuations',
    );
  }
  for (const name of [parsed.whenTrue, parsed.whenFalse]) {
    if (!continuations.includes(name)) {
      throw new PlaybookBranchConditionError(
        node.id,
        sourceStepId,
        field,
        `named continuation "${name}" is not an outbound edge`,
      );
    }
  }
}

function valueAtPath(value: unknown, field: string): unknown {
  return field.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

export function evaluateBranchCondition(
  condition: PlaybookBranchCondition,
  outputs: Record<string, Record<string, unknown>>,
): boolean {
  const actual = valueAtPath(outputs[condition.sourceStepId], condition.field);
  switch (condition.operator) {
    case 'eq': return Object.is(actual, condition.value);
    case 'neq': return !Object.is(actual, condition.value);
    case 'in': return Array.isArray(condition.value) && condition.value.some((value) => Object.is(value, actual));
    case 'gt': return typeof actual === 'number' && typeof condition.value === 'number' && actual > condition.value;
    case 'gte': return typeof actual === 'number' && typeof condition.value === 'number' && actual >= condition.value;
    case 'lt': return typeof actual === 'number' && typeof condition.value === 'number' && actual < condition.value;
    case 'lte': return typeof actual === 'number' && typeof condition.value === 'number' && actual <= condition.value;
  }
}
