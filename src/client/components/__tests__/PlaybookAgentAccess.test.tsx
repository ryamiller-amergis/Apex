import { render, screen } from '@testing-library/react';
import { PlaybookStepInspector } from '../PlaybookStepInspector';

jest.mock('../../hooks/usePlaybookCanvas', () => ({
  ...jest.requireActual('../../hooks/usePlaybookCanvas'),
  usePlaybookSkills: () => ({ data: { skills: [] }, isPending: false }),
}));
jest.mock('../../hooks/useProjectSkillConfig', () => ({
  ...jest.requireActual('../../hooks/useProjectSkillConfig'),
  useAvailableModels: () => ({ data: [], isPending: false }),
}));

function renderAgent(config: Record<string, unknown>, canAuthor = true) {
  const onChange = jest.fn();
  render(
    <PlaybookStepInspector
      project="Apex"
      node={{ id: 'agent', stepType: 'cursor-agent', config }}
      paletteItem={undefined}
      otherNodeIds={[]}
      priorNodeIds={[]}
      nextNodeIds={[]}
      allNodes={[{ id: 'agent', stepType: 'cursor-agent' }]}
      paletteItems={[]}
      canAuthor={canAuthor}
      onChange={onChange}
      onDelete={jest.fn()}
      onClose={jest.fn()}
    />,
  );
  return onChange;
}

describe('agent step access', () => {
  it('no longer asks the author for an access profile', () => {
    renderAgent({ mcpProfile: 'repository-read-only' });
    expect(screen.queryByTestId('playbook-inspector-field-mcpProfile')).not.toBeInTheDocument();
    expect(screen.queryByText('Access')).not.toBeInTheDocument();
  });

  it('stores the read-only profile on a step that has none', () => {
    const onChange = renderAgent({ prompt: 'Look at it.' });
    expect(onChange).toHaveBeenCalledWith({ prompt: 'Look at it.', mcpProfile: 'repository-read-only' });
  });

  it('leaves a step that already has a profile alone', () => {
    const onChange = renderAgent({ mcpProfile: 'repository-read-only' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not edit a step the author cannot change', () => {
    const onChange = renderAgent({ prompt: 'Look at it.' }, false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
