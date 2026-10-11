import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'prisma/migrations/**'] },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'prisma/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser: tsParser, parserOptions: { project: './tsconfig.json', sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
