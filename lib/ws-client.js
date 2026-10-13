// lib/ws-client.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const { listActiveSessions } = require('./session-registry');
const { getMachineId, loadConfig } = require('./config');
const sessionMeta = require('./session-metadata');
const { saveUpload } = require('./upload-store');

// ── JSONL 工具函数（IO 优化版） ─────────────────────────────────

const PROJECTS_BASE     = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS    = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_INDEX       = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const GEMINI_TMP        = path.join(os.homedir(), '.gemini', 'tmp');
const GEMINI_PROJECTS   = path.join(os.homedir(), '.gemini', 'projects.json');

// relay 转下来的窗格操作：消息类型 → 回执里的动作名 + 怎么调 pty-manager。
// 三者的失败处理完全同形（记日志 + 回一条 pty_error），差别只在调哪个 tmux 子命令，
// 所以走表而不是 if 链 —— 再加一个操作时只在这里补一行，回执格式不会各写各的。
const PANE_OPS = {
  pty_select_pane:   { action: 'select_pane',      run: (pty, m) => pty.selectPane(m.sessionId, { direction: m.direction }) },
  pty_kill_pane:     { action: 'kill_pane',        run: (pty, m) => pty.killPane(m.sessionId) },
  pty_scroll_bottom: { action: 'scroll_to_bottom', run: (pty, m) => pty.scrollToBottom(m.sessionId) },
};

// 文件列表缓存：避免每次都递归遍历目录
let _fileListCache = [];
let _fileListCacheTime = 0;
const FILE_LIST_CACHE_TTL = 15_000; // 15s 缓存目录结构

function findJsonlFiles(dir) {
  const now = Date.now();
  if (now - _fileListCacheTime < FILE_LIST_CACHE_TTL && _fileListCache.length > 0) {
    return _fileListCache;
  }
  const results = [];
  try {
    _findJsonlRecursive(dir, results, 0);
  } catch {}
  _fileListCache = results;
  _fileListCacheTime = now;
  return results;
}

function _findJsonlRecursive(dir, results, depth) {
  if (depth > 6) return; // 防止过深递归
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) _findJsonlRecursive(full, results, depth + 1);
      else if (entry.name.endsWith('.jsonl')) results.push(full);
    }
  } catch {}
}

// ── scanActiveSessions：以 tmux session 为真实数据源 ──────────
// tmux session 存在 = 进程在运行，不依赖 .jsonl mtime（进程空闲不写文件）

function normalizeTmuxTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function inferActiveSessionTool(sessionId, startCommand = '') {
  const sid = String(sessionId || '').trim().toLowerCase();
  const cmd = String(startCommand || '').trim().toLowerCase();

  const newMatch = sid.match(/^new-([a-z0-9]+)-/);
  if (newMatch?.[1]) {
    return newMatch[1] === 'cc' ? 'claude' : newMatch[1];
  }

  for (const tool of ['claude', 'codex', 'gemini', 'zsh', 'bash', 'vim']) {
    const pattern = new RegExp(`(^|[^a-z])${tool}([^a-z]|$)`);
    if (pattern.test(cmd)) return tool;
  }

  return 'claude';
}

function getTmuxSessions() {
  // 用 list-panes 读取 cwd / start_command / activity，再按 session 去重
  // 扫描所有 tmux session（含手动创建的非 dashboard 会话），不再限定 cc- 前缀
  try {
    const r = spawnSync('tmux', [
      'list-panes', '-a', '-F',
      '#{session_name}\t#{pane_active}\t#{pane_current_path}\t#{pane_start_command}\t#{session_activity}'
    ], {
      encoding: 'utf8', timeout: 3000
    });
    if (r.status !== 0 || !r.stdout) return [];
    const sessions = new Map();
    for (const line of r.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const [name = '', active = '0', cwd = '', startCommand = '', activity = '0'] = line.split('\t');
      const n = name.trim();
      if (!n) continue;
      // cc- 前缀是 dashboard 自建会话：去掉前缀即原始 sessionId，可与 .jsonl 元数据匹配；
      // 其余为手动创建的普通 tmux session，直接以其名称作为 sessionId（attach 时 tmuxName 会原样复用）
      const sessionIdPrefix = n.startsWith('cc-') ? n.slice(3) : n;
      const candidate = {
        tmuxName: n,
        sessionIdPrefix,
        cwd: cwd.trim(),
        startCommand: startCommand.trim(),
        activityMs: normalizeTmuxTimestamp(activity),
      };
      const prev = sessions.get(n);
      if (!prev || active === '1') sessions.set(n, candidate);
    }
    return [...sessions.values()];
  } catch { return []; }
}

