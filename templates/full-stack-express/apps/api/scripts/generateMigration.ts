import {
  classifyGenerate,
  formatMetaFiles,
  migrationsFolder,
  parseScriptArgs,
  runDrizzleKit,
  schemaFile,
} from './drizzleKit.ts';

const { root, rest } = parseScriptArgs(process.argv.slice(2));
const out = migrationsFolder(root);
const result = runDrizzleKit('generate', {
  schema: schemaFile(root),
  out,
  extra: rest,
});
process.stdout.write(result.output);
const outcome = classifyGenerate(result);
if (outcome === 'failed') {
  process.stderr.write('Migration generation failed.\n');
  process.exit(1);
}
if (outcome === 'written') {
  await formatMetaFiles(out);
}
