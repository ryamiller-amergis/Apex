/**
 * Turns explicitly selected AI step outputs into the choices a person reviews.
 *
 * A Playbook author names the source steps. This does not walk the graph to discover agents.
 */
import { parseAtsBoardSynopsis, plainLeadershipCopy } from './atsBoard';

export const FEEDBACK_REVIEW_ACTIONS = [
  'accept',
  'question',
  'override',
  'reject',
  'defer',
] as const;

export type FeedbackReviewAction = (typeof FEEDBACK_REVIEW_ACTIONS)[number];

export const FEEDBACK_REVIEW_ACTION_LABELS: Record<FeedbackReviewAction, string> = {
  accept: 'Accept',
  question: 'Ask a question',
  override: 'Override',
  reject: 'Reject',
  defer: 'Decide later',
};

export interface FeedbackReviewPrompt {
  sourceStepId: string;
  itemId: string;
  title: string;
  detail: string;
  recommendation: string | null;
}

export interface FeedbackReviewItem {
  sourceStepId: string;
  itemId: string;
  action: FeedbackReviewAction;
  note?: string;
}

const NOTE_REQUIRED = new Set<FeedbackReviewAction>(['question', 'override', 'reject']);

export function feedbackItemKey(item: Pick<FeedbackReviewItem, 'sourceStepId' | 'itemId'>): string {
  return `${item.sourceStepId}:${item.itemId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function plainExcerpt(text: string): string {
  const withoutFence = text.replace(/```[\s\S]*?```/g, ' ');
  const sentence = withoutFence
    .replace(/[#>*_`[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sentence) return 'This step finished.';
  return sentence.length > 280 ? `${sentence.slice(0, 279)}…` : sentence;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function promptsFromBrief(
  stepId: string,
  brief: Record<string, unknown>
): FeedbackReviewPrompt[] {
  const exceptions = Array.isArray(brief.materialExceptions)
    ? brief.materialExceptions.flatMap((entry) => {
        const exception = asRecord(entry);
        if (!exception || typeof exception.id !== 'string') return [];
        return [
          {
            id: exception.id.trim(),
            title: typeof exception.title === 'string' ? exception.title : '',
          },
        ];
      })
    : [];
  const say = (text: string) => plainLeadershipCopy(text, exceptions);
  const prompts: FeedbackReviewPrompt[] = stringList(brief.aiDecisions).map((decision, index) => ({
    sourceStepId: stepId,
    itemId: `decision-${index + 1}`,
    title: `Decision ${index + 1}`,
    detail: say(decision.trim()),
    recommendation: null,
  }));
  if (!Array.isArray(brief.materialExceptions)) return prompts;
  for (const entry of brief.materialExceptions) {
    const exception = asRecord(entry);
    if (!exception) continue;
    const itemId = typeof exception.id === 'string' ? exception.id.trim() : '';
    const title = typeof exception.title === 'string' ? exception.title.trim() : '';
    const detail = typeof exception.question === 'string' ? exception.question.trim() : '';
    const recommendation =
      typeof exception.recommendedResolution === 'string'
        ? exception.recommendedResolution.trim()
        : '';
    if (!itemId || !detail) continue;
    prompts.push({
      sourceStepId: stepId,
      itemId,
      title: say(title) || decisionDisplayFallback(itemId),
      detail: say(detail),
      recommendation: recommendation ? say(recommendation) : null,
    });
  }
  return prompts;
}

function decisionDisplayFallback(id: string): string {
  return plainLeadershipCopy(id, [{ id, title: '' }]);
}

function promptsFromSynopsis(
  stepId: string,
  output: Record<string, unknown>
): FeedbackReviewPrompt[] {
  const synopsis = parseAtsBoardSynopsis(output);
  const parsedBrief = synopsis?.leadershipBrief;
  if (parsedBrief) {
    const prompts = promptsFromBrief(stepId, {
      aiDecisions: parsedBrief.aiDecisions,
      materialExceptions: parsedBrief.materialExceptions,
    });
    if (prompts.length > 0) return prompts;
  }
  const scorecard = asRecord(output.scorecard) ?? output;
  const brief = asRecord(scorecard.leadershipBrief);
  if (brief) {
    const prompts = promptsFromBrief(stepId, brief);
    if (prompts.length > 0) return prompts;
  }
  const recommendation = synopsis?.recommendation?.trim();
  if (recommendation) {
    return [
      {
        sourceStepId: stepId,
        itemId: 'recommendation',
        title: 'Recommendation',
        detail: recommendation,
        recommendation: null,
      },
    ];
  }
  return [];
}

/** One card per leadership decision when the output has one, otherwise one card for the step. */
export function promptsForSourceStep(stepId: string, output: unknown): FeedbackReviewPrompt[] {
  const record = asRecord(output);
  const fromSynopsis = record ? promptsFromSynopsis(stepId, record) : [];
  if (fromSynopsis.length > 0) return fromSynopsis.slice(0, 12);
  const report = typeof record?.reportMd === 'string' ? record.reportMd : '';
  return [
    {
      sourceStepId: stepId,
      itemId: 'outcome',
      title: stepId.replace(/-/g, ' '),
      detail: plainExcerpt(report),
      recommendation: null,
    },
  ];
}

export function promptsForSources(
  sources: ReadonlyArray<{ stepId: string; output: unknown }>
): FeedbackReviewPrompt[] {
  return sources.flatMap((source) => promptsForSourceStep(source.stepId, source.output)).slice(0, 20);
}

export function noteRequired(action: FeedbackReviewAction): boolean {
  return NOTE_REQUIRED.has(action);
}

export function feedbackDecision(input: {
  stopped: boolean;
  items: readonly FeedbackReviewItem[];
}): 'accepted' | 'needs_changes' | 'rejected' {
  if (input.stopped) return 'rejected';
  const needsChange = input.items.some(
    (item) => item.action === 'question' || item.action === 'override' || item.action === 'reject'
  );
  return needsChange ? 'needs_changes' : 'accepted';
}

export function revisionBrief(input: {
  decision: 'accepted' | 'needs_changes' | 'rejected';
  items: readonly FeedbackReviewItem[];
  prompts: readonly FeedbackReviewPrompt[];
}): string {
  const titles = new Map(input.prompts.map((prompt) => [feedbackItemKey(prompt), prompt.title]));
  const lines = input.items
    .filter((item) => item.action !== 'accept')
    .map((item) => {
      const title = titles.get(feedbackItemKey(item)) ?? item.itemId;
      const action = FEEDBACK_REVIEW_ACTION_LABELS[item.action];
      const note = item.note?.trim();
      return note ? `${title}: ${action}. ${note}` : `${title}: ${action}.`;
    });
  if (input.decision === 'rejected') {
    return ['Leadership stopped this outcome.', ...lines].join('\n');
  }
  if (input.decision === 'accepted') {
    return lines.length > 0
      ? ['Leadership accepted the plan, with these notes.', ...lines].join('\n')
      : 'Leadership accepted the current plan. Keep the same decisions.';
  }
  return ['Leadership asked for these changes.', ...lines].join('\n');
}