function mergeActiveSessionMetadata(tmuxSessions, enriched) {
  return tmuxSessions.map((t) => {
    const meta = enriched.get(t.sessionIdPrefix);
    return {
      sessionId: meta?.sessionId || t.sessionIdPrefix,
      cwd: meta?.cwd || t.cwd,
      mtime: meta?.mtime || t.activityMs || Date.now(),
      tool: meta ? 'claude' : inferActiveSessionTool(t.sessionIdPrefix, t.startCommand),
    };
  });
}

function scanActiveSessions() {
  // 1. 以 tmux 为准，获取所有运行中的 session（含手动创建的非 dashboard 会话）
  const tmuxSessions = getTmuxSessions();
  if (tmuxSessions.length === 0) return [];

  // 2. 扫描 .jsonl 文件，建立 sessionIdPrefix → { sessionId, cwd, mtime } 映射
  const files = findJsonlFiles(PROJECTS_BASE);
  const enriched = new Map(); // sessionIdPrefix(16chars) → metadata
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const head = buf.toString('utf-8', 0, bytesRead);
      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.sessionId && d.cwd) {
            // tmuxName 用的 prefix = sessionId 去掉非字母数字连字符后取前48位（与 pty-manager.tmuxName 一致）
            const prefix = d.sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48);
            if (!enriched.has(prefix)) {
              enriched.set(prefix, { sessionId: d.sessionId, cwd: d.cwd, mtime: stat.mtimeMs });
            }
            break;
          }
        } catch {}
      }
    } catch {}
  }

  // 3. 合并：Claude session 优先用 .jsonl 元数据，其余工具直接用 tmux 元数据
  return mergeActiveSessionMetadata(tmuxSessions, enriched);
}

// ── Codex session 历史扫描 ────────────────────────────────────

function _loadCodexThreadNames() {
  const map = new Map();
  try {
    const lines = fs.readFileSync(CODEX_INDEX, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.id && d.thread_name) map.set(d.id, d.thread_name);
      } catch {}
    }
  } catch {}
  return map;
}

function scanCodexHistory() {
  if (!fs.existsSync(CODEX_SESSIONS)) return [];
  const threadNames = _loadCodexThreadNames();
  const files = [];
  _findJsonlRecursive(CODEX_SESSIONS, files, 0);
  const seen = new Map();
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const buf = Buffer.alloc(2048);
      const fd = fs.openSync(file, 'r');
      const n = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString('utf-8', 0, n).split('\n')[0];
      const d = JSON.parse(firstLine);
      if (d.type !== 'session_meta' || !d.payload?.id || !d.payload?.cwd) continue;
      const { id, cwd, timestamp, git } = d.payload;
      seen.set(id, {
        sessionId: id,
        cwd,
        timestamp: timestamp || '',
        gitBranch: git?.branch || '',
        summary: threadNames.get(id) || '',
        filePath: file,
        tool: 'codex',
      });
    } catch {}
  }
  return [...seen.values()];
}

// ── Gemini session 历史扫描 ───────────────────────────────────

