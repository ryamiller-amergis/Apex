import { extractJsonArray, invokeBedrockText } from './bedrockService';
import type {
  FeatureRequestPriority,
  FeatureRequestRisk,
  FeatureRequestStatus,
  WorkItemType,
} from '../../shared/types/featureRequest';

export interface RankableFeatureRequest {
  id: string;
  type: WorkItemType;
  title: string;
  request: string;
  advantage: string | null;
  status: FeatureRequestStatus;
  aiPriority: FeatureRequestPriority | null;
  aiRisk: FeatureRequestRisk | null;
  teamPriority: FeatureRequestPriority | null;
  teamRisk: FeatureRequestRisk | null;
}

export interface FeatureRequestRanking {
  id: string;
  priority: FeatureRequestPriority;
  rationale: string;
}

const PRIORITIES = new Set<FeatureRequestPriority>([
  'critical',
  'high',
  'medium',
  'low',
]);

export function parseFeatureRequestRankings(
  text: string,
  expectedIds: readonly string[],
): FeatureRequestRanking[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(text, 'feature request ranking'));
  } catch {
    throw new Error('AI ranking response was not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('AI ranking response must be a JSON array');
  }
  if (parsed.length !== expectedIds.length) {
    throw new Error('AI ranking response did not include every filtered item');
  }

  const expected = new Set(expectedIds);
  const seen = new Set<string>();
  return parsed.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('AI ranking entry must be an object');
    }
    const entry = value as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const priority =
      typeof entry.priority === 'string'
        ? (entry.priority.toLowerCase() as FeatureRequestPriority)
        : ('' as FeatureRequestPriority);
    const rationale =
      typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
    if (!expected.has(id)) {
      throw new Error(
        `AI ranking returned unknown feature request ${id || '(missing id)'}`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`AI ranking returned duplicate feature request ${id}`);
    }
    if (!PRIORITIES.has(priority)) {
      throw new Error(`AI ranking returned invalid priority for ${id}`);
    }
    if (!rationale || rationale.length > 1000) {
      throw new Error(`AI ranking returned invalid rationale for ${id}`);
    }
    seen.add(id);
    return { id, priority, rationale };
  });
}

export async function generateFeatureRequestRankings(
  project: string,
  actorId: string,
  items: RankableFeatureRequest[],
): Promise<FeatureRequestRanking[]> {
  const prompt = [
    'Rank the complete filtered Apex Backlog below from most urgent and valuable to least.',
    'Return ONLY a JSON array in exact rank order, with no prose and no markdown code fences.',
    'Include every input id exactly once.',
    'Each entry must be {"id":"...","priority":"critical|high|medium|low","rationale":"one concise sentence"}.',
    'Use critical sparingly. Consider user impact, urgency, risk, current status, team overrides, and stated advantage.',
    '',
    JSON.stringify(items),
  ].join('\n');
  const text = await invokeBedrockText(
    prompt,
    {
      feature: 'other',
      project,
      entityType: 'feature-request-ranking',
      userId: actorId,
    },
    { maxTokens: Math.max(4096, Math.min(16000, items.length * 140)) },
  );
  return parseFeatureRequestRankings(
    text,
    items.map((item) => item.id),
  );
}
