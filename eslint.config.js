import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/migrations/**', 'apps/miniapp/**', 'apps/web/**', 'apps/console/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 金额、数量、单价禁止使用 JS 浮点数
      'no-restricted-globals': ['error', { name: 'parseFloat', message: '金额与数量请使用 decimal.js' }],
    },
  },
)
