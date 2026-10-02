import fs from 'fs';
import path from 'path';
import { assertGraphWithinGuards } from '../../src/server/services/playbookGuardService';
import type { PlaybookGraph } from '../../src/shared/types/playbook';

const ROOT = path.resolve(__dirname, '../..');

describe('Phase 2 production adapter integration contracts', () => {
  it('keeps migration and Drizzle gate snapshot storage in parity', () => {
    const migration = fs.readFileSync(
      path.join(ROOT, 'migrations/20260922173000_add-playbook-gate-snapshots.sql'),
      'utf8',
    );
    const schema = fs.readFileSync(path.join(ROOT, 'src/server/db/schema.ts'), 'utf8');
    for (const name of [
      'input_inline',
      'gate_pool_key',
      'gate_approval_mode',
      'playbook_gate_approvers',
      'approver_user_id',
      'decision',
    ]) {
      expect(migration).toContain(name);
    }
    for (const name of [
      'inputInline',
      'gatePoolKey',
      'gateApprovalMode',
      'playbookGateApprovers',
      'approverUserId',
      'decision',
    ]) {
      expect(schema).toContain(name);
    }
  });

  it('publishes branch fanout but refuses an undeclared source output field', () => {
    const graph: PlaybookGraph = {
      nodes: [
        { id: 'source', stepType: 'notify', config: { title: 'Done' } },
        { id: 'choose', stepType: 'branch', config: {
          condition: {
            sourceStepId: 'source',
            field: 'missing',
            operator: 'eq',
            value: true,
          },
          whenTrue: 'yes',
          whenFalse: 'no',
        } },
        { id: 'yes', stepType: 'notify', config: { title: 'Yes' } },
        { id: 'no', stepType: 'notify', config: { title: 'No' } },
      ],
      edges: [
        { from: 'source', to: 'choose' },
        { from: 'choose', to: 'yes', condition: 'yes' },
        { from: 'choose', to: 'no', condition: 'no' },
      ],
    };
    expect(() => assertGraphWithinGuards(graph)).toThrow(/source\.missing/);
  });
});
