/** Case-insensitive A→Z order for dropdown and picker labels. */
export function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

export function sortByLabel<T>(items: readonly T[], label: (item: T) => string): T[] {
  return [...items].sort((left, right) => compareLabels(label(left), label(right)));
}
