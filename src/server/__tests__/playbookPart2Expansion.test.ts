import { getStepTypeDescriptor } from '../services/playbookSteps/registry';
import { assertGraphWithinGuards } from '../services/playbookGuardService';
import { resolvePlaybookBindings } from '../services/playbookBindingResolver';
import { evaluateJoin, assertForeachWithinCap, assertUntilWithinCap } from '../services/playbookJoinPolicy';
import {
  acceptPlaybookRecommendation,
  parsePlaybookRecommendation,
} from '../services/playbookRecommenderService';
import {
  adoServiceHookReceipt,
  playbookWebhookSignature,
  playbookWebhookSignatureMatches,
} from '../services/playbookWebhookService';
import { deliverPlaybookTeamsMessage } from '../services/playbookConnectorRegistry';
import type { PlaybookGraph } from '../../shared/types/playbook';

jest.mock('../services/teamsBotService', () => ({
  sendTeamsNotification: jest.fn(),
}));

import { sendTeamsNotification } from '../services/teamsBotService';

const notify = (id: string) => ({
  id,
  stepType: 'notify',
  config: { title: id },
});

describe('playbook part 2', () => {
  it('rejects an apex-action parameter object that fails its schema', () => {
    const parsed = getStepTypeDescriptor('apex-action').inputSchema.safeParse({
      operation: 'create-ado-items',
      parameters: { epic: { id: 'epic-1' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a single work item action and records its id', () => {
    const parsed = getStepTypeDescriptor('apex-action').inputSchema.safeParse({
      operation: 'create-work-item',
      parameters: {
        workItemType: 'Bug',
        title: 'Repeated null reference',
        description: 'The nightly investigation found one exception to fix.',
      },
    });
    expect(parsed.success).toBe(true);
    const output = getStepTypeDescriptor('apex-action').outputSchema.safeParse({
      operation: 'create-work-item',
      summary: 'Created Azure DevOps Bug 42.',
      workItemId: 42,
    });
    expect(output.success).toBe(true);
  });

  it('completes Teams delivery when the webhook call fails', async () => {
    (sendTeamsNotification as jest.Mock).mockRejectedValue(new Error('webhook unset'));
    await expect(deliverPlaybookTeamsMessage('user-1', {
      id: 'note-1',
      userId: 'user-1',
      type: 'background',
      title: 'Hello',
      body: 'There',
      link: null,
      read: false,
      createdAt: '2026-10-26T00:00:00.000Z',
    })).resolves.toBeUndefined();
  });

  it('fails an all join when one arm fails and keeps an atLeast join', () => {
    const arms = [
      { stepId: 'left', status: 'completed' as const, output: { title: 'Left' } },
      { stepId: 'right', status: 'failed' as const },
    ];
    expect(evaluateJoin('all', arms).ok).toBe(false);
    const partial = evaluateJoin({ atLeast: 1 }, arms);
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.output.arms.left).toEqual({ title: 'Left' });
  });

  it('stops foreach above maxIterations', () => {
    expect(() => assertForeachWithinCap(4, 3)).toThrow(/maxIterations 3/);
    expect(() => assertForeachWithinCap(3, 3)).not.toThrow();
  });

  it('stops an until at its cap and fails only past it', () => {
    expect(() => assertUntilWithinCap(3, 3, false)).not.toThrow();
    expect(() => assertUntilWithinCap(4, 3, false)).toThrow(/maxIterations 3/);
  });

  it('does not apply an unknown recommender step type', () => {
    const graph: PlaybookGraph = { nodes: [], edges: [] };
    expect(() => parsePlaybookRecommendation({ stepType: 'not-a-step', config: {} })).toThrow(/Unknown step type/);
    expect(() => acceptPlaybookRecommendation(graph, { stepType: 'not-a-step', config: {} })).toThrow(/Unknown step type/);
    expect(graph.nodes).toEqual([]);
  });

  it('does not apply a suggestion whose config fails the input schema', () => {
    expect(() => parsePlaybookRecommendation({
      stepType: 'notify',
      config: {},
    })).toThrow();
  });

  it('rejects a webhook signature that does not match the raw body', () => {
    const body = Buffer.from('{"project":"forged"}');
    const signature = playbookWebhookSignature('secret', body);
    expect(playbookWebhookSignatureMatches('secret', body, `sha256=${signature}`)).toBe(true);
    expect(playbookWebhookSignatureMatches('secret', Buffer.from('{"project":"other"}'), `sha256=${signature}`)).toBe(false);
    expect(adoServiceHookReceipt({ id: 'delivery-1', eventType: 'workitem.updated', project: 'forged' })?.idempotencyKey)
      .toBe('ado:delivery-1');
  });

  it('reads a join arm binding', () => {
    const value = resolvePlaybookBindings('${steps.join-1.arms.left.title}', {
      input: {},
      steps: { 'join-1': { arms: { left: { title: 'Left' } } } },
    });
    expect(value).toBe('Left');
  });

  it('still rejects a back-edge', () => {
    expect(() => assertGraphWithinGuards({
      nodes: [notify('a'), notify('b')],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    })).toThrow(/loop/);
  });

  it('allows a parallel split into a join and rejects a second inbound elsewhere', () => {
    expect(() => assertGraphWithinGuards({
      nodes: [
        { ...notify('split'), parallel: true },
        notify('left'),
        notify('right'),
        {
          id: 'join-1',
          stepType: 'join',
          config: { predecessors: ['left', 'right'], policy: 'all' },
        },
      ],
      edges: [
        { from: 'split', to: 'left' },
        { from: 'split', to: 'right' },
        { from: 'left', to: 'join-1' },
        { from: 'right', to: 'join-1' },
      ],
    })).not.toThrow();

    expect(() => assertGraphWithinGuards({
      nodes: [notify('a'), notify('b'), notify('c')],
      edges: [
        { from: 'a', to: 'c' },
        { from: 'b', to: 'c' },
      ],
    })).toThrow(/Only a join step/);
  });

  it('refuses a cloud-agent step that has no approval gate', () => {
    expect(() => assertGraphWithinGuards({
      nodes: [{
        id: 'agent',
        stepType: 'cloud-agent',
        config: { workItemId: 1, workItemType: 'Bug', state: 'New' },
      }],
      edges: [],
    })).toThrow(/approval gate|gate/i);
  });

  it('permits one gate to cover both the item it creates and the cloud agent that follows', () => {
    // The self-healing shape: a single approval reviews the finding once, and nothing between the
    // gate and the cloud agent can act without that approval already having been given.
    expect(() => assertGraphWithinGuards({
      nodes: [
        { id: 'approve', stepType: 'approval-gate', config: { subject: 'File and fix this?' } },
        {
          id: 'create',
          stepType: 'apex-action',
          config: {
            operation: 'create-ado-items',
            parameters: { epic: { id: 'epic-1', title: 'Fix the exception' }, features: [], pbis: [] },
          },
        },
        {
          id: 'fix',
          stepType: 'cloud-agent',
          config: { workItemId: 1, workItemType: 'Bug', state: 'New' },
        },
      ],
      edges: [
        { from: 'approve', to: 'create' },
        { from: 'create', to: 'fix' },
      ],
    })).not.toThrow();
  });

  it('still refuses the cloud agent when it stays reachable without crossing any gate', () => {
    // Fan-in to a non-join node is its own refusal (TBI-023), so the bypass case for a `leaves-apex`
    // node with more than one inbound edge is exercised directly against the gate rule in
    // playbookGuards.test.ts (VT-14). This asserts the companion case: an *unchanged* two-step
    // chain with no gate anywhere is still refused after generalizing the rule to "somewhere
    // upstream" — generalizing it must not have made it toothless.
    expect(() => assertGraphWithinGuards({
      nodes: [
        {
          id: 'create',
          stepType: 'apex-action',
          config: {
            operation: 'create-ado-items',
            parameters: { epic: { id: 'epic-1', title: 'Fix the exception' }, features: [], pbis: [] },
          },
        },
        {
          id: 'fix',
          stepType: 'cloud-agent',
          config: { workItemId: 1, workItemType: 'Bug', state: 'New' },
        },
      ],
      edges: [{ from: 'create', to: 'fix' }],
    })).toThrow(/approval gate|gate/i);
  });

  it('refuses a graph whose maximum iterations exceed the agent cap', () => {
    expect(() => assertGraphWithinGuards({
      nodes: [
        { id: 'loop', stepType: 'foreach', config: { items: [], maxIterations: 11 } },
        { id: 'agent', stepType: 'cursor-agent', config: {} },
      ],
      edges: [{ from: 'loop', to: 'agent' }],
    })).toThrow(/agent steps/);
  });
});
