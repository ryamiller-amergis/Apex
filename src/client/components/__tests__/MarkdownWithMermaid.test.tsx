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

async function openLightbox() {
  render(<MermaidDiagram chart={'flowchart LR\nA-->B'} />);
  await waitFor(() =>
    expect(screen.getByTestId('mermaid-expand')).toBeInTheDocument()
  );
  fireEvent.click(screen.getByTestId('mermaid-expand'));
  expect(screen.getByTestId('mermaid-lightbox')).toBeInTheDocument();
}

describe('MermaidDiagram expand lightbox', () => {
  it('opens a larger diagram lightbox from Expand', async () => {
    await openLightbox();
    expect(screen.getByRole('dialog', { name: 'Diagram' })).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText(/drag to pan/i)).toBeInTheDocument();
  });

  it('zooms and closes from the lightbox controls', async () => {
    await openLightbox();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('125%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close diagram' }));
    expect(screen.queryByTestId('mermaid-lightbox')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    await openLightbox();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('mermaid-lightbox')).not.toBeInTheDocument();
  });

  it('pans the diagram with pointer drag after zooming in', async () => {
    await openLightbox();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    const viewport = screen.getByTestId('mermaid-pan-viewport');

    fireEvent.mouseDown(viewport, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(viewport, { clientX: 160, clientY: 130 });
    fireEvent.mouseUp(viewport);

    const diagram = viewport.firstElementChild as HTMLElement;
    expect(diagram.style.transform).toContain('translate(60px, 30px)');
    expect(diagram.style.transform).toContain('scale(1.25)');
  });

  it('resets pan and zoom together', async () => {
    await openLightbox();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    const viewport = screen.getByTestId('mermaid-pan-viewport');
    fireEvent.mouseDown(viewport, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.mouseMove(viewport, { clientX: 10, clientY: 5 });
    fireEvent.mouseUp(viewport);

    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));

    const diagram = viewport.firstElementChild as HTMLElement;
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(diagram.style.transform).toBe('translate(0px, 0px) scale(1)');
  });
});
