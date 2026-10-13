// packages/server/relay.js
const { randomUUID } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { verifyToken } = require('./auth');
const owners = require('./session-owners');
const machineTokens = require('./machine-tokens');

// 会话对象的 id 字段名不统一：active_sessions 用 sessionId，session_list 用 id。
function sessionIdOf(s) {
  return s?.sessionId || s?.id || null;
}

// ── 浏览器 → relay 的鉴权策略表 ────────────────────────────────
// 每种浏览器可发的消息类型都必须在这里登记，**没登记的一律丢弃**。
// 用白名单 Set「列进来的才查」是反的：那样下一个新增的消息类型默认免鉴权。
//   session: 取出要校验归属的 sessionId
//   folders: 取出要校验归属的 folderId 列表（null/undefined = 根级，人人可用）
//   claimSession: 该会话在开发机上还不存在时视为新建，认领归属而不是拒绝
//   open: 尚未按归属收口的通道，显式声明开放（见 README「待实现」），而不是靠遗漏放行
const BROWSER_POLICY = {
  open_terminal:   { session: m => m.sessionId, claimSession: true },
  pty_attach:      { session: m => m.sessionId },
  terminal_input:  { session: m => m.sessionId },
  terminal_resize: { session: m => m.sessionId },
  release_size:    { session: m => m.sessionId },
  split_terminal:  { session: m => m.sessionId },
  select_pane:     { session: m => m.sessionId },
  kill_pane:       { session: m => m.sessionId },
  // 把窗格拉回最新输出（退出 tmux copy-mode）。同样只能对自己的会话做 ——
  // 别人正翻着历史，不该被另一个人一键拽回底部。
  scroll_to_bottom: { session: m => m.sessionId },
  close_terminal:  { session: m => m.sessionId },
  stop_terminal:   { session: m => m.sessionId },
  delete_session:  { session: m => m.sessionId },
  // 往开发机写文件：只能对自己的会话做，否则等于拿到了别人机器的落盘权
  upload_file:     { session: m => m.sessionId },
  rename_session:  { session: m => m.sessionId },
  // 会话是自己的，不代表能往别人的分组里塞
  move_session:    { session: m => m.sessionId, folders: m => [m.folderId] },
  create_folder:   { folders: m => [m.parentId] },
  rename_folder:   { folders: m => [m.folderId] },
  delete_folder:   { folders: m => [m.folderId] },
  // 移动的目标父级同样要是自己的，否则会把文件夹塞进别人的树里
  move_folder:     { folders: m => [m.folderId, m.parentId] },
  list_dir:             { open: true },
  read_file:            { open: true },
  scan_history:         { open: true },
  set_visibility_scope: { open: true },
};

// 浏览器的窗格操作 → 转给开发机时的消息类型。三者走同一条通道（同样的鉴权、同样的
// 「机器不在线」回执），差别只在开发机侧调哪个 tmux 子命令 —— 登记在这里，
// 回执里的 action 直接用浏览器发来的类型名，两端命名不会各写各的。
const PANE_ACTIONS = {
  select_pane:      'pty_select_pane',
  kill_pane:        'pty_kill_pane',
  scroll_to_bottom: 'pty_scroll_bottom',
};

// ── relay → 浏览器的出站投影表 ────────────────────────────────
// 「这条消息发给某个身份时该长什么样」。所有下行都走 _sendTo，投影在那里统一施加，
// 分支各写各的过滤迟早会漏 —— 历史上 open_terminal 的列表回推就是这么漏出去的。
const PROJECTIONS = {
  session_list:    (relay, b, msg) => ({ ...msg, sessions: relay._filterSessions(b, msg.sessions, msg.machineId) }),
  active_sessions: (relay, b, msg) => ({ ...msg, sessions: relay._filterSessions(b, msg.sessions, msg.machineId) }),
  folders:         (relay, b, msg) => ({ ...msg, folders:  relay._filterFolders(b, msg.folders, msg.machineId) }),
};

// 出站可见性谓词：这条消息该不该发给这个浏览器（与投影正交）
const VISIBILITY = {
  hook_event: (relay, b, msg) => relay._canSeeHookEvent(b, msg.machineId, msg),
  // 改名下发：判的是**新** sessionId —— 归属台账在广播之前已经迁移过去了，旧名此刻已不在账上。
  session_renamed: (relay, b, msg) => relay._canAccess(b, msg.machineId, msg.newSessionId),
  // 改名失败的回执只给看得见这个会话的人。以前是无差别广播，别人改名撞了名字，
  // 所有人的桌面版都会弹一次 alert，还顺带把会话名漏出去。
  rename_error: (relay, b, msg) => relay._canAccess(b, msg.machineId, msg.sessionId),
  // watching 是「订阅意向」，可见性才是权威：归属转交或管理员切了隐藏之后，
  // 残留的订阅不能继续把他人终端的内容送出去。
  pty_data: (relay, b, msg) =>
    b.watching.has(owners.key(msg.machineId, msg.sessionId)) &&
    relay._canAccess(b, msg.machineId, msg.sessionId),
};

