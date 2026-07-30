import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';

let mockLicenseKey = 'webviewer-demo-key';
const mockEnableFeatures = jest.fn();
const mockSetToolbarGroup = jest.fn();
const mockLoadDocument = jest.fn();
const mockDispose = jest.fn();
const mockWebViewer = jest.fn();
const mockIframeWebViewer = jest.fn();
const mockAddEventListener = jest.fn();
const mockRemoveEventListener = jest.fn();
const mockGetPageCount = jest.fn();
const mockSetCurrentPage = jest.fn();
const mockSetFitMode = jest.fn();
const documentEventHandlers = new Map<string, (...args: unknown[]) => void>();

jest.mock('../../config/env', () => ({
  env: {
    get VITE_APRYSE_WEBVIEWER_LICENSE_KEY() {
      return mockLicenseKey;
    },
  },
}));

jest.mock('@pdftron/webviewer', () => ({
  __esModule: true,
  default: Object.assign((...args: unknown[]) => mockWebViewer(...args), {
    BackendTypes: { WASM: 'ems' },
    Iframe: (...args: unknown[]) => mockIframeWebViewer(...args),
  }),
}));

import { ApryseWebViewerPoc } from '../ApryseWebViewerPoc';

describe('ApryseWebViewerPoc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    documentEventHandlers.clear();
    mockLicenseKey = 'webviewer-demo-key';
    mockGetPageCount.mockReturnValue(1);
    mockAddEventListener.mockImplementation(
      (eventName: string, handler: (...args: unknown[]) => void) => {
        documentEventHandlers.set(eventName, handler);
      }
    );
    const instance = {
      Core: {
        documentViewer: {
          addEventListener: mockAddEventListener,
          removeEventListener: mockRemoveEventListener,
          getPageCount: mockGetPageCount,
          setCurrentPage: mockSetCurrentPage,
        },
      },
      UI: {
        Feature: { ContentEdit: 'content-edit' },
        ToolbarGroup: { EDIT: 'edit' },
        FitMode: { FitPage: 'fit-page' },
        enableFeatures: mockEnableFeatures,
        setToolbarGroup: mockSetToolbarGroup,
        setFitMode: mockSetFitMode,
        loadDocument: mockLoadDocument,
        dispose: mockDispose,
      },
    };
    mockWebViewer.mockResolvedValue(instance);
    mockIframeWebViewer.mockResolvedValue(instance);
  });

  it('initializes WebViewer with ContentEdit enabled', async () => {
    render(<ApryseWebViewerPoc />);

    await waitFor(() => expect(mockIframeWebViewer).toHaveBeenCalledTimes(1));
    expect(mockWebViewer).not.toHaveBeenCalled();
    expect(mockIframeWebViewer.mock.calls[0][0]).toEqual({
      path: '/apryse-webviewer/lib',
      licenseKey: 'webviewer-demo-key',
      fullAPI: true,
      backendType: 'ems',
    });
    expect(mockEnableFeatures).toHaveBeenCalledWith(['content-edit']);
    expect(mockSetToolbarGroup).toHaveBeenCalledWith('edit');
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'documentLoaded',
      expect.any(Function)
    );
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'loadError',
      expect.any(Function)
    );
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'finishedRendering',
      expect.any(Function)
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Apryse WebViewer is ready.'
    );
  });

  it('uses a fresh host element when Strict Mode replays effects', async () => {
    render(
      <StrictMode>
        <ApryseWebViewerPoc />
      </StrictMode>
    );

    await waitFor(() => expect(mockIframeWebViewer).toHaveBeenCalledTimes(2));
    expect(mockIframeWebViewer.mock.calls[0][1]).not.toBe(
      mockIframeWebViewer.mock.calls[1][1]
    );
  });

  it('loads an uploaded PDF into the isolated viewer', async () => {
    render(<ApryseWebViewerPoc />);
    await waitFor(() => expect(mockIframeWebViewer).toHaveBeenCalledTimes(1));
    const file = new File(['pdf'], 'invoice.pdf', {
      type: 'application/pdf',
    });

    fireEvent.change(screen.getByLabelText('Choose PDF for Apryse POC'), {
      target: { files: [file] },
    });

    expect(mockLoadDocument).toHaveBeenCalledWith(file, {
      filename: 'invoice.pdf',
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading invoice.pdf…'
    );
    act(() => {
      documentEventHandlers.get('documentLoaded')?.();
    });
    expect(mockSetCurrentPage).toHaveBeenCalledWith(1, true);
    expect(mockSetFitMode).toHaveBeenCalledWith('fit-page');
    expect(screen.getByRole('status')).toHaveTextContent(
      'invoice.pdf loaded (1 page). Rendering…'
    );
    act(() => {
      documentEventHandlers.get('finishedRendering')?.();
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'invoice.pdf rendered. Use Edit Text, then Download.'
    );
  });

  it('shows Apryse document load errors', async () => {
    render(<ApryseWebViewerPoc />);
    await waitFor(() => expect(mockIframeWebViewer).toHaveBeenCalledTimes(1));
    const file = new File(['bad'], 'broken.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(screen.getByLabelText('Choose PDF for Apryse POC'), {
      target: { files: [file] },
    });

    act(() => {
      documentEventHandlers.get('loadError')?.(
        new Error('Unable to parse PDF.')
      );
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Unable to parse PDF.');
  });

  it('shows setup guidance without exposing a missing key', () => {
    mockLicenseKey = '';

    render(<ApryseWebViewerPoc />);

    expect(mockIframeWebViewer).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'VITE_APRYSE_WEBVIEWER_LICENSE_KEY is not configured.'
    );
  });
});
