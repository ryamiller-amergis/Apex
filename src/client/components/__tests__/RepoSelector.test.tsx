import { fireEvent, render, screen } from '@testing-library/react';

import { RepoSelector } from '../RepoSelector';

const configs = [
  {
    id: 'cfg-1',
    project: 'proj-alpha',
    friendlyName: 'Main',
    skillRepo: 'org/skills',
    skillBranch: 'main',
    isDefault: true,
  },
  {
    id: 'cfg-2',
    project: 'proj-alpha',
    friendlyName: 'Staging',
    skillRepo: 'org/skills',
    skillBranch: 'staging',
    isDefault: false,
  },
];

describe('RepoSelector', () => {
  it('renders repo config cards with friendly names and metadata', () => {
    render(<RepoSelector configs={configs} onSelect={jest.fn()} />);

    expect(screen.getByText('Select a repository configuration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /main/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /staging/i })).toBeInTheDocument();
    expect(screen.getByText('org/skills / main')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('calls onSelect with the config id when a card is clicked', () => {
    const onSelect = jest.fn();
    render(<RepoSelector configs={configs} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /staging/i }));

    expect(onSelect).toHaveBeenCalledWith('cfg-2');
  });

  it('shows back button and calls onBack when provided', () => {
    const onBack = jest.fn();
    render(<RepoSelector configs={configs} onSelect={jest.fn()} onBack={onBack} />);

    const backButton = screen.getByRole('button', { name: /back to projects/i });
    fireEvent.click(backButton);

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('hides back button when onBack is not provided', () => {
    render(<RepoSelector configs={configs} onSelect={jest.fn()} />);

    expect(screen.queryByRole('button', { name: /back to projects/i })).not.toBeInTheDocument();
  });
});
