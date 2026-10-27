/** Every `data-testid` value matches this pattern. */
export const TEST_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Builds a `data-testid` value in the form `{scope}-{element}[-{qualifier}]`.
 * Each part is lower-cased and the parts are joined with `-`. Dynamic parts
 * must be stable ids, never array indexes or display text.
 *
 * Throws when the result is not kebab-case, so a bad id fails in tests rather
 * than shipping an unstable selector.
 *
 * @example
 * <Link {...{ 'data-testid': testId('app-shell', 'nav-item', item.id) }} />
 */
export function testId(scope: string, ...parts: string[]): string {
  const value = [scope, ...parts].map((part) => part.toLowerCase()).join('-');
  if (!TEST_ID_PATTERN.test(value)) {
    throw new Error(`testId "${value}" is not kebab-case`);
  }
  return value;
}
