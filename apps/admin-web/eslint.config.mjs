import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

export default [{ ignores: ['dist/**'] }, { files: ['src/**/*.{ts,tsx}'], languageOptions: { parser: tsParser, parserOptions: { sourceType: 'module', ecmaFeatures: { jsx: true } } }, plugins: { '@typescript-eslint': tseslint, 'react-hooks': reactHooks }, rules: { '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }], 'no-console': 'off' } }];
