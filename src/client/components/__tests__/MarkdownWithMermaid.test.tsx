import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MermaidDiagram } from '../MarkdownWithMermaid';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('mermaid', () => ({
  initialize: jest.fn(),
  render: jest.fn(async (_id: string, _chart: string) => ({
    svg: '<svg data-testid="mermaid-svg"><text>diagram</text></svg>',
  })),
}));

describe('MermaidDiagram expand lightbox', () => {
  it('opens a larger diagram lightbox from Expand', async () => {
    render(<MermaidDiagram chart={'flowchart LR\nA-->B'} />);

    await waitFor(() =>
      expect(screen.getByTestId('mermaid-expand')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('mermaid-expand'));

    expect(screen.getByTestId('mermaid-lightbox')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Diagram' })).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('zooms and closes from the lightbox controls', async () => {
    render(<MermaidDiagram chart={'flowchart LR\nA-->B'} />);
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-expand')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('mermaid-expand'));

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close diagram' }));
    expect(screen.queryByTestId('mermaid-lightbox')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    render(<MermaidDiagram chart={'flowchart LR\nA-->B'} />);
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-expand')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByTestId('mermaid-expand'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('mermaid-lightbox')).not.toBeInTheDocument();
  });
});
