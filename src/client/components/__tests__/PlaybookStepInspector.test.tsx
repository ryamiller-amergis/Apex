import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlaybookStepTypePaletteItem } from '../../../shared/types/playbook';
import { PlaybookStepInspector } from '../PlaybookStepInspector';

const paletteItem: PlaybookStepTypePaletteItem = {
  stepType: 'capture-outcome-feedback',
  label: 'Learn from outcome',
  sideEffect: 'writes-apex',
  requiredPermissions: ['playbooks:run'],
  canSuspend: false,
  inputJsonSchema: {
    type: 'object',
    required: ['reviewStepId', 'sourceStepIds'],
    properties: {
      label: { type: 'string' },
      reviewStepId: { type: 'string' },
      sourceStepIds: { type: 'array', items: { type: 'string' } },
    },
  },
  outputJsonSchema: {},
};

describe('PlaybookStepInspector outcome feedback', () => {
  it('lets an author choose the review step and the AI steps to learn from', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();

    render(
      <PlaybookStepInspector
        node={{
          id: 'capture-learning',
          stepType: 'capture-outcome-feedback',
          config: {},
        }}
        paletteItem={paletteItem}
        otherNodeIds={['chair', 'deliberation', 'ratify', 'announce']}
        otherNodes={[
          { id: 'chair', stepType: 'cursor-agent' },
          { id: 'deliberation', stepType: 'board-deliberation' },
          { id: 'ratify', stepType: 'approval-gate' },
          { id: 'announce', stepType: 'notify' },
        ]}
        canAuthor
        onChange={onChange}
        onDelete={jest.fn()}
        onClose={jest.fn()}
      />
    );

    expect(
      screen.getByRole('combobox', { name: /review step/i })
    ).toHaveAttribute('data-testid', 'playbook-inspector-field-reviewStepId');
    await user.selectOptions(
      screen.getByTestId('playbook-inspector-field-reviewStepId'),
      'ratify'
    );
    expect(onChange).toHaveBeenLastCalledWith({ reviewStepId: 'ratify' });

    await user.click(screen.getByTestId('playbook-inspector-source-chair'));
    expect(onChange).toHaveBeenLastCalledWith({ sourceStepIds: ['chair'] });
    expect(screen.queryByTestId('playbook-inspector-source-announce')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-inspector-source-ratify')).not.toBeInTheDocument();
  });
});
