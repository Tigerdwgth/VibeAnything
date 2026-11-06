// lib/pty-manager.js
const pty = require('node-pty');
const { execSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const { createCodexWhip, matchesWhipError } = require('./codex-whip');

const DEFAULT_CODEX_WHIP = { enabled: true, cooldownMs: 30000 };

const TMUX_SPLIT_FLAGS = {
  up: ['-v', '-b'],
  down: ['-v'],
  left: ['-h', '-b'],
  right: ['-h'],
};

// 在已有的分屏之间移动焦点（不是新建）。tmux 的方向选择标志与 split 是两套，别混用。
const TMUX_SELECT_FLAGS = {
  up: '-U',
  down: '-D',
  left: '-L',
  right: '-R',
};

// tmux 子命令的超时：tmux server 卡死时 spawnSync 会一直等下去，整个 daemon 的事件循环
// （心跳、轮询、所有浏览器的输入）跟着冻住。正常调用都在几十毫秒内返回。
const TMUX_TIMEOUT_MS = 5000;

function runTmux(args, opts = {}) {
  return spawnSync('tmux', args, { timeout: TMUX_TIMEOUT_MS, ...opts });
}

// tmux 的 -t 按「精确 → 前缀 → 通配」依次找会话：会话 test 已经退出、test2 还在时，
// `-t test` 落到 test2 上 —— 删掉过期的 test 会杀掉 test2，打开 api 会 attach 进 cc-api-server。
// 前面加 = 只接受精确匹配。target-session 写 `=名字`；target-window / target-pane 写
// `=名字:`（冒号后留空 = 该会话的当前窗口 / 当前窗口的活动 pane，与原来只给会话名的语义一致）。
function sessionTarget(name) {
  return `=${name}`;
}

function paneTarget(name) {
  return `=${name}:`;
}

// tmux session 名称：截取 sessionId 前 48 字符（tmux 支持长名称，16 字符会导致
// new-claude-<timestamp> 格式的 sessionId 在 ~28 小时内全部碰撞到同一个 tmux session）
function tmuxName(sessionId) {
  // 手动创建的普通 tmux session：sessionId 本身就是其真实名称，已存在则直接复用，
  // 不再套 cc- 前缀，保证扫描到的非 dashboard 会话也能被 attach
  if (tmuxHasSession(sessionId)) return sessionId;
  // 只清洗 tmux 真正不接受的字符（. : 空白），**保留中文等非 ASCII**。
  // 从前的 [^a-zA-Z0-9-] 会把非 ASCII 整个剥掉，`多agent-bash` 与 `agent-bash`
  // 双双落到 cc-agent-bash：同一个 tmux 窗口被两个 sessionId 各开一个 PTY，
  // 两边按各自的观众尺寸互相把窗口拽回去（实测该窗口上并存 120x40 与 186x49 两个客户端）。
  // 按码点切片，避免 slice 把代理对劈成半个字符。
  const base = Array.from(sanitizeTmuxName(sessionId)).slice(0, 48).join('').replace(/-+$/, '');
  return 'cc-' + (base || 'session');
}

function tmuxHasSession(name) {
  const r = runTmux(['has-session', '-t', sessionTarget(name)], { stdio: 'ignore' });
  return r.status === 0;
}

// 会话当前窗口的 pane 数量（删分屏时判断是否只剩一个窗格）
function tmuxPaneCount(name) {
  try {
    const r = runTmux(['list-panes', '-t', paneTarget(name), '-F', 'x'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return 1;
    return r.stdout.trim().split('\n').filter(Boolean).length || 1;
  } catch {
    return 1;
  }
}

// tmux 会话名不能含 '.'、':'（tmux 的分隔符）或空白：这些替换为 '-'，其余（含中文）保留。
// 首尾多余的 '-' 去掉。用于「重命名会话」真改 tmux 名前的清洗。
function sanitizeTmuxName(name) {
  return String(name || '').trim().replace(/[.:\s]+/g, '-').replace(/^-+|-+$/g, '');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getCleanEnv() {
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_SSE_PORT;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  cleanEnv.IS_SANDBOX = '1';
  cleanEnv.TERM = 'xterm-256color';
  // 确保 UTF-8 locale：tmux session 用此 env 创建/attach，缺 UTF-8 区域会把中文显示成乱码。
  // launchd 托管的 daemon 环境没有 LANG，会退回 C 区域 —— 这里兜底补回。
  if (!/UTF-?8/i.test(cleanEnv.LANG || '')) cleanEnv.LANG = 'zh_CN.UTF-8';
  if (!cleanEnv.LC_ALL && !cleanEnv.LC_CTYPE) cleanEnv.LC_CTYPE = 'zh_CN.UTF-8';
  if (!cleanEnv.SHELL) cleanEnv.SHELL = '/bin/bash';
  return cleanEnv;
}

function buildCommandString(command) {
  if (!Array.isArray(command) || command.length === 0) return null;
  const [cmd, ...rest] = command;
  const args = [...rest];
  if (cmd === 'claude' && !args.includes('--dangerously-skip-permissions')) {
    args.push('--dangerously-skip-permissions');
  }
  return [cmd, ...args].map(quoteShellArg).join(' ');
}

// 一个 tmux 窗格的启动命令：跑用户点的命令，命令退出后落到交互式登录 shell
// （而不是 exec 替换掉直接消失），这样退出 claude/codex 会回到 zsh，窗格不会关掉。
//
// 组装方式很要紧：正文里每个参数各自 quoteShellArg，**整段正文最后再整体
// quoteShellArg 一次**，交给 `bash -l -c <整段>`。
// 早先的写法是把已经加过引号的参数直接拼进一对外层单引号里
// （`bash -l -c '... && 'claude' '--flag'; exec zsh -l'`），靠相邻引号段首尾粘连
// 才碰巧成立。只要任何一个参数或 cwd 里带空格，粘连就断在那个空格上，后面的 `;`
// 从字面量变成真正的命令分隔符，整条命令被腰斩 —— 窗格一开出来就是空的或直接没了。
//
// 外层固定用 bash 而不是用户的 $SHELL：这段正文是 POSIX 语法，bash 一定解析得了；
// 用户最终落到哪个 shell 由末尾的 `exec <defaultShell> -l` 决定，与外层无关。
function buildLoginShellCommand(command, { cwd, defaultShell = '/bin/bash' } = {}) {
  const commandString = buildCommandString(command);
  if (!commandString) return null;
  // login shell 不一定 source .bashrc（nvm 通常装在那儿），所以显式 source 一次，
  // 保证 claude/codex 用的是 nvm 管理的 node。
  const nvmInit = '[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ] && . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"';
  // codex 需要较新 node：仅当 nvm 可用时才切版本，否则（如 homebrew 装的 node）跳过。
  const nvmVersion = command[0] === 'codex' ? 'command -v nvm >/dev/null 2>&1 && nvm use 25 2>/dev/null; ' : '';
  const cwdPrefix = cwd ? `cd ${quoteShellArg(cwd)} && ` : '';
  const script = `${nvmInit}; ${nvmVersion}${cwdPrefix}${commandString}; exec ${quoteShellArg(defaultShell)} -l`;
  return `bash -l -c ${quoteShellArg(script)}`;
}

function buildSplitWindowArgs(sessionId, { direction, cwd, command, defaultShell } = {}) {
  const flags = TMUX_SPLIT_FLAGS[direction];
  if (!flags) throw new Error(`Unsupported split direction: ${direction}`);

  const args = ['split-window', ...flags, '-t', paneTarget(tmuxName(sessionId))];
  if (cwd) args.push('-c', cwd);

  const shellCommand = buildLoginShellCommand(command, {
    cwd,
    defaultShell: defaultShell || process.env.SHELL || '/bin/bash',
  });
  if (shellCommand) args.push(shellCommand);
  return args;
}

// 焦点在分屏之间移动：-t 给会话名时，tmux 解析成「该会话当前窗口的活动 pane」，
// 再从它出发按方向选下一个。到边界会**回绕**到另一头（实测，不是停住），
// 所以一路按同一个方向能轮着看完所有窗格；只有一个窗格时就是原地不动，都不报错。
function buildSelectPaneArgs(sessionId, direction) {
  const flag = TMUX_SELECT_FLAGS[direction];
  if (!flag) throw new Error(`Unsupported select direction: ${direction}`);
  return ['select-pane', '-t', paneTarget(tmuxName(sessionId)), flag];
}

// 关掉当前活动 pane。
function buildKillPaneArgs(sessionId) {
  return ['kill-pane', '-t', paneTarget(tmuxName(sessionId))];
}

// 把窗格拉回最新输出。
//
// 往上滚历史时 tmux 进的是 copy-mode，视图从此钉在历史上不再跟随新输出。`copy-mode -q`
// 的 -q 就是 cancel：退出模式，窗格自动回到活动区底部。
//
// **不在 copy-mode 时执行是无害的空操作**（tmux 3.2a 与 3.7c 上都实测过，退出码 0、
// pane_in_mode 保持 0），所以不需要先查状态再决定发不发 —— 查一次状态要多一次 spawnSync，
// 而且查完到执行之间状态还可能变。
//
// 用 `-t <会话名>` 与 select-pane 同一套目标语义：tmux 解析成该会话当前窗口的活动 pane。
function buildScrollToBottomArgs(sessionId) {
  return ['copy-mode', '-q', '-t', paneTarget(tmuxName(sessionId))];
}

// tmux 的状态栏占掉客户端最下面的若干行（status on = 1 行，也可设成 2..5）。
// 客户端有 H 行时，窗口只能有 H - status 行 —— 这正是 tmux 自己 resize-window -A
// 算出来的值（实测 100x30 的客户端 → 窗口 100x29）。
function tmuxStatusLines(name) {
  const read = (args) => {
    const r = runTmux(args, { encoding: 'utf8' });
    return r.status === 0 ? (r.stdout || '').trim() : '';
  };
  // 会话级没设就落到全局。show-options 的 -t 是 target-pane，`=名字` 会被当成找不到的会话
  const v = read(['show-options', '-t', paneTarget(name), '-v', 'status']) || read(['show-options', '-g', '-v', 'status']);
  if (v === 'off') return 0;
  if (v === '' || v === 'on') return 1;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

// 把尺寸同时应用到 attach 用的 pty 和 tmux 窗口。
// 只 resize pty 不够：tmux 窗口尺寸是所有客户端协商出来的，历史上被某个客户端
// 压小过（实测有窗口被压到 10x5）之后不会自己长回去，浏览器看到的排版就一直错位。
// resize-window 会把该窗口切到手动尺寸，从此由 dashboard 说了算。
//
// **行数必须扣掉状态栏**：pty（客户端）是 rows 行，窗口只能拿到 rows - status 行。
// 把客户端行数原样传给 resize-window，窗口就比客户端能显示的区域高一截，tmux 为了
// 让光标可见会把视口整体上移 —— 表现为「当前这屏正常，往上翻整屏错位」。
function applySize(name, p, cols, rows) {
  if (!cols || !rows) return;
  try { p?.resize(cols, rows); } catch {}
  const winRows = Math.max(1, rows - tmuxStatusLines(name));
  try { runTmux(['resize-window', '-t', paneTarget(name), '-x', String(cols), '-y', String(winRows)]); } catch {}
}

/**
 * 会话里每个 pane 最近一处容量/限流错误所在的绝对行号（history_size + 屏幕行），没有为 -1。
 *
 * 抽鞭子要靠它，而不能只看 attach 流：attach 流混着所有 pane 的输出，而且每换一次 attach
 * 客户端 tmux 都会整屏重绘，屏幕上留着的旧错误会再流一遍。绝对行号随滚屏不变，
 * 同一处错误重绘多少次都是同一个值，只有新打印的错误才会更大。
 * 相邻两行拼起来再匹配：错误文本可能被窗口宽度折成两行。
 */
function latestWhipErrorLines(name) {
  const lines = new Map();
  const r = runTmux(['list-panes', '-s', '-t', sessionTarget(name), '-F', '#{pane_id}\t#{history_size}'], { encoding: 'utf8' });
  if (r.status !== 0) return lines;
  for (const row of (r.stdout || '').trim().split('\n')) {
    const [paneId, history] = row.split('\t');
    if (!paneId) continue;
    const cap = runTmux(['capture-pane', '-p', '-t', paneId], { encoding: 'utf8' });
    if (cap.status !== 0) continue;
    const screen = (cap.stdout || '').split('\n');
    let last = -1;
    screen.forEach((text, y) => {
      if (matchesWhipError(text + (screen[y + 1] || ''))) last = Number(history) + y;
    });
    lines.set(paneId, last);
  }
  return lines;
}

/**
 * 给出现了新错误的 pane 发 continue，返回是否发了。
 * 直接 send-keys 给那个 pane，而不是写进 attach 的 PTY —— PTY 的输入落在当前活动 pane，
 * 用户分屏后焦点在别的 pane 时，continue 会敲进 shell 里。先退出 copy-mode，否则按键被它吃掉。
 */
function sendWhipContinue(state) {
  const latest = latestWhipErrorLines(state.tmuxName);
  let sent = false;
  for (const [paneId, line] of latest) {
    if (line <= (state.whipSeen.get(paneId) ?? -1)) continue;
    runTmux(['copy-mode', '-q', '-t', paneId]);
    runTmux(['send-keys', '-t', paneId, 'continue', 'Enter']);
    sent = true;
  }
  state.whipSeen = latest;
  return sent;
}

class PtyManager {
  constructor({ codexWhip } = {}) {
    // codex 容量/429 限流自动续跑配置。config.json 可能只给了部分字段
    // （loadConfig 是浅合并），这里兜底补全默认值。
    this._codexWhipCfg = { ...DEFAULT_CODEX_WHIP, ...(codexWhip || {}) };
    // sessionId → sessionState { pty, tmuxName, onDataCallbacks: Map<sessionId, cb>, refIds: Set }
    this._sessions = new Map();
    // tmuxName → sessionState。**一个 tmux 窗口只允许一个 dashboard attach 客户端**：
    // 多个 sessionId 可能落到同一个窗口（手动会话名与 cc- 名互指、历史遗留的碰撞名），
    // 各开一个 PTY 就会各按各的尺寸调 resize-window，窗口在两个值之间来回被拽。
    this._byTmuxName = new Map();
  }

  /** 把一个 sessionId 挂到已有的 sessionState 上（重连或别名共用同一个 tmux 窗口）。 */
  _attachRef(sessionId, state, onData) {
    if (onData) state.onDataCallbacks.set(sessionId, onData);
    state.refIds.add(sessionId);
    this._sessions.set(sessionId, state);
    this._byTmuxName.set(state.tmuxName, state);
  }

  /** 摘掉 state 的全部索引（pty 已死或已被 kill）。 */
  _dropState(state) {
    for (const id of state.refIds) this._sessions.delete(id);
    if (this._byTmuxName.get(state.tmuxName) === state) this._byTmuxName.delete(state.tmuxName);
  }

  /**
   * 给 state 换一个全新的 tmux attach 客户端，旧客户端随即断开。
   *
   * 为什么后来的观众不能直接挂在现有客户端上：tmux 只在客户端刚 attach 时发一次终端
   * 初始化（进 alternate screen、开鼠标上报）和整屏重绘。半路加入的 xterm 收不到这些，
   * 停在普通缓冲区里 —— 滚轮滚的是 xterm 自己的 scrollback，看到的不是 tmux 的历史；
   * 鼠标也不上报给 tmux。重新 attach 让所有观众都拿到完整的初始化与重绘；
   * copy-mode 状态挂在窗格上，不受客户端更替影响。
   *
   * 旧客户端的输出与退出事件一律丢弃：它退出时发的「离开 alternate screen」
   * 若晚于新客户端的初始化到达，会把所有观众又踢回普通缓冲区。
   */
  _spawnAttach(state, { cols, rows, cwd, env }) {
    const p = pty.spawn('tmux', ['attach-session', '-t', sessionTarget(state.tmuxName)], {
      name: 'xterm-256color',
      cols, rows,
      cwd,
      env,
    });
    const prev = state.pty;
    state.pty = p;

    p.onData((data) => {
      if (state.pty !== p) return;
      // 红绿灯状态已完全改由 Claude Code hook 驱动，这里不再记录 PTY 输出时间。
      // 抽鞭子检测先跑，命中会给出错的 pane 发 continue；不拦截也不吞数据，
      // 原分发（红绿灯等其它回调）照常收到每一份输出。
      if (state.whip) state.whip.onData(data);
      for (const cb of state.onDataCallbacks.values()) {
        try { cb(data); } catch {}
      }
    });

    p.onExit(() => {
      if (state.pty !== p) return;
      // pty 断开（浏览器关闭），但 tmux session 还在，不销毁 claude
      this._dropState(state);
      if (state.onExit) state.onExit();
    });

    if (prev) { try { prev.kill(); } catch {} }
    // attach 上去的窗口可能还带着上一个客户端留下的尺寸，立刻按本次请求的尺寸校正
    applySize(state.tmuxName, p, cols, rows);
  }

  /**
   * 打开或复用一个 tmux session。
   * tmux session 已存在时 attach 上去；已有 dashboard 客户端在看时换一个新客户端
   * （见 _spawnAttach），让新老观众都拿到完整的终端初始化。
   * @param {string} sessionId
   * @param {{ cols, rows, command, cwd, onData, onExit }} opts
   * @returns {{ isNew: boolean }}
   */
  create(sessionId, { cols = 220, rows = 50, command, cwd, onData, onExit } = {}) {
    const name = tmuxName(sessionId);
    // 同名 tmux 窗口已经有 PTY 就复用它的 state，不再并存第二个 attach 客户端
    const existing = this._sessions.get(sessionId) || this._byTmuxName.get(name);
    const cleanEnv = getCleanEnv();

    // 复用：pty 进程存活就沿用 state。回调按 sessionId 存 —— 同一 sessionId 重连是
    // 覆盖（避免累积重复回调导致输出翻倍），别名接入是新增（不能把对方的回调清掉）。
    // 先换客户端再登记引用：spawn 失败时异常直接抛给调用方，state 原样保留、旧客户端照常在跑。
    // （从前 spawn 也包在探活的 try 里，失败会被当成「pty 已死」摘掉 state，活着的旧客户端就成了孤儿。）
    if (existing) {
      if (processAlive(existing.pty.pid)) {
        this._spawnAttach(existing, { cols, rows, cwd: cwd || process.env.HOME || '/', env: cleanEnv });
        this._attachRef(sessionId, existing, onData);
        return { isNew: false };
      }
      this._dropState(existing);
    }

    // 构建要在 tmux 里运行的命令。claude 的 --dangerously-skip-permissions 由
    // buildCommandString 统一补，这里不再重复一遍。
    const cmd = (command && command.length > 0) ? command[0] : 'claude';
    const args = (command && command.length > 1) ? command.slice(1) : [];
    const workdir = cwd || process.env.HOME || '/';

    let isNew = false;
    // tmux session 已存在（例如另一台浏览器之前开过，pty 已死但 tmux 还活着）就直接 attach；
    // 不强制 set mouse off，否则会污染用户手动建的会话，导致本机直接 attach 时鼠标滚轮
    // 无法滚动。浏览器端选中文字由 xterm.js 自行处理（Shift+拖拽 / 双击 / 全选复制按钮）。
    if (!tmuxHasSession(name)) {
      // 新建 tmux session，在里面运行命令。
      // 和分屏（buildSplitWindowArgs）共用同一个构造器：两条路都要「命令退出后回到
      // 用户的登录 shell」，逻辑只该有一份。cleanEnv.SHELL 由 getCleanEnv 保证有值。
      const shellCmd = buildLoginShellCommand([cmd, ...args], {
        cwd: workdir,
        defaultShell: cleanEnv.SHELL,
      });
      // -x/-y 给的是**窗口**尺寸，同样要扣掉状态栏（会话还不存在，取全局 status）
      runTmux([
        'new-session', '-d',
        '-s', name,
        '-x', String(cols),
        '-y', String(Math.max(1, rows - tmuxStatusLines(name))),
        shellCmd,
      ], { env: cleanEnv });
      isNew = true;
    }

    const sessionState = {
      pty: null,
      tmuxName: name,
      onDataCallbacks: new Map(),   // sessionId → cb
      refIds: new Set(),            // 共用这条 PTY 的所有 sessionId
      onExit,
      whip: null,
      whipSeen: new Map(),          // paneId → 已经处理过（或挂上时就在屏幕上）的最新错误行号
    };

    // 仅 codex 会话挂自动续跑：遇容量/限流错误给出错的 pane 发 continue，其它会话不触发。
    // 挂在 sessionState 上，复用已存在会话、更换 attach 客户端时沿用（不重复创建）。
    // 挂上那一刻屏幕上已有的错误记为已见：那是挂上之前的事，用户可能早就处理过了。
    if (cmd === 'codex' && this._codexWhipCfg.enabled) {
      sessionState.whipSeen = latestWhipErrorLines(name);
      sessionState.whip = createCodexWhip({
        write: () => sendWhipContinue(sessionState),
        cooldownMs: this._codexWhipCfg.cooldownMs,
        enabled: true,
        onTrigger: (msg) => console.log(`[pty-manager] ${msg} (session ${sessionId})`),
      });
    }

    // node-pty attach 到 tmux session（这是浏览器和 tmux 之间的 PTY）
    this._spawnAttach(sessionState, { cols, rows, cwd: workdir, env: cleanEnv });
    this._attachRef(sessionId, sessionState, onData);
    return { isNew };
  }

  /**
   * 给 sessionId 对应的 pty（tmux attach）写输入
   */
  write(sessionId, data) {
    const s = this._sessions.get(sessionId);
    if (s) s.pty.write(data);
  }

  split(sessionId, { direction, cwd, command, defaultShell } = {}) {
    const name = tmuxName(sessionId);
    if (!tmuxHasSession(name)) {
      throw new Error(`tmux session not found: ${sessionId}`);
    }

    const cleanEnv = getCleanEnv();
    const result = runTmux(buildSplitWindowArgs(sessionId, {
      direction,
      cwd: cwd || process.env.HOME || '/',
      command,
      defaultShell: defaultShell || cleanEnv.SHELL,
    }), {
      env: cleanEnv,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'tmux split failed').trim());
    }
    // 不再 set mouse off：保留用户全局 mouse on，鼠标滚轮可滚动。
  }

  /** 把焦点移到相邻分屏（上/下/左/右）。到边界回绕，只有一个窗格时原地不动，都不算失败。 */
  selectPane(sessionId, { direction } = {}) {
    const name = tmuxName(sessionId);
    if (!tmuxHasSession(name)) {
      throw new Error(`tmux session not found: ${sessionId}`);
    }

    const result = runTmux(buildSelectPaneArgs(sessionId, direction), {
      env: getCleanEnv(),
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'tmux select-pane failed').trim());
    }
  }

  /**
   * 关掉当前活动分屏。
   *
   * 只剩一个 pane 时 tmux 的 kill-pane 会连整个 window 一起收掉，会话随之结束 ——
   * 里面跑着的 claude / codex 会被一起杀掉。那是「删除会话」而不是「删除分屏」，
   * 是两件事，所以这里直接拒绝，让上层去走删除会话的路径。
   */
  killPane(sessionId) {
    const name = tmuxName(sessionId);
    if (!tmuxHasSession(name)) {
      throw new Error(`tmux session not found: ${sessionId}`);
    }
    if (tmuxPaneCount(name) <= 1) {
      throw new Error('当前会话只有一个窗格，没有可删除的分屏（删掉它等于结束整个会话）');
    }

    const result = runTmux(buildKillPaneArgs(sessionId), {
      env: getCleanEnv(),
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'tmux kill-pane failed').trim());
    }
  }

  /**
   * 回到最新输出（退出 copy-mode）。
   *
   * 浏览器侧的 `term.scrollToBottom()` 对这件事无效：终端里跑的是 tmux attach，内容在
   * alternate screen，xterm 自己的 scrollback 是空的（见 TerminalPanel.jsx 的说明）。
   * 滚上去之后 tmux 停在 copy-mode，只有它自己能退出来。
   *
   * 已经在底部时是空操作，不算失败。
   */
  scrollToBottom(sessionId) {
    const name = tmuxName(sessionId);
    if (!tmuxHasSession(name)) {
      throw new Error(`tmux session not found: ${sessionId}`);
    }

    const result = runTmux(buildScrollToBottomArgs(sessionId), {
      env: getCleanEnv(),
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'tmux copy-mode -q failed').trim());
    }
  }

  resize(sessionId, cols, rows) {
    const s = this._sessions.get(sessionId);
    if (s) applySize(s.tmuxName, s.pty, cols, rows);
  }

  /**
   * 某个 sessionId 不再需要这条 PTY。别名共用同一个 tmux 窗口时按引用计数，
   * 最后一个引用离开才真的断开 —— 否则关掉一个 tab 会把另一个 tab 的流一起掐断。
   * 不 kill tmux session，claude 继续跑。
   */
  destroy(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return;
    s.onDataCallbacks.delete(sessionId);
    s.refIds.delete(sessionId);
    this._sessions.delete(sessionId);
    if (s.refIds.size > 0) return;
    try { s.pty.kill(); } catch {}
    this._dropState(s);
  }

  /**
   * 彻底终止：同时 kill tmux session（关闭 claude 进程）。
   * 窗口没了，共用它的所有别名一并失效，不走引用计数。
   */
  destroyWithTmux(sessionId) {
    const s = this._sessions.get(sessionId);
    const name = s ? s.tmuxName : tmuxName(sessionId);
    if (s) {
      try { s.pty.kill(); } catch {}
      this._dropState(s);
    }
    try {
      runTmux(['kill-session', '-t', sessionTarget(name)]);
    } catch {}
  }

  has(sessionId) {
    // 也检查 tmux session 是否存在（即使 pty 断了 claude 还在跑）
    if (this._sessions.has(sessionId)) return true;
    return tmuxHasSession(tmuxName(sessionId));
  }

  /**
   * 重命名会话：真改 tmux session 名（tmux rename-session）。
   * 重命名后该会话的 sessionId 会变成新名字（扫描时非 cc- 名直接当 sessionId），
   * 调用方需用 session-metadata.reassignSession 迁移分组归属。
   * @returns {{ ok: boolean, newTmuxName?: string, error?: string }}
   */
  renameTmuxSession(sessionId, newName) {
    const sanitized = sanitizeTmuxName(newName);
    if (!sanitized) return { ok: false, error: '名称不能为空' };

    const existing = this._sessions.get(sessionId);
    const oldName = existing ? existing.tmuxName : tmuxName(sessionId);
    if (!tmuxHasSession(oldName)) return { ok: false, error: `会话不存在: ${sessionId}` };
    if (sanitized === oldName) return { ok: true, newTmuxName: oldName };
    if (tmuxHasSession(sanitized)) return { ok: false, error: `已存在同名会话: ${sanitized}` };

    const r = runTmux(['rename-session', '-t', sessionTarget(oldName), sanitized], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'tmux rename 失败').trim() };

    // 旧 sessionId 对应的 pty 会悬空（sessionId 已变）：断开旧 pty 但保留 tmux，
    // 让前端用新名重新 attach。state 里记的 tmuxName 已作废，共用它的别名一起摘掉。
    if (existing) {
      try { existing.pty.kill(); } catch {}
      this._dropState(existing);
    }
    return { ok: true, newTmuxName: sanitized };
  }

  destroyAll() {
    for (const id of [...this._sessions.keys()]) this.destroy(id);
  }
}

module.exports = {
  PtyManager, buildSplitWindowArgs, buildSelectPaneArgs, buildKillPaneArgs,
  buildScrollToBottomArgs, buildLoginShellCommand,
  tmuxName, tmuxPaneCount, sanitizeTmuxName,
};