// 终端尺寸下限。低于这个值的一定是「容器还没布局好」时 fit 出来的假尺寸
// （线上实测出现过 10x6），放进 tmux 会把整个窗口压成 10 列，所有观众一起错位，
// 而且前端「尺寸没变就不重发」的去重会让它永远不自愈。
const MIN_COLS = 20;
const MIN_ROWS = 5;

function sanitizeSize(cols, rows) {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  return { cols: Math.floor(cols), rows: Math.floor(rows) };
}

const MACHINE_TOKENS = new Set(
  (process.env.MACHINE_TOKENS || '').split(',').filter(Boolean)
);

/** 运行时追加 token（供 CLI 从 config 注入） */
function addMachineTokens(tokens) {
  for (const t of tokens) if (t) MACHINE_TOKENS.add(t);
}

/**
 * 校验开发机 token。WS 握手（machine 协议）和用量上报的 HTTP 接口共用这一份判定，
 * 避免两处各维护一套。两类 token 都认：台账里绑定到某台机器的（装机时用邀请码换的），
 * 和旧的全局名单（`MACHINE_TOKENS` 环境变量）。
 */
function hasMachineToken(token) {
  if (!token) return false;
  return MACHINE_TOKENS.has(token) || !!machineTokens.resolveToken(token);
}

/**
 * 开发机握手鉴权。两条路，优先台账：
 *
 *  ① **台账**（`machine-tokens.js`，装机时用一次性邀请码换的 token）：machineId 由台账决定。
 *     客户端在 `x-machine-id` 里报什么都不作数 —— 以前 machineId 就是客户端自报的，
 *     而 relay 对 machineId 碰撞的处理是「新连接顶掉旧连接」，等于任何一把 token
 *     配上一个写错的 machineId 就能把真机踢下线。
 *  ② **旧的全局名单**（环境变量）：token 不绑机器，machineId 只能听客户端报。
 *     保留它是为了现网那几台还没换装的开发机 —— 换完一台撤一台，不是一刀切。
 *
 * @returns {{machineId: string, bound: boolean, claimed?: string}|null} null = token 不认
 */
function authenticateMachine(token, requestedMachineId) {
  const claimed = String(requestedMachineId || '').trim();
  const boundId = machineTokens.resolveToken(token);
  if (boundId) {
    return { machineId: boundId, bound: true, claimed: claimed && claimed !== boundId ? claimed : undefined };
  }
  if (token && MACHINE_TOKENS.has(token)) {
    return { machineId: claimed || 'unknown', bound: false };
  }
  return null;
}

// ── 心跳常量 ──────────────────────────────────────────────────
const PING_INTERVAL = 30_000;   // 每 30s 发一次 ping
const PONG_TIMEOUT  = 10_000;   // ping 后 10s 内没收到 pong 就判定死连接

class RelayServer {
  constructor() {
    this.machines = new Map();   // machineId → { ws, sessions, defaultWorkDir, foldersMigrated }
    // browserId → { ws, user, ownOnly, watching, lastListHash }
    // user = { username, role }，来自 JWT，决定该浏览器能看到/操作哪些会话
    // ownOnly = 管理员的「隐藏他人会话」开关，逐连接生效（同一 admin 换个浏览器互不影响）
    // watching = Map<"machineId:sessionId", {cols,rows}|null>：这条连接正在看哪些会话、
    //   各自声明的终端尺寸（null = 还没报过尺寸，不参与尺寸协商）
    this.browsers = new Map();
    this._browserId = 0;
    this._pingTimers = new Map();    // ws → { pingInterval, pongTimeout }
    this._sessionSizes = new Map();  // "machineId:sessionId" → 已下发给开发机的权威尺寸
  }

  // ── 终端尺寸协商 ────────────────────────────────────────────
  // 一个会话在开发机上只有一个 tmux 窗口。多个观众各按自己的浏览器尺寸发 resize，
  // 谁后发谁生效，另一端的排版当场错位；而 tmux 多客户端本身就取最小尺寸。
  // 所以权威尺寸 = 所有观众的最小值，由 relay 统一算出、只在变化时下发。

  /** 会话当前的观众数（用于「最后一个人走了才关 PTY」）。 */
  _viewerCount(machineId, sessionId) {
    const k = owners.key(machineId, sessionId);
    let n = 0;
    for (const b of this.browsers.values()) if (b.watching.has(k)) n++;
    return n;
  }

