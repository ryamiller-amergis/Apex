import { fireEvent, render, screen } from '@testing-library/react';
import { CloudAgentLaunchDialog } from '../CloudAgentLaunchDialog';

function renderDialog() {
  render(
    <CloudAgentLaunchDialog
      title="There's an issue on the site"
      reason="Describe the problem."
      skills={[{ name: 'bug-fix', path: '.cursor/skills/bug-fix/SKILL.md', description: 'Fix' }]}
      models={[{ id: 'composer-2.5', displayName: 'Composer' }]}
      defaultSkillPath=".cursor/skills/bug-fix/SKILL.md"
      defaultModel="composer-2.5"
      requireTask
      allowImages
      loading={false}
      loadError={null}
      pending={false}
      error={null}
      onClose={() => undefined}
      onConfirm={() => undefined}
    />,
  );
}

describe('CloudAgentLaunchDialog screenshots', () => {
  it('keeps Add file and accepts a dropped screenshot', async () => {
    renderDialog();
    expect(screen.getByTestId('cloud-agent-launch-add-file')).toBeInTheDocument();
    expect(screen.getByText(/Or drop a screenshot here/)).toBeInTheDocument();

    const file = new File(['png'], 'screen.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('cloud-agent-launch-drop'), {
      dataTransfer: { files: [file] },
    });

    expect(await screen.findByText('screen.png')).toBeInTheDocument();
  });
});
