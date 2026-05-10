import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'package-lock.json', 'index.js'],
  },
  {
    files: ['eslint.config.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        AbortController: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
    },
  }
);
