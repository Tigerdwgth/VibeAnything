# PRD: Session 列表 UI 优化

## Introduction

优化 Dashboard 左侧面板 session 列表的视觉细节：将关闭按钮（红色 ■）固定到行最右侧，并移除 sessionId 中无意义的 tmux 前缀（如 `cc-`、`codex-` 等），使列表更简洁、操作更直观。

## Goals

- 关闭按钮始终靠右对齐，视觉上统一整齐
- 去除 sessionId 显示中的工具前缀（`cc-`、`codex-` 等），减少冗余信息
- 所有三个标签页（已打开、运行中、历史）统一应用

## User Stories

### US-001: 关闭按钮靠右对齐
**Description:** 作为用户，我希望 session 列表中的红色关闭按钮固定在行的最右侧，这样视觉整齐且容易定位点击。

**Acceptance Criteria:**
- [ ] "已打开"标签页中，红色 ■ 按钮通过 `marginLeft: auto` 推到行最右侧
- [ ] "运行中"标签页中，红色 ■ 按钮同样靠右对齐
- [ ] 按钮位置不受 sessionId 长度或 cwd 长度影响，始终在最右端
- [ ] 移动端触摸目标大小不受影响

### US-002: 去除 sessionId 的 tmux 前缀
**Description:** 作为用户，我不想看到 sessionId 中的 `cc-`、`codex-` 等前缀，因为 ToolBadge 已经显示了工具类型，前缀是冗余信息。

**Acceptance Criteria:**
- [ ] "已打开"标签页中，`sessionId.slice(0, 7)` 显示前先去除 `cc-`、`codex-`、`gemini-` 等已知前缀
- [ ] "运行中"标签页中，同样去除前缀
- [ ] "历史"标签页中不显示 sessionId（当前已经不显示，确认保持现状）
- [ ] 去除前缀后仍然截取前 7 个字符，保证显示长度一致
- [ ] 对于没有前缀的 sessionId（如纯 UUID），显示逻辑不变

## Functional Requirements

- FR-1: 在 `SessionTabs.jsx` 中新增一个 `stripSessionPrefix(sessionId)` 工具函数，移除已知前缀（`cc-`、`codex-`、`gemini-`、`bash-`、`zsh-`）后返回剩余部分
- FR-2: `OpenedTab` 和 `RunningTab` 中 sessionId 显示改为 `stripSessionPrefix(sessionId).slice(0, 7)`
- FR-3: `OpenedTab` 中红色 ■ 按钮添加 `marginLeft: auto` 样式，使其推到 flex 行末尾
- FR-4: `RunningTab` 中红色 ■ 按钮同样添加 `marginLeft: auto`（注意此处按钮前还有时间戳，确保按钮在时间戳之后靠右）

## Non-Goals

- 不修改历史标签页的布局（其已有不同的两行布局和操作按钮组）
- 不修改 ToolBadge 组件
- 不修改后端 `tmuxName()` 函数或 sessionId 生成逻辑
- 不修改移动端专属样式

## Technical Considerations

- 修改仅涉及 `packages/server/frontend/src/SessionTabs.jsx` 一个文件
- `itemStyle` 已经是 `display: flex`，加 `marginLeft: auto` 即可实现靠右
- 前缀列表应与 `TOOL_STYLE` 对象的 key 保持一致（当前有 cc、codex、gemini、bash、zsh）
- 修改完需 `npm run build` 重新构建前端并部署到服务器

## Success Metrics

- 红色关闭按钮在各行宽下始终右对齐
- sessionId 显示更有意义（去掉无信息量的前缀后展示时间戳或唯一标识部分）

## Open Questions

- 无
