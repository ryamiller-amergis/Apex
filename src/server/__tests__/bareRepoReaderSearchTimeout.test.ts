/**
 * @jest-environment node
 */

jest.mock('../utils/asyncGit', () => ({
  git: jest.fn(),
  safeArgs: (_mirrorPath: string, args: string[]) => args,
}));

import { BareRepoReader } from '../services/repoRead/bareRepoReader';
import { git } from '../utils/asyncGit';

const gitMock = git as jest.MockedFunction<typeof git>;

function reader(): BareRepoReader {
  return new BareRepoReader({
    identity: {
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      sha: 'a'.repeat(40),
    },
    mirrorPath: '/mirror.git',
  });
}

function timeoutKill(): Error {
  // execFile reports a timeout by killing the child, not by exiting non-zero.
  return Object.assign(new Error('git grep terminated'), {
    killed: true,
    signal: 'SIGTERM',
  });
}

describe('BareRepoReader search timeout', () => {
  beforeEach(() => {
    gitMock.mockReset();
  });

  it('surfaces a timed-out grep as a non-retryable SEARCH_TIMEOUT', async () => {
    gitMock.mockRejectedValue(timeoutKill());

    // Retrying re-scans the same tree and dies at the same limit, so the error
    // must not invite another attempt.
    await expect(reader().searchCode('needle')).rejects.toMatchObject({
      code: 'SEARCH_TIMEOUT',
      fallbackEligible: false,
    });
  });

  it('tells the caller how to make the search succeed', async () => {
    gitMock.mockRejectedValue(timeoutKill());

    await expect(reader().searchCode('needle')).rejects.toThrow(/narrow/i);
  });

  it('still treats a clean no-match exit as an empty result', async () => {
    gitMock.mockRejectedValue(new Error('git grep failed with exit code 1'));

    await expect(reader().searchCode('needle')).resolves.toEqual([]);
  });

  it('gives a repo-wide grep a larger budget than a single object read', async () => {
    gitMock.mockResolvedValue('');
    const subject = reader();

    await subject.searchCode('needle');
    await subject.readFile('README.md');

    const searchOptions = gitMock.mock.calls[0][1] as { timeout: number };
    const readOptions = gitMock.mock.calls[1][1] as { timeout: number };
    expect(searchOptions.timeout).toBeGreaterThan(readOptions.timeout);
  });

  it('parallelizes grep so blob inflation is not serialized', async () => {
    gitMock.mockResolvedValue('');

    await reader().searchCode('needle');

    const args = gitMock.mock.calls[0][0] as string[];
    expect(args.some((arg) => /^--threads=\d+$/.test(arg))).toBe(true);
  });
});
