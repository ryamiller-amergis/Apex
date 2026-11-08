import { ESLint, RuleTester } from 'eslint';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import rule from './eslint/no-hardcoded-color.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const reported = [{ messageId: 'hardcodedColor' }];

describe('VT-07 PBI-017 AC-3 no-hardcoded-color rule', () => {
  ruleTester.run('no-hardcoded-color', rule, {
    valid: [
      "const sx = { color: 'primary.main' };",
      'const sx = { color: theme.vars.palette.text.primary };',
      'const href = "#main-content";',
      "const label = 'Profile';",
    ],
    invalid: [
      {
        code: "const el = <Box sx={{ color: '#ff0000' }} />;",
        errors: reported,
      },
      { code: "const shadow = 'rgb(0,0,0)';", errors: reported },
      { code: "const shadow = 'rgba(0, 0, 0, 0.4)';", errors: reported },
      { code: "const fill = 'hsl(0 0% 0%)';", errors: reported },
      { code: "const fill = 'hsla(0, 0%, 0%, 0.5)';", errors: reported },
      { code: "const border = '1px solid #FFF';", errors: reported },
      { code: 'const fill = `hsl(${hue} 50% 50%)`;', errors: reported },
      { code: 'const el = <div color="#123456" />;', errors: reported },
    ],
  });
});

const templateRoot = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({
  cwd: templateRoot,
  overrideConfigFile: path.join(templateRoot, 'eslint.config.mjs'),
});

async function ruleIdsFor(relativePath, text) {
  const results = await eslint.lintText(text, {
    filePath: path.join(templateRoot, relativePath),
  });
  return results.flatMap((result) =>
    result.messages.map((message) => message.ruleId)
  );
}

const sample = "export const sx = { color: '#ff0000' };\n";

describe('VT-07 no-hardcoded-color workspace scope', () => {
  it('reports a colour literal in apps/web/src', async () => {
    expect(await ruleIdsFor('apps/web/src/Fixture.tsx', sample)).toContain(
      'design-tokens/no-hardcoded-color'
    );
  });

  it('reports a colour literal in packages/ui/src', async () => {
    expect(
      await ruleIdsFor('packages/ui/src/shell/Fixture.tsx', sample)
    ).toContain('design-tokens/no-hardcoded-color');
  });

  it('allows the same literal in packages/ui/src/tokens', async () => {
    expect(
      await ruleIdsFor('packages/ui/src/tokens/fixture.ts', sample)
    ).not.toContain('design-tokens/no-hardcoded-color');
  });

  it('allows the same literal in the web token override module', async () => {
    expect(
      await ruleIdsFor('apps/web/src/theme/overrides.ts', sample)
    ).not.toContain('design-tokens/no-hardcoded-color');
  });
});
