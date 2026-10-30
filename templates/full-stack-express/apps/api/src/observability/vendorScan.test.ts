import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const VENDOR_NAMES = [
  'aws-sdk',
  'xray',
  'cloudwatch',
  'awsemf',
  'applicationinsights',
  'azure-monitor',
  'datadog',
];

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
const thisFile = fileURLToPath(import.meta.url);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function scanForVendorNames(files: string[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const name of VENDOR_NAMES) {
      if (text.includes(name)) {
        findings.push(`${path.relative(apiRoot, file)} mentions ${name}`);
      }
    }
  }
  return findings;
}

function apiSourceFiles(): string[] {
  return [
    ...listFiles(path.join(apiRoot, 'src')).filter((file) => file !== thisFile),
    path.join(apiRoot, 'package.json'),
  ];
}

describe('vendor exporter scan', () => {
  it('VT-16 PBI-014 AC-3 BR-008 finds no cloud-vendor exporter in apps/api', () => {
    const findings = scanForVendorNames(apiSourceFiles());
    expect(findings, findings.join('\n')).toEqual([]);
  });

  it('VT-16 a seeded vendor name makes the scan fail with the file and name', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vendor-scan-'));
    try {
      const seeded = path.join(dir, 'seeded.ts');
      writeFileSync(
        seeded,
        "import x from '@azure/monitor-opentelemetry';\n// datadog\n"
      );
      const findings = scanForVendorNames([...apiSourceFiles(), seeded]);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('seeded.ts mentions datadog');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
