# PRD: 日间/夜间模式切换

## Introduction

在 Web Dashboard 右上角增加主题切换按钮，支持日间（浅灰）和夜间（深黑）两种模式。用户偏好持久化到 `localStorage`，刷新后保持。

## Goals

- 右上角一键切换日间/夜间模式
- 日间模式：浅灰背景（`#f4f4f5`）+ 深色文字
- 夜间模式：保持现有深空 SaaS 配色
- 偏好持久化，刷新不丢失

## User Stories

### US-001: 主题 token 扩展
**Description:** 作为开发者，我需要在 `theme.js` 中为日间模式定义完整的色彩 token，以便所有组件统一切换。

**Acceptance Criteria:**
- [ ] `theme.js` 导出 `DARK` 和 `LIGHT` 两套 token 对象
- [ ] `LIGHT` 包含：bgBase `#f4f4f5`、bgPanel `#ffffff`、bgCard `#ffffff`、bgHover `#f0f0f2`、bgInput `#f9f9fb`、border `rgba(0,0,0,0.08)`、textPrimary `#111118`、textSecondary `#4b5563`、textMuted `#9ca3af`，其余 accent/success/danger 保持不变
- [ ] 导出 `getTheme(isDark: boolean)` 函数返回对应 token

### US-002: 主题状态管理
**Description:** 作为用户，我希望主题偏好在刷新后保持，不需要每次重新设置。

**Acceptance Criteria:**
- [ ] `App.jsx` 中用 `useState` + `localStorage` 管理 `isDark` 状态，初始值读取 `localStorage.getItem('theme') === 'light'` 的反值（默认夜间）
- [ ] 切换时同步写入 `localStorage.setItem('theme', isDark ? 'dark' : 'light')`
- [ ] `token` 通过 props 或 Context 传递给 `Dashboard`

### US-003: 切换按钮 UI
**Description:** 作为用户，我想在 Dashboard 右上角看到一个清晰的主题切换按钮，一眼知道当前模式。

**Acceptance Criteria:**
- [ ] 按钮位于 Dashboard 顶栏右侧，视图切换 pill 左边
- [ ] 夜间模式显示 `☀` 图标（点击切换到日间），日间模式显示 `🌙` 图标（点击切换到夜间）
- [ ] 按钮样式与现有 view-pill 一致（同款圆角、hover 效果）
- [ ] Verify in browser using dev-browser skill

### US-004: 全组件主题适配
**Description:** 作为用户，我希望切换主题后所有页面（Login、Dashboard、SessionTabs、FileBrowser、AddUser）都正确响应，没有残留的硬编码颜色。

**Acceptance Criteria:**
- [ ] `Dashboard.jsx`、`SessionTabs.jsx`、`FileBrowser.jsx`、`AddUser.jsx` 均接收 `theme` prop（或通过 Context），替换所有 `T.xxx` 引用
- [ ] `Login.jsx` 读取 `localStorage` 初始化主题，独立适配
- [ ] 日间模式下背景、文字、边框、卡片颜色均正确
- [ ] 无硬编码的 `#0a0a0f`、`#111118` 等颜色残留在 JSX 中
- [ ] Verify in browser using dev-browser skill

## Functional Requirements

- FR-1: `theme.js` 导出 `DARK`、`LIGHT` 两套 token 和 `getTheme()` 函数
- FR-2: `App.jsx` 管理全局 `isDark` 状态，初始值从 `localStorage` 读取，默认 `true`（夜间）
- FR-3: 切换时写入 `localStorage`，key 为 `theme`，值为 `'dark'` 或 `'light'`
- FR-4: `Dashboard` 顶栏右侧增加切换按钮，图标随模式变化
- FR-5: 所有组件通过 props 接收 `theme` 对象，不再直接 `import { T }`（或用 React Context）
- FR-6: 日间模式 `LIGHT` 配色：bgBase `#f4f4f5`，bgPanel `#ffffff`，bgCard `#ffffff`，bgHover `#f0f0f2`，bgInput `#f9f9fb`，border `rgba(0,0,0,0.08)`，textPrimary `#111118`，textSecondary `#4b5563`，textMuted `#9ca3af`

## Non-Goals

- 不支持跟随系统主题（`prefers-color-scheme`）自动切换
- 不支持自定义主题色
- 不涉及 PixelView / PixelApp 组件的主题适配

## Design Considerations

- 切换按钮复用现有 `view-pill` 样式，保持视觉一致
- 日间模式 accent 色 `#6366f1` 保持不变，保证品牌一致性
- 过渡动画：`transition: background 0.2s, color 0.2s` 加在根容器上，切换时平滑

## Technical Considerations

- 推荐用 **React Context**（`ThemeContext`）传递 token，避免 props drilling 穿透多层组件
- `theme.js` 改动：原 `export const T` 保留为 `DARK` 的别名，向后兼容
- 构建后需验证 dist 正常

## Success Metrics

- 切换响应 < 100ms（纯 CSS 变量切换）
- 所有页面无白屏/闪烁
- localStorage 持久化验证：刷新后主题不变

## Open Questions

- 无
