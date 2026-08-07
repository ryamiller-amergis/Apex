import { gunzipSync } from 'zlib';
import fs from 'fs';
import path from 'path';
import { posix as posixPath } from 'path';
import type {
  FoundationSkillArtifactManifest,
  FoundationSkillArtifactManifestSkill,
  FoundationSkillRelease,
} from '../../shared/types/foundationSkills';
import {
  FoundationSkillReleaseValidationError,
  collectFoundationSkillValidationIssues,
} from '../../shared/foundationSkillDependencies';

const CATALOG_PATH = 'package/catalog.json';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED_TAR_BYTES = 128 * 1024 * 1024;

/** Read and normalize catalog.json directly from an npm .tgz buffer. */
export function extractCatalogFromNpmTarball(
  tarball: Buffer,
): FoundationSkillArtifactManifest {
  const tar = inflateTarball(tarball);
  let offset = 0;
  let manifest: FoundationSkillArtifactManifest | null = null;
  const archiveFiles = new Set<string>();
  const regularFiles = new Set<string>();

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const rawName = prefix ? `${prefix}/${name}` : name;
    if (rawName.startsWith('/') || rawName.includes('\\')) {
      throw new Error(`Artifact contains an unsafe tar path: ${rawName}`);
    }
    const fullName = posixPath.normalize(rawName);
    if (fullName === '..' || fullName.startsWith('../')) {
      throw new Error(`Artifact tar path escapes package root: ${rawName}`);
    }
    if (!fullName.startsWith('package/')) {
      throw new Error(`Artifact tar path is outside package/: ${fullName}`);
    }
    if (archiveFiles.has(fullName)) {
      throw new Error(`Artifact contains duplicate tar path: ${fullName}`);
    }
    archiveFiles.add(fullName);
    const sizeText = readString(header, 124, 12).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${fullName}`);
    }

    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) {
      throw new Error(`Truncated npm artifact entry: ${fullName}`);
    }

    const typeFlag = header[156];
    const regular = typeFlag === 0 || typeFlag === '0'.charCodeAt(0);
    const directory = typeFlag === '5'.charCodeAt(0);
    if (!regular && !directory) {
      throw new Error(`Artifact tar entry type is not allowed: ${fullName}`);
    }
    if (regular) regularFiles.add(fullName);

    if (fullName === CATALOG_PATH) {
      if (!regular) throw new Error('Artifact catalog.json must be a regular tar entry');
      if (manifest) {
        throw new Error(`Artifact contains duplicate ${CATALOG_PATH} entries`);
      }
      if (size > MAX_MANIFEST_BYTES) {
        throw new Error('catalog.json exceeds the 2 MB safety limit');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(tar.subarray(contentStart, contentEnd).toString('utf8'));
      } catch {
        throw new Error('Artifact catalog.json is not valid JSON');
      }
      manifest = normalizeManifest(parsed);
    }

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  if (!manifest) {
    throw new Error(`Artifact does not contain ${CATALOG_PATH}`);
  }
  validateDeclaredFiles(manifest, regularFiles);
  return manifest;
}

/** Extract only regular files/directories under package/ without following links. */
export function extractNpmTarballSafely(
  tarball: Buffer,
  destination: string,
): void {
  const tar = inflateTarball(tarball);
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  const seen = new Set<string>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = canonicalTarPath(prefix ? `${prefix}/${name}` : name);
    if (!fullName.startsWith('package/')) {
      throw new Error(`Artifact tar path is outside package/: ${fullName}`);
    }
    if (seen.has(fullName)) {
      throw new Error(`Artifact contains duplicate tar path: ${fullName}`);
    }
    seen.add(fullName);

    const sizeText = readString(header, 124, 12).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (!Number.isFinite(size) || size < 0 || contentEnd > tar.length) {
      throw new Error(`Invalid or truncated tar entry: ${fullName}`);
    }

    const typeFlag = header[156];
    const regular = typeFlag === 0 || typeFlag === '0'.charCodeAt(0);
    const directory = typeFlag === '5'.charCodeAt(0);
    if (!regular && !directory) {
      throw new Error(`Artifact tar entry type is not allowed: ${fullName}`);
    }

    const output = path.resolve(root, ...fullName.split('/'));
    const relative = path.relative(root, output);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Artifact tar path escapes destination: ${fullName}`);
    }
    if (directory) {
      fs.mkdirSync(output, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, tar.subarray(contentStart, contentEnd), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
}

export function validateReleaseArtifactManifest(
  release: FoundationSkillRelease,
  manifest: FoundationSkillArtifactManifest,
): void {
  if (manifest.package !== release.artifactPackage) {
    throw new Error(
      `Artifact package mismatch: expected ${release.artifactPackage}, got ${manifest.package}`,
    );
  }
  if (
    manifest.suiteVersion !== release.version ||
    manifest.suiteVersion !== release.artifactVersion
  ) {
    throw new Error(
      `Artifact suite version ${manifest.suiteVersion} does not match ` +
      `release/artifact version ${release.version}/${release.artifactVersion}`,
    );
  }
  if (manifest.contractApiVersion !== release.contractApiVersion) {
    throw new Error(
      `Artifact contract API version ${manifest.contractApiVersion} does not match ` +
      `release contract API version ${release.contractApiVersion}`,
    );
  }

  const byName = new Map(manifest.skills.map((skill) => [skill.name, skill]));
  validateManifestDependencyGraph(manifest.skills, byName);
  const effective = new Set(release.selectedSkills);
  for (const skill of manifest.skills) {
    if (skill.alwaysInstall) effective.add(skill.name);
  }

  for (const name of effective) {
    const skill = byName.get(name);
    if (!skill) {
      throw new Error(`Release selects skill "${name}" absent from the artifact manifest`);
    }
    if (skill.tier === 'apex-only') {
      throw new Error(`Release cannot include apex-only skill "${name}"`);
    }
  }

  const issues = collectFoundationSkillValidationIssues({
    skills: manifest.skills,
    selectedSkills: [...effective],
    targetProjects: release.targetProjects,
    skillTargets: release.skillTargets,
  });
  if (issues.length > 0) {
    throw new FoundationSkillReleaseValidationError(issues);
  }
}

export function validateReleaseUpdate(
  release: FoundationSkillRelease,
  input: Record<string, unknown>,
): void {
  if (release.status === 'draft') return;
  if (release.status === 'publishing') {
    throw new Error('Release is publishing and cannot be edited');
  }

  const mutable = new Set(['releaseNotes', 'breakingChanges']);
  const immutableFields = Object.keys(input).filter((key) => !mutable.has(key));
  if (immutableFields.length) {
    throw new Error(
      `Published release fields are immutable: ${immutableFields.join(', ')}`,
    );
  }
}

function normalizeManifest(value: unknown): FoundationSkillArtifactManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('Artifact catalog.json must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.suiteVersion !== 'string' ||
    typeof raw.package !== 'string' ||
    typeof raw.contractApiVersion !== 'number' ||
    !Array.isArray(raw.skills)
  ) {
    throw new Error('Artifact catalog.json is missing required manifest fields');
  }

  const skills = raw.skills.map(normalizeSkill);
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new Error(`Artifact catalog contains duplicate skill "${skill.name}"`);
    }
    names.add(skill.name);
  }

  return {
    suiteVersion: raw.suiteVersion,
    package: raw.package,
    contractApiVersion: raw.contractApiVersion,
    skills,
  };
}

