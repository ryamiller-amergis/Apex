import { extractFormFieldGeometry } from '../pdfFormFields';

describe('extractFormFieldGeometry', () => {
  it('treats PDF.js maxLen zero as an unconstrained field', () => {
    const fields = extractFormFieldGeometry(
      [
        {
          annotationType: 20,
          fieldType: 'Tx',
          fieldName: 'Name',
          maxLen: 0,
          rect: [10, 10, 110, 30],
        },
      ],
      [],
      200,
      100
    );

    expect(fields).toHaveLength(1);
    expect(fields[0].maxLength).toBeNull();
  });
});