  /** 所有观众尺寸的最小值；没人报过尺寸则返回 null。 */
  _negotiateSize(machineId, sessionId) {
    const k = owners.key(machineId, sessionId);
    let cols = Infinity, rows = Infinity;
    for (const b of this.browsers.values()) {
      const size = b.watching.get(k);
      if (!size) continue;
      cols = Math.min(cols, size.cols);
      rows = Math.min(rows, size.rows);
    }
    return Number.isFinite(cols) ? { cols, rows } : null;
  }

  /**
   * 重算并下发权威尺寸；结果没变就不发（tmux resize-window 会打断所有观众的排版）。
   *
   * force = 观众显式重新宣告尺寸（切回 tab）。这条去重的前提是「relay 记的值就是 tmux
   * 窗口的真实值」，而这个前提并不总成立 —— 同一个 tmux 窗口可能被别的 sessionId 改过。
   * 所以重新宣告必须能穿透去重，否则窗口一旦被拽偏就永远不自愈。
   */
  _syncSessionSize(machineId, sessionId, { force = false } = {}) {
    const k = owners.key(machineId, sessionId);
    const size = this._negotiateSize(machineId, sessionId);
    if (!size) { this._sessionSizes.delete(k); return; }
    const prev = this._sessionSizes.get(k);
    if (!force && prev && prev.cols === size.cols && prev.rows === size.rows) return;
    this._sessionSizes.set(k, size);
    this._toMachine(machineId, { type: 'pty_resize', sessionId, ...size });
  }

  /**
   * 某个浏览器不再看这个会话。最后一个观众离开时才关掉开发机上的 PTY ——
   * 没有引用计数的话，一端关 tab 会把另一端的流也掐断；而浏览器直接断线时
   * 从来没人通知开发机，attach 客户端就永远挂在 tmux 上，还继续用它那份
   * （可能是错的）尺寸参与 tmux 的窗口大小计算。
   */
  _releaseViewer(browser, watchKey) {
    browser.watching.delete(watchKey);
    const { machineId, id: sessionId } = owners.parseKey(watchKey);
    if (this._viewerCount(machineId, sessionId) === 0) {
      this._sessionSizes.delete(watchKey);
      this._toMachine(machineId, { type: 'pty_close', sessionId });
    } else {
      this._syncSessionSize(machineId, sessionId);   // 小尺寸的观众走了，窗口该长回去
    }
  }

  // ── 出站：唯一出口 ──────────────────────────────────────────
  /**
   * 发一条消息给某个浏览器。**relay 里所有发往浏览器的数据都必须走这里**，
   * 可见性判定与按身份的投影只在这一处施加。
   * @param raw 已序列化的原文；只在无投影时使用（pty_data 热路径省一次序列化）
   */
  _sendTo(browser, msg, raw = null) {
    if (!browser || browser.ws.readyState !== 1) return false;
    const gate = VISIBILITY[msg.type];
    if (gate && !gate(this, browser, msg)) return false;
    const project = PROJECTIONS[msg.type];
    if (!project) {
      browser.ws.send(raw ?? JSON.stringify(msg));
      return true;
    }
    const payload = JSON.stringify(project(this, browser, msg));
    // 会话列表按连接去重：重连时每个已打开的 tab 都会触发一次回推，内容完全相同
    if (msg.type === 'session_list') {
      if (payload === browser.lastListHash) return false;
      browser.lastListHash = payload;
    }
    browser.ws.send(payload);
    return true;
  }

  _broadcast(msg, raw = null) {
    for (const browser of this.browsers.values()) this._sendTo(browser, msg, raw);
  }

  /** 发给某台开发机；机器不在线则静默丢弃（浏览器侧会因为拿不到数据自然表现为不可用）。 */
  _toMachine(machineId, obj) {
    const m = this.machines.get(machineId);
    if (!m || m.ws.readyState !== 1) return false;
    m.ws.send(JSON.stringify(obj));
    return true;
  }

  _toMachines(obj) {
    const payload = JSON.stringify(obj);
    for (const m of this.machines.values()) {
      if (m.ws.readyState === 1) m.ws.send(payload);
    }
  }

  // ── 归属：可见性与鉴权 ──────────────────────────────────────
  // 单一真源是 session-owners 的 canAccess / canAccessFolder，语义见那里。
  _canAccess(browser, machineId, sessionId) {
    return owners.canAccess(browser?.user, machineId, sessionId, { ownOnly: !!browser?.ownOnly });
  }

  _canAccessFolder(browser, machineId, folderId) {
    return owners.canAccessFolder(browser?.user, machineId, folderId, { ownOnly: !!browser?.ownOnly });
  }

