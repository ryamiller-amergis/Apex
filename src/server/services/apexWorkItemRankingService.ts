import { extractJsonArray, invokeBedrockText } from './bedrockService';
import type {
  AcceptanceCriterion,
  ApexWorkItemPriority,
  ApexWorkItemStatus,
  ApexWorkItemType,
} from '../../shared/types/apexWorkItem';

export interface RankableApexWorkItem {
  id: string;
  itemNumber: number;
  title: string;
  outcome: string;
  type: ApexWorkItemType;
  status: ApexWorkItemStatus;
  dueDate: string | null;
  releaseName: string | null;
  releaseTargetDate: string | null;
  epicTitle: string | null;
  featureTitle: string | null;
  acceptanceCriteria: AcceptanceCriterion[];
}

export interface ApexWorkItemRanking {
  id: string;
  priority: ApexWorkItemPriority;
  rationale: string;
}

const PRIORITIES = new Set<ApexWorkItemPriority>(['critical', 'high', 'medium', 'low']);

export function parseApexWorkItemRankings(
  text: string,
  expectedIds: readonly string[],
): ApexWorkItemRanking[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(text, 'apex work item ranking'));
  } catch {
    throw new Error('AI ranking response was not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('AI ranking response must be a JSON array');
  if (parsed.length !== expectedIds.length) {
    throw new Error('AI ranking response did not include every filtered work item');
  }

  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  return parsed.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('AI ranking entry must be an object');
    const entry = value as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const priority = typeof entry.priority === 'string'
      ? entry.priority.toLowerCase() as ApexWorkItemPriority
      : '' as ApexWorkItemPriority;
    const rationale = typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
    if (!expected.has(id)) throw new Error(`AI ranking returned unknown work item ${id || '(missing id)'}`);
    if (seen.has(id)) throw new Error(`AI ranking returned duplicate work item ${id}`);
    if (!PRIORITIES.has(priority)) throw new Error(`AI ranking returned invalid priority for ${id}`);
    if (!rationale || rationale.length > 1000) throw new Error(`AI ranking returned invalid rationale for ${id}`);
    seen.add(id);
    return { id, priority, rationale };
  });
}

export async function generateApexWorkItemRankings(
  project: string,
  actorId: string,
  items: RankableApexWorkItem[],
): Promise<ApexWorkItemRanking[]> {
  const prompt = [
    'Rank the complete backlog below from most urgent/valuable to least.',
    'Return ONLY a JSON array in exact rank order, with no prose and no markdown code fences.',
    'Include every input id exactly once.',
    'Each entry must be {"id":"...","priority":"critical|high|medium|low","rationale":"one concise sentence"}.',
    'Use critical sparingly. Consider delivery impact, urgency, dependencies, release/due dates, hierarchy, status, outcome, and acceptance criteria.',
    '',
    JSON.stringify(items),
  ].join('\n');
  const text = await invokeBedrockText(
    prompt,
    { feature: 'other', project, entityType: 'apex-work-item-ranking', userId: actorId },
    { maxTokens: Math.max(4096, Math.min(16000, items.length * 140)) },
  );
  return parseApexWorkItemRankings(text, items.map((item) => item.id));
}
