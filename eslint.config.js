// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'extension/dist-types/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'local-data/**',
      'test-results/**',
      'playwright-report/**',
      'tests/fixtures/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Build-tool configs live outside every package tsconfig; type-aware
          // linting still applies to them via the default project.
          allowDefaultProject: [
            'vitest.config.ts',
            'playwright.config.ts',
            'extension/vite.config.ts',
            'extension/vite.content.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The model must never be handed loosely typed data; `any` defeats every
      // schema guarantee in shared/. Escape hatches require an inline reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/require-await': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['agent-server/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['extension/**/*.ts', 'extension/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
