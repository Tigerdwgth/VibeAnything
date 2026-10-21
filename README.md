# vibeanything

Claude Code hooks + Web Dashboard —— 会话事件上报、危险命令拦截，以及通过浏览器管理多台开发机的 Claude Code 会话（完整 PTY 终端、文件夹分组、红绿灯状态）。

## 安装

### 方式一：npx 一键安装（推荐）

```bash
npx vibeanything
```

### 方式二：从 GitHub 安装

```bash
git clone https://github.com/Tigerdwgth/vibeanything.git
cd vibeanything && node bin/cli.js
```

交互式向导会自动完成所有配置（包括 `~/.claude/settings.json`），无需手动编辑任何文件。

## 功能

| Hook | 触发事件 | 说明 |
|------|---------|------|
| 会话事件上报 | Stop / Notification | 任务完成、需要确认时上报给 Dashboard（小人状态 + 提示音） |
| 危险拦截 | PreToolUse (Bash) | 直接拦截 rm -rf 等危险命令，并把原因反馈给 Claude |
| 会话状态 | UserPromptSubmit / Stop | 上报会话「运行中/空闲」给 Dashboard 红绿灯 |
| Python 格式化 | PostToolUse (Edit/Write) | 自动格式化 .py 文件 |
| Commit 审查 | PreToolUse (Bash) | git commit 前检查代码风格 |

### Dashboard 会话管理

- **会话列表（合并「已打开」与「运行中」）**：单一「会话」Tab 展示机器上所有活跃会话，已打开的会话高亮标记 + ✕ 关闭按钮。
- **会话重命名 + 多级文件夹分组**：支持重命名会话（真改 tmux 名）、任意层级嵌套文件夹、拖拽 / 菜单分组。详见 [docs/session-folders.md](docs/session-folders.md)。
- **红绿灯会话状态**：绿灯=Claude 正在运行（`UserPromptSubmit`），灰灯=空闲（`Stop`）；hook 驱动为主，未装 hook 的会话回退到 PTY 输出活跃度判断。
- **粘贴图片 / 拖入文件**：在终端里 `Cmd/Ctrl+V` 粘贴截图，或把文件直接拖进终端区域 ——
  文件会上传到**该会话所在的那台开发机**，落在 `<VIBEANYTHING_HOME|~/.vibeanything>/uploads/<日期>/`，
  然后自动把绝对路径敲进终端（含空格的路径会加引号），Claude 随即就能读到这张图/这个文件。
  纯文本粘贴不受影响，仍走 xterm 原生行为。单文件默认上限 20MB。

## 命令

```bash
npx vibeanything                # 安装/重新配置
npx vibeanything --remove       # 卸载
npx vibeanything --daemon start # 启动交互守护进程
npx vibeanything --daemon stop  # 停止守护进程
npx vibeanything --daemon status# 查看守护进程状态

# 装机（开发机接入 Dashboard）
npx vibeanything invite --server <dashboard> --user <管理员>   # 管理员签发一次性邀请码
npx vibeanything join --server <dashboard> --code <邀请码>     # 新机器换取自己的 token 并写配置
npx vibeanything service install                              # 交给 launchd / systemd 托管

# 部署命令（systemd 自启动）
sudo npx vibeanything --deploy dashboard  # 部署为 Dashboard 服务器
sudo npx vibeanything --deploy client     # 部署为客户端（开发机）

# 用量上报（Dashboard「📊 用量」标签页的数据来源）
npx vibeanything --usage-report              # 立刻采集并上报一次
npx vibeanything --usage-schedule install    # macOS: 装每小时定时上报
npx vibeanything --usage-schedule status     # 查看定时状态
npx vibeanything --usage-schedule remove     # 卸载定时
npx vibeanything --crontab install           # Linux: 定时上报随 daemon crontab 一起装
```

## 用量统计

