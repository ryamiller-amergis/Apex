import {
  adoServiceHookAuthorized,
  adoWorkItemCreatedReceipt,
  readAdoWorkItemTypeFilter,
} from '../services/playbookWebhookService';
import { withAdoWorkItemRunInput } from '../services/playbookTriggerDispatchService';

function created(type: string, id = 4821): Record<string, unknown> {
  return {
    id: 'event-1',
    eventType: 'workitem.created',
    resource: {
      id,
      fields: {
        'System.WorkItemType': type,
        'System.Title': 'Checkout fails after deploy',
        'System.State': 'New',
      },
    },
  };
}

describe('Azure DevOps work item trigger', () => {
  it('keeps a created Production Bug and puts the work item id on the run', () => {
    const receipt = adoWorkItemCreatedReceipt(created('Production Bug'), 'production bug');
    expect(receipt).toMatchObject({
      idempotencyKey: 'ado:event-1',
      entityId: '4821',
      data: {
        workItemId: 4821,
        workItemType: 'Production Bug',
        title: 'Checkout fails after deploy',
        state: 'New',
      },
    });
    expect(withAdoWorkItemRunInput('azure_devops', {}, receipt && receipt !== 'skip' ? receipt.data : {}))
      .toMatchObject({ workItemId: 4821, workItemType: 'Production Bug' });
  });

  it('does not start for a different type or a different event', () => {
    expect(adoWorkItemCreatedReceipt(created('Bug'), 'Production Bug')).toBe('skip');
    expect(adoWorkItemCreatedReceipt({
      ...created('Production Bug'),
      eventType: 'workitem.updated',
    }, 'Production Bug')).toBe('skip');
  });

  it('leaves webhook and schedule run input alone', () => {
    expect(withAdoWorkItemRunInput('webhook', {}, { workItemId: 1 })).toEqual({});
  });

  it('accepts the service hook password and a token header', () => {
    const secret = 'hook-secret';
    const basic = `Basic ${Buffer.from(`apex:${secret}`).toString('base64')}`;
    expect(adoServiceHookAuthorized(secret, basic, undefined)).toBe(true);
    expect(adoServiceHookAuthorized(secret, undefined, secret)).toBe(true);
    expect(adoServiceHookAuthorized(secret, `Basic ${Buffer.from('apex:nope').toString('base64')}`, undefined)).toBe(false);
  });

  it('reads the saved work item type', () => {
    expect(readAdoWorkItemTypeFilter({
      eventType: 'workitem.created',
      workItemType: ' Production Bug ',
    })).toBe('Production Bug');
    expect(readAdoWorkItemTypeFilter(null)).toBeNull();
  });
});