  // admin 能看到全部会话，额外附上 owner 字段，前端据此显示归属徽章并做转交。
  // 普通用户拿到的会话一定是自己的，不需要这个字段。
  _filterSessions(browser, sessions, machineId) {
    const withOwner = browser?.user?.role === 'admin';
    const out = [];
    for (const s of (sessions || [])) {
      const sid = sessionIdOf(s);
      if (!sid) continue;
      const mid = machineId || s.machineId;
      if (!this._canAccess(browser, mid, sid)) continue;
      out.push(withOwner ? { ...s, owner: owners.getOwner(mid, sid) } : s);
    }
    return out;
  }

  /** 文件夹按登记的归属过滤，各人的分组树互不相见。 */
  _filterFolders(browser, folders, machineId) {
    if (browser?.user?.role === 'admin' && !browser.ownOnly) return folders || [];
    return (folders || []).filter(f => this._canAccessFolder(browser, machineId, f.id));
  }

  // 越权时回一条 pty_error，便于前端提示与排障；不透露会话是否存在。
  _denyAccess(browser, action, machineId, sessionId) {
    this._sendTo(browser, {
      type: 'pty_error', action, machineId, sessionId, error: '无权访问该会话',
    });
  }

  // 文件夹越权：单独一种消息类型，前端弹提示（不会误伤终端 tab 的关闭逻辑）
  _denyFolder(browser, action, machineId, folderId) {
    this._sendTo(browser, {
      type: 'folder_error', action, machineId, folderId, error: '无权操作该文件夹',
    });
  }

  /**
   * 存量文件夹补登归属：每台开发机连上后只跑一次。
   * 08-02 之前建的文件夹没有归属记录，按无主处理会让普通用户的分组集体消失；
   * 这里用已确定的会话归属反推，只登记能唯一确定的那些（见 inferFolderOwners）。
   * 一次性迁移不能常驻 —— 否则它会变成「无主文件夹自动归属最近往里放会话的人」这条
   * 谁也没打算要的长期规则。
   */
  _claimLegacyFolders(machineId, folders) {
    const unowned = (folders || []).filter(f => f?.id && !owners.getFolderOwner(machineId, f.id));
    if (!unowned.length) return;
    // 推断要看整棵树（父子链），登记只动当前无主的那些
    const m = this.machines.get(machineId);
    const inferred = owners.inferFolderOwners(machineId, folders, m?.sessions || []);
    const claimed = unowned
      .filter(f => inferred.has(f.id))
      .map(f => ({ machineId, id: f.id, owner: inferred.get(f.id) }));
    if (!claimed.length) return;
    owners.setFolderOwners(claimed);   // 一次落盘，不是每个文件夹写一次全库
    console.log(`[relay] machine ${machineId}: 存量文件夹补登归属 ${claimed.length} 个`);
  }

  /** 会话是否已在该机器上运行（用于区分「新建会话」与「attach 已有会话」）。 */
  _machineHasSession(machineId, sessionId) {
    const sessions = this.machines.get(machineId)?.sessions || [];
    return sessions.some(s => sessionIdOf(s) === sessionId);
  }

  // ── 心跳管理 ────────────────────────────────────────────────
  // 对每个 ws 连接启动 ping 定时器，超时未 pong 则主动断开
  _startHeartbeat(ws, label) {
    this._stopHeartbeat(ws);
    const state = {
      pingInterval: setInterval(() => {
        if (ws.readyState !== 1) { this._stopHeartbeat(ws); return; }
        ws.ping();
        state.pongTimeout = setTimeout(() => {
          console.warn(`[relay] 💀 ${label} 心跳超时，断开连接`);
          ws.terminate();  // 强制断开，触发 close 事件走正常清理流程
        }, PONG_TIMEOUT);
      }, PING_INTERVAL),
      pongTimeout: null,
    };
    ws.on('pong', () => {
      if (state.pongTimeout) { clearTimeout(state.pongTimeout); state.pongTimeout = null; }
    });
    this._pingTimers.set(ws, state);
  }

  _stopHeartbeat(ws) {
    const state = this._pingTimers.get(ws);
    if (!state) return;
    clearInterval(state.pingInterval);
    if (state.pongTimeout) clearTimeout(state.pongTimeout);
    this._pingTimers.delete(ws);
  }

  registerMachine(machineId, ws, defaultWorkDir = '') {
    const prev = this.machines.get(machineId);
    if (prev) {
      console.warn(`[relay] ⚠️  machineId 碰撞: "${machineId}" 已存在，新连接将覆盖旧连接。请在各机器的 ~/.vibeanything/config.json 中设置不同的 machineId。`);
      // 主动关掉旧连接：其 close 回调里有「cur.ws === ws」守卫，不会误删本次注册的新条目。
      if (prev.ws !== ws && prev.ws.readyState === 1) {
        try { prev.ws.close(4000, 'superseded by new connection'); } catch {}
      }
    }
    console.log(`[relay] machine registered: ${machineId}`);
    this.machines.set(machineId, { ws, sessions: [], defaultWorkDir, foldersMigrated: false });
    this._broadcastMachineList();
  }

