/**
 * Deterministically orders repository source by its relevance to one feature.
 *
 * The byte budget consumes this order. That keeps a large alphabetically
 * early file from pushing the component named by the feature out of context.
 */

function tokens(value: string): string[] {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function relevanceScore(path: string, terms: ReadonlySet<string>): number {
  if (terms.size === 0) return 0;
  let score = 0;
  for (const pathToken of tokens(path)) {
    for (const term of terms) {
      if (pathToken === term) {
        score += 4;
      } else if (pathToken.startsWith(term) || term.startsWith(pathToken)) {
        score += 1;
      }
    }
  }
  return score;
}

export function rankSourcePaths(
  paths: ReadonlyArray<string>,
  relevanceText: string,
): string[] {
  const terms = new Set(tokens(relevanceText));
  return [...new Set(paths.map((path) => path.replace(/\\/g, '/')))].sort(
    (left, right) =>
      relevanceScore(right, terms) - relevanceScore(left, terms)
      || left.localeCompare(right),
  );
}
