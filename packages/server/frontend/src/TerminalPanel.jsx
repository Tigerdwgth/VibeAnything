import { memo, useEffect, useRef, useState } from 'react';
import { parseWsMessage } from './ws-message';

// 尺寸停止变化多久之后才 fit + 通知 tmux（侧边栏宽度动画是 200ms，这里等它走完）
const RESIZE_SETTLE_MS = 90;
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getLaunchCommand } from './launch-config';
import { takeWheelSteps, buildWheelSequence, fingerDeltaToAccum } from './terminal-touch-scroll';
import { buildClickSequence, clientXYToCell } from './terminal-mouse-click';
import { attachTerminalPointer } from './terminal-pointer';
import { clipboardKeyAction, isMacPlatform } from './terminal-clipboard-keys';
import { isTouchOnlyDevice } from './input-device';
import { attachImeCursorSync } from './terminal-ime';
import {
  encodeInput, decodePtyData, measureTerminalSize, createPtyWriteBatcher, installWebFontRefit,
} from './terminal-io';
import { copyTextToClipboard as copyToClipboard } from './clipboard';
import { selectionAsCommand } from './terminal-command-copy';
import { SLASH_COMMANDS, sendSlashCommand } from './slash-commands';
import TerminalComposer from './TerminalComposer';
import {
  attachUploadHandlers, fileToBase64, inferFileName, quotePath, DEFAULT_MAX_UPLOAD_MB,
} from './terminal-upload';

// memo：Dashboard 每次收到会话列表都会整体重渲染，终端面板的 props（会话标识、ws、可见性）
// 那时并没有变，没必要把每个面板连同几十个按钮再渲染一遍
export default memo(TerminalPanel);