  unregisterMachine(machineId) {
    this.machines.delete(machineId);
    this._broadcastMachineList();
  }

  // 机器连接 close 处理。防陈旧关闭误删：同一 machineId 断线重连时，旧连接的
  // close 可能晚于新连接的 register（新条目已覆盖进 Map）。仅当 Map 里登记的
  // ws 仍是「我这条」时才注销，否则会把刚覆盖进来的新连接也一并删除，导致该
  // 机器从 machine_list 消失（日志仍在响、但浏览器永远看不到它）。
  _handleMachineClose(machineId, ws) {
    this._stopHeartbeat(ws);
    const cur = this.machines.get(machineId);
    if (cur && cur.ws === ws) {
      this.unregisterMachine(machineId);
      this._broadcastSessionList();
    }
  }

  /**
   * 踢掉某台机器的连接。撤销 token / 换 token 之后必须调一次：
   * 鉴权只发生在握手那一刻，已经建立的连接不会因为台账变了自己断开。
   */
  disconnectMachine(machineId, reason = 'machine token revoked') {
    const m = this.machines.get(machineId);
    if (!m) return false;
    try { m.ws.close(4003, reason); } catch {}
    return true;
  }

  getMachine(machineId) {
    return this.machines.get(machineId);
  }

  updateSessions(machineId, sessions) {
    const m = this.machines.get(machineId);
    if (m) m.sessions = sessions;
    this._broadcastSessionList();
  }

  getAllSessions() {
    const result = [];
    for (const [machineId, { sessions }] of this.machines) {
      for (const s of sessions) result.push({ ...s, machineId });
    }
    return result;
  }

  _machineListMessage() {
    return {
      type: 'machine_list',
      machines: Array.from(this.machines.entries()).map(([machineId, m]) => ({
        machineId, defaultWorkDir: m.defaultWorkDir || '',
      })),
    };
  }

  _broadcastMachineList() {
    this._broadcast(this._machineListMessage());
  }

  // 每个浏览器只收到自己有权看到的会话；投影与逐连接的 diff 去重都在 _sendTo 里
  _broadcastSessionList() {
    this._broadcast({ type: 'session_list', sessions: this.getAllSessions() });
  }

  /**
   * 归属或可见范围变更后强制重推会话列表：清掉 per-browser 的 diff 缓存并让各机器重扫，
   * 否则内容未变会跳过广播，前端要等下一轮轮询才看到结果。
   */
  refreshSessionLists() {
    for (const b of this.browsers.values()) b.lastListHash = '';
    this._broadcastSessionList();
    this._toMachines({ type: 'scan_active' });
  }

  _addBrowser(ws, user, ownOnly = false) {
    const browserId = ++this._browserId;
    const browser = { ws, user, ownOnly: !!ownOnly, watching: new Map(), lastListHash: '' };
    this.browsers.set(browserId, browser);
    console.log(`[relay] browser #${browserId} (${user.username}) connected, ${this.machines.size} machines`);
    // 身份下发：前端据此决定是否显示管理员才有的「隐藏他人会话」开关。
    // 走 WS 而不是再开一个 HTTP 接口 —— 身份的真源就是这条连接校验过的 JWT。
    this._sendTo(browser, { type: 'whoami', username: user.username, role: user.role });
    this._sendTo(browser, { type: 'session_list', sessions: this.getAllSessions() });
    this._sendTo(browser, this._machineListMessage());
    // 触发所有在线机器立即推送 active_sessions 和 history
    this._toMachines({ type: 'scan_active' });
    this._toMachines({ type: 'scan_history' });
    return browserId;
  }

  /** 断线清理：先释放它看着的会话（否则开发机上的 attach 客户端永远挂着），再摘掉连接。 */
  _removeBrowser(browserId) {
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    this.browsers.delete(browserId);
    for (const watchKey of [...browser.watching.keys()]) {
      browser.watching.delete(watchKey);
      const { machineId, id: sessionId } = owners.parseKey(watchKey);
      if (this._viewerCount(machineId, sessionId) === 0) {
        this._sessionSizes.delete(watchKey);
        this._toMachine(machineId, { type: 'pty_close', sessionId });
      } else {
        this._syncSessionSize(machineId, sessionId);
      }
    }
  }

  /**
   * 切换该浏览器的会话可见范围（管理员的「隐藏他人会话」按钮）。
   *
   * 隐藏 = 服务端停止投递，不是前端不画：watching 里属于他人的会话立刻摘掉，
   * PTY 流当场断供，并回一条 pty_error 让前端沿用既有的「无权即摘 tab」逻辑关掉窗口。
   */
  _setVisibilityScope(browserId, ownOnly) {
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    browser.ownOnly = !!ownOnly;

    for (const watchKey of [...browser.watching.keys()]) {
      const { machineId, id } = owners.parseKey(watchKey);
      if (this._canAccess(browser, machineId, id)) continue;
      this._releaseViewer(browser, watchKey);
      this._sendTo(browser, {
        type: 'pty_error', action: 'scope', machineId, sessionId: id,
        error: '已隐藏他人会话',
      });
    }
    this.refreshSessionLists();
  }

