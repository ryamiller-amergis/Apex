import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);

function findPackageRoot() {
  let current = path.dirname(require.resolve('@cursor/sdk'));

  while (current !== path.dirname(current)) {
    const manifestPath = path.join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === '@cursor/sdk') {
        return { manifest, packageRoot: current };
      }
    }
    current = path.dirname(current);
  }

  throw new Error('Unable to locate the installed @cursor/sdk package');
}

function normalizeDeclaration(text) {
  return text.replace(/\r\n/g, '\n').trim();
}

function loadSource(packageRoot, relativePath) {
  const absolutePath = path.join(packageRoot, ...relativePath.split('/'));
  const text = readFileSync(absolutePath, 'utf8');
  return ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function namedDeclaration(sourceFile, sourcePath, name, kind) {
  const node = sourceFile.statements.find(
    (statement) => statement.name?.getText(sourceFile) === name
  );
  if (!node) {
    throw new Error(`Missing ${name} in ${sourcePath}`);
  }
  return {
    name,
    kind,
    sourceFile: sourcePath,
    text: normalizeDeclaration(node.getText(sourceFile)),
  };
}

function interfaceMember(sourceFile, sourcePath, interfaceName, memberName) {
  const owner = sourceFile.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName
  );
  const member = owner?.members.find(
    (candidate) => candidate.name?.getText(sourceFile) === memberName
  );
  if (!member) {
    throw new Error(`Missing ${interfaceName}.${memberName} in ${sourcePath}`);
  }
  return {
    name: `${interfaceName}.${memberName}`,
    kind: 'property',
    sourceFile: sourcePath,
    text: normalizeDeclaration(member.getText(sourceFile)),
  };
}

function contract(runtimeModule, declarations, runtimeCandidates) {
  return {
    runtimeExports: runtimeCandidates
      .filter((name) => Object.hasOwn(runtimeModule, name))
      .sort(),
    sourceFiles: [
      ...new Set(declarations.map(({ sourceFile }) => sourceFile)),
    ].sort(),
    declarations,
  };
}

async function generateSnapshot() {
  const { manifest, packageRoot } = findPackageRoot();
  const optionsPath = 'dist/esm/options.d.ts';
  const stubsPath = 'dist/esm/stubs.d.ts';
  const options = loadSource(packageRoot, optionsPath);
  const stubs = loadSource(packageRoot, stubsPath);
  const runtimeModule = await import('@cursor/sdk');

  const contracts = {
    Agent: contract(
      runtimeModule,
      [
        namedDeclaration(stubs, stubsPath, 'Agent', 'class'),
        namedDeclaration(options, optionsPath, 'AgentOptions', 'interface'),
      ],
      ['Agent', 'AgentOptions']
    ),
    LocalAgent: contract(
      runtimeModule,
      [
        namedDeclaration(
          options,
          optionsPath,
          'LocalAgentOptions',
          'interface'
        ),
        namedDeclaration(options, optionsPath, 'LocalSendOptions', 'interface'),
      ],
      ['LocalAgent', 'LocalAgentOptions', 'LocalSendOptions']
    ),
    sandbox: contract(
      runtimeModule,
      [
        namedDeclaration(options, optionsPath, 'SandboxOptions', 'interface'),
        interfaceMember(
          options,
          optionsPath,
          'LocalAgentOptions',
          'sandboxOptions'
        ),
      ],
      ['SandboxOptions']
    ),
    trustedSettings: contract(
      runtimeModule,
      [
        namedDeclaration(options, optionsPath, 'SettingSource', 'type'),
        interfaceMember(
          options,
          optionsPath,
          'LocalAgentOptions',
          'settingSources'
        ),
      ],
      ['SettingSource']
    ),
  };

  return {
    schemaVersion: 1,
    package: {
      name: manifest.name,
      version: manifest.version,
    },
    runtime: {
      Agent: {
        exported: Object.hasOwn(runtimeModule, 'Agent'),
        staticMembers: Object.hasOwn(runtimeModule, 'Agent')
          ? Object.getOwnPropertyNames(runtimeModule.Agent)
              .filter((name) => !['length', 'name', 'prototype'].includes(name))
              .sort()
          : [],
      },
    },
    contracts,
  };
}

const snapshot = await generateSnapshot();
const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

if (process.argv.includes('--stdout')) {
  process.stdout.write(serialized);
} else {
  const outputPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    `cursor-sdk-${snapshot.package.version}.contract.json`
  );
  writeFileSync(outputPath, serialized, 'utf8');
  process.stdout.write(`${path.basename(outputPath)}\n`);
}
