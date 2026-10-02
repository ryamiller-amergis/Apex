import { normalizeGeneratedPrototypeHtml } from '../utils/htmlSanitizer';

describe('normalizeGeneratedPrototypeHtml', () => {
  it('removes one outer HTML markdown fence and surrounding whitespace', () => {
    expect(
      normalizeGeneratedPrototypeHtml(
        '  ```html\n<!DOCTYPE html><html><body>Done</body></html>\n```  ',
      ),
    ).toBe('<!DOCTYPE html><html><body>Done</body></html>');
  });

  it('leaves unfenced HTML unchanged apart from surrounding whitespace', () => {
    expect(
      normalizeGeneratedPrototypeHtml(
        '  <!DOCTYPE html><html><body>Done</body></html>  ',
      ),
    ).toBe('<!DOCTYPE html><html><body>Done</body></html>');
  });

  it('preserves the existing empty-completion behavior', () => {
    expect(normalizeGeneratedPrototypeHtml(' \n ')).toBe('');
  });
});
