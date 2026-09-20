/**
 * The `notify` step type.
 *
 * Its asserted effect is the durable notification row, not the delivery. That distinction is the
 * whole of TBI-019 and it matters more than it looks: an unconfigured Teams webhook must not make a
 * healthy step appear to have failed, and `writes-apex` in the taxonomy FEAT-008 builds means
 * exactly this — the row is the artifact, the push is a courtesy.
 *
 * `createNotification` already draws that line for us. It writes the row, fires
 * `sendTeamsNotification(...).catch(() => {})`, and pushes over SSE through a function that prunes
 * dead connections rather than throwing. So the adapter deliberately adds no error handling of its
 * own: if `createNotification` rejects, the row write genuinely failed and the step genuinely
 * failed. Wrapping it in a catch here would hide a real database error behind a "delivery is
 * best-effort" comment.
 *
 * Non-suspending, so it completes in the same tick it starts and declares no deadline.
 */
import { createNotification } from '../notificationService';
import { completeStepRun, PlaybookStepExecutionContext, PlaybookStepOutcome } from './stepRuns';
import type { NotifyStepConfig } from '../../../shared/types/playbook';

export class NotifyStepConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotifyStepConfigError';
  }
}

export function parseNotifyConfig(config: Record<string, unknown>): NotifyStepConfig {
  const title = config.title;
  if (typeof title !== 'string' || !title.trim()) {
    throw new NotifyStepConfigError('A notify step needs a non-empty title.');
  }

  for (const key of ['body', 'link', 'recipientUserId'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new NotifyStepConfigError(`A notify step's ${key} must be a string when present.`);
    }
  }

  return {
    title,
    body: config.body as string | undefined,
    link: config.link as string | undefined,
    recipientUserId: config.recipientUserId as string | undefined,
  };
}

export async function executeNotifyStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  const config = parseNotifyConfig(context.config);

  /*
   * Defaults to the initiator because they are the only identity Phase 0 can resolve (BR-003).
   * Recipient-pool resolution arrives with the approver pool in Epic 3, and inventing a narrower
   * rule now would be a second thing to unpick then.
   */
  const recipientUserId = config.recipientUserId ?? context.initiatorUserId;

  const notification = await createNotification(recipientUserId, {
    // 'background' rather than 'system': this row is produced by background workflow execution,
    // which is what the existing type means, and it inherits the user's preference for that class.
    type: 'background',
    title: config.title,
    body: config.body,
    link: config.link,
  });

  const output = { notificationId: notification.id, recipientUserId };
  await completeStepRun({ stepRunId: context.stepRunId, output });

  return { kind: 'completed', output };
}
