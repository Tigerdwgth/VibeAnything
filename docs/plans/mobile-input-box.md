# 手机终端输入框 & 工具栏重构方案

日期: 2026-03-18
状态: 待实施
影响文件: `packages/server/frontend/src/TerminalPanel.jsx`

## 背景与问题

### P0: 手机输入体验差
- 当前依赖 xterm 内部隐藏 textarea 弹出手机键盘，需要先点「⌨↑」按钮才能打字，操作链路长且不直观
- xterm textarea 的 `inputMode="none"` + `readonly` hack 导致各机型兼容性问题

### P1: 工具栏在手机上显示不全
- 当前工具栏分 3 行（/clear + /compact | 方向键 | 控制键+复制粘贴），第二行控制键在小屏手机上被截断看不到

### P1: 桌面端点击终端无法定位光标
- 当前 tap-to-position 只绑定了 touch 事件（touchstart/touchend），桌面鼠标 click 没有对应处理

## 技术方案

### 1. 新增独立输入框（替代 xterm 隐藏 textarea）

在终端区域底部新增一个始终可见的 `<input type="text">` 输入框。

#### 布局结构变更

```
┌─────────────────────────┐
│     xterm 终端区域       │  ← flex: 1, 占满剩余空间
│                         │
├─────────────────────────┤
│  [输入框................] │  ← 新增，固定在底部
├─────────────────────────┤
│  ↑ ↓ ← → | ^C ⇥ Esc | /clear /compact | 复制 粘贴  │  ← 工具栏合并为 1 行
└─────────────────────────┘
```

#### 输入逻辑

**字符级实时转发**:
- `onInput` 事件触发时，取 `e.target.value` 中新增的字符，立即调用 `sendText()` 发送到 PTY
- 发送后清空输入框（`input.value = ""`），输入框始终为空态
- 用户看到的回显来自 PTY 输出写入 xterm，不是输入框本身

**CJK 输入法（composition）处理**:
```jsx
const composingRef = useRef(false);

onCompositionStart  → composingRef.current = true
onCompositionEnd    → composingRef.current = false; sendText(e.data); clearInput()
onInput             → if (!composingRef.current) { sendText(newChars); clearInput() }
```

关键点：
- composition 期间（拼音输入中）不发送，避免发送未完成的拼音字母
- `compositionEnd` 时 `e.data` 就是最终选字结果，直接发送
- 用自定义 `composingRef` 而非 `e.isComposing`，避免浏览器差异（Chrome 的 compositionEnd 之后还会触发一个 `isComposing=false` 的 input 事件，需要手动跳过）

**特殊键处理（onKeyDown）**:

| 按键 | 发送内容 | 说明 |
|------|----------|------|
| Enter | `\r` | 回车 |
| Backspace | `\x7f` | 删除 |
| Tab | `\t` | 制表符（需 `e.preventDefault()` 防止焦点跳转）|
| ArrowUp/Down/Left/Right | `\x1b[A/B/C/D` | 方向键 |
| Escape | `\x1b` + `input.blur()` | ESC + 收起键盘 |
| Ctrl+A~Z | `\x01`~`\x1a` | Ctrl 组合键 |

注意：`onKeyDown` 中如果 `composingRef.current === true`，直接 return 不处理（输入法拦截）。

**桌面端兼容**:
- xterm 自身的 `onData` 回调仍然保留，桌面用户可以直接在终端区域打字
- 输入框是额外的输入入口，两者共存互不干扰
- 桌面用户点击终端区域 → xterm 获焦 → 直接打字（原有流程不变）
- 桌面用户点击输入框 → 通过输入框打字 → 也能正常工作

#### 输入框样式

```jsx
<input
  type="text"
  autoComplete="off"
  autoCorrect="off"
  autoCapitalize="off"
  spellCheck={false}
  placeholder="点击输入..."
  style={{
    width: '100%',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '6px',
    color: '#e6edf3',
    fontSize: '16px',        // >= 16px 防止 iOS 自动缩放
    padding: '8px 12px',
    outline: 'none',
    fontFamily: '"JetBrains Mono", monospace',
  }}
/>
```

`fontSize >= 16px` 是关键——iOS Safari 在 input fontSize < 16px 时会自动缩放页面。

### 2. 工具栏合并为单行横向滚动

将现有 3 行工具栏（`/clear /compact` + 方向键 + 控制键）合并为 1 行，超出屏幕时横向滚动。

#### 新布局

```jsx
<div style={{
  display: 'flex',
  gap: '6px',
  padding: '4px 8px',
  overflowX: 'auto',
  WebkitOverflowScrolling: 'touch',  // iOS 惯性滚动
  flexShrink: 0,
  borderTop: '1px solid rgba(255,255,255,0.08)',
}}>
  {/* 方向键组 */}
  <button>↑</button> <button>↓</button> <button>←</button> <button>→</button>
  <Divider />
  {/* 控制键组 */}
  <button>^C</button> <button>⇥</button> <button>Esc</button>
  <Divider />
  {/* 命令组 */}
  <button>/clear</button> <button>/compact</button>
  <Divider />
  {/* 剪贴板组 */}
  <button>复制</button> <button>粘贴</button>
</div>
```

