jest.mock('../../shared/types/playbookConnectors', () => {
  const actual = jest.requireActual('../../shared/types/playbookConnectors');
  return {
    ...actual,
    // The catalog has no write operation yet. Stand one in for the guard.
    connectorConfigWrites: (config: Record<string, unknown> | undefined) =>
      config?.operation === 'create-thing',
  };
});

import { findUngatedLeavesApexSteps } from '../services/playbookGuardService';
import type { PlaybookGraph } from '../../shared/types/playbook';

const actual = jest.requireActual(
  '../../shared/types/playbookConnectors',
) as typeof import('../../shared/types/playbookConnectors');

function graph(connectorOperation: string, withGate: boolean): PlaybookGraph {
  const connector = {
    id: 'act',
    stepType: 'connector',
    config: { integration: 'azure-devops', operation: connectorOperation },
  };
  return withGate
    ? {
      nodes: [
        { id: 'gate', stepType: 'approval-gate', config: { subject: 'ok?', approverPool: { type: 'initiator' } } },
        connector,
      ],
      edges: [{ from: 'gate', to: 'act' }],
    }
    : { nodes: [connector], edges: [] };
}

describe('connector write operations and the approval gate', () => {
  it('requires a gate upstream of a connector whose operation writes', () => {
    expect(findUngatedLeavesApexSteps(graph('create-thing', false))).toEqual(['act']);
  });

  it('accepts the same connector behind a gate', () => {
    expect(findUngatedLeavesApexSteps(graph('create-thing', true))).toEqual([]);
  });

  it('does not ask a read operation for a gate', () => {
    expect(findUngatedLeavesApexSteps(graph('list-branches', false))).toEqual([]);
  });
});

describe('connectorConfigWrites', () => {
  const catalog = [{
    id: 'demo',
    label: 'Demo',
    description: '',
    operations: [
      { id: 'look', label: 'Look', description: '', access: 'read' as const, fields: [] },
      { id: 'change', label: 'Change', description: '', access: 'write' as const, fields: [] },
    ],
  }];

  it('is true only for a write operation named in the catalog', () => {
    expect(actual.connectorConfigWrites({ integration: 'demo', operation: 'change' }, catalog)).toBe(true);
    expect(actual.connectorConfigWrites({ integration: 'demo', operation: 'look' }, catalog)).toBe(false);
  });

  it('is false for an unknown integration, an unknown operation, or no config', () => {
    expect(actual.connectorConfigWrites({ integration: 'other', operation: 'change' }, catalog)).toBe(false);
    expect(actual.connectorConfigWrites({ integration: 'demo', operation: 'gone' }, catalog)).toBe(false);
    expect(actual.connectorConfigWrites(undefined, catalog)).toBe(false);
  });
});
