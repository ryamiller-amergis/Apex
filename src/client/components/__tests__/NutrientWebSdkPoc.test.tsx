import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let mockLicenseKey = 'nutrient-demo-key';
const mockLoad = jest.fn();
const mockUnload = jest.fn();
const mockExportOffice = jest.fn();
const mockHasUnsavedChanges = jest.fn();
const mockSaveContentEditingSession = jest.fn();
const mockCreateObjectURL = jest.fn(() => 'blob:docx');
const mockRevokeObjectURL = jest.fn();
const mockAnchorClick = jest.fn();

Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
  configurable: true,
  value: mockAnchorClick,
});

jest.mock('../../config/env', () => ({
  env: {
    get VITE_NUTRIENT_LICENSE_KEY() {
      return mockLicenseKey;
    },
  },
}));

jest.mock('@nutrient-sdk/viewer', () => ({
  __esModule: true,
  default: {
    defaultToolbarItems: [{ type: 'pager' }],
    load: (...args: unknown[]) => mockLoad(...args),
    unload: (...args: unknown[]) => mockUnload(...args),
  },
}));

import { NutrientWebSdkPoc } from '../NutrientWebSdkPoc';

describe('NutrientWebSdkPoc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLicenseKey = 'nutrient-demo-key';
    mockLoad.mockResolvedValue({
      exportOffice: mockExportOffice,
      hasUnsavedContentEditingChanges: mockHasUnsavedChanges,
      saveContentEditingSession: mockSaveContentEditingSession,
    });
    mockHasUnsavedChanges.mockReturnValue(false);
    mockSaveContentEditingSession.mockResolvedValue(undefined);
    mockExportOffice.mockResolvedValue(new ArrayBuffer(8));
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: mockCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: mockRevokeObjectURL,
    });
  });

  it('loads a PDF with content editing enabled', async () => {
    render(<NutrientWebSdkPoc />);
    const file = new File(['pdf'], 'invoice.pdf', {
      type: 'application/pdf',
    });
    Object.defineProperty(file, 'arrayBuffer', {
      value: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
    });

    fireEvent.change(screen.getByLabelText('Choose PDF for Nutrient POC'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    expect(mockLoad.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        document: expect.any(ArrayBuffer),
        useCDN: true,
        licenseKey: 'nutrient-demo-key',
        toolbarItems: [
          { type: 'pager' },
          { type: 'content-editor', dropdownGroup: 'editor' },
        ],
      })
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'invoice.pdf loaded. Edit the PDF or export it to Word.'
    );
  });

  it('exports the loaded PDF to DOCX in the browser', async () => {
    render(<NutrientWebSdkPoc />);
    const file = new File(['pdf'], 'invoice.pdf', {
      type: 'application/pdf',
    });
    Object.defineProperty(file, 'arrayBuffer', {
      value: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
    });
    fireEvent.change(screen.getByLabelText('Choose PDF for Nutrient POC'), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Export to Word' })
      ).toBeEnabled()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export to Word' }));

    await waitFor(() =>
      expect(mockExportOffice).toHaveBeenCalledWith({ format: 'docx' })
    );
    expect(mockCreateObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:docx');
  });

  it('can run in evaluation mode without a key', async () => {
    mockLicenseKey = '';
    render(<NutrientWebSdkPoc />);
    const file = new File(['pdf'], 'trial.pdf', {
      type: 'application/pdf',
    });
    Object.defineProperty(file, 'arrayBuffer', {
      value: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
    });

    fireEvent.change(screen.getByLabelText('Choose PDF for Nutrient POC'), {
      target: { files: [file] },
    });

    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    expect(mockLoad.mock.calls[0][0]).not.toHaveProperty('licenseKey');
  });
});
