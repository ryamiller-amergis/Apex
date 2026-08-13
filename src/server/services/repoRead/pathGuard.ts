import path from 'path';
import { RepoReaderError } from '../repoReader';

const ACCESS_DENIED_MESSAGE = 'Repository path access denied';

export function validateRepoRelativePath(requestedPath: string): {
  platformPath: string;
  portablePath: string;
} {
  const repoRelativePath =
    requestedPath.startsWith('/') && !requestedPath.startsWith('//')
      ? requestedPath.slice(1)
      : requestedPath;
  if (
    requestedPath.includes('\0')
    || path.isAbsolute(repoRelativePath)
    || path.posix.isAbsolute(repoRelativePath)
    || path.win32.isAbsolute(repoRelativePath)
  ) {
    throw new RepoReaderError('ACCESS_DENIED', ACCESS_DENIED_MESSAGE, false);
  }

  const segments = repoRelativePath.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) {
    throw new RepoReaderError('ACCESS_DENIED', ACCESS_DENIED_MESSAGE, false);
  }

  const safeSegments = segments.filter((segment) => segment && segment !== '.');
  return {
    platformPath: safeSegments.join(path.sep),
    portablePath: safeSegments.join('/'),
  };
}
