import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
// Dùng import * as để đảm bảo tương thích
import * as tseslint from 'typescript-eslint';

import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';

export default tseslint.config(
  // Bỏ qua các file không cần lint
  {
    ignores: ['dist/', 'node_modules/', 'eslint.config.mjs'],
  },

  // Cấu hình ESLint cơ bản
  eslint.configs.recommended,

  // Sử dụng hàm trợ giúp tseslint.config để tạo cấu hình cho TypeScript
  // Đây là cách làm đúng chuẩn và ổn định nhất
  ...tseslint.config({
    files: ['**/*.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unicorn': unicorn,
    },
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-misused-spread': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'unicorn/prevent-abbreviations': 'off',
      'no-console': ['warn', { 'allow': ['warn', 'error'] }],
      'eqeqeq': 'error',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@/lines-between-class-members': [
        'error',
        'always',
        { 'exceptAfterSingleLine': true }
      ],
    },
  }),

  // Cấu hình cho môi trường runtime
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },

  // Cấu hình Prettier (LUÔN ĐỂ CUỐI CÙNG)
  eslintConfigPrettier,
);