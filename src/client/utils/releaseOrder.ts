/**
 * Compute the new order after moving a release row from `fromIndex` to `toIndex`.
 * Returns `null` when the move is a no-op or out of bounds.
 */
export function reorderReleases<T>(
  items: T[],
  fromIndex: number,
  toIndex: number,
): T[] | null {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return null;
  }

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
