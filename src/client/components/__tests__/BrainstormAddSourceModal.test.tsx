import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { BrainstormAddSourceModal } from '../BrainstormAddSourceModal';

const options = {
  repositories: [],
  catalog: [],
  mcpServers: [],
  mcpEnabled: false,
  limits: { maxWorkspaceBytes: 1, maxConcurrentClones: 1 },
};

describe('BrainstormAddSourceModal', () => {
  it('tells people the temporary repository is public and has no password', () => {
    render(
      <BrainstormAddSourceModal
        open
        options={options}
        optionsError={null}
        pending={false}
        serverError={null}
        onClose={jest.fn()}
        onAttach={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('brainstorm-add-source-tab-temporary-repository'));
    expect(screen.getByTestId('brainstorm-temp-public-note')).toHaveTextContent('Public repositories only');
    expect(screen.getByTestId('brainstorm-temp-public-note')).toHaveTextContent('Do not include a password');
  });

  it('points an empty repository list at the Brainstorm card on Agent Home', () => {
    render(
      <BrainstormAddSourceModal
        open
        options={options}
        optionsError={null}
        pending={false}
        serverError={null}
        onClose={jest.fn()}
        onAttach={jest.fn()}
      />,
    );
    expect(screen.getByTestId('brainstorm-catalog-empty')).toHaveTextContent('Brainstorm page');
  });
});