function scanGeminiHistory() {
  if (!fs.existsSync(GEMINI_TMP)) return [];
  // 构建 slug → cwd 映射（优先用 .project_root 文件，其次 projects.json）
  let slugToCwd = {};
  try {
    const gp = JSON.parse(fs.readFileSync(GEMINI_PROJECTS, 'utf-8'));
    for (const [cwd, slug] of Object.entries(gp.projects || {})) slugToCwd[slug] = cwd;
  } catch {}

  const sessions = [];
  try {
    for (const entry of fs.readdirSync(GEMINI_TMP, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const chatsDir = path.join(GEMINI_TMP, slug, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      // .project_root 文件比 projects.json 更准确
      let cwd = slugToCwd[slug] || '';
      try {
        const pr = path.join(GEMINI_TMP, slug, '.project_root');
        if (fs.existsSync(pr)) cwd = fs.readFileSync(pr, 'utf-8').trim();
      } catch {}

      for (const f of fs.readdirSync(chatsDir)) {
        if (!f.endsWith('.json')) continue;
        const filePath = path.join(chatsDir, f);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const { sessionId, startTime, messages = [] } = content;
          if (!sessionId) continue;
          let summary = '';
          for (const msg of messages) {
            if (msg.type === 'user' && Array.isArray(msg.content)) {
              summary = (msg.content[0]?.text || '').slice(0, 60);
              break;
            }
          }
          sessions.push({
            sessionId,
            cwd,
            timestamp: startTime || '',
            gitBranch: '',
            summary,
            filePath,
            tool: 'gemini',
          });
        } catch {}
      }
    }
  } catch {}
  return sessions;
}

// ── scanSessionHistory（带 mtime 缓存，只读变化的文件） ──────

const _historyCache = new Map(); // file → { mtime, data }
let _historyCacheResult = null;
let _historyCacheTime = 0;
const HISTORY_CACHE_TTL = 60_000; // 60s 内不重新扫描

async function scanSessionHistory() {
  const now = Date.now();
  if (_historyCacheResult && now - _historyCacheTime < HISTORY_CACHE_TTL) {
    return _historyCacheResult;
  }

  const files = findJsonlFiles(PROJECTS_BASE);
  const sessions = new Map();
  const aliveFiles = new Set(files);

  // 清理已删除文件的缓存
  for (const key of _historyCache.keys()) {
    if (!aliveFiles.has(key)) _historyCache.delete(key);
  }

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const cached = _historyCache.get(file);
      if (cached && cached.mtime === stat.mtimeMs) {
        // 文件未变化，复用缓存
        if (cached.data) sessions.set(cached.data.sessionId, cached.data);
        continue;
      }

      // 文件变化或新文件，只读前 4KB 提取元数据
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const head = buf.toString('utf-8', 0, bytesRead);
      const lines = head.split('\n');

      let data = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.sessionId && d.cwd) {
            let summary = '';
            // 在已读取的部分中找 user message
            for (const l2 of lines) {
              try {
                const d2 = JSON.parse(l2);
                if (d2.type === 'user' && d2.message?.content) {
                  const c = d2.message.content;
                  summary = Array.isArray(c)
                    ? (c.find(x => x.type === 'text')?.text || '').slice(0, 60)
                    : String(c).slice(0, 60);
                  break;
                }
              } catch {}
            }
            data = {
              sessionId: d.sessionId,
              cwd: d.cwd,
              timestamp: d.timestamp || '',
              gitBranch: d.gitBranch || '',
              summary,
              filePath: file
            };
            break;
          }
        } catch {}
      }

      _historyCache.set(file, { mtime: stat.mtimeMs, data });
      if (data) sessions.set(data.sessionId, data);
    } catch {}
  }

  // 合并 Codex 和 Gemini 历史
  const claudeSessions = [...sessions.values()].map(s => ({ ...s, tool: 'claude' }));
  const codexSessions  = scanCodexHistory();
  const geminiSessions = scanGeminiHistory();

  _historyCacheResult = [...claudeSessions, ...codexSessions, ...geminiSessions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  _historyCacheTime = now;
  return _historyCacheResult;
}

// 使历史缓存失效（删除 session 后调用）
function invalidateHistoryCache() {
  _historyCacheResult = null;
  _historyCacheTime = 0;
}

function listDir(dirPath) {
  try {
    const all = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'));
    const dirs = all.filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name), type: 'dir' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = all.filter(e => e.isFile())
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name), type: 'file' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  } catch { return []; }
}

// ── WsClient ─────────────────────────────────────────────────

const ACTIVE_POLL_INTERVAL = 60_000; // 60s 全量扫描（tmux + jsonl），捕获新会话/cwd 变化
const STATUS_POLL_INTERVAL = 2_500;  // 2.5s 轻量状态轮询，只刷新红绿灯 isRunning（纯内存，无 IO）
const HOOK_RUNNING_TTL_MS = 10 * 60_000;  // hook running 状态最长保活 10min，超时视为 Stop 漏触发，置为「无状态」
const WS_PING_INTERVAL    = 30_000; // 30s 发一次应用层 ping
const WS_PONG_TIMEOUT     = 15_000; // 15s 内没收到 pong 就断开重连