function normalizeSkill(value: unknown): FoundationSkillArtifactManifestSkill {
  if (!value || typeof value !== 'object') {
    throw new Error('Artifact catalog contains an invalid skill entry');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== 'string' || typeof raw.summary !== 'string') {
    throw new Error('Artifact catalog skill is missing name or summary');
  }
  if (
    raw.tier !== undefined &&
    raw.tier !== 'shippable' &&
    raw.tier !== 'apex-only'
  ) {
    throw new Error(`Artifact catalog skill "${raw.name}" has invalid tier`);
  }
  if (
    raw.alwaysInstall !== undefined &&
    typeof raw.alwaysInstall !== 'boolean'
  ) {
    throw new Error(
      `Artifact catalog skill "${raw.name}" has invalid alwaysInstall`,
    );
  }
  if (
    raw.dependsOn !== undefined &&
    (
      !Array.isArray(raw.dependsOn) ||
      raw.dependsOn.some((item) => typeof item !== 'string')
    )
  ) {
    throw new Error(`Artifact catalog skill "${raw.name}" has invalid dependsOn`);
  }
  const tier = raw.tier === 'apex-only' ? 'apex-only' : 'shippable';
  return {
    ...(raw as unknown as FoundationSkillArtifactManifestSkill),
    name: raw.name,
    summary: raw.summary,
    tier,
    alwaysInstall: raw.alwaysInstall === true,
    dependsOn: (raw.dependsOn as string[] | undefined) ?? [],
  };
}

function validateManifestDependencyGraph(
  skills: FoundationSkillArtifactManifestSkill[],
  byName: Map<string, FoundationSkillArtifactManifestSkill>,
): void {
  for (const skill of skills) {
    for (const dependency of skill.dependsOn) {
      if (!byName.has(dependency)) {
        throw new Error(`Skill "${skill.name}" depends on unknown skill "${dependency}"`);
      }
      if (dependency === skill.name) {
        throw new Error(`Skill "${skill.name}" cannot depend on itself`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Artifact manifest contains a dependency cycle at "${name}"`);
    }
    visiting.add(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const skill of skills) visit(skill.name);
}

function verifyTarChecksum(header: Buffer): void {
  const storedText = readString(header, 148, 8).trim();
  const stored = Number.parseInt(storedText || '0', 8);
  const copy = Buffer.from(header);
  copy.fill(' ', 148, 156);
  const actual = [...copy].reduce((sum, byte) => sum + byte, 0);
  if (!Number.isFinite(stored) || stored !== actual) {
    throw new Error('Artifact contains a tar entry with an invalid checksum');
  }
}

function validateDeclaredFiles(
  manifest: FoundationSkillArtifactManifest,
  archiveFiles: Set<string>,
): void {
  for (const skill of manifest.skills) {
    for (const relative of skill.foundationFiles ?? []) {
      const expected = `package/foundation/${skill.name}/${relative}`;
      if (!archiveFiles.has(expected)) {
        throw new Error(`Artifact is missing declared file ${expected}`);
      }
    }
    for (const relative of skill.adapterFiles ?? []) {
      const expected = `package/adapters/${skill.name}/${relative}`;
      if (!archiveFiles.has(expected)) {
        throw new Error(`Artifact is missing declared file ${expected}`);
      }
    }
  }
}

function readString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end >= start && end < start + length ? end : start + length;
  return buffer.subarray(start, boundedEnd).toString('utf8');
}

function inflateTarball(tarball: Buffer): Buffer {
  return gunzipSync(tarball, {
    maxOutputLength: MAX_UNCOMPRESSED_TAR_BYTES,
  });
}

function canonicalTarPath(rawName: string): string {
  if (rawName.startsWith('/') || rawName.includes('\\')) {
    throw new Error(`Artifact contains an unsafe tar path: ${rawName}`);
  }
  const normalized = posixPath.normalize(rawName);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`Artifact tar path escapes package root: ${rawName}`);
  }
  return normalized;
}
