import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // `bin/` is build output, same as `dist/` — the single-file CLI that `build:plugin`
  // produces for the plugin branch and for `init` to vendor. Linting it lints the bundler.
  { ignores: ['dist/', 'bin/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Build scripts run in Node directly, so they get Node's globals.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
);