function TerminalPanel({ machineId, sessionId, ws, command, cwd, visible = true, style }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(ws);
  useEffect(() => { wsRef.current = ws; }, [ws]);
  // 本连接是否已经为该会话开过 PTY。ws 重连后 relay 侧的观众身份随连接销毁，需要重开。
  const openedRef = useRef(false);

  // 复制成功提示 state
  const [copyNotification, setCopyNotification] = useState(false);
  // 粘贴/拖入文件的状态：一条提示 + 拖拽悬停高亮
  const [uploadNotice, setUploadNotice] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  // uploadId → 文件名。回执只带 id，要靠它把「哪个文件传完了」说清楚。
  const pendingUploadsRef = useRef(new Map());
  const noticeTimerRef = useRef(null);
  // composer（输入框 + IME/回车/工具键透传）已抽成共用组件，与手机版同一份实现。
  // 顶栏「⏎」按钮要触发整行发送，所以留一个 ref 调它的 sendLine。
  const composerRef = useRef(null);
  const sendLine = () => composerRef.current?.sendLine();

  // 量一次当前容器能容纳的尺寸（判据与下限见 terminal-io.js）
  function measureSize() {
    return measureTerminalSize(containerRef.current, termRef.current, fitRef.current);
  }

  // declare = 「本观众重新宣告尺寸」，relay 收到会绕过「尺寸没变就不下发」的去重强制下发。
  // 同一个 tmux 窗口可能被别的 sessionId 改过尺寸，relay 记的权威值未必是窗口的真实值 ——
  // 切回这个 tab 必须能无条件把窗口拉正，这是用户唯一的手动兜底动作。
  function sendResize(size, { declare = false } = {}) {
    const currentWs = wsRef.current;
    if (currentWs?.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify({
      type: 'terminal_resize', machineId, sessionId, ...size,
      ...(declare ? { declare: true } : {}),
    }));
  }

  // 开 PTY。**只接受真量出来的尺寸**：猜出来的默认值一旦进了 tmux resize-window，
  // 窗口就被钉成 window-size manual，从此不再跟随任何客户端；而隐藏的面板永远量不到
  // 尺寸去纠正它 —— 08-06 实测 16/19 个窗口卡死在兜底的 120x40，且缩小生效、放大回不来。
  function sendOpenTerminal(size) {
    const currentWs = wsRef.current;
    if (currentWs?.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify({
      type: 'open_terminal',
      machineId,
      sessionId,
      cols: size.cols,
      rows: size.rows,
      command: getLaunchCommand(command),
      cwd: cwd || undefined,
    }));
    openedRef.current = true;
  }

  // 切到后台：撤销本连接对该会话的尺寸声明（不等于关闭，观众身份保留）。
  // 权威尺寸 = 所有观众的最小值，隐藏面板留着的旧尺寸会变成一个降不下来的天花板：
  // 另开一个 dashboard 页签之后，当前页签怎么放大都顶不过它。
  function releaseSize() {
    const currentWs = wsRef.current;
    if (currentWs?.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify({ type: 'release_size', machineId, sessionId }));
  }

  // 关 tab：退掉本连接的观众身份。最后一个观众走了 relay 才断 PTY，tmux 照常跑。
  // 没开过（后台挂载从没显示过）就没有观众身份可退。
  function closeViewer() {
    const currentWs = wsRef.current;
    if (!openedRef.current || currentWs?.readyState !== WebSocket.OPEN) return;
    openedRef.current = false;
    currentWs.send(JSON.stringify({ type: 'close_terminal', machineId, sessionId }));
  }

  function sendText(text) {
    const currentWs = wsRef.current;
    if (currentWs?.readyState === WebSocket.OPEN) {
      currentWs.send(JSON.stringify({
        type: 'terminal_input',
        machineId,
        sessionId,
        data: encodeInput(text),
      }));
    }
  }

  // 回到最新输出。两个缓冲区各有各的路，都走一遍：
  //
  //  · 终端里跑的是 tmux attach，往上滚历史时 tmux 进的是 copy-mode，视图从此不跟随新输出。
  //    那份内容在 alternate screen，**xterm 自己的 scrollback 是空的**，term.scrollToBottom()
  //    对它完全无效 —— 只能让开发机侧 `tmux copy-mode -q` 退出模式（见 pty-manager.js）。
  //  · 少数不经 tmux 的内容（attach 之前的启动输出）留在 xterm 自己的 scrollback 里，
  //    那一份反过来只有 term.scrollToBottom() 管得着。
  //
  // 两条路各管各的缓冲区，互不影响，所以不需要先判断「现在是哪一种」——
  // 判断本身也做不准（浏览器拿不到 tmux 的 pane_in_mode）。
  function scrollToBottom() {
    termRef.current?.scrollToBottom();
    const currentWs = wsRef.current;
    if (currentWs?.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify({ type: 'scroll_to_bottom', machineId, sessionId }));
  }

  // 统一复制入口（HTTP 非 secure context 下的回退实现见 clipboard.js）。
  // 桌面端复制完要把焦点还给终端 —— 回退路径里的 textarea.select() 抢走了它。
  const copyTextToClipboard = (text) => copyToClipboard(text, {
    onSuccess: () => {
      setCopyNotification(true);
      setTimeout(() => setCopyNotification(false), 1500);
    },
    onRestoreFocus: () => termRef.current?.focus(),
  });

  // 一条自动消失的提示。错误留久一点，够看清为什么没传上去。
  const notifyUpload = (text, isError = false) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setUploadNotice({ text, error: isError });
    noticeTimerRef.current = setTimeout(() => setUploadNotice(null), isError ? 4000 : 2000);
  };

  // 「复制命令」按钮：选区 → 拼成一行的命令 → 剪贴板。没选中给出提示，别静默。
  const copyAsCommand = () => {
    const term = termRef.current;
    const command = term ? selectionAsCommand(term) : '';
    if (!command) { notifyUpload('先用鼠标选中命令，再点「复制命令」', true); return; }
    copyTextToClipboard(command);
    term.clearSelection();
  };

  // 粘贴/拖入的文件 → 开发机落盘 → 回执里的路径由 onMessage 敲进终端。
  // 为什么不直接把字节塞进 PTY：claude 跑在开发机上，只能读它自己的本地路径
  // （完整来龙去脉见 terminal-upload.js 顶部）。
  const uploadFiles = async (files) => {
    const currentWs = wsRef.current;
    if (currentWs?.readyState !== WebSocket.OPEN) {
      notifyUpload('未连接到服务器，无法上传', true);
      return;
    }
    for (const file of files) {
      const name = inferFileName(file);
      if (file.size > DEFAULT_MAX_UPLOAD_MB * 1024 * 1024) {
        notifyUpload(`${name} 超过 ${DEFAULT_MAX_UPLOAD_MB}MB，未上传`, true);
        continue;
      }
      notifyUpload(`上传中 ${name}…`);
      try {
        const data = await fileToBase64(file);
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        pendingUploadsRef.current.set(uploadId, name);
        currentWs.send(JSON.stringify({
          type: 'upload_file', machineId, sessionId, uploadId, name, data,
        }));
      } catch {
        notifyUpload(`读取 ${name} 失败`, true);
      }
    }
  };

  // 只在首次挂载时创建 xterm
  useEffect(() => {
    if (termRef.current) return;
    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78'
      },
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"JetBrains Mono", monospace',
      // tmux 的内容在 alternate screen，xterm 自己的 scrollback 只存 attach 前的少量输出；
      // 行数越大每个终端预留的缓冲越多，同类产品（VS Code/Tabby）默认都是 1000
      scrollback: 2000,
      macOptionClickForcesSelection: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    // 手机端：禁止 xterm textarea 自动弹出键盘
    // xterm 内部有一个隐藏 textarea 用于接收键盘输入，在手机上 focus 时会弹出输入法
    // 默认设为 inputMode="none"，用户可通过键盘按钮主动打开。
    // 只认手机/平板：触屏笔记本被压成 readonly 会丢掉所有输入法输入（见 input-device.js）
    const isMobileDevice = isTouchOnlyDevice();
    const xtermTextarea = containerRef.current?.querySelector('textarea');
    if (isMobileDevice && xtermTextarea) {
      xtermTextarea.inputMode = 'none';
      xtermTextarea.setAttribute('readonly', '');
    }

    // 复制 / 粘贴快捷键（判定与来龙去脉见 terminal-clipboard-keys.js）：
    //  · Ctrl+C / Ctrl+Shift+C 有选中文本时 = 复制（不发 SIGINT），与 iTerm2 / VS Code 一致；
    //    preventDefault 挡住 Chrome 的 Ctrl+Shift+C（开发者工具的选取元素）。
    //  · Windows / Linux 的 Ctrl+V 交给浏览器原生粘贴，文字和截图 / 文件都走 paste 事件。
    const isMac = isMacPlatform(navigator.platform);
    term.attachCustomKeyEventHandler((e) => {
      const action = clipboardKeyAction(e, { isMac, hasSelection: term.hasSelection() });
      if (action === 'copy') {
        e.preventDefault();
        copyTextToClipboard(term.getSelection());
        term.clearSelection();
        return false; // 阻止 xterm 发送 \x03
      }
      if (action === 'paste') return false; // 不发 \x16，也不 preventDefault，浏览器照常粘贴
      return true;
    });

    // 键盘输入 → ws
    term.onData((data) => {
      const currentWs = wsRef.current;
      if (currentWs?.readyState === WebSocket.OPEN) {
        currentWs.send(JSON.stringify({
          type: 'terminal_input',
          machineId,
          sessionId,
          data: encodeInput(data)
        }));
      }
    });

    // 手机端点击定位光标：点击终端某个位置 → 计算目标列 → 发送箭头键移动光标
    let _tapStartTime = 0;
    let _tapStartX = 0;
    let _tapStartY = 0;
    const onTapStart = (e) => {
      _tapStartTime = Date.now();
      _tapStartX = e.touches[0].clientX;
      _tapStartY = e.touches[0].clientY;
    };
    const onTapEnd = (e) => {
      // 只处理短按（< 300ms）且位移小（< 10px）的 tap，排除滑动和长按
      const dt = Date.now() - _tapStartTime;
      if (dt > 300) return;
      const ct = e.changedTouches[0];
      const dx = Math.abs(ct.clientX - _tapStartX);
      const dy = Math.abs(ct.clientY - _tapStartY);
      if (dx > 10 || dy > 10) return;
      // 如果有选中文本则不处理（用户在选中操作）
      if (term.hasSelection()) return;

      // tmux 鼠标上报开启时（典型多 pane 分屏），tap 转成 SGR 左键让 tmux 切换 pane，
      // 并定位光标 —— 否则手机端点另一个 pane 永远切不过去（08-23 复现）。
      if (mouseActive()) {
        const rect = containerRef.current.getBoundingClientRect();
        const dim = term._core?._renderService?.dimensions?.css?.cell;
        const { col, row } = clientXYToCell(
          ct.clientX, ct.clientY, rect,
          dim?.width || 0, dim?.height || 0,
          term.cols, term.rows
        );
        const currentWs = wsRef.current;
        if (currentWs?.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({
            type: 'terminal_input', machineId, sessionId,
            data: encodeInput(buildClickSequence(col, row))
          }));
        }
        // 手机端不 focus —— 避免弹出输入法
        return;
      }

      const cellWidth = term._core?._renderService?.dimensions?.css?.cell?.width;
      const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellWidth || !cellHeight) return;

      const rect = containerRef.current.getBoundingClientRect();
      const x = ct.clientX - rect.left - 4; // 4px padding
      const y = ct.clientY - rect.top - 4;
      const targetCol = Math.max(0, Math.floor(x / cellWidth));
      const targetRow = Math.floor(y / cellHeight);

      // 当前光标位置（相对于 viewport）
      const buf = term.buffer.active;
      const cursorCol = buf.cursorX;
      const cursorViewRow = buf.cursorY;
      // 只处理同一行或相邻行的点击
      if (targetRow !== cursorViewRow) return;

      const diff = targetCol - cursorCol;
      if (diff === 0) return;
      const arrow = diff > 0 ? '\x1b[C' : '\x1b[D';
      const count = Math.min(Math.abs(diff), 200);
      const currentWs = wsRef.current;
      if (currentWs?.readyState === WebSocket.OPEN) {
        currentWs.send(JSON.stringify({
          type: 'terminal_input',
          machineId, sessionId,
          data: encodeInput(arrow.repeat(count))
        }));
      }
    };

    // resize：display:none / 尚未布局的容器 fit 出来的尺寸一律不发（见 measureSize）
    // 尺寸连续变化（侧边栏折叠的宽度动画、拖侧边栏边缘、拖窗口）时不逐帧 fit：
    // 每次 fit 都会重排 xterm，每次发出去的 resize 都让 tmux 整屏重绘再推回一大段输出。
    // 停下 RESIZE_SETTLE_MS 后只做一次（VS Code / Wave / Tabby 都是这么做的）。
    let _resizeTimer = 0;
    let _lastCols = 0;
    let _lastRows = 0;
    const ro = new ResizeObserver(() => {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(() => {
        _resizeTimer = 0;
        // 还没开过 PTY 就没有「本观众的尺寸」可言，不能拿它去参与协商压别人
        if (!openedRef.current) return;
        const size = measureSize();
        if (!size) return;
        // 只在 cols/rows 实际变化时发送
        if (size.cols === _lastCols && size.rows === _lastRows) return;
        _lastCols = size.cols;
        _lastRows = size.rows;
        sendResize(size);
      }, RESIZE_SETTLE_MS);
    });
    if (containerRef.current) ro.observe(containerRef.current);

    // 网页字体晚到的自愈（完整来龙去脉见 terminal-io.js 的 installWebFontRefit）：
    // 字体一到，格子高度就从回退字体的 16px 变成 18px，而 xterm 还按 16px 排版 ——
    // 面板里塞进 50 行却只放得下 44 行，这正是「新登录进来比例不对、缩放一下才好」。
    const disposeFontRefit = installWebFontRefit(term, () => {
      const grid = `${term.cols}x${term.rows}`;
      const size = measureSize();                        // 按新格子重新 fit 一次
      if (!size || !openedRef.current) return;           // 后台面板量不到，等它显示出来再说
      if (`${size.cols}x${size.rows}` === grid) return;  // 格子没变就不去打扰 PTY
      _lastCols = size.cols;
      _lastRows = size.rows;
      sendResize(size, { declare: true });
    });

    // 手机触摸滚动。终端里跑的是 tmux attach，内容在 alternate screen 缓冲区里，
    // xterm 自身没有 scrollback，term.scrollLines() 永远无效 —— 这正是「手机上滑不动」的根因。
    // 桌面滚轮能滚是因为 xterm 把滚轮编码成 SGR 鼠标事件交给 tmux，tmux(mouse on) 自己滚动历史。
    // 这里把手指滑动翻译成同样的 SGR 滚轮事件，走同一条路（08-17 实测 scroll_position 正常递增）。
    let _touchY = 0;
    let _scrollAccum = 0;
    const mouseActive = () => term._core?.coreMouseService?.activeProtocol !== 'NONE';
    const onTouchStart = (e) => { _touchY = e.touches[0].clientY; _scrollAccum = 0; };
    const onTouchMove = (e) => {
      // 自然滚动（内容跟手）：手指下滑 = 看更早内容（滚轮上）；方向换算在
      // fingerDeltaToAccum 里并配了单测（08-24 之前方向反了：上滑=看历史）。
      const dy = fingerDeltaToAccum(_touchY, e.touches[0].clientY);
      _touchY = e.touches[0].clientY;
      if (Math.abs(dy) < 2) return;
      // 阻止页面滚动 / 下拉刷新，只让终端吃掉这次滑动
      e.preventDefault();
      if (mouseActive()) {
        // tmux 已开鼠标上报：合成 SGR 滚轮事件。一个滚轮事件在 tmux copy-mode 里滚 5 行，
        // 所以换算按「5 行 × 行高」的手指位移一步，手指和内容才是 1:1
        // （见 terminal-touch-scroll.js）。
        const rect = containerRef.current.getBoundingClientRect();
        const dim = term._core?._renderService?.dimensions?.css?.cell;
        const cellW = dim?.width || 8;
        const cellH = dim?.height || 18;
        _scrollAccum += dy;
        const taken = takeWheelSteps(_scrollAccum, cellH);
        _scrollAccum = taken.accum;
        if (taken.steps === 0) return;
        const col = Math.max(1, Math.min(term.cols, Math.floor((e.touches[0].clientX - rect.left - 4) / cellW) + 1));
        const row = Math.max(1, Math.min(term.rows, Math.floor((e.touches[0].clientY - rect.top - 4) / cellH) + 1));
        const seq = buildWheelSequence(taken.steps, col, row);
        const currentWs = wsRef.current;
        if (currentWs?.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({
            type: 'terminal_input', machineId, sessionId,
            data: encodeInput(seq)
          }));
        }
      } else {
        // 无鼠标上报（如 tmux mouse off）：退回 xterm 本地滚动，聊胜于无。
        // xterm scrollLines(正) = 滚到较新内容，所以这里取负号，让方向和 tmux 分支一致
        // （手指下滑看更早）。
        _scrollAccum += dy;
        const lineHeight = Math.max(14, term._core?._renderService?.dimensions?.css?.cell?.height || 18);
        const lines = Math.trunc(_scrollAccum / lineHeight);
        if (lines !== 0) {
          term.scrollLines(-lines);
          _scrollAccum -= lines * lineHeight;
        }
      }
    };
    const onTouchEnd = () => { _scrollAccum = 0; };
    // 桌面端点击定位光标（鼠标 click）
    const onMouseClick = (ev) => {
      // 触摸设备已由 onTapEnd 处理，跳过
      if ('ontouchstart' in window) return;
      // tmux 鼠标上报开启时，点击已由 onMousedownCapture 转成 SGR 事件发给 tmux
      //（切换 pane 并定位光标），这里不再用箭头键做光标定位，避免同一击发两路
      if (mouseActive()) return;
      if (term.hasSelection()) return;
      const cellWidth = term._core?._renderService?.dimensions?.css?.cell?.width;
      if (!cellWidth) return;
      const el2 = containerRef.current;
      if (!el2) return;
      const cellHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellHeight) return;
      const rc = el2.getBoundingClientRect();
      const targetCol = Math.max(0, Math.floor((ev.clientX - rc.left - 4) / cellWidth));
      const targetRow = Math.floor((ev.clientY - rc.top - 4) / cellHeight);
      // 只处理光标所在行的点击，跨行点击不处理（避免发送错误数量的箭头键）
      if (targetRow !== term.buffer.active.cursorY) return;
      const cursorCol = term.buffer.active.cursorX;
      const diff = targetCol - cursorCol;
      if (diff === 0) return;
      const arrow = diff > 0 ? '\x1b[C' : '\x1b[D';
      const count = Math.min(Math.abs(diff), 200);
      const cws = wsRef.current;
      if (cws?.readyState === WebSocket.OPEN) {
        cws.send(JSON.stringify({
          type: 'terminal_input', machineId, sessionId,
          data: encodeInput(arrow.repeat(count))
        }));
      }
    };

    // ── 鼠标（点击切 pane / 拖选复制）与可点链接 ──
    // 全部接线在 terminal-pointer.js，那里有完整的来龙去脉与三条铁律，
    // 并配了真 DOM 回归测试（tests/terminal-pointer.test.js）。
    // 一句话：裸左键 = 切 pane，Option(mac)/Shift + 左键 = 选中（与 iTerm2 一致），
    // 悬停链接时放行给 xterm 才点得动链接。
    const pointerHandle = attachTerminalPointer(term, containerRef.current, {
      sendInput: (text) => sendText(text),
      onCopy: (text) => copyTextToClipboard(text),
    });

    // ── 输入法（IME）定位 ──
    // xterm 只在光标移动时才把隐藏 textarea 挪到光标处，全屏 TUI（codex 等）画面静态、
    // 光标不动，textarea 就一直停在 CSS 初值 left:-9999em，中文候选框被画到屏幕外，
    // 表现为「打拼音不跳输入法、切不了中英文」。这里在 focus / keydown 时补同步。
    const imeHandle = attachImeCursorSync(term, containerRef.current);

    // ── 粘贴图片 / 拖入文件 ──
    // 剪贴板里有文件才接管（纯文本仍走 xterm 原生粘贴）；文件传到开发机落盘后，
    // 把绝对路径当文本敲进终端，claude 就能读到了。
    const uploadHandle = attachUploadHandlers(containerRef.current, {
      onFiles: (files) => { uploadFiles(files); },
      onDragState: setDragActive,
    });

    const el = containerRef.current;
    if (el) {
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchmove', onTouchMove, { passive: false });
      el.addEventListener('touchend', onTouchEnd, { passive: true });
      el.addEventListener('touchstart', onTapStart, { passive: true });
      el.addEventListener('touchend', onTapEnd, { passive: true });
      el.addEventListener('click', onMouseClick);
    }

    return () => {
      clearTimeout(_resizeTimer);
      ro.disconnect();
      disposeFontRefit();
      pointerHandle.dispose();
      imeHandle.dispose();
      uploadHandle.dispose();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      if (el) {
        el.removeEventListener('touchstart', onTouchStart);
        el.removeEventListener('touchmove', onTouchMove);
        el.removeEventListener('touchend', onTouchEnd);
        el.removeEventListener('touchstart', onTapStart);
        el.removeEventListener('touchend', onTapEnd);
        el.removeEventListener('click', onMouseClick);
      }
      // 面板卸载 = 关掉这个 tab：退掉观众身份（否则 relay 一直推这个会话的输出直到重连），
      // 再释放 xterm（不 dispose 的 Terminal 连同缓冲区和 DOM 都回收不掉）。
      closeViewer();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 监听 ws pty_data（依赖 ws，确保 ws 从 null 变为真实对象时重新注册）
  // 关键：先注册 listener，再发 open_terminal，保证 pty_data 不丢失
  useEffect(() => {
    if (!ws) return;
    // 同一帧内到达的多条 pty_data 合成一次 write（见 terminal-io.js）
    const writer = createPtyWriteBatcher(() => termRef.current);
    function onMessage(e) {
      try {
        const msg = parseWsMessage(e);
        if (!msg) return;
        if (msg.type === 'pty_data' && msg.sessionId === sessionId && msg.data) {
          writer.push(decodePtyData(msg.data));
        }
        // 上传回执：路径敲进终端（尾随空格，方便接着打字）。
        // 只认自己发起的 uploadId —— 同一会话的其它浏览器也会收到各自的回执。
        if (msg.type === 'file_uploaded' && pendingUploadsRef.current.has(msg.uploadId)) {
          const name = pendingUploadsRef.current.get(msg.uploadId);
          pendingUploadsRef.current.delete(msg.uploadId);
          if (msg.error) notifyUpload(`${name}：${msg.error}`, true);
          else if (msg.path) {
            sendText(`${quotePath(msg.path)} `);
            notifyUpload(`已插入 ${name}`);
          }
        }
      } catch { /* 非本会话或非 JSON 的消息，忽略 */ }
    }
    ws.addEventListener('message', onMessage);

    // listener 注册完成后再请求 PTY（避免 pty_data 在 listener 注册前到达丢失）。
    // 新连接上的 relay 不认识旧连接的观众身份，重连必须重新 open。
    openedRef.current = false;
    // 后台 tab（display:none）量不到尺寸，就**不开** —— 不再拿默认值凑一个假尺寸出去。
    // openTerminals 存在 localStorage，一次页面加载会挂载全部已打开会话的面板，
    // 从前它们每个都会带着猜出来的 120x40 去开 PTY，把对应的 tmux 窗口永久钉死。
    // 这一刻开不了没关系：visible 效应会在它真正显示出来时带真实尺寸开。
    function tryOpen() {
      const size = measureSize();
      if (size) sendOpenTerminal(size);
    }
    if (ws.readyState === WebSocket.OPEN) {
      tryOpen();
    } else {
      ws.addEventListener('open', tryOpen, { once: true });
    }

    return () => {
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('open', tryOpen);
      writer.dispose();   // 取消排队的 RAF，并把残留数据写完
    };
  }, [sessionId, ws]);

  // visible 变化时 fit + 发 resize + focus
  // 切换 tab 或重开浏览器后，PTY 的 cols 可能与 xterm 不匹配，必须重新发送 resize
  useEffect(() => {
    if (!visible || !fitRef.current) return;
    let attempts = 0;
    let timer = 0;
    // 100ms 让 DOM 稳定（手机渲染较慢）；这一刻还量不到就再等两轮，
    // 绝不退而求其次发一个假尺寸出去。
    const settle = () => {
      const size = measureSize();
      if (size) {
        // 第一次真正显示出来才开 PTY（后台挂载时故意没开，见 ws 效应）；
        // 已经开过的就重新宣告尺寸，declare 保证即使 relay 认为尺寸没变也强制拉正。
        if (!openedRef.current) sendOpenTerminal(size);
        else sendResize(size, { declare: true });
      } else if (++attempts < 3) {
        timer = setTimeout(settle, 150);
        return;
      }
      // 手机端不自动 focus —— 防止弹出输入法
      if (!isTouchOnlyDevice()) termRef.current?.focus();
    };
    timer = setTimeout(settle, 100);
    // 切走（或卸载）时撤销尺寸声明：隐藏的面板量不到尺寸，留着旧值只会当天花板。
    return () => {
      clearTimeout(timer);
      releaseSize();
    };
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const btnStyle = {
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
    color: '#8b949e', borderRadius: '4px', cursor: 'pointer',
    padding: '2px 10px', fontSize: '0.72rem', fontFamily: 'monospace',
    transition: 'background-color 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s, box-shadow 0.12s',
  };

  // 手机方向键按钮样式
  const mBtnStyle = {
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
    color: '#e6edf3', borderRadius: '6px', cursor: 'pointer',
    padding: '0', fontSize: '1.1rem', fontFamily: 'monospace',
    minHeight: '40px', minWidth: '44px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    userSelect: 'none', WebkitUserSelect: 'none', flexShrink: 0,
    transition: 'background 0.1s',
  };

  return (
    <div style={{
      flex: 1, height: '100%',
      background: '#0d1117', overflow: 'hidden',
      display: visible ? 'flex' : 'none',
      flexDirection: 'column',
      ...style,
    }}>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div
          ref={containerRef}
          style={{ width: '100%', height: '100%', padding: '4px' }}
        />

        {/* 复制成功提示 */}
        {copyNotification && (
          <div style={{
            position: 'absolute',
            top: 8, right: 8,
            zIndex: 20,
            background: 'rgba(16,185,129,0.9)',
            color: '#fff',
            borderRadius: '6px',
            padding: '4px 12px',
            fontSize: '0.75rem',
            fontFamily: 'monospace',
            pointerEvents: 'none',
            animation: 'fadeInUp 0.12s ease',
          }}>已复制</div>
        )}

        {/* 拖入文件时的落点提示：pointerEvents none，别挡住 drop 事件 */}
        {dragActive && (
          <div style={{
            position: 'absolute', inset: 4, zIndex: 25,
            border: '2px dashed rgba(88,166,255,0.8)',
            borderRadius: '8px',
            background: 'rgba(88,166,255,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#58a6ff', fontSize: '0.9rem', fontFamily: 'monospace',
            pointerEvents: 'none',
          }}>松手上传到这台开发机，并把路径敲进终端</div>
        )}

        {/* 上传进度 / 结果提示 */}
        {uploadNotice && (
          <div style={{
            position: 'absolute',
            bottom: 8, right: 8,
            zIndex: 20,
            background: uploadNotice.error ? 'rgba(248,113,113,0.92)' : 'rgba(88,166,255,0.92)',
            color: '#fff',
            borderRadius: '6px',
            padding: '4px 12px',
            fontSize: '0.75rem',
            fontFamily: 'monospace',
            maxWidth: '80%',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>{uploadNotice.text}</div>
        )}
      </div>

      {/* 输入框：独立于 xterm textarea，手机上点击自然弹出键盘 */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px 8px',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        background: '#0d1117', flexShrink: 0,
      }}>
        <TerminalComposer ref={composerRef} onSendText={sendText} />
      </div>

      {/* 快捷键栏：单行横向滚动，手机上不会被截断 */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px 8px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: '#0d1117', flexShrink: 0,
        overflowX: 'auto', WebkitOverflowScrolling: 'touch',
      }}>
        <button style={mBtnStyle} onPointerDown={e => e.preventDefault()} onClick={() => sendText('\x1b[A')} title="↑">↑</button>
        <button style={mBtnStyle} onPointerDown={e => e.preventDefault()} onClick={() => sendText('\x1b[B')} title="↓">↓</button>
        <button style={mBtnStyle} onPointerDown={e => e.preventDefault()} onClick={() => sendText('\x1b[D')} title="←">←</button>
        <button style={mBtnStyle} onPointerDown={e => e.preventDefault()} onClick={() => sendText('\x1b[C')} title="→">→</button>
        {/* 回到最新：滚上去之后 tmux 停在 copy-mode，光按方向键回不来（那是发给程序的按键，
            不是滚动）。这个按钮走的是 tmux 控制通路，一步退回底部。 */}
        <button
          style={{ ...mBtnStyle, color: '#58a6ff', borderColor: 'rgba(88,166,255,0.4)', background: 'rgba(88,166,255,0.1)', minWidth: '40px', fontSize: '0.75rem' }}
          onPointerDown={e => e.preventDefault()}
          onClick={scrollToBottom}
          title="回到最新输出（退出 tmux 复制模式，跳到最底部）"
        >⤓ 最新</button>
        {/* 回车：输入框有内容 = 整行发送（composer），空框 = 发一个回车 */}
        <button
          style={{ ...mBtnStyle, color: '#58a6ff', borderColor: 'rgba(88,166,255,0.4)', background: 'rgba(88,166,255,0.1)' }}
          onPointerDown={e => e.preventDefault()}
          onClick={sendLine}
          title="回车：发送输入框内容（空框 = 发一个回车）"
        >⏎</button>
        {/* 继续：向终端发送「继续」+ 回车（Claude Code 停在确认点/checkpoint 时一键续跑） */}
        <button
          style={{ ...mBtnStyle, color: '#3fb950', borderColor: 'rgba(63,185,80,0.4)', background: 'rgba(63,185,80,0.1)', fontSize: '0.8rem' }}
          onPointerDown={e => e.preventDefault()}
          onClick={() => sendText('继续\r')}
          title="继续：向终端发送「继续」+ 回车"
        >继续</button>
        <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch', margin: '2px 0', flexShrink: 0 }} />
        <button style={{ ...mBtnStyle, color: '#f87171' }} onPointerDown={e => e.preventDefault()} onClick={() => sendText('\x03')} title="Ctrl+C">^C</button>
        <button style={mBtnStyle} onPointerDown={e => e.preventDefault()} onClick={() => sendText('\t')} title="Tab">⇥</button>
        <button style={mBtnStyle} onPointerDown={e => e.preventDefault()} onClick={() => sendText('\x1b')} title="Escape">Esc</button>
        <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch', margin: '2px 0', flexShrink: 0 }} />
        {SLASH_COMMANDS.map(cmd => (
          <button
            key={cmd}
            style={btnStyle}
            onPointerDown={e => e.preventDefault()}
            onClick={() => sendSlashCommand(sendText, cmd)}
            title={`先 Ctrl+C 打断，再发送 ${cmd}`}
          >{cmd}</button>
        ))}
        <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch', margin: '2px 0', flexShrink: 0 }} />
        <button
          style={{ ...mBtnStyle, fontSize: '0.75rem', minWidth: '40px' }}
          onPointerDown={e => e.preventDefault()}
          onClick={() => {
            const term = termRef.current;
            if (!term) return;
            const sel = term.getSelection();
            if (!sel) { term.selectAll(); const all = term.getSelection(); if (all) { copyTextToClipboard(all); term.clearSelection(); } return; }
            copyTextToClipboard(sel);
            term.clearSelection();
          }}
        >复制</button>
        {/* 复制为命令：选中后点它，折成多行的命令（Claude Code 按宽度硬折行并缩进 2 格、
            tmux 滚历史时丢软换行标记）拼回一行可直接粘贴执行。普通复制不动，见 terminal-command-copy.js */}
        <button
          style={{ ...mBtnStyle, fontSize: '0.75rem', minWidth: '40px' }}
          onPointerDown={e => e.preventDefault()}
          onClick={copyAsCommand}
          title="把选中的命令拼成一行再复制（去缩进、拼回被折断的行）；先用鼠标选中命令"
        >复制命令</button>
        <button
          style={{ ...mBtnStyle, fontSize: '0.75rem', minWidth: '40px' }}
          onPointerDown={e => e.preventDefault()}
          onClick={() => {
            // HTTP（非 secure context）下浏览器不给网页读剪贴板，而且**存在也可能当场被拒**。
            // 两条路都要有出口：原来这里是 alert + 空 catch —— 弹窗阻塞整页，被拒时
            // 则一点反应没有（手机版 09-22 栽的就是「失败没出口」，见 LESSONS_LEARNED）。
            const hint = '浏览器不让网页读剪贴板：点一下终端，直接按 Ctrl+V（Mac 用 Cmd+V）';
            if (!navigator.clipboard?.readText) { notifyUpload(hint, true); return; }
            navigator.clipboard.readText()
              .then(text => {
                if (text) { sendText(text); notifyUpload('已粘贴到终端'); }
                else notifyUpload('剪贴板是空的');
              })
              .catch(() => notifyUpload(hint, true));
          }}
        >粘贴</button>
      </div>
    </div>
  );
}
