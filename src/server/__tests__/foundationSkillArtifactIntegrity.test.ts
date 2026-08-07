import { gzipSync } from 'zlib';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import {
  extractCatalogFromNpmTarball,
  extractNpmTarballSafely,
  validateReleaseArtifactManifest,
  validateReleaseUpdate,
} from '../services/foundationSkillArtifactManifest';
import {
  downloadPackageArtifact,
  isTrustedArtifactUrl,
  listCandidates,
} from '../services/azureArtifactsSkillService';
import type {
  FoundationSkillRelease,
  FoundationSkillArtifactManifest,
} from '../../shared/types/foundationSkills';

function tarball(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const content = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(' ', 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, content);
    const remainder = content.length % 512;
    if (remainder) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const manifest: FoundationSkillArtifactManifest = {
  suiteVersion: '2.0.0',
  package: '@apex/skills',
  contractApiVersion: 1,
  skills: [
    {
      name: 'to-prd',
      summary: 'Create PRDs.',
      tier: 'shippable',
      alwaysInstall: false,
      dependsOn: [],
    },
    {
      name: 'post-skill-bootstrap',
      summary: 'Complete setup.',
      tier: 'shippable',
      alwaysInstall: true,
      dependsOn: ['to-prd'],
    },
    {
      name: 'internal-only',
      summary: 'Internal.',
      tier: 'apex-only',
      alwaysInstall: false,
      dependsOn: [],
    },
  ],
};

function release(overrides: Partial<FoundationSkillRelease> = {}): FoundationSkillRelease {
  return {
    id: 'release-1',
    version: '2.0.0',
    status: 'draft',
    artifactPackage: '@apex/skills',
    artifactVersion: '2.0.0',
    artifactFeed: null,
    integritySha256: null,
    contractApiVersion: 1,
    selectedSkills: ['to-prd'],
    targetProjects: [],
    skillTargets: {},
    manifestSnapshot: null,
    releaseNotes: null,
    breakingChanges: null,
    publishedBy: null,
    publishedAt: null,
    deprecatedBy: null,
    deprecatedAt: null,
    createdBy: 'admin',
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('extractCatalogFromNpmTarball', () => {
  it('reads catalog.json from the exact npm tarball', () => {
    const packed = tarball({
      'package/package.json': JSON.stringify({ name: '@apex/skills', version: '2.0.0' }),
      'package/catalog.json': JSON.stringify(manifest),
    });

    expect(extractCatalogFromNpmTarball(packed)).toEqual(manifest);
  });

  it('rejects an artifact without a package catalog', () => {
    const packed = tarball({
      'package/package.json': JSON.stringify({ name: '@apex/skills', version: '2.0.0' }),
    });

    expect(() => extractCatalogFromNpmTarball(packed)).toThrow(/catalog\.json/i);
  });

  it('rejects duplicate catalogs and invalid manifest field types', () => {
    const duplicate = tarball({
      'package/catalog.json': JSON.stringify(manifest),
      'package/./catalog.json': JSON.stringify(manifest),
    });
    expect(() => extractCatalogFromNpmTarball(duplicate)).toThrow(/duplicate/i);

    const invalid = tarball({
      'package/catalog.json': JSON.stringify({
        ...manifest,
        skills: [
          {
            name: 'bad-skill',
            summary: 'Bad.',
            tier: 'external',
            alwaysInstall: 'yes',
            dependsOn: 'to-prd',
          },
        ],
      }),
    });
    expect(() => extractCatalogFromNpmTarball(invalid)).toThrow(
      /tier|alwaysInstall|dependsOn/i,
    );
  });
});

describe('extractNpmTarballSafely', () => {
  it('extracts regular package files within the destination', () => {
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-safe-tar-'));
    try {
      extractNpmTarballSafely(
        tarball({
          'package/bin/apex-skills.mjs': 'console.log("ok");\n',
          'package/catalog.json': JSON.stringify(manifest),
        }),
        destination,
      );
      expect(
        fs.readFileSync(
          path.join(destination, 'package/bin/apex-skills.mjs'),
          'utf8',
        ),
      ).toContain('console.log');
    } finally {
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it('rejects traversal paths before writing outside the destination', () => {
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-safe-tar-'));
    try {
      expect(() =>
        extractNpmTarballSafely(
          tarball({ 'package/../../escape.txt': 'escape\n' }),
          destination,
        ),
      ).toThrow(/escapes|unsafe/i);
    } finally {
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });
});

describe('artifact download authentication', () => {
  it('downloads the scoped npm artifact through the canonical package path', async () => {
    const oldOrg = process.env.AZURE_ARTIFACTS_ORG;
    const oldFeed = process.env.AZURE_ARTIFACTS_FEED;
    const oldPat = process.env.AZURE_ARTIFACTS_PAT;
    process.env.AZURE_ARTIFACTS_ORG = 'amergis';
    process.env.AZURE_ARTIFACTS_FEED = 'apex-skills';
    process.env.AZURE_ARTIFACTS_PAT = 'test-pat';
    const requestSpy = jest
      .spyOn(https, 'request')
      .mockImplementation((() => {
        throw new Error('request captured');
      }) as typeof https.request);

    try {
      await expect(downloadPackageArtifact('2.0.0')).rejects.toThrow('request captured');
      expect(String(requestSpy.mock.calls[0][0])).toBe(
        'https://pkgs.dev.azure.com/amergis/_apis/packaging/feeds/apex-skills/npm/packages/@apex/skills/versions/2.0.0/content?api-version=7.1',
      );
    } finally {
      requestSpy.mockRestore();
      if (oldOrg === undefined) delete process.env.AZURE_ARTIFACTS_ORG;
      else process.env.AZURE_ARTIFACTS_ORG = oldOrg;
      if (oldFeed === undefined) delete process.env.AZURE_ARTIFACTS_FEED;
      else process.env.AZURE_ARTIFACTS_FEED = oldFeed;
      if (oldPat === undefined) delete process.env.AZURE_ARTIFACTS_PAT;
      else process.env.AZURE_ARTIFACTS_PAT = oldPat;
    }
  });

  it('queries package metadata through the Azure Artifacts REST API host', async () => {
    const oldOrg = process.env.AZURE_ARTIFACTS_ORG;
    const oldFeed = process.env.AZURE_ARTIFACTS_FEED;
    const oldPat = process.env.AZURE_ARTIFACTS_PAT;
    process.env.AZURE_ARTIFACTS_ORG = 'amergis';
    process.env.AZURE_ARTIFACTS_FEED = 'apex-skills';
    process.env.AZURE_ARTIFACTS_PAT = 'test-pat';
    const requestSpy = jest
      .spyOn(https, 'request')
      .mockImplementation((() => {
        throw new Error('request captured');
      }) as typeof https.request);

    try {
      await expect(listCandidates()).rejects.toThrow('request captured');
      expect(String(requestSpy.mock.calls[0][0])).toMatch(
        /^https:\/\/feeds\.dev\.azure\.com\/amergis\/_apis\/packaging\/feeds\/apex-skills\/packages/,
      );
    } finally {
      requestSpy.mockRestore();
      if (oldOrg === undefined) delete process.env.AZURE_ARTIFACTS_ORG;
      else process.env.AZURE_ARTIFACTS_ORG = oldOrg;
      if (oldFeed === undefined) delete process.env.AZURE_ARTIFACTS_FEED;
      else process.env.AZURE_ARTIFACTS_FEED = oldFeed;
      if (oldPat === undefined) delete process.env.AZURE_ARTIFACTS_PAT;
      else process.env.AZURE_ARTIFACTS_PAT = oldPat;
    }
  });

  it('sends feed credentials only to the exact configured origin', () => {
    const oldOrg = process.env.AZURE_ARTIFACTS_ORG;
    const oldFeed = process.env.AZURE_ARTIFACTS_FEED;
    process.env.AZURE_ARTIFACTS_ORG = 'amergis';
    process.env.AZURE_ARTIFACTS_FEED = 'apex-skills';
    try {
      expect(
        isTrustedArtifactUrl(
          'https://pkgs.dev.azure.com/amergis/_apis/packaging/feeds/apex-skills',
        ),
      ).toBe(true);
      expect(
        isTrustedArtifactUrl('https://evil.pkgs.dev.azure.com/steal'),
      ).toBe(false);
      expect(
        isTrustedArtifactUrl('https://storage.example.com/redirected-package'),
      ).toBe(false);
    } finally {
      if (oldOrg === undefined) delete process.env.AZURE_ARTIFACTS_ORG;
      else process.env.AZURE_ARTIFACTS_ORG = oldOrg;
      if (oldFeed === undefined) delete process.env.AZURE_ARTIFACTS_FEED;
      else process.env.AZURE_ARTIFACTS_FEED = oldFeed;
    }
  });
});

describe('validateReleaseArtifactManifest', () => {
  it('accepts matching versions, shippable selections, and dependency closure', () => {
    expect(() =>
      validateReleaseArtifactManifest(release(), manifest),
    ).not.toThrow();
  });

  it('rejects suite-version mismatch and apex-only selections', () => {
    expect(() =>
      validateReleaseArtifactManifest(
        release({ version: '2.0.1' }),
        manifest,
      ),
    ).toThrow(/suite version/i);
    expect(() =>
      validateReleaseArtifactManifest(
        release({ selectedSkills: ['internal-only'] }),
        manifest,
      ),
    ).toThrow(/apex-only/i);
  });

  it('rejects contract-version mismatch and broken per-project dependency audiences', () => {
    expect(() =>
      validateReleaseArtifactManifest(
        release({ contractApiVersion: 2 }),
        manifest,
      ),
    ).toThrow(/contract api/i);

    expect(() =>
      validateReleaseArtifactManifest(
        release({
          selectedSkills: ['to-prd', 'post-skill-bootstrap'],
          targetProjects: [],
          skillTargets: {
            'post-skill-bootstrap': [],
            'to-prd': ['MaxView'],
          },
        }),
        manifest,
      ),
    ).toThrow(/audience.*dependency|dependency.*audience/i);
  });

  it('rejects a selected or always-installed skill with a missing dependency', () => {
    expect(() =>
      validateReleaseArtifactManifest(
        release({ selectedSkills: [] }),
        manifest,
      ),
    ).toThrow(/depends on.*to-prd/i);
  });

  it('rejects invalid dependencies anywhere in the artifact manifest', () => {
    const invalidManifest: FoundationSkillArtifactManifest = {
      ...manifest,
      skills: [
        ...manifest.skills,
        {
          name: 'unselected-skill',
          summary: 'Broken but unselected.',
          tier: 'shippable',
          alwaysInstall: false,
          dependsOn: ['does-not-exist'],
        },
      ],
    };

    expect(() =>
      validateReleaseArtifactManifest(release(), invalidManifest),
    ).toThrow(/unselected-skill.*does-not-exist/i);
  });
});

describe('validateReleaseUpdate', () => {
  it('allows notes-only edits after publication', () => {
    expect(() =>
      validateReleaseUpdate(
        release({ status: 'published' }),
        { releaseNotes: 'Clarification' },
      ),
    ).not.toThrow();
  });

  it('rejects audience, skill, and artifact edits after publication', () => {
    const published = release({ status: 'published' });
    expect(() =>
      validateReleaseUpdate(published, { selectedSkills: ['to-prd'] }),
    ).toThrow(/immutable/i);
    expect(() =>
      validateReleaseUpdate(published, { targetProjects: ['MaxView'] }),
    ).toThrow(/immutable/i);
    expect(() =>
      validateReleaseUpdate(published, { artifactVersion: '2.0.1' }),
    ).toThrow(/immutable/i);
  });
});
