import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SignatureToolPanel } from '../SignatureToolPanel';

describe('SignatureToolPanel uploaded image source', () => {
  const originalImage = window.Image;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    URL.createObjectURL = jest.fn(() => 'blob:signature');
    URL.revokeObjectURL = jest.fn();

    class MockImage {
      naturalWidth = 200;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        window.setTimeout(() => this.onload?.(), 0);
      }
    }
    window.Image = MockImage as unknown as typeof Image;

    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: jest.fn(),
    } as unknown as CanvasRenderingContext2D);
    jest
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback) => {
        callback(new Blob(['normalised'], { type: 'image/png' }));
      });
  });

  afterEach(() => {
    window.Image = originalImage;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    jest.restoreAllMocks();
  });

  it('normalises a selected image to PNG and emits it as an uploaded signature', async () => {
    const onSignatureReady = jest.fn();
    const { container } = render(
      <SignatureToolPanel
        onSignatureReady={onSignatureReady}
        onCancel={jest.fn()}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]'
    );
    expect(input).not.toBeNull();

    fireEvent.change(input!, {
      target: {
        files: [new File(['image'], 'signature.jpg', { type: 'image/jpeg' })],
      },
    });

    await waitFor(() => expect(onSignatureReady).toHaveBeenCalledTimes(1));
    const [blob, source] = onSignatureReady.mock.calls[0] as [
      Blob,
      string,
    ];
    expect(blob.type).toBe('image/png');
    expect(source).toBe('uploaded');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:signature');
  });

  it('rejects a non-image file without emitting a signature', () => {
    const onSignatureReady = jest.fn();
    const { container } = render(
      <SignatureToolPanel
        onSignatureReady={onSignatureReady}
        onCancel={jest.fn()}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"]'
    );

    fireEvent.change(input!, {
      target: {
        files: [new File(['text'], 'signature.txt', { type: 'text/plain' })],
      },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please select a PNG or JPEG image.'
    );
    expect(onSignatureReady).not.toHaveBeenCalled();
  });
});
