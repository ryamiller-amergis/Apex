export type EnvIssue = {
  path?: readonly PropertyKey[];
  message?: string;
};

export function formatEnvIssues(
  issues: readonly EnvIssue[],
  source: object,
  secretNames?: ReadonlySet<string>
): string;
