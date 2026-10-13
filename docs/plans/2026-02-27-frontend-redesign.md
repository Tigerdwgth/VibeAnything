# Frontend Redesign 设计文档

日期：2026-02-27
分支：feat/web-dashboard

## 目标

将现有 GitHub 暗色朴素风格全面升级为现代 SaaS 风格（参考 Vercel / Railway）。

## 色彩系统

| Token | 值 | 用途 |
|---|---|---|
| bg-base | #0a0a0f | 页面背景 |
| bg-panel | #111118 | 左侧面板 |
| bg-card | #1a1a2e | 卡片/悬停 |
| border | rgba(255,255,255,0.08) | 边框 |
| accent | #6366f1 | 主色（靛紫） |
| success | #10b981 | 连接成功 |
| danger | #ef4444 | 错误/断线 |
| text-primary | #f1f5f9 | 主文字 |
| text-secondary | #94a3b8 | 次要文字 |
| text-muted | #475569 | 弱文字 |

## 排版

- 字体：`Inter, system-ui, sans-serif`（终端区域保留 monospace）
- 圆角：卡片 8px，按钮 6px，弹窗 12px，pill 9999px

## 各组件改动

### Login.jsx
- 背景加 SVG 网格纹 + 径向渐变光晕
- 卡片加 backdrop-filter 毛玻璃 + 微妙边框光
- 顶部加 Claude Code 品牌 logo 区域

### Dashboard.jsx
- 左栏宽度 240px，顶部加 logo + 机器连接 badge
- 连接状态改为带文字的 badge（"已连接" / "连接中…"）
- 右侧顶栏加面包屑 + 视图切换 pill

### SessionTabs.jsx
- Tab 改为 pill 胶囊样式
- Session 条目加 hover 时的卡片浮起效果
- 机器名改为带颜色点的 badge

### FileBrowser.jsx
- 目录条目加文件夹 icon
- 最近目录改为横向标签云

### AddUser.jsx
- 改为居中 modal + 半透明遮罩

## 实施顺序

1. 提取 `theme.js` 色彩常量
2. Login.jsx
3. Dashboard.jsx
4. SessionTabs.jsx
5. FileBrowser.jsx
6. AddUser.jsx
7. 重新构建 + 验证
