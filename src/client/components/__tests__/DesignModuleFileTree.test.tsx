import { render, screen } from '@testing-library/react';
import { DesignModuleFileTree } from '../DesignModuleFileTree';

describe('DesignModuleFileTree', () => {
  it('renders the empty label but keeps the anchor target mounted when there are no files', () => {
    render(<DesignModuleFileTree files={[]} emptyLabel="Nothing matched." />);

    // Walkthrough coachmarks anchor to this test id; it must resolve even before a
    // data-dependent preview has produced matches, so it stays mounted while empty.
    const tree = screen.getByTestId('design-module-file-tree');
    expect(tree).toBeInTheDocument();
    expect(tree).toHaveTextContent('Nothing matched.');
  });

  it('renders folders before files and shows folder file counts', () => {
    render(
      <DesignModuleFileTree
        files={[
          'src/server/a.ts',
          'src/client/b.tsx',
          'src/client/__tests__/b.test.tsx',
          'README.md',
        ]}
      />
    );

    const tree = screen.getByTestId('design-module-file-tree');
    expect(tree).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('client')).toBeInTheDocument();
    expect(screen.getByText('server')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('b.test.tsx')).toBeInTheDocument();

    // root "src" folder should report 3 nested files
    const srcRow = screen.getByText('src').closest('div');
    expect(srcRow?.textContent).toMatch(/3/);
  });
});
