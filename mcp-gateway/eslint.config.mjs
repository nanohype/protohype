import tseslint from 'typescript-eslint';

export default [
  ...tseslint.configs.recommended,
  {
    files: ['lib/**/*.ts', 'bin/**/*.ts', 'lambda/**/*.ts'],
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'cdk.out/**', 'coverage/**', 'dashboard/**', '**/*.js', '**/*.d.ts'],
  },
];
