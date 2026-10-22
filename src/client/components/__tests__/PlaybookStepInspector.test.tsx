import { render, screen } from '@testing-library/react';
import type { PlaybookStepTypePaletteItem } from '../../../shared/types/playbook';
import { PlaybookStepInspector } from '../PlaybookStepInspector';

const palette: PlaybookStepTypePaletteItem[] = [
  {
    stepType: 'notify',
    schemaVersion: 1,
    label: 'Notify',
    description: 'Notify',
    sideEffect: 'leaves-apex',
    requiredPermissions: [],
    defaultDeadlineMs: 1_000,
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
    description: 'Approval',
    sideEffect: 'human-decision',
    requiredPermissions: [],
    defaultDeadlineMs: 1_000,
    inputJsonSchema: { type: 'object', properties: { body: { type: 'string' } } },
    outputJsonSchema: { type: 'object', properties: {} },
  },
];

it('shows run-input and prior-step reads with their availability', () => {
  render(
    <PlaybookStepInspector
      node={{
        id: 'gate',
        stepType: 'approval-gate',
        config: {
          body: '${input.releaseName} ${steps.notify.notificationId} ${steps.later.notificationId}',
        },
      }}
      paletteItem={palette[1]}
      otherNodeIds={['notify', 'later']}
      priorNodeIds={['notify']}
      allNodes={[
        { id: 'notify', stepType: 'notify' },
        { id: 'gate', stepType: 'approval-gate' },
        { id: 'later', stepType: 'notify' },
      ]}
      paletteItems={palette}
      canAuthor
      onChange={jest.fn()}
      onDelete={jest.fn()}
      onClose={jest.fn()}
    />
  );

  const reads = screen.getByTestId('playbook-inspector-reads');
  expect(reads).toHaveTextContent('${input.releaseName} — available');
  expect(reads).toHaveTextContent('${steps.notify.notificationId} — available');
  expect(reads).toHaveTextContent(
    '${steps.later.notificationId} — not available before this step'
  );
});