// 红绿灯状态纯函数：完全由 Claude Code hook 驱动，不再有任何 PTY 输出活跃度兜底。
// 之所以彻底去掉 PTY 兜底：dashboard attach 到 tmux 会触发整屏重绘 → PTY 有输出，
// 会被误判成「运行中」让会话变红。现在只认 hook 信号：
//   - hookState === 'running'（UserPromptSubmit）→ true（红灯，运行中）
//   - 其他一切（done / 没装 hook / 还没上报 / 从没触发过 hook）→ false（绿灯，空闲）
// 即「只有 hook 明确说正在跑才红，否则一律绿（空闲）」。这样每个会话都有灯，
// 没操作过的会话默认绿（会话存在但没在跑 = 空闲）。
// 纯函数、无副作用，便于单测。
function resolveIsRunning(hookState) {
  return hookState === 'running';
}

class WsClient {
  constructor({ url, machineToken, machineId, defaultWorkDir, ptyManager }) {
    this._url = url;
    this._token = machineToken;
    this._machineId = machineId || getMachineId();
    this._defaultWorkDir = defaultWorkDir || '';
    this._pty = ptyManager;
    this._ws = null;
    this._reconnectTimer = null;
    this._reconnectEnabled = true;
    this._scanDebounce = null;
    this._lastActiveHash = '';  // diff 检测用
    this._lastEnrichedBase = []; // 上一轮全量扫描的会话基础列表（不含 isRunning），供状态轮询复用
    this._lastTmuxSig = null; // 上一轮 tmux 会话集合签名，状态轮询用它廉价检测「新会话/会话退出」
    // sessionId → { state:'running'|'done', ts }。由 Claude Code hooks（status.js）经
    // daemon 转发后写入（updateHookState）。红绿灯计算时 hook 状态优先，PTY 活跃度兜底。
    this._hookStates = new Map();
    this._pingTimer = null;
    this._pongTimer = null;
    this._lastPong = 0;
  }

