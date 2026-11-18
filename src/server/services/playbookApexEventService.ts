/**
 * Publishes a typed Apex event onto Playbook trigger subscriptions.
 * Features call this. They do not call the Playbook engine.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  playbookDefinitionVersions,
  playbookRuns,
  playbookTriggerSubscriptions,
} from '../db/schema';
import {
  producedPlaybookApexEventTypes,
  renderPlaybookDedupeKey,
  type PlaybookApexEventType,
} from '../../shared/utils/playbookTriggerMapping';
import { dispatchPlaybookTrigger } from './playbookTriggerDispatchService';

export interface PlaybookApexEvent {
  project: string;
  type: PlaybookApexEventType;
  entityId: string;
  actorUserId: string | null;
  data: Record<string, unknown>;
  /** Set when a Playbook run is the source, so that run cannot start itself again. */
  sourceRunId?: string;
}

export async function publishPlaybookApexEvent(
  event: PlaybookApexEvent,
): Promise<{ started: Array<{ runId: string; definitionVersionId: string }> }> {
  if (!producedPlaybookApexEventTypes.includes(event.type)) {
    return { started: [] };
  }
  const subscriptions = await db.select().from(playbookTriggerSubscriptions).where(and(
    eq(playbookTriggerSubscriptions.project, event.project),
    eq(playbookTriggerSubscriptions.kind, 'apex_event'),
    eq(playbookTriggerSubscriptions.eventType, event.type),
    eq(playbookTriggerSubscriptions.enabled, true),
  ));

  let sourceDefinitionId: string | null = null;
  if (event.sourceRunId) {
    const [sourceRun] = await db.select({
      definitionId: playbookDefinitionVersions.definitionId,
    }).from(playbookRuns).innerJoin(
      playbookDefinitionVersions,
      eq(playbookRuns.definitionVersionId, playbookDefinitionVersions.id),
    ).where(eq(playbookRuns.id, event.sourceRunId)).limit(1);
    sourceDefinitionId = sourceRun?.definitionId ?? null;
  }

  const started: Array<{ runId: string; definitionVersionId: string }> = [];
  for (const subscription of subscriptions) {
    if (sourceDefinitionId && subscription.definitionId === sourceDefinitionId) continue;
    const idempotencyKey = renderPlaybookDedupeKey(subscription.dedupeKeyTemplate, {
      'event.type': event.type,
      'event.entityId': event.entityId,
      'event.actorUserId': event.actorUserId ?? '',
    });
    const result = await dispatchPlaybookTrigger({
      subscriptionId: subscription.id,
      source: 'apex_event',
      idempotencyKey,
      event: {
        entityId: event.entityId,
        actorUserId: event.actorUserId,
        data: {
          ...event.data,
          ...(event.sourceRunId ? { playbookRunId: event.sourceRunId } : {}),
        },
      },
    });
    if (result.runId && result.definitionVersionId) {
      started.push({ runId: result.runId, definitionVersionId: result.definitionVersionId });
    }
  }
  return { started };
}
