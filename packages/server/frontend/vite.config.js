import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // 两个独立入口：桌面版 index.html（/）与手机版 mobile.html（/m，路由见
      // packages/server/index.js）。它们各自是一棵完整的 React 应用，只共用 src/ 下的
      // 模块；手机版不是给桌面版打的响应式补丁。
      input: {
        main: resolve(here, 'index.html'),
        mobile: resolve(here, 'mobile.html'),
      },
      output: {
        // 两个入口共用的那块（React / xterm / src 下的公共模块）会被拆成一个
        // 独立 chunk，rollup 默认拿它里面第一个模块的名字命名 —— 排查线上产物时
        // 会看到「app-height-xxx.js 有 540KB」这种误导性文件名，显式叫 shared。
        chunkFileNames: 'assets/shared-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true }
    }
  }
});
