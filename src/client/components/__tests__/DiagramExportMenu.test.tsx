import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiagramExportMenu } from '../DiagramExportMenu';
import * as downloadUtil from '../../utils/diagramDownload';

jest.mock('../../utils/diagramDownload', () => {
  const actual = jest.requireActual('../../utils/diagramDownload');
  return {
    ...actual,
    downloadBlob: jest.fn(),
  };
});

describe('DiagramExportMenu — PBI-005', () => {
  const downloadBlob = downloadUtil.downloadBlob as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as jest.Mock;
  });

  it('PBI-005 AC-2 / VT-07 unit: PNG export downloads sanitized filename', async () => {
    const user = userEvent.setup();
    const blob = new Blob(['png'], { type: 'image/png' });
    render(
      <DiagramExportMenu
        title="My Diagram: V2"
        exportPng={async () => blob}
        exportSvg={async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')}
        exportNativeJson={async () => '{}'}
      />,
    );

    await user.click(screen.getByTestId('diagram-export-png'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob).toHaveBeenCalledWith('My-Diagram-V2.png', blob);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PBI-005 AC-2: SVG export downloads .svg content', async () => {
    const user = userEvent.setup();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    render(
      <DiagramExportMenu
        title="Flow"
        exportPng={async () => new Blob(['x'], { type: 'image/png' })}
        exportSvg={async () => svg}
        exportNativeJson={async () => '{}'}
      />,
    );

    await user.click(screen.getByTestId('diagram-export-svg'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [filename, blob] = downloadBlob.mock.calls[0];
    expect(filename).toBe('Flow.svg');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toMatch(/svg/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PBI-005 AC-2: native .excalidraw export downloads JSON', async () => {
    const user = userEvent.setup();
    const json = JSON.stringify({ type: 'excalidraw', version: 2, elements: [] });
    render(
      <DiagramExportMenu
        title="Native"
        exportPng={async () => new Blob(['x'], { type: 'image/png' })}
        exportSvg={async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')}
        exportNativeJson={async () => json}
      />,
    );

    await user.click(screen.getByTestId('diagram-export-excalidraw'));

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [filename, blob] = downloadBlob.mock.calls[0];
    expect(filename).toBe('Native.excalidraw');
    expect(blob).toBeInstanceOf(Blob);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PBI-005 AC-1 / VT-06: export failure shows error without calling update API', async () => {
    const user = userEvent.setup();
    render(
      <DiagramExportMenu
        title="Broken"
        exportPng={async () => {
          throw new Error('PNG export failed');
        }}
        exportSvg={async () => {
          throw new Error('SVG export failed');
        }}
        exportNativeJson={async () => {
          throw new Error('Native export failed');
        }}
      />,
    );

    await user.click(screen.getByTestId('diagram-export-png'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/PNG export failed|export failed/i);
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('PBI-005 AC-3: export buttons remain available for view-only users', () => {
    render(
      <DiagramExportMenu
        title="View Only"
        exportPng={async () => new Blob(['x'], { type: 'image/png' })}
        exportSvg={async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')}
        exportNativeJson={async () => '{}'}
      />,
    );

    expect(screen.getByTestId('diagram-export-png')).toBeEnabled();
    expect(screen.getByTestId('diagram-export-svg')).toBeEnabled();
    expect(screen.getByTestId('diagram-export-excalidraw')).toBeEnabled();
  });
});
