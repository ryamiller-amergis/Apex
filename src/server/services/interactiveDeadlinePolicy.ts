import type {
  InteractiveClass,
  InteractiveDeadlinePolicy,
} from '../../shared/types/durableInteractiveTurn';
import { absoluteTurnMsForClass } from '../../shared/types/durableInteractiveTurn';
import { resolveAgentMcpToolTimeoutMs } from '../mcp/mcpTimeout';
import { resolveAgentFirstEventTimeoutMs } from './agentRunReaperService';

const GROUNDING_PREPARATION_TIMEOUT_MS = 2 * 60 * 1000;

export type EffectiveInteractiveDeadlines = Readonly<{
  repositoryPreparationMs: number | null;
  firstEventMs: number;
  toolCallMs: number;
}>;

type DeadlineResolvers = Readonly<{
  resolveFirstEventMs: () => number;
  resolveToolCallMs: () => number;
  resolveRepositoryPreparationMs: () => number;
}>;

function positiveFiniteInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite integer`);
  }
  return value;
}

export function resolveGroundingPreparationTimeoutMs(): number {
  return GROUNDING_PREPARATION_TIMEOUT_MS;
}

export function resolveInteractiveDeadlinePolicy(
  input: Readonly<{
    interactiveClass: InteractiveClass;
    requiresRepositoryPreparation: boolean;
  }>,
  resolvers: DeadlineResolvers = {
    resolveFirstEventMs: resolveAgentFirstEventTimeoutMs,
    resolveToolCallMs: resolveAgentMcpToolTimeoutMs,
    resolveRepositoryPreparationMs: resolveGroundingPreparationTimeoutMs,
  },
): InteractiveDeadlinePolicy {
  const firstEventMs = positiveFiniteInteger(
    resolvers.resolveFirstEventMs(),
    'firstEventMs',
  );
  const toolCallMs = positiveFiniteInteger(
    resolvers.resolveToolCallMs(),
    'toolCallMs',
  );
  const repositoryPreparationMs = input.requiresRepositoryPreparation
    ? positiveFiniteInteger(
        resolvers.resolveRepositoryPreparationMs(),
        'repositoryPreparationMs',
      )
    : null;

  return {
    absoluteTurnMs: absoluteTurnMsForClass(input.interactiveClass),
    repositoryPreparationMs,
    firstEventMs,
    toolCallMs,
  };
}

export function clampInteractiveDeadlinePolicy(
  policy: InteractiveDeadlinePolicy,
  remainingAbsoluteMs: number,
): EffectiveInteractiveDeadlines {
  const remaining = positiveFiniteInteger(
    remainingAbsoluteMs,
    'remainingAbsoluteMs',
  );
  return {
    repositoryPreparationMs:
      policy.repositoryPreparationMs === null
        ? null
        : Math.min(
            positiveFiniteInteger(
              policy.repositoryPreparationMs,
              'repositoryPreparationMs',
            ),
            remaining,
          ),
    firstEventMs: Math.min(
      positiveFiniteInteger(policy.firstEventMs, 'firstEventMs'),
      remaining,
    ),
    toolCallMs: Math.min(
      positiveFiniteInteger(policy.toolCallMs, 'toolCallMs'),
      remaining,
    ),
  };
}