  /**
   * hook_event（红绿灯 + 提示音）的可见性：事件同时带 claude 侧 sessionId 与 tmuxSession，
   * 归属台账两种 key 都可能登记，任一命中即放行。两个都判不出归属的事件只发给全量视图的
   * admin —— 否则隐藏他人会话后，别人的会话跑完仍会在管理员这边响一声。
   */
  _canSeeHookEvent(browser, machineId, msg) {
    const ids = [msg.sessionId, msg.tmuxSession].filter(Boolean);
    if (!ids.length) return browser.user.role === 'admin' && !browser.ownOnly;
    return ids.some(id => this._canAccess(browser, machineId, id));
  }

  handleMachineMessage(machineId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // pty_data 是每帧终端输出都走的热路径，逐条打日志比转发本身还贵
    if (msg.type !== 'pty_data') {
      const detail = msg.type === 'session_list' ? `(${(msg.sessions||[]).length} sessions)` :
        msg.type === 'active_sessions' ? `(${(msg.sessions||[]).length} active)` :
        msg.type === 'session_history' ? `(${(msg.sessions||[]).length} history)` : '';
      console.log(`[relay] machine ${machineId} → ${msg.type} ${detail}`);
    }

    if (msg.type === 'register') {
      const m = this.machines.get(machineId);
      if (m && msg.defaultWorkDir) {
        m.defaultWorkDir = msg.defaultWorkDir;
        this._broadcastMachineList();
      }
      return;
    }
    if (msg.type === 'session_list') {
      this.updateSessions(machineId, msg.sessions || []);
      return;
    }
    if (msg.type === 'pty_data') {
      // 带 browserId = 定向回该浏览器（补屏快照），否则广播给所有观众。
      // 可见性判定统一在 _sendTo 的 VISIBILITY 里，两条路都要过。
      if (msg.browserId) {
        this._sendTo(this.browsers.get(msg.browserId), { ...msg, machineId }, raw);
      } else {
        this._broadcast({ ...msg, machineId }, raw);
      }
      return;
    }
    // 会话改名/删除后同步归属台账，否则改名会把会话变成无主（普通用户从列表里丢失）。
    // 新名由开发机给出（tmux 侧真实结果），relay 不自行推算。
    if (msg.type === 'session_renamed') {
      owners.renameSession(machineId, msg.oldSessionId, msg.newSessionId);
      // 也要下发给浏览器：sessionId 就是 tmux 名，改完之后开着的那个标签还指着旧名，
      // 下次重连时 open_terminal 会照旧名**新建**一个空会话（手机切后台就重连，尤其明显）。
      this._broadcast({ ...msg, machineId });
      return;
    }
    if (msg.type === 'session_deleted' && msg.sessionId) {
      owners.removeOwner(machineId, msg.sessionId);
    }
    if (msg.type === 'pty_error' && msg.browserId) {
      this._sendTo(this.browsers.get(msg.browserId), { ...msg, machineId });
      return;
    }
    // 上传回执：同一会话可能有多个观众，路径只回给按下 Cmd+V 的那个浏览器
    if (msg.type === 'file_uploaded') {
      this._sendTo(this.browsers.get(msg.browserId), { ...msg, machineId });
      return;
    }
    // active_sessions 是前端会话列表的真正数据源 —— 隔离的本体。
    // 开发机实际只发 active_sessions，从不发 session_list —— m.sessions 若只靠
    // updateSessions 填充会永远是空的，getAllSessions()（归属管理 API 的数据源）跟着为空。
    if (msg.type === 'active_sessions') {
      const m = this.machines.get(machineId);
      if (m) m.sessions = msg.sessions || [];
      this._broadcast({ ...msg, machineId });
      return;
    }
    if (msg.type === 'folders') {
      const m = this.machines.get(machineId);
      // 存量迁移只在这台机器连上后的首轮跑一次。开发机总是先发 active_sessions
      // 再发 folders（_sendActiveSessions 成对发送），所以这时归属证据已经齐了。
      if (m && !m.foldersMigrated) {
        this._claimLegacyFolders(machineId, msg.folders);
        m.foldersMigrated = true;
      }
      this._broadcast({ ...msg, machineId });
      return;
    }
    if (msg.type === 'hook_event' || msg.type === 'rename_error' || msg.type === 'session_history' ||
        msg.type === 'dir_entries' || msg.type === 'session_deleted' || msg.type === 'file_content' ||
        msg.type === 'pty_error') {
      this._broadcast({ ...msg, machineId });
    }
  }

