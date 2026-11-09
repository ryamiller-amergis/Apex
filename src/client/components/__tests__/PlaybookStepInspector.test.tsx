import { fireEvent, render, screen } from '@testing-library/react';
import type { PlaybookStepTypePaletteItem } from '../../../shared/types/playbook';
import { PlaybookStepInspector } from '../PlaybookStepInspector';

const palette: PlaybookStepTypePaletteItem[] = [
  {
    stepType: 'notify',
    schemaVersion: 1,
    label: 'Notify',
    sideEffect: 'leaves-apex',
    requiredPermissions: [],
    canSuspend: false,
    addable: true,
    inputJsonSchema: { type: 'object', properties: { body: { type: 'string' } } },
    outputJsonSchema: {
      type: 'object',
      properties: { notificationId: { type: 'string' } },
    },
  },
  {
    stepType: 'approval-gate',
    schemaVersion: 1,
    label: 'Approval',
    sideEffect: 'writes-apex',
    requiredPermissions: [],
    canSuspend: true,
    addable: true,
    inputJsonSchema: { type: 'object', properties: { body: { type: 'string' } } },
    outputJsonSchema: { type: 'object', properties: {} },
  },
];

function renderGate(config: Record<string, unknown>, onChange = jest.fn()) {
  render(
    <PlaybookStepInspector
      project="Apex"
      node={{ id: 'gate', stepType: 'approval-gate', config }}
      paletteItem={palette[1]}
      otherNodeIds={['notify', 'later']}
      priorNodeIds={['notify']}
      nextNodeIds={['later']}
      allNodes={[
        { id: 'notify', stepType: 'notify' },
        { id: 'gate', stepType: 'approval-gate' },
        { id: 'later', stepType: 'notify' },
      ]}
      paletteItems={palette}
      canAuthor
      onChange={onChange}
      onDelete={jest.fn()}
      onClose={jest.fn()}
    />
  );
  return onChange;
}

it('names each value a step reads and whether it is available', () => {
  renderGate({
    body: '${input.releaseName} ${steps.notify.notificationId} ${steps.later.notificationId}',
  });

  const reads = screen.getByTestId('playbook-inspector-reads');
  expect(reads).toHaveTextContent('Trigger input › Release name');
  expect(reads).toHaveTextContent('Notify (notify) › Notification id');
  expect(reads).toHaveTextContent('Notify (later) › Notification id');
  expect(reads).toHaveTextContent('not available before this step');
  expect(reads).not.toHaveTextContent('${steps');
});

it('leaves approver routing unset until the author asks for a reviewer group', () => {
  const onChange = renderGate({ subject: 'Ship it' });

  fireEvent.click(screen.getByTestId('playbook-gate-approver-group'));

  expect(onChange).toHaveBeenLastCalledWith({
    subject: 'Ship it',
    approverPool: 'prd',
    gatedStepId: 'later',
  });
});