Dashboard 的「📊 用量」标签页汇总各开发机的 Claude Code、Codex 与 OpenCode 花费，按用户、
日期、模型三个维度看。数据由每台开发机上的采集器上报：调 [ccusage](https://ccusage.com)
读本地会话日志，归一化后 POST 到 `/api/usage/report`。

前置条件：

```bash
npm install -g ccusage          # 需要 20.x 及以上，Codex / OpenCode 支持从这一版开始
```

采集器读 `~/.vibeanything/config.json` 的 `usage` 段（都可省略）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `username` | `centralServer.machineId` | 用量归到哪个 Dashboard 用户名下，**必须是平台已有用户** |
| `ccusageCmd` | `ccusage` | ccusage 可执行文件路径，定时任务下建议写绝对路径 |
| `lookbackDays` | `7` | 每次回溯上报的天数，用于补齐漏报 |
| `codexHome` | `~/.codex` | Codex 日志目录，多份用逗号分隔 |

上报口用 `centralServer.machineToken` 鉴权（和 WS 握手同一份名单），因此不需要
额外配置凭证。按 `(用户, 机器, agent, 日期, 模型)` 幂等落库，重复上报只覆盖不累加。

普通用户在页面上只能看到自己的用量，管理员默认看全员，可切换「仅我」。

## codex 容量/限流自动续跑

codex 会话在终端输出里出现模型容量（`model at capacity`）或 429 限流
（`exceeded retry limit, last status: 429 Too Many Requests`）错误时，自动向该会话
PTY 写入 `continue`（回车），等效于用户敲 "continue" 推卡住的 codex 继续执行，无需人工干预。

- **生效范围**：两层监控——
  1. Dashboard 直接创建的 codex 会话：pty-manager 在输出流里实时检测；
  2. 任意 tmux 会话里的 codex 进程（手动 tmux、其它途径启动的 codex）：daemon 每 5 秒
     `capture-pane` 轮询屏幕输出检测。claude 等其它会话不会触发。
- **防抖冷却**：同一会话每次自动发送后默认 30 秒内不再重复触发；且同一屏错误文本
  原样停住时不重复抽，只有屏幕变化（新输出/错误再现）才可能再次触发。
- **错误匹配**：检测不区分大小写，基于最近 2048 字符的 PTY 输出尾部做匹配，错误文本被
  输出流分块切碎也能命中。
- **关闭/调参**：编辑 `~/.vibeanything/config.json` 的 `codexWhip` 段，改完重启 daemon：

```json
{
  "codexWhip": {
    "enabled": false,
    "cooldownMs": 30000,
    "intervalMs": 5000
  }
}
```

## 生产部署

### Dashboard 服务器部署

在中央服务器上部署 Web Dashboard，支持 systemd 自启动：

```bash
# 1. 配置 Dashboard
node bin/cli.js
# 在配置向导中设置 server.machineTokens

# 2. 部署为 systemd 服务
sudo node bin/cli.js --deploy dashboard

# 3. 查看状态
sudo systemctl status claude-dashboard
sudo journalctl -u claude-dashboard -f
```

部署特性：
- 自动检测 Tailscale IP 并绑定（内网专用）
- systemd 服务自动重启
- 开机自启动
- 日志输出到 journalctl

### 客户端（开发机）部署

在开发机上部署 daemon，连接到中央服务器：

```bash
# 1. 配置客户端
node bin/cli.js
# 在配置向导中配置中央服务器地址

# 2. 部署为 systemd 服务
sudo node bin/cli.js --deploy client

# 3. 查看状态
sudo systemctl status claude-hooks-daemon
sudo journalctl -u claude-hooks-daemon -f
```

部署特性：
- daemon 自动启动（WebSocket 连接 + hook 事件转发）
- systemd 服务自动重启
- 开机自启动
- 日志输出到 journalctl



## 新功能

### 开发机切换
- Dashboard 顶部显示开发机选择器
- 可以按开发机筛选 session 列表
- 显示每台机器的 session 数量

### 修改密码
- 登录后点击"修改密码"按钮
- 需要验证旧密码
- 新密码至少 6 个字符
- 修改成功后需要重新登录

### 回到最新输出（跳到最底部）
- 桌面版快捷键栏的「⤓ 最新」、手机版工具条的「⤓」
- 终端里跑的是 tmux attach，往上滚历史时 tmux 进 copy-mode，视图从此不跟随新输出；
  这个按钮让开发机侧执行 `tmux copy-mode -q` 退出该模式，一步回到底部
- 走的是 tmux 控制通路而不是往 PTY 敲按键 —— 不在 copy-mode 时按键会被直接打进正在跑的程序
- 已经在底部时是无害的空操作

### 手机版工具条与桌面版对齐
- 手机版补齐了原先缺的 `/clear`、`/compact`、`粘贴`，键位与桌面版快捷键栏一致
  （手机上另有「＋图片」「⌨直连」两个专有键）
- 斜杠命令两端共用 `src/slash-commands.js`：先 Ctrl+C 打断再发命令 ——
  不打断的话 Claude Code 停在补全菜单上时会把 `/clear` 当普通输入吃掉
- 粘贴在 HTTP 页面上读不到剪贴板时，弹出可编辑的手动粘贴框（长按粘贴 → 发送到终端），
  不会出现「点了没反应」

### 个人信息（头像 / 昵称）
- 桌面版：侧边栏左上角的「头像 + 昵称」那一行点开；手机版：顶栏的头像点开
- 昵称最多 24 个字符（按码点算，emoji 不吃亏），留空则显示用户名
- 头像支持点击选择或拖入图片（PNG / JPEG / WebP / GIF / BMP），浏览器侧居中裁方并压到
  256×256 后再上传；可随时「恢复默认头像」退回站点默认图
- 改完立刻生效，不需要重新登录

## Web Dashboard（v4.0）

通过浏览器管理多台开发机的 Claude Code session，支持完整 PTY 终端交互。

```
开发机A (daemon + ws-client) ─────┐
开发机B (daemon + ws-client) ─────┼──▶ 中央服务器 (relay) ◀── 浏览器
开发机C (daemon + ws-client) ─────┘        │
                                       Web Dashboard
                                       (React 前端)
```

### 推荐：使用 Tailscale 内网部署（安全 + 零配置）

**为什么推荐 Tailscale？**
- 端到端加密（WireGuard），无需配置 HTTPS
- 无需公网暴露端口，无需配置防火墙
- 跨设备访问（手机、平板、笔记本）
- 零配置 NAT 穿透

**部署步骤**：

1. 在中央服务器和所有开发机上安装 Tailscale：
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

2. 在中央服务器上部署（见下方"部署中央服务器"），配置 `server.host` 为 Tailscale IP：
```json
{
  "server": {
    "port": 3000,
    "host": "100.x.x.x"  // 你的 Tailscale IP（运行 tailscale ip -4 查看）
  }
}
```

3. 开发机配置 `centralServer.url` 使用 Tailscale 主机名：
```json
{
  "centralServer": {
    "enabled": true,
    "url": "ws://your-server-hostname:3000/ws"  // Tailscale 主机名
  }
}
```

4. 浏览器访问 `http://your-server-hostname:3000`（需在 Tailscale 网络内）

---

### 部署中央服务器（Ubuntu）

**1. 安装 Node.js**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash
source ~/.bashrc
nvm install 25 && nvm use 25
```

**2. 克隆项目并安装依赖**

```bash
git clone https://github.com/Tigerdwgth/vibeanything.git /opt/vibeanything
cd /opt/vibeanything
npm install

# 构建前端
cd packages/server/frontend && npm install && npm run build && cd ../../..
```

**3. 为每台开发机生成 machine token**

```bash
# 每台开发机执行一次，生成各自的 UUID token
node -e "const {randomUUID}=require('crypto'); console.log(randomUUID())"
```

记录生成的 token，后续配置开发机时使用。

**4. 创建管理员账号**

```bash
cd /opt/vibeanything
node packages/server/index.js --create-user admin
```

输入密码后，系统会创建管理员账号。

**5. 配置服务器绑定地址**

编辑 `~/.vibeanything/config.json`：

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0",  // 公网部署用 0.0.0.0；Tailscale 部署用 Tailscale IP
    "machineTokens": ["<token1>", "<token2>"]
  }
}
```

**6. 配置 systemd 服务**

```bash
cat > /etc/systemd/system/claude-dashboard.service << 'EOF'
[Unit]
Description=Claude Code Dashboard Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vibeanything
Environment=PORT=3000
Environment=JWT_SECRET=<生成随机字符串>
ExecStart=/root/.nvm/versions/node/v25.8.0/bin/node packages/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable claude-dashboard
systemctl start claude-dashboard
```

**7. （可选）Nginx 反代配置（支持 WebSocket）**

```nginx
server {
    listen 80;
    server_name your-server.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

### 配置开发机连接中央服务器

每台开发机安装本项目后，编辑 `~/.vibeanything/config.json`，填入 `centralServer` 配置：

```json
{
  "centralServer": {
    "enabled": true,
    "url": "ws://your-server:3000/ws",  // Tailscale 主机名或公网域名
    "machineToken": "<该机器的 token>",
    "machineId": "dev-machine-1"
  }
}
```

也可以重新运行配置向导，在 Web Dashboard 配置环节填写：

```bash
npx vibeanything
```

配置完成后启动 daemon（自动连接中央服务器）：

```bash
npx vibeanything --daemon start
```

### 访问

浏览器打开服务器地址（Tailscale 主机名或公网域名），用管理员账号登录，即可看到所有已连接开发机的 session 列表，点击 session 打开完整 PTY 终端。

## 会话归属隔离 —— 待实现部分

多用户会话隔离已按「会话级归属 + relay 强制鉴权」落地：每个会话在 relay 侧登记 owner，
普通用户只看得到、也只操作得了自己的会话，无主会话仅管理员可见。以下为**尚未实现**的部分：

### 待实现：归属转交的 UI 入口

当前只有 HTTP 接口（`GET/POST /api/session-owners`、`POST /api/session-owners/claim-all`），
管理员需要用 curl 转交归属。侧边栏已显示归属徽章，但右键菜单里还没有「转交给…」的操作项。

**分组文件夹的归属没有转交入口**：`GET /api/session-owners` 会一并返回 `folderLedger`，
但没有对应的写接口，改文件夹归属只能直接改 `folder_owners` 表。存量文件夹里判不出归属的
（根级空文件夹）会一直留在无主状态，只有管理员看得到 —— 需要时得手工指派。

### 待实现：会话列表之外的隔离面

下列数据通道目前仍是**全量广播给所有登录用户**，需要时再按 owner 收口
（它们在 `relay.js` 的 `BROWSER_POLICY` 里显式登记为 `{ open: true }`，收口时改那一行即可）：

- `read_file` / `list_dir`：文件浏览器可浏览开发机整个文件系统，不受会话归属限制
- `session_history`：`~/.claude/projects/**/*.jsonl` 扫出的历史会话列表。
  历史会话没有 owner 概念（sessionId 是 claude 侧 UUID，与 tmux 会话不同域），
  要收口得先决定归属怎么推断——按扫描它的开发机、还是按 cwd 匹配已登记会话。

### 待实现：尺寸声明的服务端兜底

权威尺寸取所有观众的最小值，而「我还在看、我有多大」完全靠前端主动上报：面板可见才声明
尺寸，切到后台发 `release_size` 撤销声明。浏览器被系统冻结、或页面进程被杀而 WS 尚未断开时，
滞留的声明在心跳判死前（最长 `PING_INTERVAL + PONG_TIMEOUT` = 40s）仍会当天花板压着其他观众。

relay 目前没有独立判据能识别「这个观众其实已经不看了」。要补的话，方向是给尺寸声明加 TTL，
或让浏览器带 `document.visibilityState` 定期续约，过期即自动降级为「不参与协商」。

### 待实现：等宽字体自托管

界面的 JetBrains Mono / Plus Jakarta Sans 现在从 fonts.googleapis.com 取。网页字体是异步到的，
终端的格子尺寸因此会在字体到位后变一次（已有 `installWebFontRefit` 负责重量并重新宣告尺寸，
见 `src/terminal-io.js`），代价是首屏会看到一次重排；网络取不到字体时（离线内网、被墙）
整个界面只能用回退字体。

把两套字体的 latin 子集放进 `public/fonts/` 自己用 `@font-face` 声明，就能同时去掉这两条：
同源取字体 ≈ 瞬时可用，首屏不再重排，也不再依赖外网。要做的话注意 woff2 子集别漏
latin-ext（界面里有带音标的字符），中文本来就是走系统回退字体，不需要打包。

## 终端滚动 —— 待实现部分

「回到最新输出」按钮已按「开发机侧 `tmux copy-mode -q`」落地（浏览器侧 `term.scrollToBottom()`
只管得着 xterm 自己的 scrollback，tmux 的 alternate screen 它够不着）。以下为**尚未实现**的部分：

### 待实现：查清「自动滚到最顶端」的根因

用户反馈的原始现象是「窗口自动滑到最顶端，然后回不到底部」。当前只补了「回不到底部」
这半边的出口，**为什么会自己滚上去没有查**。可疑的地方有两处，都还没有证据：

- 触摸/滚轮的位移累计（`terminal-touch-scroll.js` 的 `takeWheelSteps`）在某些情况下
  可能一次合成出远超预期的滚轮步数 —— `MAX_WHEEL_STEPS_PER_MOVE` 只卡单次 touchmove，
  累计值 `accum` 本身没有上限
- 重连 / 尺寸协商触发的重绘可能让 tmux 进 copy-mode

复现条件也还不清楚（用户是在一个长时间运行的会话里遇到的）。在拿到稳定复现之前不猜着改。

### 待实现：手机上够不着的那些控制键

工具条现在与桌面版对齐了，但两端**都**没有的键在手机上是真的打不出来 ——
手机软键盘给不了 Ctrl 组合键，`⌨直连` 模式也只能转发键盘本身能产生的按键：

- `Ctrl+D`（退出 shell / EOF）、`Ctrl+Z`（挂起）、`Ctrl+R`（历史反查）、`Ctrl+L`（清屏）
- `Home` / `End` / `PageUp` / `PageDown`
- `F1`–`F12`

字节序列本身很简单（都能加进 `mobile/key-sequences.js`），没做是因为工具条是单行横向滚动，
再往里塞会把常用键挤到要滑动才看得见的位置。要加得先决定分组方式 ——
比如常用键留在第一行，其余收进一个可展开的「更多」抽屉。

### 待实现：按钮只在「真的滚上去了」时才出现

现在按钮是常驻的。想做成「滚上去才浮出来」，前端需要知道 tmux 的 `pane_in_mode`，
而那个状态只有开发机侧查得到 —— 要么让 ws-client 把它随 `active_sessions` 一起上报
（多一次 `tmux display-message`，得掂量轮询开销），要么解析终端内容里的 copy-mode 指示器
（脆，tmux 配置一改就失效）。

### 待实现：键盘快捷键

终端里所有按键都归 PTY，抢不到快捷键。要做只能加在 composer 输入框上（那里焦点不在终端），
或者走一个全局组合键并显式排除终端聚焦的情况。

## 个人信息 —— 待实现部分

昵称与头像已按「存在 `users` 表、显示时回落」落地：`nickname` / `avatar` 两列都可空，
NULL 表示没设过，昵称回落用户名、头像回落 `/usagi.png`。读写走 `GET /api/me` 与
`PATCH /api/profile`，只能改自己（改谁由 JWT 决定，body 里的 username 不作数）。
以下为**尚未实现**的部分：

### 待实现：昵称在别人眼里也生效

昵称目前只用在「自己那一行」（侧边栏用户条、手机版顶栏、个人信息弹窗）。管理员看到的
会话归属徽章、用量面板的用户列仍然显示**用户名**，因为后端只有 `/api/me` 能读 profile，
没有批量口。要打通得加一个 `GET /api/profiles`（返回 username → {nickname, avatar}），
并想清楚缓存策略 —— 归属徽章是跟着会话列表每次推送一起渲染的，不能每条都发一次请求。

### 待实现：管理员代改 / 重置他人头像

没有任何代改入口，头像昵称只有本人能动。真要加（比如有人传了不合适的头像），
需要一个管理员专用的 `PATCH /api/admin/users/:username/profile`，并决定是否留审计记录。

### 待实现：头像挪出 users.db

头像以 data URI 存在 `users.avatar` 列里 —— 部署流程只把 `users.db` 当持久数据，
另开一个头像目录会多一条容易漏同步的运维路径，所以先塞进库里，
并把尺寸卡在 256KB（实际 256×256 的 JPEG 通常 15–25KB）。

代价是 sql.js 每次 `saveDb` 都全量导出整个库，而**会话归属的每一次写入都会触发它**。
用户数上到几十人时这里会开始拖慢归属登记。届时的方向是把头像挪到独立文件/对象存储，
`users.avatar` 只存 URL，并给它配 ETag 缓存；同时 `/api/me` 就不必每次把整段 data URI
带回来了。

### 待实现：自选裁剪框

现在是无条件取原图中间最大的正方形。想把人脸挪到框里、或只取图的一角，都做不到 ——
需要一个可拖拽缩放的裁剪框（`squareCropOf` 已经把「取哪一块」和「怎么画」分开了，
接裁剪框只需换掉这个函数的来源）。

## 装机与分发 —— 待实现部分

装机本身已经是「邀请码 → `join` → `service install`」三步，
机器身份也绑进台账了。以下几项是这条线上还没做的：

### 待实现：版本握手与 `vibeanything update`

开发机 `register` 消息里只有 `machineId` 和 `defaultWorkDir`，**不带版本**，relay 因此
看不出哪台机器的代码旧了。现网实测：三台机器 `package.json` 全写 `4.3.0`，而 git HEAD
分别停在今天、7 月、3 月，`lib/` 里还留着几个手动打补丁时的 `.bak-*`。症状不是报错，
是「某台机器没有文件夹功能」「改名没反应」—— 得 ssh 上去 grep 才知道。

要做的是两件事：① `register` 带上 version/commit/capabilities，relay 比对后在机器列表上
打「旧版本」徽章、日志打一行；② 一条 `vibeanything update`（从 release 拉包换目录 + 重启
托管服务），替掉现在逐个文件 rsync 的手术 —— 那个手术在 2026-09-25 已经把一台机器的
daemon 打挂过一次。

### 待实现：状态与代码分离

`users.db` 默认落在 `packages/server/users.db`，也就是**代码树里**。2026-06-01 全部账号
丢失就是改名搬目录时没带它；今天任何一次 `rsync --delete packages/server/` 还能再丢一次。
要把默认位置挪到 `~/.vibeanything/`（或 `/var/lib/vibeanything`）并在启动时自动搬一次，
`uploads/` 同理。这件事要配数据迁移，所以单独做。

### 待实现：客户端真正可分发

`npm publish` 没做（`files` 白名单已就绪），所以装机前仍要 clone 私有仓库 —— 而跳板机
没有 GitHub 凭据，只能走 `git bundle` 手搬。真正的拦路虎是 `node-pty` 是原生模块：
新机器 `npm install` 要么有匹配 Node ABI 的 prebuild、要么得现场编译。先把目标机器集合
（macOS arm64 / Linux x64 × 几个 Node 大版本）的 prebuild 覆盖情况摸清，再决定是发 npm
还是发 GitHub Release tarball。客户端其实用不到 `pg`，可以降成可选依赖。

### 待实现：前端产物由 CI 发布

`dist/` 进 git + `packages/server/frontend/DO_NOT_BUILD_HERE.md` 是**人工纪律**不是机制，
2026-07-14 已经因此把线上功能删掉过一次。CI 已经在跑 build，把 dist 作为 release 资产、
服务端只拉资产即可（跳板机内存小，拉资产比本地 build 现实）。

## 测试与 CI —— 待实现部分

CI 定义在 `.github/workflows/ci.yml`：前端 job 跑 `npm test`（vitest + jsdom，含终端
「能选中 / 能点链接」的真 DOM 回归）与 `npm run build`；后端 job 起 postgres service 与 tmux
后跑 `npm test`。以下几项尚未做：

### 待实现：Lint 转为硬门禁

存量文件（`Dashboard.jsx`、`sound.js`、`useFolderCollapse.js` 等）还有一批 `no-unused-vars`
等历史问题，所以 lint job 现在挂着 `continue-on-error: true`，只提供可见性、不挡合并。
存量清零后应去掉该标记，改成与测试同级的硬门禁。

### 待实现：终端选区的像素级断言

`tests/terminal-pointer.test.js` 验的是事件接线（该放行的有没有被吞、补交的形状对不对），
不验「拖过去到底选中了哪几个字」—— jsdom 没有真实布局，xterm 的坐标换算在那里算不出结果。
要覆盖这一层得上真浏览器（Playwright / vitest browser mode），届时可以直接断言
`term.getSelection()` 的内容，并顺带覆盖「HTTP 非 secure context 下 execCommand 兜底复制」
这条目前只能靠人工验的路径。

### 待实现：跨 workspace 的测试归位

根目录 `tests/` 里有两个测试其实不属于后端：`dnd-activation.test.js` 跑的是前端
`@dnd-kit` 的真 sensor（还把包路径硬编码成 `../packages/server/frontend/node_modules/...`），
`usage-store.test.js` 依赖 `packages/server` 的 `bcryptjs`。目前靠 CI 里多装两处依赖绕过，
更合理的做法是把前者迁进 `packages/server/frontend/tests/`（需从 CommonJS 改写为 ESM，
并处理它手搓的 FakeWindow 与 jsdom 全局的冲突），后者留在后端但改用包名解析。

## 终端上传 —— 待实现部分

粘贴图片与拖入文件已可用（链路：前端 `terminal-upload.js` → relay 转发 → 开发机
`lib/upload-store.js` 落盘 → 回执路径敲进终端）。以下几项尚未做：

### 待实现：上传目录的自动清理

`uploads/<日期>/` 只增不减，长期使用会累积。需要一个保留期策略（按天数或总大小）
在 daemon 启动时或定时清理，目前只能手工删。

### 待实现：大文件的分片与进度

整个文件编码成 base64 放在**一条** ws 消息里发送，因此有 20MB 的硬上限，
且上传过程只有「上传中…」一句提示，没有百分比。要支持更大的文件得改成分片 +
断点，并把进度回报给前端。

### 待实现：其余开发机的 daemon 同步

上传落盘发生在**开发机本机的 daemon**（`lib/ws-client.js` + `lib/upload-store.js`），
所以每台开发机都要更新代码并重启 daemon 才有这个功能。目前只有 mac-mini 与
aliyun-derper 是新代码，`macair` / `gpuserver1-jdh` 上粘贴会收到失败回执。

### 待实现：移动端与「粘贴」按钮

手机端 xterm 的 helper textarea 被设成 `readonly`（防止自动弹键盘），系统粘贴能不能
把文件事件送进来未经验证；快捷键栏那个「粘贴」按钮走的是 `navigator.clipboard.readText`，
在 HTTP（非 secure context）下浏览器不暴露该 API，只能读文本、读不了图片 ——
图片粘贴依赖的是 paste **事件**上的 `clipboardData`，两条路互不相通。上 HTTPS 后
才能让按钮也具备同样能力。

## 像素小镇 —— 待实现部分

右侧「像素」视图是从 VS Code 扩展 **pixel-agents**（MIT）移植来的子系统
（`packages/server/frontend/src/pixel-*`），地图按真实结构生成：**一台开发机一个标签页**，
选中的那台占满整块画布（网格是按画布尺寸算出来的），楼里一间房对应一个 VibeAnything 分类文件夹，
房里的工位就是会话（`pixel-office/layout/townLayout.ts`）。以下几项尚未做：

### 待实现：TypeScript 真的被检查

项目没有 `tsconfig.json`，`npm run build` 只跑 vite（esbuild 擦掉类型、不做检查），
所以这个子系统的 7800 行 TS **零类型检查** —— `import type` 写错路径都不会报错
（已经踩过两处）。要补得先加一份 `tsconfig.json` 并把现存错误清一遍，再把
`tsc --noEmit` 挂进 CI，否则加了也是红的。

### 待实现：美术资产由服务端下发

地板现在是纯色块、家具只有内置 8 件、墙是扁平填色。子系统本来支持
`floorTilesLoaded` / `wallTilesLoaded` / `furnitureAssetsLoaded` / `characterSpritesLoaded`
四条资产消息（上游由扩展宿主读 PNG 后发过来），移植后**没有任何一端发它们**。
要让小镇真的像镇子，得在服务端放一份资产目录并按这四条消息下发。

### 待实现：工具级进度与子 agent

名牌上只有「正在跑 / 空闲 / 等待确认 / 离线」四档，看不出在用什么工具；
子 agent（Task 工具派生的小人）和授权气泡同理 —— 它们依赖
`agentToolStart` / `subagentToolStart` / `agentToolPermission` 这些消息里的工具粒度，
而 relay 从不下发 `agent_status`，要做只能走 Claude Code 的
`PreToolUse` / `PostToolUse` hook，两端都得加。

### 待实现：渲染的墙体与 z 排序缓存

`engine/renderer.ts` 每帧重建全部墙体实例并对 drawable 做一次全量 z 排序。墙与家具在
两次布局变更之间是不变量，可以缓存；地板瓦片已经做了视口裁剪，墙与家具还没有。
地图大（比如十几台开发机）时这一项会先成为瓶颈。

### 待实现：离开编辑模式时的未保存改动

带着未保存改动退出编辑模式，Save / Reset 按钮会消失（改动还在，只是没有入口）——
`editorState` 是模块级单例而 `isEditMode` 是组件级 state，两者生命周期不一致。
要修得把「有未保存改动」提升到与编辑模式同一层。

### 待实现：布局重建时保住用户摆的家具

楼层只在构成（分类树及名称 / 工位台阶 / **画布尺寸**）变化时重建，期间用户在编辑模式里摆的家具
都留着；但一旦重建，手摆的那些就被新生成的布局顶掉了 —— 现在网格跟着画布走，
拖一次窗口或侧栏分隔条就可能重建一次。要保住得把「用户的改动」存成相对房间的增量叠加层，
而不是整张布局存档。

### 待实现：所有开发机的总览

一台开发机一个标签页之后，没有「一眼看完全部机器」的视图了（四台机器挤一张图时，
取整缩放只剩 1×、谁都看不清，所以才改成标签页）。要做得是另一种画法 ——
比如每台机器缩成一个带人数的小方块，而不是把四层楼按原尺寸拼在一起。

## 手机版 `/m` —— 待实现部分

手机版是**独立的第二个前端入口**（`packages/server/frontend/mobile.html` + `src/mobile/`，
Vite 双入口构建，服务端路由在 `packages/server/index.js` 的 `/m`、`/m/*`），
不是桌面版的响应式变体；桌面版 `/` 行为不变。登录态、主题与桌面版共用同一份
localStorage 键，桌面登录过手机打开不用重登。已可用：登录、机器选择、会话列表（红绿灯）、
终端（软键盘 / 中文输入法 / 触摸滚动 / 长按选中复制）、常用按键工具条、新建 / 切换 / 关闭 / 停止 / 重命名会话、
文件夹分组、相册选图上传、安全区适配与「添加到主屏幕」。以下几项尚未做：

### 待实现：真机验收

目前只在 mac-mini 上做了 jsdom 级回归（真 xterm、真事件）与生产构建，**没有在 iOS / Android
真机上跑过**。需要真机确认的几件事互相独立，出问题也各查各的：软键盘弹出后
`--app-height` 是否跟手、`env(safe-area-inset-bottom)` 有没有把工具条顶到 home indicator 之上、
中文输入法在「⌨ 直连」模式下候选框是否跟着光标、长按选中整行后系统菜单会不会抢走手势、
相册选图在 iOS 上是否直接调起图库。

### 待实现：软键盘弹起时的底部留白

底部工具条恒定按 `env(safe-area-inset-bottom)` 留出 home indicator 的高度。软键盘弹起时
home indicator 其实盖在键盘上、不在页面上，那 34px 就成了工具条与键盘之间的一条空隙。
要消掉得先判断键盘是否弹起（`window.innerHeight - visualViewport.height` 超过阈值），
判据是启发式的，需要真机标定后再加。

### 待实现：文件浏览器与历史会话

新建会话的工作目录只能手输，或从「这台机器上已有会话的 cwd」里挑一个。桌面版那棵目录树
（`list_dir` / `read_file`）和历史会话列表（`scan_history`，即 `~/.claude/projects/**/*.jsonl`
扫出来的记录，含「恢复历史会话」）手机版都没接。

### 待实现：分屏

tmux 分屏（`split_terminal` / `select_pane` / `kill_pane`）没有入口 —— 窄屏上分屏不实用，
但手机版**能**通过 tap 切换已有分屏的焦点（tmux 鼠标上报开着时 tap 会合成 SGR 左键）。

文件夹分组的**跨机器移动**没有：文件夹台账是每台开发机各存一份，移动只能在同一台机器的树里进行，
把会话从 A 机挪到 B 机的分组做不到（协议层面也没有这个消息）。

### 待实现：终端之外的面板

用量统计、像素视图、Markdown 预览、添加用户、修改密码这几个桌面版标签页手机版都没有。
管理员的「隐藏他人会话」开关也没有 UI —— 手机版握手时直接沿用桌面版存下的那份偏好
（`localStorage` 的 `hideOthers`），要改只能先去桌面版切。

### 待实现：桌面浏览器打开 `/m` 时的鼠标能力

`terminal-pointer.js`（修饰键豁免的拖选、可点链接、点击切 pane）是桌面版的接线，手机版没挂。
用桌面浏览器打开 `/m` 时终端只有触摸那套能力：能滚、能长按选整行，但拖选和点链接不可用。

### 待实现：离线可用

`public/mobile.webmanifest` 让页面能「添加到主屏幕」并以独立窗口启动，但没有 Service Worker，
断网状态下打开的是浏览器的离线页。要真正离线可用得缓存入口 HTML 与 `assets/` 下的 chunk。

### 待实现：已打开会话的跨端同步

手机版的「已打开哪些会话」存在自己的 localStorage 键（`mobileOpenTerminals` /
`mobileActiveSession`），与桌面版的 `openTerminals` 互不干扰 —— 在手机上随手关一个标签
不会动到桌面的工作区。反过来说两端也不同步，要同步得把这份状态挪到服务端。

## 配置文件

配置存储在 `~/.vibeanything/config.json`（不含在仓库中）。

与终端上传相关的可选项（都在 `fileAccess` 下）：

| 键 | 默认 | 说明 |
|----|------|------|
| `fileAccess.maxUploadMB` | `20` | 单个粘贴/拖入文件的大小上限 |
| `fileAccess.uploadDir` | `<VIBEANYTHING_HOME>/uploads` | 上传落盘目录 |

## 危险命令拦截规则

默认拦截以下命令模式（可在配置中自定义）：

- `rm -rf` / `rm -r /`
- `git push --force` / `git push -f`
- `git reset --hard`
- `DROP TABLE` / `DROP DATABASE`
- `mkfs` / `dd if=` / `> /dev/sda`

## License

MIT