#### 移除项
- 去掉「⌨↑ / ⌨↓」键盘切换按钮（被独立输入框取代）
- 去掉 `kbdVisible` state 及相关切换逻辑
- 去掉 xterm textarea 的 `inputMode`/`readonly` 操控代码

#### 按钮行为保持
- 所有按钮仍用 `onPointerDown={e => e.preventDefault()}` 防止抢焦点
- 手机上按方向键/控制键不会弹出键盘（因为不触发 input focus）

### 3. 桌面端点击定位光标

当前 tap-to-position 只绑定了 `touchstart`/`touchend` 事件，桌面端鼠标点击没有对应处理。

#### 新增 click 事件处理

```javascript
// 桌面端点击定位光标
const onClick = (e) => {
  // 跳过触摸设备（已由 touch 事件处理，避免重复）
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
  // 有选中文本时不处理
  if (term.hasSelection()) return;

  const cellWidth = term._core?._renderService?.dimensions?.css?.cell?.width;
  const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
  if (!cellWidth || !cellHeight) return;

  const rect = containerRef.current.getBoundingClientRect();
  const x = e.clientX - rect.left - 4;
  const y = e.clientY - rect.top - 4;
  const targetCol = Math.max(0, Math.floor(x / cellWidth));
  const targetRow = Math.floor(y / cellHeight);

  const buf = term.buffer.active;
  const cursorCol = buf.cursorX;
  const cursorViewRow = buf.cursorY;
  if (targetRow !== cursorViewRow) return;

  const diff = targetCol - cursorCol;
  if (diff === 0) return;
  const arrow = diff > 0 ? '\x1b[C' : '\x1b[D';
  const count = Math.min(Math.abs(diff), 200);
  sendText(arrow.repeat(count));
};

el.addEventListener('click', onClick);
```

与现有 touch 逻辑的区别：
- touch 事件有 tap 检测（< 300ms, < 10px 位移），click 不需要（浏览器已做过滤）
- 通过 `ontouchstart in window` 判断，触摸设备走 touch 逻辑，桌面走 click 逻辑，不会重复触发

### 4. xterm textarea 处理简化

由于输入框取代了键盘切换按钮，xterm 隐藏 textarea 的处理可以简化：

**手机端**: 保持 `inputMode="none"` + `readonly`，完全禁止 xterm textarea 弹出键盘。用户通过底部输入框输入。

**桌面端**: 不做任何修改，xterm textarea 正常工作。

移除的代码：
- `kbdVisible` state
- `containerRef.current._xtermTextarea` 引用
- 键盘切换按钮的 onClick 处理逻辑

## 实施步骤

### Step 1: 新增输入框组件
1. 在 TerminalPanel 中添加 `inputRef`、`composingRef`
2. 实现 `<input>` 及其事件处理（onInput, onKeyDown, onCompositionStart/End）
3. 放置在 xterm 容器和工具栏之间

### Step 2: 工具栏合并
1. 删除原有 3 段工具栏 DOM
2. 合并为单行 `overflowX: 'auto'` 容器
3. 移除 `kbdVisible` state 和键盘切换相关代码

### Step 3: 桌面端点击定位
1. 在 xterm 初始化 useEffect 中添加 click 事件监听
2. cleanup 中移除事件监听

### Step 4: 清理
1. 移除不再需要的 xterm textarea hack 代码（键盘切换部分）
2. 保留手机端 `inputMode="none"` + `readonly`（仍需禁止 xterm textarea 弹键盘）

## 验收标准

| # | 场景 | 预期结果 |
|---|------|----------|
| 1 | 手机点击输入框 | 键盘弹出，输入中文/英文实时显示在终端 |
| 2 | 手机输入法选字过程中 | 拼音字母不发送到终端，选字完成后才发送 |
| 3 | 手机按虚拟方向键 | 不弹出键盘，光标正确移动 |
| 4 | 桌面端点击终端某行 | 光标移动到点击位置（同行内） |
| 5 | 工具栏在手机上 | 单行完整可见，超出部分可横向滚动 |
| 6 | 桌面端 xterm 直接键盘输入 | 仍然正常工作（不受输入框影响） |
| 7 | 输入框按 Escape | 发送 ESC 到终端 + 输入框失焦（收起键盘） |
| 8 | 输入框按 Tab | 发送 Tab 到终端（不跳转焦点） |
| 9 | 输入框按 Ctrl+C | 发送 SIGINT 到终端 |

## 风险与注意事项

1. **iOS Safari 缩放**: input fontSize 必须 >= 16px，否则聚焦时页面会自动缩放
2. **composition 浏览器差异**: Chrome 在 compositionEnd 后还会触发一个 input 事件，需要用 composingRef 手动控制而非依赖 `e.isComposing`
3. **sendText 重复发送**: 输入框和 xterm onData 是两个独立入口，桌面端如果同时聚焦了 xterm 和输入框，可能导致双重发送。解决方案：输入框获焦时不影响 xterm（xterm 的 textarea 是独立的 DOM 元素，不会同时聚焦）
4. **清空输入框时机**: 必须在 sendText 之后立即清空，否则连续快速输入可能重复发送
