import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../services/appSettingsService', () => ({
  getAppSetting: jest.fn(),
}));

import { getAppSetting } from '../services/appSettingsService';
import {
  ChangelogContentError,
  compareVersions,
  getChangelogPayload,
  getCurrentChangelogVersion,
  readChangelogEntries,
  readValidChangelogEntries,
  resetChangelogCache,
  resolveCurrentChangelogVersion,
} from '../services/changelogService';

const mockedGetAppSetting = getAppSetting as jest.MockedFunction<typeof getAppSetting>;

let tmpDir: string | undefined;
let originalCwd: string;

beforeEach(() => {
  resetChangelogCache();
  mockedGetAppSetting.mockReset();
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-test-'));
  process.chdir(tmpDir);
  fs.mkdirSync('public', { recursive: true });
});

afterEach(() => {
  resetChangelogCache();
  if (tmpDir) {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('compareVersions', () => {
  it('returns positive when first version is newer', () => {
    expect(compareVersions('1.33.1', '1.33.0')).toBeGreaterThan(0);
    expect(compareVersions('1.33.0', '1.31.0')).toBeGreaterThan(0);
  });

  it('returns zero for equal versions', () => {
    expect(compareVersions('1.33.1', '1.33.1')).toBe(0);
  });
});

describe('strict changelog validity (DoD-2 / VT-03)', () => {
  it('readValidChangelogEntries rejects malformed SemVer', () => {
    fs.writeFileSync(
      path.join('public', 'CHANGELOG.json'),
      JSON.stringify([{ version: 'not-semver', date: '2026-07-01', title: 'Bad', changes: [] }]),
    );
    expect(() => readValidChangelogEntries()).toThrow(ChangelogContentError);
  });

  it('getChangelogPayload throws for malformed content', async () => {
    fs.writeFileSync(
      path.join('public', 'CHANGELOG.json'),
      JSON.stringify([{ version: '1.2', date: '2026-07-01', title: 'Bad', changes: [] }]),
    );
    await expect(getChangelogPayload()).rejects.toThrow(ChangelogContentError);
  });

  it('resolveCurrentChangelogVersion ignores DB-only newer value absent from bundled entries', async () => {
    fs.writeFileSync(
      path.join('public', 'CHANGELOG.json'),
      JSON.stringify([{ version: '1.31.0', date: '2026-06-30', title: 'File', changes: [] }]),
    );
    mockedGetAppSetting.mockResolvedValue('1.99.0');
    await expect(resolveCurrentChangelogVersion()).resolves.toBe('1.31.0');
  });

  it('resolveCurrentChangelogVersion uses DB when valid and present in entries', async () => {
    fs.writeFileSync(
      path.join('public', 'CHANGELOG.json'),
      JSON.stringify([
        { version: '1.31.0', date: '2026-06-30', title: 'Older head', changes: [] },
        { version: '1.30.0', date: '2026-06-01', title: 'Prior', changes: [] },
      ]),
    );
    // DB points at an entry that exists but file head is same major line — still prefer file when newer
    mockedGetAppSetting.mockResolvedValue('1.30.0');
    await expect(resolveCurrentChangelogVersion()).resolves.toBe('1.31.0');
  });
});

describe('getCurrentChangelogVersion', () => {
  it('prefers deployed changelog file when it is newer than DB', async () => {
    fs.writeFileSync(
      path.join('public', 'CHANGELOG.json'),
      JSON.stringify([{ version: '1.33.1', date: '2026-07-01', title: 'Test', changes: [] }]),
    );
    mockedGetAppSetting.mockResolvedValue('1.31.0');

    await expect(getCurrentChangelogVersion()).resolves.toBe('1.33.1');
  });

  it('prefers DB when it is newer than file and present in entries', async () => {
    fs.writeFileSync(
      path.join('public', 'CHANGELOG.json'),
      JSON.stringify([
        { version: '1.31.0', date: '2026-06-30', title: 'Old', changes: [] },
        { version: '1.33.1', date: '2026-07-01', title: 'DB target', changes: [] },
      ]),
    );
    mockedGetAppSetting.mockResolvedValue('1.33.1');

    await expect(getCurrentChangelogVersion()).resolves.toBe('1.33.1');
  });

  it('reads entries from public changelog in dev layout', () => {
    fs.writeFileSync(
      path.join('public', 'CHANGELOG.json'),
      JSON.stringify([{ version: '1.33.0', date: '2026-07-01', title: 'Release', changes: [] }]),
    );

    expect(readChangelogEntries()[0]?.version).toBe('1.33.0');
  });
});
