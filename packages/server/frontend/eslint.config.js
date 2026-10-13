import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // 本项目大量 `try { 尽力而为 } catch {}` 是有意为之（DOM/剪贴板/已卸载组件等
      // 失败了也只能忽略），不该为了过 lint 逐处塞空注释。其余空块仍然报错。
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 测试跑在 jsdom + vitest 下：既有浏览器全局，也有 node 全局
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
])
