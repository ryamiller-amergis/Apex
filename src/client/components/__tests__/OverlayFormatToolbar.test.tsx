import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OverlayTextBox } from '../../../shared/types/pdf';
import { OverlayFormatToolbar } from '../OverlayFormatToolbar';
import { OverlayTextBox as OverlayTextBoxPreview } from '../OverlayTextBox';

const overlay: OverlayTextBox = {
  id: 'overlay-1',
  pageId: 'page-1',
  x: 10,
  y: 10,
  width: 30,
  height: 10,
  text: 'First\nSecond\nThird',
  fontFamily: 'Helvetica',
  fontSize: 14,
  bold: false,
  italic: false,
  color: '#000000',
  horizontalAlign: 'left',
  verticalAlign: 'top',
  opacity: 100,
  rotation: 0,
  listStyle: 'none',
  linkUrl: null,
  linkDisplayText: null,
  zIndex: 1,
};

describe('OverlayFormatToolbar', () => {
  it('applies core and rich formatting patches', () => {
    const onChange = jest.fn();
    render(<OverlayFormatToolbar overlay={overlay} onChange={onChange} />);

    expect(
      screen
        .getAllByTestId('overlay-format-font-family')[0]
        .querySelectorAll('option')
    ).toHaveLength(3);

    fireEvent.change(screen.getByTestId('overlay-format-font-family'), {
      target: { value: 'Times-Roman' },
    });
    fireEvent.change(screen.getByTestId('overlay-format-font-size'), {
      target: { value: '72' },
    });
    fireEvent.click(screen.getByTestId('overlay-format-bold'));
    fireEvent.click(screen.getByRole('button', { name: 'Align center' }));
    fireEvent.change(screen.getByTestId('overlay-format-opacity'), {
      target: { value: '60' },
    });
    fireEvent.change(screen.getByTestId('overlay-format-rotation'), {
      target: { value: '15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Align middle' }));
    fireEvent.change(screen.getByTestId('overlay-format-list-style'), {
      target: { value: 'numbered' },
    });

    expect(onChange).toHaveBeenCalledWith({ fontFamily: 'Times-Roman' });
    expect(onChange).toHaveBeenCalledWith({ fontSize: 72 });
    expect(onChange).toHaveBeenCalledWith({ bold: true });
    expect(onChange).toHaveBeenCalledWith({ horizontalAlign: 'center' });
    expect(onChange).toHaveBeenCalledWith({ opacity: 60 });
    expect(onChange).toHaveBeenCalledWith({ rotation: 15 });
    expect(onChange).toHaveBeenCalledWith({ verticalAlign: 'middle' });
    expect(onChange).toHaveBeenCalledWith({ listStyle: 'numbered' });
  });

  it('refuses invalid size, color, and rotation values', () => {
    const onChange = jest.fn();
    render(<OverlayFormatToolbar overlay={overlay} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('overlay-format-font-size'), {
      target: { value: '73' },
    });
    fireEvent.change(screen.getByTestId('overlay-format-rotation'), {
      target: { value: '181' },
    });
    const color = screen.getByTestId('overlay-format-color');
    fireEvent.change(color, { target: { value: 'red' } });
    fireEvent.blur(color);

    expect(onChange).not.toHaveBeenCalled();
    expect(color).toHaveValue('#000000');
    expect(screen.getByText(/six-digit hex color/i)).toBeInTheDocument();
  });

  it('adjusts numeric values with custom stepper controls', () => {
    const onChange = jest.fn();
    render(<OverlayFormatToolbar overlay={overlay} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Increase Font size' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Rotation' }));

    expect(onChange).toHaveBeenCalledWith({ fontSize: 15 });
    expect(onChange).toHaveBeenCalledWith({ rotation: -1 });
  });

  it('applies and validates an http link', async () => {
    const onChange = jest.fn();
    const onValidationChange = jest.fn();
    render(
      <OverlayFormatToolbar
        overlay={overlay}
        onChange={onChange}
        onValidationChange={onValidationChange}
      />
    );

    fireEvent.change(screen.getByTestId('overlay-format-link-url'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.change(screen.getByTestId('overlay-format-link-display'), {
      target: { value: 'Example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply link' }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        linkUrl: 'https://example.com',
        linkDisplayText: 'Example',
      })
    );
  });

  it('blocks an unsafe link and announces its field error', async () => {
    const onChange = jest.fn();
    const onValidationChange = jest.fn();
    render(
      <OverlayFormatToolbar
        overlay={overlay}
        onChange={onChange}
        onValidationChange={onValidationChange}
      />
    );

    fireEvent.change(screen.getByTestId('overlay-format-link-url'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply link' }));

    expect(
      await screen.findByTestId('overlay-format-link-error')
    ).toHaveTextContent(/http/);
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onValidationChange).toHaveBeenLastCalledWith(true)
    );
  });

  it('renders list markers and linked display text in the preview', () => {
    const { rerender } = render(
      <OverlayTextBoxPreview
        overlay={{ ...overlay, listStyle: 'bullet' }}
        selected={false}
        onSelect={jest.fn()}
      />
    );
    expect(
      screen.getByTestId('pdf-tools-overlay-drag-surface')
    ).toHaveTextContent('• First • Second • Third');

    rerender(
      <OverlayTextBoxPreview
        overlay={{
          ...overlay,
          linkUrl: 'https://example.com',
          linkDisplayText: 'Example',
        }}
        selected={false}
        onSelect={jest.fn()}
      />
    );
    const box = screen.getByTestId('pdf-tools-overlay-box');
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(box).toHaveStyle({
      textDecoration: 'underline',
      fontSize: '14pt',
    });
  });
});
