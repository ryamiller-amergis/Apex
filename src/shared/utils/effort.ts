const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}