  /**
   * 入站鉴权：按 BROWSER_POLICY 判定，未登记的消息类型一律拒绝。
   * 前端过滤只是障眼法 —— 不在这里拦，对方改个 sessionId 就能操作别人的会话。
   */
  _authorize(browser, msg) {
    const policy = BROWSER_POLICY[msg.type];
    if (!policy) return false;
    if (policy.open) return true;

    if (policy.session) {
      const sessionId = policy.session(msg);
      // 机器上还没有这个会话 = 新建，归创建者所有；已存在则必须已经是自己的
      if (policy.claimSession && !this._machineHasSession(msg.machineId, sessionId)) {
        owners.setOwner(msg.machineId, sessionId, browser.user.username);
      } else if (!this._canAccess(browser, msg.machineId, sessionId)) {
        this._denyAccess(browser, msg.type, msg.machineId, sessionId);
        return false;
      }
    }
    for (const folderId of (policy.folders ? policy.folders(msg) : [])) {
      if (this._canAccessFolder(browser, msg.machineId, folderId)) continue;
      this._denyFolder(browser, msg.type, msg.machineId, folderId);
      return false;
    }
    return true;
  }

  handleBrowserMessage(browserId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    if (!this._authorize(browser, msg)) return;

    const watchKey = () => owners.key(msg.machineId, msg.sessionId);

    if (msg.type === 'set_visibility_scope') {
      this._setVisibilityScope(browserId, msg.ownOnly);
    } else if (msg.type === 'open_terminal') {
      browser.watching.set(watchKey(), sanitizeSize(msg.cols, msg.rows));
      // 用协商后的尺寸开 PTY：已经有人在看时，不能拿自己的尺寸把对方的排版顶掉
      const size = this._negotiateSize(msg.machineId, msg.sessionId) || { cols: 220, rows: 50 };
      this._sessionSizes.set(watchKey(), size);
      this._toMachine(msg.machineId, {
        type: 'pty_open', sessionId: msg.sessionId,
        browserId,                       // 补屏快照要定向回这个浏览器，不能广播
        cols: size.cols, rows: size.rows,
        command: msg.command,
        cwd: msg.cwd,
      });
      this._sendTo(browser, { type: 'session_list', sessions: this.getAllSessions() });
    } else if (msg.type === 'terminal_input') {
      this._toMachine(msg.machineId, { type: 'pty_input', sessionId: msg.sessionId, data: msg.data });
    } else if (msg.type === 'terminal_resize') {
      const size = sanitizeSize(msg.cols, msg.rows);
      if (!size) return;          // 容器没布局好时算出来的假尺寸，丢掉
      browser.watching.set(watchKey(), size);
      this._syncSessionSize(msg.machineId, msg.sessionId, { force: !!msg.declare });
    } else if (msg.type === 'release_size') {
      // 面板切到后台：撤销它的尺寸声明，但**保留观众身份**。
      // 用 set(key, null) 而不是 delete —— delete 会让 _viewerCount 少一个，
      // 凑够 0 就误发 pty_close 把还开着的终端流掐断。
      if (!browser.watching.has(watchKey())) return;
      browser.watching.set(watchKey(), null);
      this._syncSessionSize(msg.machineId, msg.sessionId);
    } else if (msg.type === 'split_terminal') {
      const sent = this._toMachine(msg.machineId, {
        type: 'pty_split', browserId,
        sessionId: msg.sessionId, direction: msg.direction,
        cwd: msg.cwd, command: msg.command,
      });
      if (!sent) {
        this._sendTo(browser, {
          type: 'pty_error', action: 'split',
          machineId: msg.machineId, sessionId: msg.sessionId,
          error: 'Machine unavailable',
        });
      }
    } else if (PANE_ACTIONS[msg.type]) {
      // 窗格操作（焦点移动 / 删除分屏 / 回到最新输出）。与 split_terminal 同一条通道，
      // 差别只在开发机侧调的 tmux 子命令，所以这里只做类型翻译。
      const sent = this._toMachine(msg.machineId, {
        type: PANE_ACTIONS[msg.type], browserId,
        sessionId: msg.sessionId, direction: msg.direction,
      });
      if (!sent) {
        this._sendTo(browser, {
          type: 'pty_error', action: msg.type,
          machineId: msg.machineId, sessionId: msg.sessionId,
          error: 'Machine unavailable',
        });
      }
    } else if (msg.type === 'scan_history') {
      this._toMachines({ type: 'scan_history' });
    } else if (msg.type === 'list_dir') {
      this._toMachine(msg.machineId, msg);
    } else if (msg.type === 'pty_attach') {
      if (!browser.watching.has(watchKey())) browser.watching.set(watchKey(), null);
    } else if (msg.type === 'close_terminal') {
      // 关闭浏览器 tab：最后一个观众走了才断 PTY，tmux 始终保留（claude 继续跑）
      this._releaseViewer(browser, watchKey());
    } else if (msg.type === 'stop_terminal') {
      // 停止进程：kill tmux session（真正终止 claude），不走引用计数
      browser.watching.delete(watchKey());
      this._sessionSizes.delete(watchKey());
      this._toMachine(msg.machineId, { type: 'pty_kill', sessionId: msg.sessionId });
    } else if (msg.type === 'delete_session') {
      this._toMachine(msg.machineId, { type: 'delete_session', sessionId: msg.sessionId });
    } else if (msg.type === 'read_file') {
      this._toMachine(msg.machineId, { type: 'read_file', path: msg.path });
    } else if (msg.type === 'upload_file') {
      // 粘贴/拖入的文件：relay 只做转发，不落盘 —— 文件必须躺在跑 claude 的那台机器上
      const sent = this._toMachine(msg.machineId, {
        type: 'upload_file', browserId,
        sessionId: msg.sessionId, uploadId: msg.uploadId,
        name: msg.name, data: msg.data,
      });
      if (!sent) {
        this._sendTo(browser, {
          type: 'file_uploaded', uploadId: msg.uploadId,
          machineId: msg.machineId, sessionId: msg.sessionId,
          name: msg.name, error: 'Machine unavailable',
        });
      }
    } else if (msg.type === 'create_folder') {
      // folderId 由 relay 生成 —— 归属要在创建的同一刻落台账，
      // 不能等开发机把新文件夹推回来再猜是谁建的（两个人同时建就分不清）。
      const folderId = randomUUID();
      owners.setFolderOwner(msg.machineId, folderId, browser.user.username);
      this._toMachine(msg.machineId, { ...msg, folderId });
    } else if (msg.type === 'rename_session' || msg.type === 'move_session' ||
               msg.type === 'rename_folder' || msg.type === 'delete_folder' || msg.type === 'move_folder') {
      // 会话重命名 / 文件夹分组：透传给目标开发机，由 ws-client 操作 tmux 与本地元数据
      this._toMachine(msg.machineId, msg);
      // 删掉的文件夹不留归属记录，否则台账无限增长
      if (msg.type === 'delete_folder') owners.removeFolderOwner(msg.machineId, msg.folderId);
    }
  }

