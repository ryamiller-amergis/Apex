/**
 * FEAT-007 / S1 — shared Playbook definition lifecycle contracts (TBI-030, TBI-031, PBI-006).
 *
 * Source-bound so Jest can fail RED before the DTOs exist; the shapes match the reviewed
 * playbook-definition-version-lifecycle tech-spec Shared contracts table.
 */
import fs from 'node:fs';
import path from 'node:path';

const typesPath = path.resolve(process.cwd(), 'src/shared/types/playbook.ts');

describe('FEAT-007 S1 — Playbook definition lifecycle shared contracts', () => {
  const source = fs.readFileSync(typesPath, 'utf8');

  it('TBI-030 / PBI-006 AC — PlaybookDefinitionVersion carries updatedAt for draft concurrency', () => {
    expect(source).toMatch(
      /export interface PlaybookDefinitionVersion\s*\{[\s\S]*?\bupdatedAt:\s*string;/,
    );
  });

  it('TBI-031 DoD — PlaybookRun stores versionPinReason for explicit pins', () => {
    expect(source).toMatch(
      /export interface PlaybookRun\s*\{[\s\S]*?\bversionPinReason:\s*string\s*\|\s*null;/,
    );
  });

  it('TBI-030 / PBI-006 — exposes definition list, detail, draft, and published-version DTOs', () => {
    for (const name of [
      'PlaybookDefinitionSummary',
      'PlaybookDefinitionDraft',
      'PlaybookPublishedVersionSummary',
      'PlaybookDefinitionDetail',
      'PlaybookDefinitionListResult',
      'PlaybookDefinitionDraftResponse',
      'PlaybookPublishResponse',
      'PlaybookDeprecateVersionResponse',
    ]) {
      expect(source).toMatch(new RegExp(`export interface ${name}\\b`));
    }

    expect(source).toMatch(
      /export interface PlaybookDefinitionSummary\s*\{[\s\S]*?\bdraftUpdatedAt:\s*string;[\s\S]*?\bcurrentPublishedVersionNumber:\s*number\s*\|\s*null;/,
    );
    expect(source).toMatch(
      /export interface PlaybookDefinitionDraft\s*\{[\s\S]*?\bnextVersionNumber:\s*number;[\s\S]*?\bupdatedAt:\s*string;/,
    );
    expect(source).toMatch(
      /export interface PlaybookPublishResponse\s*\{[\s\S]*?\bpublishedVersion:[\s\S]*?\bdraft:[\s\S]*?\bcurrentPublishedVersionId:/,
    );
  });

  it('TBI-031 / VT-12 / VT-14 / VT-15 — StartRun request and result expose pin fields', () => {
    expect(source).toMatch(/export interface StartRunRequest\b/);
    expect(source).toMatch(/export interface StartRunResult\b/);
    expect(source).toMatch(
      /export interface StartRunRequest\s*\{[\s\S]*?\bdefinitionVersionId\?:\s*string;[\s\S]*?\bversionPinReason\?:\s*string;/,
    );
    expect(source).toMatch(
      /export interface StartRunResult\s*\{[\s\S]*?\brunId:\s*string;[\s\S]*?\bstatus:[\s\S]*?\bdefinitionVersionId:\s*string;/,
    );
  });

  it('keeps Apex vocabulary and does not import engine packages', () => {
    expect(source).not.toMatch(/from\s+['"][^'"]*playbook[_-]?engine/i);
    expect(source).not.toMatch(/from\s+['"]@?[^'"]*temporal/i);
    expect(source).toMatch(/Apex-vocabulary contracts for playbook orchestration/);
  });
});
