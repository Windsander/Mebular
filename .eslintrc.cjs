// ESLint 配置（TypeScript 项目，ESM）
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
  rules: {
    // 与 strict TS 配合后的务实放宽
    '@typescript-eslint/no-explicit-any': 'off', // 图载荷/配置处保留显式 any
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off', // noUncheckedIndexedAccess 场景下人工把关
    'no-control-regex': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      env: { jest: true },
    },
    {
      files: ['scripts/**/*.mjs'],
      parserOptions: { sourceType: 'module' },
      rules: { '@typescript-eslint/no-var-requires': 'off' },
    },
  ],
};
