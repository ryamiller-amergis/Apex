/**
 * Plain-language explanation of a cloud build machine that cannot install
 * the repository. Cursor cloud images ship a fixed Node version and ignore
 * `.nvmrc`, so `pnpm` stops when `engines.node` does not match.
 */
export function describeRuntimeFailure(text: string): string | null {
  if (
    !/ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported environment \(bad pnpm and\/or Node\.js version\)/i.test(
      text,
    )
  ) {
    return null;
  }

  const expected = text.match(/Expected version:\s*([^\n]+)/)?.[1]?.trim() ?? '';
  const got = text.match(/Got:\s*(v?\d+\.\d+\.\d+)/)?.[1] ?? '';
  const requiredMajor = expected.match(/>=(\d+)/)?.[1];
  const installedMajor = got.match(/v?(\d+)/)?.[1];
  if (requiredMajor && installedMajor) {
    return `The build machine could not install dependencies. This repository requires Node ${requiredMajor}, and the build machine has Node ${installedMajor}.`;
  }
  return 'The build machine could not install dependencies because its Node version does not match this repository.';
}

export function missingChecksMessage(
  requirementIds: readonly (string | null | undefined)[],
): string {
  const ids = [
    ...new Set(
      requirementIds
        .map((id) => (id ?? '').trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) return 'The build finished without the required checks.';
  return `The build finished without the required checks for ${ids.join(', ')}.`;
}
