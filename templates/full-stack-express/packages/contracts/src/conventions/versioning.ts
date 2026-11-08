const segment = String.raw`(?:[a-z0-9][a-z0-9-]*|:[A-Za-z][A-Za-z0-9]*)`;
const versionedPath = new RegExp(
  String.raw`^(?:/api/v[1-9][0-9]*|/health)(?:/${segment})+$`
);

export function isVersionedPath(path: string): boolean {
  return versionedPath.test(path);
}

export function pathParameterNames(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part.startsWith(':'))
    .map((part) => part.slice(1));
}

export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
}
