import React from 'react';
import { render, screen } from '@testing-library/react';
import { PdfFormFieldLayer } from '../PdfFormFieldLayer';

describe('PdfFormFieldLayer', () => {
  it('renders persisted values as non-interactive document content in display mode', () => {
    const DisplayableLayer = PdfFormFieldLayer as React.ComponentType<
      React.ComponentProps<typeof PdfFormFieldLayer> & { displayOnly: boolean }
    >;

    render(
      <DisplayableLayer
        fileId="file-1"
        fields={[
          {
            fieldName: 'Name',
            multiline: false,
            maxLength: null,
            xPct: 10,
            yPct: 20,
            widthPct: 30,
            heightPct: 5,
          },
        ]}
        catalog={[]}
        values={[{ fileId: 'file-1', fieldName: 'Name', value: 'Alex' }]}
        readOnly
        displayOnly
        onValuesChange={jest.fn()}
      />
    );

    const field = screen.getByRole('textbox', { name: 'Name' });
    expect(field).toHaveValue('Alex');
    expect(field).toHaveAttribute('tabindex', '-1');
  });
});
