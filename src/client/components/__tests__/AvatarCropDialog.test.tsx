/**
 * Avatar crop dialog — full photo + draggable square selection.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { AvatarCropDialog } from '../AvatarCropDialog';

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: jest.fn().mockReturnValue('blob:mock-crop'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: jest.fn(),
  });
});

function renderDialog(
  overrides: Partial<{
    onConfirm: jest.Mock;
    onCancel: jest.Mock;
    isSubmitting: boolean;
  }> = {}
) {
  const onConfirm = overrides.onConfirm ?? jest.fn();
  const onCancel = overrides.onCancel ?? jest.fn();
  const file = new File(['abc'], 'avatar.png', { type: 'image/png' });
  render(
    <AvatarCropDialog
      file={file}
      isSubmitting={overrides.isSubmitting ?? false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
  return { onConfirm, onCancel, file };
}

/** Simulate a decoded image + measured stage (jsdom has neither). */
function hydrateCropSurface(naturalW: number, naturalH: number, stagePx = 200) {
  const stage = screen.getByTestId('avatar-crop-preview');
  jest.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
    width: stagePx,
    height: stagePx,
    top: 0,
    left: 0,
    bottom: stagePx,
    right: stagePx,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  const img = screen.getByTestId('avatar-crop-image');
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: naturalW });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: naturalH });
  fireEvent.load(img);
}

describe('AvatarCropDialog', () => {
  it('defaults to a full-image crop on confirm when image metrics are unavailable', () => {
    const { onConfirm, file } = renderDialog();
    fireEvent.click(screen.getByTestId('avatar-upload-submit'));
    expect(onConfirm).toHaveBeenCalledWith(file, { x: 0, y: 0, width: 1, height: 1 });
  });

  it('square photo at min zoom yields a full-frame crop', () => {
    const { onConfirm, file } = renderDialog();
    hydrateCropSurface(400, 400, 200);

    fireEvent.click(screen.getByTestId('avatar-upload-submit'));
    expect(onConfirm).toHaveBeenCalledWith(file, { x: 0, y: 0, width: 1, height: 1 });
  });

  it('landscape photo uses a square pixel window (unequal normalized fractions)', () => {
    const { onConfirm } = renderDialog();
    hydrateCropSurface(800, 400, 200);

    fireEvent.click(screen.getByTestId('avatar-upload-submit'));
    const crop = onConfirm.mock.calls[0][1] as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(crop.height).toBeCloseTo(1, 5);
    expect(crop.width).toBeCloseTo(0.5, 5);
    expect(crop.y).toBeCloseTo(0, 5);
    expect(crop.x).toBeCloseTo(0.25, 5);
  });

  it('arrow keys move the selection square over the photo', () => {
    const { onConfirm } = renderDialog();
    hydrateCropSurface(800, 400, 200);

    const frame = screen.getByTestId('avatar-crop-frame');
    frame.focus();
    fireEvent.keyDown(frame, { key: 'ArrowRight' });
    fireEvent.keyDown(frame, { key: 'ArrowRight' });

    fireEvent.click(screen.getByTestId('avatar-upload-submit'));
    const crop = onConfirm.mock.calls[0][1] as { x: number; width: number; height: number };
    expect(crop.width).toBeCloseTo(0.5, 5);
    expect(crop.height).toBeCloseTo(1, 5);
    expect(crop.x).toBeGreaterThan(0.25);
  });

  it('shows drag-the-square guidance and a Zoom control', () => {
    renderDialog();
    expect(screen.getByText(/drag the square/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom')).toBeInTheDocument();
  });
});
