/**
 * Turns an author goal into one registry step, or a written gap.
 * An unknown step type is refused and is not written into the draft.
 */
import { getStepTypeDescriptor, isRegisteredStepType } from './playbookSteps/registry';
import type { PlaybookGraph, PlaybookGraphNode } from '../../shared/types/playbook';

export class PlaybookRecommendationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookRecommendationError';
  }
}

export interface PlaybookRecommendation {
  kind: 'suggestion';
  stepType: string;
  config: Record<string, unknown>;
  reason: string;
}

export interface PlaybookRecommendationGap {
  kind: 'gap';
  reason: string;
}

const SUGGESTIONS: Array<{
  pattern: RegExp;
  stepType: string;
  config: Record<string, unknown>;
  reason: string;
}> = [
  {
    pattern: /cloud agent|cloud-agent/i,
    stepType: 'cloud-agent',
    config: { workItemId: 1, workItemType: 'Product Backlog Item', state: 'New' },
    reason: 'A cloud-agent step starts the existing Cloud Agent for one work item.',
  },
  {
    pattern: /ado comment|work item comment/i,
    stepType: 'apex-action',
    config: { operation: 'post-ado-comment', parameters: { workItemId: 1, text: 'Update from the Playbook.' } },
    reason: 'An apex-action posts the comment through Azure DevOps.',
  },
  {
    pattern: /create ado|ado items|backlog items/i,
    stepType: 'apex-action',
    config: {
      operation: 'create-ado-items',
      parameters: { epic: { id: 'epic-1', title: 'Epic' }, features: [], pbis: [] },
    },
    reason: 'An apex-action creates the work items through Azure DevOps.',
  },
  {
    pattern: /approve (the )?(design doc|prd|document)/i,
    stepType: 'apex-action',
    config: {
      operation: 'set-document-status',
      parameters: { documentType: 'design_doc', documentId: 'document-id', status: 'approved' },
    },
    reason: 'An apex-action sets the document status through the existing review service.',
  },
  {
    pattern: /notify|tell|message/i,
    stepType: 'notify',
    config: { title: 'Playbook update' },
    reason: 'A notify step writes the notification.',
  },
];

export function recommendPlaybookStep(goal: string): PlaybookRecommendation | PlaybookRecommendationGap {
  const match = SUGGESTIONS.find((candidate) => candidate.pattern.test(goal));
  if (!match) {
    return {
      kind: 'gap',
      reason: 'No registered step type fits that goal. Add the step from the library or narrow the goal.',
    };
  }
  return {
    kind: 'suggestion',
    stepType: match.stepType,
    config: match.config,
    reason: match.reason,
  };
}

export function parsePlaybookRecommendation(raw: unknown): PlaybookRecommendation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlaybookRecommendationError('A suggestion must name a registered step type.');
  }
  const body = raw as { stepType?: unknown; config?: unknown; reason?: unknown };
  if (typeof body.stepType !== 'string' || !isRegisteredStepType(body.stepType)) {
    throw new PlaybookRecommendationError(
      `Unknown step type "${String(body.stepType)}". A suggestion can only use a registered type.`,
    );
  }
  const descriptor = getStepTypeDescriptor(body.stepType);
  const parsed = descriptor.inputSchema.safeParse(body.config ?? {});
  if (!parsed.success) {
    throw new PlaybookRecommendationError(
      parsed.error.issues[0]?.message ?? 'The suggested config does not match the step type.',
    );
  }
  return {
    kind: 'suggestion',
    stepType: body.stepType,
    config: parsed.data as Record<string, unknown>,
    reason: typeof body.reason === 'string' ? body.reason : 'Suggested from the registry.',
  };
}

export function acceptPlaybookRecommendation(
  graph: PlaybookGraph,
  raw: unknown,
): PlaybookGraph {
  const suggestion = parsePlaybookRecommendation(raw);
  const id = `suggested-${suggestion.stepType}-${graph.nodes.length + 1}`;
  const node: PlaybookGraphNode = {
    id,
    stepType: suggestion.stepType,
    config: suggestion.config,
  };
  return { ...graph, nodes: [...graph.nodes, node], edges: [...graph.edges] };
}