  connect() {
    console.log(`[ws-client] 尝试连接到: ${this._url}`);
    const wsOptions = {
      headers: {
        'x-machine-token': this._token,
        'x-machine-id': this._machineId
      },
      rejectUnauthorized: false  // 允许自签名证书
    };

    // 如果是 Tailscale userspace-networking 模式，使用 SOCKS5 代理
    // 临时禁用：直接连接而不使用代理
    if (process.env.TAILSCALE_SOCKS5 && process.env.TAILSCALE_SOCKS5 !== 'disabled') {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      const proxyUrl = process.env.TAILSCALE_SOCKS5;
      wsOptions.agent = new SocksProxyAgent(proxyUrl);
      console.log(`[ws-client] 使用 SOCKS5 代理: ${proxyUrl}`);
    }

    const ws = new WebSocket(this._url, wsOptions);
    this._ws = ws;

    ws.on('open', () => {
      console.log(`[ws-client] ✅ WebSocket 连接成功`);
      ws.send(JSON.stringify({ type: 'register', machineId: this._machineId, defaultWorkDir: this._defaultWorkDir || os.homedir() }));
      this._sendSessionList();
      this._sendActiveSessions();
      this._startActiveSessionPoller();
      this._startClientHeartbeat();
    });

    ws.on('message', (data) => this._handleMessage(data.toString()));

    // relay 发来的 WebSocket 协议层 ping → ws 库自动回 pong
    // 但我们也监听 pong 来更新 lastPong 时间戳（用于主动检测）
    ws.on('pong', () => { this._lastPong = Date.now(); });
    ws.on('ping', () => { this._lastPong = Date.now(); }); // relay ping 也算活跃

    ws.on('close', (code, reason) => {
      console.log(`[ws-client] ❌ WebSocket 连接关闭: code=${code}, reason=${reason}`);
      this._stopActiveSessionPoller();
      this._stopClientHeartbeat();
      if (this._reconnectEnabled) {
        console.log(`[ws-client] 5秒后重连...`);
        this._reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws-client] ❌ WebSocket 错误:`, err.message);
    });
  }

  _sendSessionList() {
    try {
      const sessions = listActiveSessions().map(s => ({ id: s.sessionId, cwd: s.cwd }));
      this._send({ type: 'session_list', sessions });
    } catch {
      this._send({ type: 'session_list', sessions: [] });
    }
  }

  // 由 Claude Code hooks（status.js）经 daemon 转发后调用，更新某会话的 hook 状态。
  // state: 'running'（UserPromptSubmit）/ 'done'（Stop）。状态变化时主动重发一轮
  // active_sessions，让红绿灯及时更新（不必等 2.5s 状态轮询）。
  updateHookState(sessionId, state, tmuxSession) {
    if (state !== 'running' && state !== 'done') return;
    // 用两个 key 都登记：Claude Code 给的 UUID（sessionId）和所在 tmux 会话名（tmuxSession）。
    // dashboard 列表里手动建的会话用 tmux 名作 sessionId（如 Vibe/0），UUID 那条永远匹配不上，
    // 必须靠 tmuxSession 这条命中。两条都写，_hookStates 两个 key 都登记，哪条对得上用哪条。
    let changed = false;
    const now = Date.now();
    for (const key of [sessionId, tmuxSession]) {
      if (!key) continue;
      const prev = this._hookStates.get(key);
      this._hookStates.set(key, { state, ts: now });
      if (!prev || prev.state !== state) changed = true;
    }
    if (changed) {
      try { this._sendActiveSessions(); } catch {}
    }
  }

  // 计算某会话的 isRunning（红绿灯状态）：完全由 hook 驱动，不再读 PTY。
  //   - hook running → true（红灯，正在跑）
  //   - 其他一切（done / 没装 hook / 还没上报 / 从没触发过 hook）→ false（绿灯，空闲）
  // 即每个会话都有灯：只有 hook 明确 running 才红，否则一律绿（空闲）。
  // 这样 dashboard attach 重绘 PTY 时不会误判成运行中变红（已不读 PTY）。
  _computeIsRunning(sessionId, now = Date.now()) {
    const hook = this._hookStates.get(sessionId);
    // running 保活兜底：Stop hook 万一漏触发（Claude 崩溃/被 kill），会话会永久卡红灯。
    // 一个 running 超过 HOOK_RUNNING_TTL_MS 仍没等到 done，视为 hook 失效，回落空闲（绿灯）。
    let hookState = hook?.state;
    if (hookState === 'running' && hook.ts && now - hook.ts > HOOK_RUNNING_TTL_MS) {
      hookState = undefined;
    }
    return resolveIsRunning(hookState);
  }

  // 扫描运行中会话，并合并 dashboard 分组归属（folderId）+ 红绿灯状态（isRunning）。
  // isRunning：true=运行中（红灯）/ false=空闲（绿灯）。每个会话都有该字段，都显示灯。
  _enrichedActiveSessions() {
    const sessions = scanActiveSessions();
    const assignments = sessionMeta.getAssignments();
    const now = Date.now();
    const enriched = sessions.map(s => {
      const base = { ...s, folderId: assignments[s.sessionId] || null };
      base.isRunning = this._computeIsRunning(s.sessionId, now);
      return base;
    });
    // 缓存基础会话列表（不含 isRunning），供轻量状态轮询复用，避免高频重扫 tmux/jsonl
    this._lastEnrichedBase = sessions.map(s => ({ ...s, folderId: assignments[s.sessionId] || null }));
    return enriched;
  }

  // 主动推送一轮 active_sessions（含 folderId）+ folders（文件夹树，含空文件夹）。
  // 用户改名/分组操作后强制下发，并同步 _lastActiveHash 避免 poller 紧接着重复发。
  _sendActiveSessions() {
    try {
      const enriched = this._enrichedActiveSessions();
      this._lastActiveHash = JSON.stringify(enriched);
      this._send({ type: 'active_sessions', sessions: enriched });
      this._send({ type: 'folders', folders: sessionMeta.listFolders() });
    } catch {}
  }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'pty_open') {
      const { isNew, historySnapshot } = this._pty.create(msg.sessionId, {
        cols: msg.cols, rows: msg.rows,
        command: msg.command,
        cwd: msg.cwd,
        onData: (data) => {
          this._send({
            type: 'pty_data',
            sessionId: msg.sessionId,
            data: Buffer.from(data).toString('base64')
          });
        },
        onExit: () => {
          this._send({ type: 'pty_data', sessionId: msg.sessionId, data: '' });
        }
      });
      // attach 到已有 tmux session 时，推送历史屏幕快照补屏。
      // 带上 browserId 定向发给请求方：这是 500 行历史文本，广播给该会话的所有
      // 观众会把它硬插进别人正在渲染的 TUI 画面里（最炸屏的一种花屏）。
      if (!isNew && historySnapshot) {
        this._send({
          type: 'pty_data',
          sessionId: msg.sessionId,
          browserId: msg.browserId,
          data: Buffer.from(historySnapshot).toString('base64')
        });
      }
      // 新建 tmux/PTY 成功后立即全量重扫并广播 active_sessions：
      // Dashboard 启动按钮建的新会话无需等 60s 全量轮询或手动刷新页面，即可出现在侧栏。
      if (isNew) {
        this._sendActiveSessions();
      }
    } else if (msg.type === 'pty_input') {
      const data = Buffer.from(msg.data, 'base64').toString();
      this._pty.write(msg.sessionId, data);
    } else if (msg.type === 'pty_resize') {
      this._pty.resize(msg.sessionId, msg.cols, msg.rows);
    } else if (msg.type === 'pty_split') {
      try {
        this._pty.split(msg.sessionId, {
          direction: msg.direction,
          cwd: msg.cwd,
          command: msg.command,
        });
      } catch (error) {
        console.error(`[ws-client] split failed for ${msg.sessionId}:`, error.message);
        this._send({
          type: 'pty_error',
          browserId: msg.browserId,
          action: 'split',
          sessionId: msg.sessionId,
          error: error.message,
        });
      }
    } else if (PANE_OPS[msg.type]) {
      const { action, run } = PANE_OPS[msg.type];
      try {
        run(this._pty, msg);
      } catch (error) {
        console.error(`[ws-client] ${action} failed for ${msg.sessionId}:`, error.message);
        this._send({
          type: 'pty_error',
          browserId: msg.browserId,
          action,
          sessionId: msg.sessionId,
          error: error.message,
        });
      }
    } else if (msg.type === 'pty_close') {
      // 断开浏览器连接，但保留 tmux session（claude 继续跑）
      this._pty.destroy(msg.sessionId);
    } else if (msg.type === 'pty_kill') {
      // 真正终止 claude 进程（kill tmux session）
      this._pty.destroyWithTmux(msg.sessionId);
    } else if (msg.type === 'scan_history') {
      this._debouncedScanHistory();
    } else if (msg.type === 'scan_active') {
      this._sendActiveSessions();
    } else if (msg.type === 'list_dir') {
      const entries = listDir(msg.path || os.homedir());
      this._send({ type: 'dir_entries', path: msg.path, entries });
    } else if (msg.type === 'delete_session') {
      this._deleteSession(msg.sessionId);
    } else if (msg.type === 'read_file') {
      this._readFile(msg.path);
    } else if (msg.type === 'upload_file') {
      this._saveUpload(msg);
    } else if (msg.type === 'rename_session') {
      // 真改 tmux 会话名；成功后迁移分组归属（sessionId 会变成新名）
      const result = this._pty.renameTmuxSession(msg.sessionId, msg.newName);
      if (result.ok) {
        if (result.newTmuxName && result.newTmuxName !== msg.sessionId) {
          sessionMeta.reassignSession(msg.sessionId, result.newTmuxName);
          // 告知 relay 真实的新名，让会话归属台账跟着迁移（relay 无法自行推算 tmux 清洗后的名字）
          this._send({
            type: 'session_renamed',
            oldSessionId: msg.sessionId,
            newSessionId: result.newTmuxName,
          });
        }
        this._sendActiveSessions();
      } else {
        this._send({ type: 'rename_error', sessionId: msg.sessionId, error: result.error });
      }
    } else if (msg.type === 'move_session') {
      sessionMeta.assignSession(msg.sessionId, msg.folderId || null);
      this._sendActiveSessions();
    } else if (msg.type === 'create_folder') {
      // folderId 由 relay 下发：归属台账在服务端，id 必须两边一致
      sessionMeta.createFolder(msg.name, msg.parentId || null, msg.folderId || null);
      this._sendActiveSessions();
    } else if (msg.type === 'rename_folder') {
      sessionMeta.renameFolder(msg.folderId, msg.newName);
      this._sendActiveSessions();
    } else if (msg.type === 'delete_folder') {
      sessionMeta.deleteFolder(msg.folderId);
      this._sendActiveSessions();
    } else if (msg.type === 'move_folder') {
      sessionMeta.moveFolder(msg.folderId, msg.parentId || null);
      this._sendActiveSessions();
    }
  }

  // debounce：多个浏览器同时请求 scan_history 时只执行一次
  _debouncedScanHistory() {
    if (this._scanDebounce) return;
    this._scanDebounce = setTimeout(() => {
      this._scanDebounce = null;
      scanSessionHistory().then(sessions => {
        this._send({ type: 'session_history', sessions });
      });
    }, 200);
  }

  _readFile(filePath) {
    try {
      const resolved = path.resolve(filePath);
      const home = os.homedir();
      const cfg = loadConfig();
      const access = cfg.fileAccess || {};
      const blockedDirs = access.blockedDirs || ['.ssh', '.gnupg', '.aws', '.config/gcloud', '.env'];
      const blockedSystem = access.blockedSystemPaths || ['/etc/shadow', '/etc/passwd', '/proc', '/sys'];
      const maxSize = (access.maxFileSizeKB || 100) * 1024;
      // 安全检查：禁止 home 下的敏感目录
      for (const b of blockedDirs) {
        if (resolved.startsWith(path.join(home, b))) {
          this._send({ type: 'file_content', path: filePath, error: 'Access denied' });
          return;
        }
      }
      // 禁止系统关键路径
      for (const s of blockedSystem) {
        if (resolved.startsWith(s)) {
          this._send({ type: 'file_content', path: filePath, error: 'Access denied' });
          return;
        }
      }
      const stat = fs.statSync(resolved);
      if (stat.size > maxSize) {
        this._send({ type: 'file_content', path: filePath, error: `File too large (>${access.maxFileSizeKB || 100}KB)` });
        return;
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      this._send({ type: 'file_content', path: filePath, content });
    } catch (e) {
      this._send({ type: 'file_content', path: filePath, error: e.message });
    }
  }

  /**
   * 浏览器粘贴 / 拖入的文件落到本机盘上，把绝对路径回给发起的那个浏览器，
   * 由前端把路径敲进终端 —— claude 读的是**本机**路径，字节直接进 PTY 没有意义。
   * 回执必须带 browserId 定向（同一会话可能有多个观众，不能广播给所有人）。
   */
  _saveUpload(msg) {
    const reply = (extra) => this._send({
      type: 'file_uploaded',
      browserId: msg.browserId,
      uploadId: msg.uploadId,
      sessionId: msg.sessionId,
      name: msg.name,
      ...extra,
    });
    try {
      const cfg = loadConfig();
      const { path: saved, bytes } = saveUpload(
        { name: msg.name, data: msg.data },
        { maxUploadMB: cfg.fileAccess?.maxUploadMB, baseDir: cfg.fileAccess?.uploadDir },
      );
      reply({ path: saved, bytes });
    } catch (e) {
      console.error('[ws-client] upload failed:', e.message);
      reply({ error: e.message });
    }
  }

  _deleteSession(sessionId) {
    scanSessionHistory().then(sessions => {
      const target = sessions.find(s => s.sessionId === sessionId);
      if (target && target.filePath) {
        try { fs.unlinkSync(target.filePath); } catch {}
      }
      invalidateHistoryCache();
      this._send({ type: 'session_deleted', sessionId });
      scanSessionHistory().then(updated => {
        this._send({ type: 'session_history', sessions: updated });
      });
    });
  }

  // ── 客户端心跳：主动检测 relay 是否存活 ─────────────────────
  _startClientHeartbeat() {
    this._stopClientHeartbeat();
    this._lastPong = Date.now();
    this._pingTimer = setInterval(() => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      // 检查上次收到 pong/ping 的时间
      if (Date.now() - this._lastPong > WS_PING_INTERVAL + WS_PONG_TIMEOUT) {
        console.warn(`[ws-client] 💀 心跳超时（${WS_PONG_TIMEOUT}ms 无响应），主动断开重连`);
        this._ws.terminate();
        return;
      }
      try { this._ws.ping(); } catch {}
    }, WS_PING_INTERVAL);
  }

  _stopClientHeartbeat() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _startActiveSessionPoller() {
    this._stopActiveSessionPoller();
    this._activePoller = setInterval(() => {
      const enriched = this._enrichedActiveSessions();
      const hash = JSON.stringify(enriched);
      if (hash === this._lastActiveHash) return; // diff 检测：不变（含 folderId）则不发送
      this._lastActiveHash = hash;
      this._send({ type: 'active_sessions', sessions: enriched });
      this._send({ type: 'folders', folders: sessionMeta.listFolders() });
    }, ACTIVE_POLL_INTERVAL);
    this._startStatusPoller();
  }

  // 轻量状态轮询：高频（2.5s）只刷新红绿灯 isRunning，不重新扫描 tmux/jsonl。
  // 复用上一轮全量扫描缓存的会话列表（_lastEnrichedBase），逐个会话从内存里的 _hookStates
  // 重算 isRunning（纯内存，零 IO）。仅当某会话 isRunning 发生变化时才重发 active_sessions。
  // 为什么保留这个轮询：hook 状态变化大多由 updateHookState 主动触发重发，但 running 保活
  // 超时失效（HOOK_RUNNING_TTL_MS）是「被动」状态变化，没有触发点，只能靠这个轮询捕获并刷新。
  // 无状态会话不写 isRunning 字段（与 _enrichedActiveSessions 保持一致），前端据此不显示灯。
  // 注意：复用同一份 _lastActiveHash diff 机制，与慢速全量 poller 不冲突——两者算出的
  // hash 结构一致，谁先发都会更新 hash，后者发现无变化自然跳过。
  _startStatusPoller() {
    this._stopStatusPoller();
    this._statusPoller = setInterval(() => this._pollStatusOnce(), STATUS_POLL_INTERVAL);
  }

  // 当前 tmux 会话集合的签名（会话名排序后拼接）。只做一次 `tmux list-panes`，用于廉价检测
  // 「会话集合是否发生增删」。抽成独立方法便于单测注入替身。
  _currentTmuxSignature() {
    return getTmuxSessions().map(t => t.tmuxName).sort().join('|');
  }

  // 一次状态轮询：先廉价检测 tmux 会话集合是否变化——新建/退出的会话（含在开发机终端里
  // 裸跑的 claude、非 Dashboard 启动的会话）借此在 ≤2.5s 内被发现，无需等 60s 全量轮询或
  // 手动刷新页面。集合未变时，退回原有「纯内存重算红绿灯」逻辑（零 IO），仅刷新 isRunning。
  _pollStatusOnce() {
    const tmuxSig = this._currentTmuxSignature();
    if (tmuxSig !== this._lastTmuxSig) {
      this._lastTmuxSig = tmuxSig;
      this._sendActiveSessions(); // 内部全量重扫 tmux+jsonl 并广播
      return;
    }
    const base = this._lastEnrichedBase;
    if (!base || base.length === 0) return; // 还没有过全量扫描，跳过
    const now = Date.now();
    const enriched = base.map(s => {
      const next = { ...s };
      const isRunning = this._computeIsRunning(s.sessionId, now);
      if (isRunning !== undefined) next.isRunning = isRunning; // 无状态不加字段
      return next;
    });
    const hash = JSON.stringify(enriched);
    if (hash === this._lastActiveHash) return; // isRunning 无变化（且基础列表未变）则不发
    this._lastActiveHash = hash;
    this._send({ type: 'active_sessions', sessions: enriched });
  }

  _stopStatusPoller() {
    if (this._statusPoller) {
      clearInterval(this._statusPoller);
      this._statusPoller = null;
    }
  }

  _stopActiveSessionPoller() {
    this._stopStatusPoller();
    if (this._activePoller) {
      clearInterval(this._activePoller);
      this._activePoller = null;
    }
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  disconnect() {
    this._reconnectEnabled = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._stopActiveSessionPoller();
    this._stopClientHeartbeat();
    if (this._scanDebounce) clearTimeout(this._scanDebounce);
    if (this._ws) this._ws.close();
  }
}

module.exports = {
  WsClient,
  PANE_OPS,
  scanSessionHistory,
  scanActiveSessions,
  getTmuxSessions,
  listDir,
  inferActiveSessionTool,
  mergeActiveSessionMetadata,
  resolveIsRunning,
};
