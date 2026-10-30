// @vitest-environment node
//
// 手机版入口的构建契约。
//
// 这一条跑在 node 环境而不是 jsdom：它要 import 真实的 vite.config.js（连带
// @vitejs/plugin-react → esbuild），而 esbuild 在 jsdom 的全局下会因为
// TextEncoder 不是同一个 realm 的 Uint8Array 直接拒绝加载。
//
// 这几条要么错了一眼看不出来（少一个 viewport-fit，iOS 上就是两侧留黑边），
// 要么错了整个页面直接没了（vite 少一个 input，dist 里就没有 mobile.html，
// 服务端 /m 路由会吐 503）。都属于「不测就会悄悄坏掉」的东西，所以直接读真文件。

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const html = read('mobile.html');

describe('mobile.html', () => {
  test('挂的是手机版自己的入口脚本，不是桌面版的', () => {
    expect(html).toMatch(/src="\/src\/mobile\/main\.jsx"/);
    expect(html).not.toMatch(/src="\/src\/main\.jsx"/);
  });

  test('viewport-fit=cover —— 不加它 iOS 会把整页缩进安全区，两侧留黑边', () => {
    const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)?.[1];
    expect(viewport).toBeTruthy();
    expect(viewport).toContain('width=device-width');
    expect(viewport).toContain('viewport-fit=cover');
  });

  test('安全区四个方向都有变量，且取自 env(safe-area-inset-*)', () => {
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(html).toMatch(new RegExp(`--safe-${side}:\\s*env\\(safe-area-inset-${side}`));
    }
  });

  test('高度用 --app-height，不是裸 100vh', () => {
    expect(html).toMatch(/--app-height/);
    expect(html).toMatch(/height:\s*var\(--app-height\)/);
  });

  test('「添加到主屏幕」后像个 App：独立窗口 + 标题 + manifest', () => {
    expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/);
    expect(html).toMatch(/<meta\s+name="mobile-web-app-capable"\s+content="yes"/);
    expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-title"\s+content="VibeAnything"/);
    expect(html).toMatch(/rel="manifest"\s+href="\/mobile\.webmanifest"/);
  });

  test('品牌与图标与桌面版一致', () => {
    expect(html).toMatch(/<title>VibeAnything<\/title>/);
    expect(html).toMatch(/href="\/usagi\.png"/);
    expect(html).toMatch(/href="\/favicon-32\.png"/);
    expect(html).toMatch(/rel="apple-touch-icon"\s+href="\/apple-touch-icon\.png"/);
  });

  test('关掉 iOS 的电话号码自动识别 —— 终端输出里全是数字', () => {
    expect(html).toMatch(/<meta\s+name="format-detection"\s+content="telephone=no"/);
  });
});

describe('mobile.webmanifest', () => {
  const manifest = JSON.parse(read('public/mobile.webmanifest'));

  test('从主屏幕启动时进的是 /m，而且是独立窗口', () => {
    expect(manifest.start_url).toBe('/m');
    expect(manifest.display).toBe('standalone');
  });

  test('图标指向仓库里真实存在的那三个文件', () => {
    const srcs = manifest.icons.map(i => i.src);
    expect(srcs).toContain('/usagi.png');
    expect(srcs).toContain('/apple-touch-icon.png');
    expect(srcs).toContain('/favicon-32.png');
    for (const icon of manifest.icons) {
      expect(() => read(`public${icon.src}`)).not.toThrow();
    }
  });
});

describe('vite 多入口', () => {
  const input = viteConfig.build.rollupOptions.input;

  test('桌面版、手机版与多节点总览各自是一个入口', () => {
    expect(Object.keys(input).sort()).toEqual(['main', 'mobile', 'nodes']);
    expect(input.main).toMatch(/index\.html$/);
    expect(input.mobile).toMatch(/mobile\.html$/);
    expect(input.nodes).toMatch(/nodes\.html$/);
  });

  test('各个入口指向的 html 都真实存在', () => {
    expect(() => readFileSync(input.main, 'utf8')).not.toThrow();
    expect(() => readFileSync(input.mobile, 'utf8')).not.toThrow();
    expect(() => readFileSync(input.nodes, 'utf8')).not.toThrow();
  });

  test('共用 chunk 有个说得清的名字（排查线上产物时不至于被误导）', () => {
    expect(viteConfig.build.rollupOptions.output.chunkFileNames).toMatch(/shared-\[hash\]\.js$/);
  });
});
