const insertedValues: Array<Record<string, unknown>> = [];

jest.mock('../db/drizzle', () => ({
  db: {
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        insertedValues.push(value);
        return { returning: async () => [{ ...value, id: 'trigger-1', webhookSecret: null }] };
      },
    }),
  },
}));

import {
  createPlaybookTrigger,
  defaultConcurrencyPolicy,
} from '../services/playbookTriggerSubscriptionService';

const ado = {
  name: 'Production Issue',
  kind: 'azure_devops',
  eventFilter: { eventType: 'workitem.created', workItemType: 'Production Issue' },
  dedupeKeyTemplate: '{event.entityId}',
};

async function create(body: Record<string, unknown>) {
  await createPlaybookTrigger({
    project: 'MaxView',
    definitionId: 'definition-1',
    actorUserId: 'user-1',
    body,
  });
  return insertedValues[insertedValues.length - 1];
}

describe('Playbook trigger concurrency', () => {
  beforeEach(() => {
    insertedValues.length = 0;
  });

  it('lets event-driven triggers run at the same time by default', () => {
    expect(defaultConcurrencyPolicy('azure_devops')).toBe('allow');
    expect(defaultConcurrencyPolicy('webhook')).toBe('allow');
    expect(defaultConcurrencyPolicy('apex_event')).toBe('allow');
  });

  it('skips a schedule tick while a run is live by default', () => {
    expect(defaultConcurrencyPolicy('schedule')).toBe('skip_if_active');
  });

  it('saves allow for an Azure DevOps trigger that does not set a policy', async () => {
    expect(await create(ado)).toMatchObject({ concurrencyPolicy: 'allow' });
  });

  it('saves skip_if_active for a schedule that does not set a policy', async () => {
    const saved = await create({
      name: 'Nightly',
      kind: 'schedule',
      scheduleHour: 2,
      scheduleMinute: 0,
      dedupeKeyTemplate: 'schedule:{occurrence}',
    });
    expect(saved).toMatchObject({ concurrencyPolicy: 'skip_if_active' });
  });

  it('keeps a policy the caller sets', async () => {
    expect(await create({ ...ado, concurrencyPolicy: 'skip_if_active' }))
      .toMatchObject({ concurrencyPolicy: 'skip_if_active' });
  });
});