  attachToHttpServer(server) {
    // 不限制 path，让代理转发的各种路径都能连接（如 /proxy/3000/ws）
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
    server.on('upgrade', (req, socket, head) => {
      // 只要路径以 /ws 结尾就接受
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname.endsWith('/ws') || pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const machineToken = req.headers['x-machine-token'];

      // 开发机连接
      const machineAuth = machineToken ? authenticateMachine(machineToken, req.headers['x-machine-id']) : null;
      if (machineAuth) {
        const { machineId } = machineAuth;
        if (machineAuth.bound) {
          machineTokens.touch(machineId);
          // 台账 token 报了别的名字：按台账为准，但要留一行日志 —— 这多半是
          // 某台机器的 config.json 被抄去了另一台（machineId 没改）。
          if (machineAuth.claimed) {
            console.warn(`[relay] machine ${machineId} 的 token 报了 machineId "${machineAuth.claimed}"，按台账为准`);
          }
        } else {
          console.warn(`[relay] machine ${machineId} 用的是未绑定机器的旧 token，建议用邀请码重装（vibeanything join）`);
        }
        this.registerMachine(machineId, ws);
        this._startHeartbeat(ws, `machine(${machineId})`);
        ws.on('message', (data) => this.handleMachineMessage(machineId, data.toString()));
        ws.on('close', () => this._handleMachineClose(machineId, ws));
        return;
      }

      // 浏览器连接（JWT）：payload 里的身份决定这条连接能看到/操作哪些会话
      const payload = verifyToken(token);
      if (!payload) { ws.close(4001, 'Unauthorized'); return; }
      // 「隐藏他人会话」随 URL 一起带上：连上后再发消息切换的话，第一份全量列表
      // 已经推出去了，管理员每次刷新都会闪一下别人的会话。
      const browserId = this._addBrowser(ws, {
        username: payload.username,
        role: payload.role || 'user',   // 存量 JWT（24h 有效期）里没有 role
      }, url.searchParams.get('ownOnly') === '1');
      this._startHeartbeat(ws, `browser(#${browserId})`);
      ws.on('message', (data) => this.handleBrowserMessage(browserId, data.toString()));
      ws.on('close', () => {
        this._stopHeartbeat(ws);
        this._removeBrowser(browserId);
      });
    });
  }
}

module.exports = {
  RelayServer, addMachineTokens, hasMachineToken, authenticateMachine,
  sessionIdOf, BROWSER_POLICY, PANE_ACTIONS,
};
