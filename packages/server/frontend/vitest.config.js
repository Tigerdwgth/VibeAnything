import { defineConfig } from 'vitest/config';

// 前端测试跑在 jsdom 里，为的是能真实挂载 xterm 并派发真实 DOM 事件 ——
// 「能不能选中 / 能不能点链接」这类基本特性靠纯函数单测测不出来（08-25 的回归
// 就是纯函数全对、事件接线错了），必须在真 DOM 上验。
export default defineConfig({
  // vitest 不走 vite.config.js 的 react 插件，JSX 默认编译成 React.createElement
  // （测试文件里没有 React 变量会直接 ReferenceError）。用 automatic runtime 与
  // 生产构建保持一致，组件测试才能像应用里那样渲染。
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup-jsdom.js'],
    // 手机版的组件测试用 .jsx 写（真渲染 React、派发真事件），所以两种后缀都收
    include: ['tests/**/*.test.js', 'tests/**/*.test.jsx'],
    globals: false,
    // xterm 的渲染会排 rAF/定时器，单条用例给足时间，避免 CI 上偶发超时
    testTimeout: 15000,
  },
});
