# src/mobile —— 手机版前端

独立的第二个 Vite 入口（`../../mobile.html` → `main.jsx`），与桌面版（`../main.jsx` → `App.jsx`）
是两棵各自完整的 React 应用，只共用 `src/` 下的模块。服务端路由 `/m`、`/m/*` 指向
`dist/mobile.html`，**必须排在 `app.get('*')` 这条 SPA fallback 之前**，否则会被吞成桌面版。

## 文件索引

| 文件 | 职责 |
|---|---|
| `main.jsx` | 入口：装 `--app-height` 校准 + 渲染 |
| `MobileApp.jsx` | 登录 / 注册 / 主界面切换；登录态与主题沿用桌面版的 localStorage 键 |
| `useRelay.js` | 一条 WebSocket + 它带来的全部会话状态（重连退避、whoami、机器/会话列表、hook 红绿灯、会话改名、文件夹树与增删改） |
| `MobileShell.jsx` | 布局：顶栏 + 会话抽屉 + 终端；已打开会话的增删与切换 |
| `MobileSessionList.jsx` | 机器胶囊、文件夹树、会话行、新建会话面板 |
| `MobileSheet.jsx` | 底部动作面板 / 输入面板（触屏上替代右键菜单） |
| `MobileTerminal.jsx` | xterm + 手势 + 上传 + composer + 工具条 |
| `MobileKeyBar.jsx` | 常用按键工具条 |
| `key-sequences.js` | 工具条每个键发给 PTY 的字节（单独成文件，供单测直接断言） |

## 与桌面版共用的模块

改这些会同时影响两端，动之前先跑两端的测试：

`../theme.js`、`../Login.jsx` / `../Register.jsx`、`../TerminalComposer.jsx`（输入框与 IME 回车）、
`../terminal-io.js`（字节编解码 / 尺寸判据 / 写入合批）、`../clipboard.js`、`../session-merge.js`、
`../app-height.js`、`../terminal-touch-scroll.js`、`../terminal-mouse-click.js`、`../terminal-ime.js`、
`../terminal-upload.js`、`../launch-config.js`、`../machine-prefs.js`、`../session-list-utils.js`、`../sound.js`、
`../folder-tree.js`（建树 / 路径拍平 / 防环）、`../useFolderCollapse.js`（折叠状态，按 machineId 存 localStorage）。

## 文件夹交互为什么长这样

桌面版靠**拖拽**把会话拖进文件夹、靠**右键菜单**改名删除。这两样在手机上都不能照搬：

- 拖拽库的 sensor 会和列表的滚动手势抢同一串 touch 事件（2026-08-23 的「会话列表滑不动」
  就是这么来的）。
- 触屏没有右键；桌面版 `ContextMenu` 按鼠标坐标定位，在手机上会飘出屏幕、被软键盘顶掉。

所以这里统一走「点 ⋯ → 底部面板里选」：不碰滚动手势，目标也比拖一段距离更准。
「停止会话」一并收进面板——它会杀进程，不该在手指常扫过的行尾放一个一碰就中的按钮。

## 测试

`packages/server/frontend/tests/` 下与手机版相关的：`mobile-entry.test.js`（入口与构建契约）、
`mobile-terminal.test.jsx`、`mobile-session-list.test.jsx`、`mobile-key-bar.test.jsx`，
以及两端共用模块的 `terminal-composer.test.jsx`、`terminal-io.test.js`、`session-merge.test.js`、
`app-height.test.js`。服务端路由在仓库根的 `tests/mobile-route.test.js`。

```bash
cd packages/server/frontend && npx vitest run     # 前端
cd /Users/gsj/VibeAnything && npm test            # 后端（含 /m 路由）
```

## 待实现

本目录范围内尚未做的事，详见仓库根 `README.md` 的「手机版 `/m` —— 待实现部分」：
真机验收、软键盘弹起时的底部留白、文件浏览器与历史会话、分屏、
终端之外的面板、桌面浏览器打开 `/m` 时的鼠标能力、离线可用、已打开会话的跨端同步。
