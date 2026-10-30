/**
 * Turns an author goal into registry steps, in the order the goal mentions them, or a written gap.
 * An unknown step type is refused and is not written into the draft.
 */
import {
  getStepTypeDescriptor,
  isRegisteredStepType,
} from './playbookSteps/registry';
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

export interface PlaybookStepSuggestion {
  stepType: string;
  title: string;
  config: Record<string, unknown>;
  reason: string;
}

export interface PlaybookRecommendationPlan {
  kind: 'suggestions';
  reason: string;
  suggestions: PlaybookStepSuggestion[];
}

export interface PlaybookRecommendationGap {
  kind: 'gap';
  reason: string;
}

const READ_ONLY_PROFILE = 'repository-read-only';

function agentSkill(goal: string): string {
  if (/incident|outage|production|error|exception|self[- ]?heal/i.test(goal)) {
    return 'playbook-skills/maxview-incident-investigation/SKILL.md';
  }
  if (/design doc|design document|tech spec/i.test(goal)) {
    return '.cursor/skills/design-doc-validation/SKILL.md';
  }
  return '.cursor/skills/app-knowledge/SKILL.md';
}

const SUGGESTIONS: Array<{
  pattern: RegExp;
  build: (goal: string) => PlaybookStepSuggestion;
}> = [
  {
    pattern: /investigat|analy[sz]|research|scan|summari[sz]|audit|look into|check|find|review the code|triage/i,
    build: (goal) => ({
      stepType: 'cursor-agent',
      title: 'Agent task',
      config: { skillPath: agentSkill(goal), prompt: goal.trim(), mcpProfile: READ_ONLY_PROFILE },
      reason: 'A read-only agent investigates and writes a report later steps can use.',
    }),
  },
  {
    pattern: /approv(e|al)(?! (the )?(design doc|prd|document))|sign[- ]off|human review|ask (a person|someone)/i,
    build: () => ({
      stepType: 'approval-gate',
      title: 'Approval',
      config: { subject: 'Approve before the Playbook continues' },
      reason: 'The run pauses until the person who started it approves.',
    }),
  },
  {
    pattern: /approve (the )?(design doc|prd|document)/i,
    build: () => ({
      stepType: 'apex-action',
      title: 'Approve a document',
      config: {
        operation: 'set-document-status',
        parameters: { documentType: 'design_doc', documentId: '${input.documentId}', status: 'approved' },
      },
      reason: 'An Apex action sets the document status through the existing review service.',
    }),
  },
  {
    pattern: /create ado|ado items|backlog items/i,
    build: () => ({
      stepType: 'apex-action',
      title: 'Create backlog items',
      config: {
        operation: 'create-ado-items',
        parameters: { epic: { id: 'epic-1', title: 'Epic' }, features: [], pbis: [] },
      },
      reason: 'An Apex action creates the work items in Azure DevOps.',
    }),
  },
  {
    pattern: /\b(file|open|create|log|raise)\b.*\b(bug|work item|ticket|issue)\b|\b(bug|ticket)\b/i,
    build: (goal) => ({
      stepType: 'apex-action',
      title: 'Create a work item',
      config: {
        operation: 'create-work-item',
        parameters: {
          workItemType: /\bbug\b/i.test(goal) ? 'Bug' : 'Product Backlog Item',
          title: 'Playbook finding',
          description: goal.trim(),
        },
      },
      reason: 'An Apex action files the work item in Azure DevOps and passes its id on.',
    }),
  },
  {
    pattern: /ado comment|work item comment|comment on/i,
    build: () => ({
      stepType: 'apex-action',
      title: 'Comment on a work item',
      config: {
        operation: 'post-ado-comment',
        parameters: { workItemId: '${input.workItemId}', text: 'Update from the Playbook.' },
      },
      reason: 'An Apex action posts the comment through Azure DevOps.',
    }),
  },
  {
    pattern: /cloud agent|cloud-agent|\bfix\b|implement|pull request|\bpr\b|write the code|patch/i,
    build: () => ({
      stepType: 'cloud-agent',
      title: 'Cloud agent',
      config: {},
      reason: 'The Cloud Agent works the work item from the step before it and opens a pull request.',
    }),
  },
  {
    pattern: /notify|tell|message|alert|let (me|the team) know|teams/i,
    build: () => ({
      stepType: 'notify',
      title: 'Notify',
      config: { title: 'Playbook update' },
      reason: 'A notify step tells whoever started the run.',
    }),
  },
];

function leavesApex(suggestion: PlaybookStepSuggestion): boolean {
  if (suggestion.stepType === 'cursor-agent' && suggestion.config.mcpProfile === READ_ONLY_PROFILE) {
    return false;
  }
  return getStepTypeDescriptor(suggestion.stepType).sideEffect === 'leaves-apex';
}

export function recommendPlaybookSteps(
  goal: string,
): PlaybookRecommendationPlan | PlaybookRecommendationGap {
  const matched = SUGGESTIONS
    .map((candidate) => ({ candidate, index: goal.search(candidate.pattern) }))
    .filter((entry) => entry.index !== -1)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.candidate.build(goal));
  if (!matched.length) {
    return {
      kind: 'gap',
      reason: 'No step fits that goal yet. Try naming what should happen, such as "investigate", "file a bug", "fix it", or "notify me".',
    };
  }

  const suggestions: PlaybookStepSuggestion[] = [];
  let gated = false;
  for (const suggestion of matched) {
    if (suggestion.stepType === 'approval-gate') gated = true;
    if (!gated && leavesApex(suggestion)) {
      suggestions.push({
        stepType: 'approval-gate',
        title: 'Approval',
        config: { subject: `Approve before: ${suggestion.title}` },
        reason: `${suggestion.title} acts outside Apex, so a person approves it first.`,
      });
      gated = true;
    }
    suggestions.push(suggestion);
  }
  return {
    kind: 'suggestions',
    reason: suggestions.length === 1
      ? 'One step fits that goal.'
      : `${suggestions.length} steps, in the order your goal describes them.`,
    suggestions,
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
