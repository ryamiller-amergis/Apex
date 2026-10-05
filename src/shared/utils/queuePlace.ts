/** "1st in line", "2nd in line", "3rd in line", "4th in line". */
export function queuePlaceLabel(position: number): string {
  const place = Math.trunc(position);
  const teen = place % 100;
  const digit = place % 10;
  const suffix = teen >= 11 && teen <= 13
    ? 'th'
    : digit === 1
      ? 'st'
      : digit === 2
        ? 'nd'
        : digit === 3
          ? 'rd'
          : 'th';
  return `${place}${suffix} in line`;
}
