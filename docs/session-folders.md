# 会话重命名 + 多级文件夹分组

Dashboard「运行中」Tab 支持给会话重命名、并用任意层级嵌套的文件夹组织会话。

## 能力

- **重命名会话**：右键会话 / 菜单「重命名」或双击会话名，inline 编辑。
- **多级文件夹**：新建文件夹、子文件夹（任意深度），折叠/展开。
- **分组会话**：
  - 拖拽：把会话拖进文件夹、把文件夹拖进另一个文件夹改变层级（dnd-kit，5px 激活距离，不影响点击 attach）。
  - 菜单：会话右键「移动到文件夹…」按层级路径选择目标，或「移动到根目录」。
- 折叠状态按机器存 `localStorage`（`folderCollapsed:<machineId>`），刷新保留。

## 重命名 = 真改 tmux 会话名（重要取舍）

「重命名」执行的是 `tmux rename-session`，**不是显示别名**。由此带来的约束：

- **会话名受 tmux 命名规则限制**：名字不能含 `.`、`:`、空白（tmux 的分隔符），这些字符会被清洗成 `-`（`sanitizeTmuxName`）；中文保留。与现存 tmux 会话**重名**会被拒绝，前端弹 `重命名失败` 提示。
- **sessionId 会改变**：扫描时非 `cc-` 前缀的 tmux 名直接作为 sessionId。重命名后该会话的 sessionId = 新名字。系统会自动把分组归属从旧 id 迁移到新 id（`reassignSession`）。
- **claude（`cc-`）会话重命名后与 `.jsonl` 历史脱钩**：tmux 名不再是 `cc-` 开头 → 扫描时当普通会话，cwd/工具图标退回从 tmux pane 读取，不再匹配 `~/.claude/projects` 的历史元数据。
- **已打开的终端 tab 会悬空**：重命名运行中且已 attach 的会话后，旧 sessionId 的 tab 不再对应，重新从列表打开即可（tmux 进程不受影响，不会丢）。

## 存储

分组元数据存在**各开发机本地**（非中央服务器），复用 `lib/config.js` 的 `~/.vibeanything/` 目录（`VIBEANYTHING_HOME` 可覆盖），单文件 `session-folders.json`：

```json
{
  "folders":     [ { "id": "<uuid>", "name": "AI", "parentId": null } ],
  "assignments": { "<sessionId>": "<folderId>" }
}
```

- `folders`：平铺文件夹列表，`parentId` 表达嵌套（根级为 `null`），空文件夹也保留。
- `assignments`：会话 → 文件夹归属，未分组的会话无条目（= 根级）。
- 删除文件夹时，其直属子文件夹与会话「提升」到父级（根级则会话变未归属），不丢失。

读写逻辑在 `lib/session-metadata.js`（纯函数，可单测）。

## 消息契约

浏览器 → relay（远程）→ ws-client（开发机）：

| type | 字段 | 开发机动作 |
|---|---|---|
| `rename_session` | machineId, sessionId, newName | `tmux rename-session` + 迁移归属；失败回 `rename_error` |
| `move_session` | machineId, sessionId, folderId | 设置/清除归属 |
| `create_folder` | machineId, name, parentId | 新建文件夹 |
| `rename_folder` | machineId, folderId, newName | 改名 |
| `delete_folder` | machineId, folderId | 删除（内容提升到父级） |
| `move_folder` | machineId, folderId, parentId | 改父级（防环） |

开发机 → 浏览器：
- `active_sessions`：每个会话对象新增 `folderId` 字段。
- `folders`：`{ folders:[{id,name,parentId}] }`（含空文件夹）。
- `rename_error`：`{ sessionId, error }`。

## 相关文件

- 后端：`lib/session-metadata.js`、`lib/pty-manager.js`（`renameTmuxSession`/`sanitizeTmuxName`）、`lib/ws-client.js`、`packages/server/relay.js`
- 前端：`packages/server/frontend/src/folder-tree.js`、`useFolderCollapse.js`、`ContextMenu.jsx`、`SessionTabs.jsx`、`Dashboard.jsx`
- 测试：`tests/session-metadata.test.js`、`tests/pty-manager.test.js`、`packages/server/frontend/tests/folder-tree.test.js`
