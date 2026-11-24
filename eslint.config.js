// Layer rules (docs/ARCHITECTURE.md §7): core depends on nothing; plugins depend on core only; app/cli compose.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PLUGIN_LAYERS = ['channels', 'connectors', 'skills', 'mobile'];
const deny = (layers, message) => layers.map((l) => ({ group: [`**/${l}`, `**/${l}/**`], message }));

const restrict = (patterns, extraPaths = []) => ({
  'no-restricted-imports': ['error', { patterns, paths: extraPaths }],
});

const discordOnly = { name: 'discord.js', message: 'Only src/channels/discord may import discord.js.' };
const cliOnly = { name: 'qrcode', message: 'Only src/cli may import qrcode.' };
const vendorSdks = [discordOnly, cliOnly];

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/', 'bin/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: restrict(deny([...PLUGIN_LAYERS, 'app', 'cli'], 'core must not depend on outer layers.'), vendorSdks),
  },
  ...PLUGIN_LAYERS.map((layer) => ({
    files: [`src/${layer}/**/*.ts`],
    rules: restrict(
      deny([...PLUGIN_LAYERS.filter((l) => l !== layer), 'app', 'cli'], `${layer} may import only core.`),
      layer === 'channels' ? [] : vendorSdks,
    ),
  })),
  {
    files: ['src/app/**/*.ts'],
    rules: restrict(deny(['cli'], 'app must not depend on cli.'), vendorSdks),
  },
  {
    files: ['src/cli/**/*.ts'],
    rules: { 'no-console': 'off', ...restrict([], [discordOnly]) },
  },
  {
    files: ['src/core/**/types.ts'],
    rules: { '@typescript-eslint/no-invalid-void-type': 'off' },
  },
  {
    files: ['test/**/*.ts', '**/*.test.ts'],
    rules: { 'max-lines': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  { files: ['eslint.config.js', 'vitest.config.ts'], ...tseslint.configs.disableTypeChecked },
);
