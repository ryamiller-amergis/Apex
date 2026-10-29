const VAR_PATTERN =
  /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/;
const CALC_PATTERN = /^calc\(\s*([\d.]+)\s*\*\s*([\d.]+)px\s*\)$/;

/**
 * Test helper: reads a computed property and substitutes `var()` references
 * from the element's custom properties, because jsdom does not resolve them.
 * A `calc(n * Mpx)` result is reduced to `${n * M}px`.
 */
export function resolvedStyle(
  element: Element,
  property: string,
  pseudo?: string
): string {
  const style = getComputedStyle(element, pseudo);
  let value = style.getPropertyValue(property).trim();
  for (let depth = 0; depth < 20 && VAR_PATTERN.test(value); depth += 1) {
    value = value.replace(VAR_PATTERN, (_match, name: string, fallback) => {
      const resolved = getComputedStyle(element).getPropertyValue(name).trim();
      return resolved || (fallback ?? '').trim();
    });
  }
  const calc = CALC_PATTERN.exec(value);
  if (calc) {
    return `${Number(calc[1]) * Number(calc[2])}px`;
  }
  return value;
}
