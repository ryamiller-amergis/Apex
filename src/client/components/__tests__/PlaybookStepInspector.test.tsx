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

function renderBranch(issues?: string[]) {
  render(
    <PlaybookStepInspector
      project="Apex"
      node={{ id: 'branch-1', stepType: 'branch', config: {} }}
      paletteItem={undefined}
      otherNodeIds={['approval-gate-1']}
      priorNodeIds={['approval-gate-1']}
      allNodes={[
        { id: 'approval-gate-1', stepType: 'approval-gate' },
        { id: 'branch-1', stepType: 'branch' },
      ]}
      paletteItems={palette}
      issues={issues}
      canAuthor
      onChange={jest.fn()}
      onDelete={jest.fn()}
      onClose={jest.fn()}
    />,
  );
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

it('lists every problem the server found on the step', () => {
  renderBranch([
    'Branch step "branch-1" cannot use "approval-1.decision": no step on this Playbook has that id.',
    'Branch step "branch-1" has no continuation.',
  ]);

  const problems = screen.getByTestId('playbook-inspector-issues');
  expect(problems).toHaveTextContent('2 problems to fix before publishing');
  expect(problems).toHaveTextContent('"approval-1.decision"');
  expect(problems).toHaveTextContent('has no continuation');
});

it('shows no problem card for a step with nothing wrong', () => {
  renderBranch(undefined);

  expect(screen.queryByTestId('playbook-inspector-issues')).not.toBeInTheDocument();
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
