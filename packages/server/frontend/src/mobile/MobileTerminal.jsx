import { memo, useEffect, useRef, useState } from 'react';
import { parseWsMessage } from '../ws-message';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getLaunchCommand } from '../launch-config';
import {
  encodeInput, decodePtyData, measureTerminalSize, createPtyWriteBatcher, installWebFontRefit,
} from '../terminal-io';
import { takeWheelSteps, buildWheelSequence, fingerDeltaToAccum } from '../terminal-touch-scroll';
import { buildClickSequence, clientXYToCell } from '../terminal-mouse-click';
import { attachImeCursorSync, attachImeCommitInput, isImeProcessKeydown } from '../terminal-ime';
import { copyTextToClipboard } from '../clipboard';
import { selectionAsCommand } from '../terminal-command-copy';
import { sendSlashCommand } from '../slash-commands';
import {
  attachUploadHandlers, fileToBase64, inferFileName, quotePath, DEFAULT_MAX_UPLOAD_MB,
} from '../terminal-upload';
import TerminalComposer from '../TerminalComposer';
import MobileKeyBar from './MobileKeyBar';

// 手机版终端。协议部分（open/resize/release、写入合批、字节编码）与桌面版共用
// src/terminal-io.js；手势部分复用 terminal-touch-scroll / terminal-mouse-click；
// 输入框复用 TerminalComposer。这里只负责「手机上的接线与布局」。
//
// 与桌面版 TerminalPanel 的差别（都是手机专有需求，不是简化）：
//  · 输入默认走 composer，xterm 的 helper textarea 被 readonly + inputMode=none 压住
//    （不压的话它一获焦就弹键盘且收不回去）；需要逐键交互（y/n、vim）时用「⌨ 直连」打开它。
//  · 直连模式下中文输入法的候选框要跟着光标走 —— 见 terminal-ime.js（全屏 TUI 光标不动，
//    xterm 自己不会同步 textarea 位置，候选框会被画到屏幕外）。
//  · 触屏没有「拖选」，长按整行选中并复制代替它。
//  · 相册选图走 <input type="file">：手机上没有拖拽，粘贴也不顺手。

const TAP_MAX_MS = 300;        // 超过这个时长不再算「点一下」
const TAP_MAX_MOVE_PX = 10;    // 位移超过这个距离算滑动，不是点击
const LONG_PRESS_MS = 500;     // 长按选中整行的阈值
const SCROLL_DEAD_ZONE_PX = 2; // 小于这个位移不当滚动，留给点击判定

// memo：会话列表一变 MobileShell 就整体重渲染，而终端面板的 props 那时并没有变
export default memo(MobileTerminal);

function MobileTerminal({ machineId, sessionId, ws, command, cwd, visible }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(ws);
  useEffect(() => { wsRef.current = ws; }, [ws]);
  // 本连接是否已经为该会话开过 PTY。ws 重连后 relay 侧的观众身份随连接销毁，需要重开。
  const openedRef = useRef(false);
  const composerRef = useRef(null);
  const fileInputRef = useRef(null);
  // uploadId → 文件名。回执只带 id，要靠它把「哪个文件传完了」说清楚。
  const pendingUploadsRef = useRef(new Map());
  const noticeTimerRef = useRef(null);

  const [notice, setNotice] = useState(null);                  // { text, error }
  // 浏览器拒绝自动复制时，把内容摊出来让用户自己长按拷贝
  const [copyFallback, setCopyFallback] = useState(null);      // 要手动拷贝的文本
  const [pasteFallback, setPasteFallback] = useState(null);    // null=不显示；字符串=手动粘贴框里的内容
  const [dragActive, setDragActive] = useState(false);
  const [directKeyboard, setDirectKeyboard] = useState(false);

  function sendText(text) {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'terminal_input', machineId, sessionId, data: encodeInput(text) }));
    }
  }

  // 回到最新输出。tmux 滚历史时进的是 copy-mode，那份内容在 alternate screen，
  // xterm 自己的 scrollback 是空的 —— term.scrollToBottom() 只管得着后者，
  // 退出 copy-mode 只有开发机侧的 tmux 做得到。两条路都走，各管各的缓冲区。
  // （桌面版 TerminalPanel.jsx 里是同一份实现，改一处要同步另一处。）
  function scrollToBottom() {
    termRef.current?.scrollToBottom();
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'scroll_to_bottom', machineId, sessionId }));
  }

  // 一条自动消失的提示。错误留久一点，够看清为什么没传上去。
  function notify(text, isError = false) {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice({ text, error: isError });
    noticeTimerRef.current = setTimeout(() => setNotice(null), isError ? 4000 : 2000);
  }

  // 手机端复制不回焦终端：focus 会把输入法顶出来。
  // 失败必须有出口：HTTP 页面没有 navigator.clipboard，只能靠 execCommand，
  // 而浏览器随时可能拒绝（iOS 尤其挑剔）。原来失败时一声不吭，用户看到的就是
  // 「点了没反应」，连是没选中还是被挡了都分不出来 —— 现在兜到手动拷贝面板。
  function copy(text, okText) {
    copyTextToClipboard(text, {
      onSuccess: () => notify(okText),
      onFailure: (t) => setCopyFallback(t),
    });
  }

  // 粘贴。和复制是一体两面：HTTP（非 secure context）页面上 navigator.clipboard 根本不存在，
  // 存在也可能被浏览器当场拒绝 —— 两种都必须有出口，否则又是「点了没反应」
  // （2026-09-22 复制那次栽的就是这个，见 LESSONS_LEARNED）。
  // 兜底是弹一个真 textarea 让用户自己长按粘贴，这条路 100% 有效。
  function paste() {
    if (!navigator.clipboard?.readText) { setPasteFallback(''); return; }
    navigator.clipboard.readText()
      .then((text) => {
        if (!text) { notify('剪贴板是空的'); return; }
        sendText(text);
        notify('已粘贴到终端');
      })
      .catch(() => setPasteFallback(''));
  }

  /** 手动粘贴面板上点「发送」：把框里的内容敲进终端。 */
  function submitPaste() {
    const text = pasteFallback;
    setPasteFallback(null);
    if (!text) return;
    sendText(text);
    notify('已粘贴到终端');
  }

  function measureSize() {
    return measureTerminalSize(containerRef.current, termRef.current, fitRef.current);
  }

  function sendResize(size, { declare = false } = {}) {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'terminal_resize', machineId, sessionId, ...size,
      ...(declare ? { declare: true } : {}),
    }));
  }

  // 开 PTY。**只接受真量出来的尺寸**：猜出来的默认值一旦进了 tmux resize-window，
  // 窗口就被钉成 manual，从此不跟随任何客户端，而隐藏的面板永远量不到尺寸去纠正它。
  function sendOpenTerminal(size) {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'open_terminal', machineId, sessionId,
      cols: size.cols, rows: size.rows,
      command: getLaunchCommand(command),
      cwd: cwd || undefined,
    }));
    openedRef.current = true;
  }

  // 切走时撤销本连接的尺寸声明：权威尺寸取所有观众的最小值，
  // 隐藏面板留着的旧尺寸会变成一个降不下来的天花板。
  function releaseSize() {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'release_size', machineId, sessionId }));
  }

  // 关标签：退掉观众身份，relay 不再推这个会话的输出（同桌面版 TerminalPanel）
  function closeViewer() {
    const socket = wsRef.current;
    if (!openedRef.current || socket?.readyState !== WebSocket.OPEN) return;
    openedRef.current = false;
    socket.send(JSON.stringify({ type: 'close_terminal', machineId, sessionId }));
  }

  // 粘贴/拖入/相册选出的文件 → 开发机落盘 → 回执里的路径由 onMessage 敲进终端。
  // 为什么不直接把字节塞进 PTY：claude 跑在开发机上，只能读它自己的本地路径
  // （完整来龙去脉见 terminal-upload.js 顶部）。
  async function uploadFiles(files) {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      notify('未连接到服务器，无法上传', true);
      return;
    }
    for (const file of files) {
      const name = inferFileName(file);
      if (file.size > DEFAULT_MAX_UPLOAD_MB * 1024 * 1024) {
        notify(`${name} 超过 ${DEFAULT_MAX_UPLOAD_MB}MB，未上传`, true);
        continue;
      }
      notify(`上传中 ${name}…`);
      try {
        const data = await fileToBase64(file);
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        pendingUploadsRef.current.set(uploadId, name);
        socket.send(JSON.stringify({ type: 'upload_file', machineId, sessionId, uploadId, name, data }));
      } catch {
        notify(`读取 ${name} 失败`, true);
      }
    }
  }

  // ── 创建 xterm 与全部手势接线（只在首次挂载时做一次）──
  useEffect(() => {
    if (termRef.current) return undefined;
    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
      },
      cursorBlink: true,
      // 手机屏窄，13px 能多放几列；再小 tmux 状态栏会糊
      fontSize: 13,
      fontFamily: '"JetBrains Mono", monospace',
      // 内容在 tmux 的 alternate screen，xterm 自己的 scrollback 只存少量启动输出（同桌面版）
      scrollback: 2000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    // xterm 的隐藏 textarea 一获焦就弹输入法且压不住 —— 它的启用/禁用统一由下面那个
    // directKeyboard 效应负责（挂载后立刻会以 false 跑一次，把它压住），这里不要再压一遍。

    // 直连模式下键盘输入 → PTY（composer 模式下 textarea 是 readonly，这里收不到东西）
    term.onData((data) => sendText(data));

    const mouseActive = () => term._core?.coreMouseService?.activeProtocol !== 'NONE';
    const cellSize = () => {
      const dim = term._core?._renderService?.dimensions?.css?.cell;
      return { w: dim?.width || 8, h: dim?.height || 18 };
    };

    // ── 触摸滚动 ──
    // 终端里跑的是 tmux attach，内容在 alternate screen 缓冲区，xterm 自身 scrollback 为空，
    // term.scrollLines() 永远无效 —— 这正是「手机上滑不动」的根因。桌面滚轮能滚是因为
    // xterm 把滚轮编码成 SGR 鼠标事件交给 tmux。这里把手指滑动翻译成同样的事件。
    let touchY = 0;
    let scrollAccum = 0;
    let tapStartTime = 0;
    let tapStartX = 0;
    let tapStartY = 0;
    let longPressTimer = 0;
    let longPressFired = false;

    const cancelLongPress = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = 0; }
    };

    // 长按整行 = 选中，松手复制。触屏没有拖选（xterm 的选区服务只接鼠标事件，
    // 且鼠标上报一开就被 disable），selectLines 是手机上唯一能选中文本的公开入口。
    //
    // 为什么「选中」在定时器里、「复制」留到 touchend：HTTP 页面拿不到
    // navigator.clipboard，复制要回退 document.execCommand，而它**必须在用户手势的
    // 调用栈里**才生效。touchend 是真手势，定时器不是。
    const selectLineAt = (clientY) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const { h } = cellSize();
      const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor((clientY - rect.top - 4) / h)));
      const absolute = term.buffer.active.viewportY + viewportRow;
      term.selectLines(absolute, absolute);
    };

    const onTouchStart = (e) => {
      touchY = e.touches[0].clientY;
      scrollAccum = 0;
      tapStartTime = Date.now();
      tapStartX = e.touches[0].clientX;
      tapStartY = e.touches[0].clientY;
      longPressFired = false;
      cancelLongPress();
      const y = e.touches[0].clientY;
      longPressTimer = setTimeout(() => {
        longPressTimer = 0;
        longPressFired = true;
        selectLineAt(y);
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e) => {
      const cur = e.touches[0];
      // 手指挪开了就不是长按了：还没触发的取消掉，已经触发的也放弃复制
      //（用户改主意去滚动了，松手时不该弹「已复制」）
      if (Math.abs(cur.clientX - tapStartX) > TAP_MAX_MOVE_PX
        || Math.abs(cur.clientY - tapStartY) > TAP_MAX_MOVE_PX) {
        cancelLongPress();
        longPressFired = false;
      }
      // 自然滚动（内容跟手）：手指下滑 = 看更早内容（滚轮上）。方向换算在
      // fingerDeltaToAccum 里并配了单测（历史上反过一次）。
      // preventDefault 必须无条件先调，不能放在死区判断之后：手指起步慢的时候
      // 前几个 touchmove 的 dy 都小于死区，一旦这几下没 preventDefault，浏览器就把
      // 这次手势认成自己的滚动/回弹，**之后再调 preventDefault 也不管用了**（手势
      // 归属只在开头判定一次）——表现就是「刚开始滑的时候一顿一顿的」。
      e.preventDefault();
      const dy = fingerDeltaToAccum(touchY, cur.clientY);
      touchY = cur.clientY;
      if (Math.abs(dy) < SCROLL_DEAD_ZONE_PX) return;
      scrollAccum += dy;
      const { w, h } = cellSize();
      if (mouseActive()) {
        // 一个滚轮事件在 tmux copy-mode 里滚 5 行，所以换算按「5 行 × 行高」的
        // 手指位移一步，手指和内容才是 1:1（见 terminal-touch-scroll.js）。
        const taken = takeWheelSteps(scrollAccum, h);
        scrollAccum = taken.accum;
        if (taken.steps === 0) return;
        const rect = containerRef.current.getBoundingClientRect();
        const col = Math.max(1, Math.min(term.cols, Math.floor((cur.clientX - rect.left - 4) / w) + 1));
        const row = Math.max(1, Math.min(term.rows, Math.floor((cur.clientY - rect.top - 4) / h) + 1));
        sendText(buildWheelSequence(taken.steps, col, row));
      } else {
        // 无鼠标上报（tmux mouse off / 裸 shell）：退回 xterm 本地滚动。
        // scrollLines(正) = 滚到较新内容，取负号才和 tmux 分支同向（下滑=看更早）。
        const lineHeight = Math.max(14, h);
        const lines = Math.trunc(scrollAccum / lineHeight);
        if (lines !== 0) {
          term.scrollLines(-lines);
          scrollAccum -= lines * lineHeight;
        }
      }
    };

    const onTouchEnd = (e) => {
      cancelLongPress();
      scrollAccum = 0;
      if (longPressFired) {
        // 长按已经把整行选中了，松手这一下（真用户手势）负责复制
        const text = term.getSelection();
        if (text && text.trim()) copy(text, '已复制该行');
        else notify('这一行是空的');
        return;
      }
      if (Date.now() - tapStartTime > TAP_MAX_MS) return;
      const ct = e.changedTouches[0];
      if (Math.abs(ct.clientX - tapStartX) > TAP_MAX_MOVE_PX) return;
      if (Math.abs(ct.clientY - tapStartY) > TAP_MAX_MOVE_PX) return;
      if (term.hasSelection()) { term.clearSelection(); return; }

      const rect = containerRef.current.getBoundingClientRect();
      const { w, h } = cellSize();
      if (mouseActive()) {
        // tmux 开着鼠标上报（典型是分屏）：tap 合成 SGR 左键，tmux 据此切 pane。
        // 不 term.focus()，否则输入法会被顶出来。
        const { col, row } = clientXYToCell(ct.clientX, ct.clientY, rect, w, h, term.cols, term.rows);
        sendText(buildClickSequence(col, row));
        return;
      }
      // 非 tmux 场景：同一行内点击 = 用左右方向键把光标挪过去
      const targetCol = Math.max(0, Math.floor((ct.clientX - rect.left - 4) / w));
      const targetRow = Math.floor((ct.clientY - rect.top - 4) / h);
      const buf = term.buffer.active;
      if (targetRow !== buf.cursorY) return;
      const diff = targetCol - buf.cursorX;
      if (diff === 0) return;
      const arrow = diff > 0 ? '\x1b[C' : '\x1b[D';
      sendText(arrow.repeat(Math.min(Math.abs(diff), 200)));
    };

    // ── 尺寸 ──
    // ResizeObserver 在移动端会被极频繁触发（地址栏收放、键盘弹出），必须 RAF 节流 +
    // 变化检测，否则 write→resize→fit→write 会转成死循环，表现为花屏。
    let resizeRaf = 0;
    let lastCols = 0;
    let lastRows = 0;
    const ro = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!openedRef.current) return;   // 还没开 PTY 就没有「本观众的尺寸」可言
        const size = measureSize();
        if (!size) return;
        if (size.cols === lastCols && size.rows === lastRows) return;
        lastCols = size.cols;
        lastRows = size.rows;
        sendResize(size);
      });
    });
    if (containerRef.current) ro.observe(containerRef.current);

    // 网页字体晚到的自愈（见 terminal-io.js 的 installWebFontRefit）：字体一到，
    // 格子就从回退字体的尺寸变成 JetBrains Mono 的尺寸，而 xterm 只在 open() 量过一次。
    const disposeFontRefit = installWebFontRefit(term, () => {
      const grid = `${term.cols}x${term.rows}`;
      const size = measureSize();
      if (!size || !openedRef.current) return;
      if (`${size.cols}x${size.rows}` === grid) return;
      lastCols = size.cols;
      lastRows = size.rows;
      sendResize(size, { declare: true });
    });

    // 输入法定位：直连模式下打拼音时候选框必须画在光标处（见 terminal-ime.js）
    const imeHandle = attachImeCursorSync(term, containerRef.current);
    // 输入法直接上屏的字符（标点、Shift+符号）：等输入法真正写入时再发，见 terminal-ime.js
    term.attachCustomKeyEventHandler((e) => !isImeProcessKeydown(e));
    const imeCommitHandle = attachImeCommitInput(term, containerRef.current);

    // 粘贴 / 拖入文件（手机上少用，但平板接键盘、或桌面浏览器打开 /m 时是有效入口）
    const uploadHandle = attachUploadHandlers(containerRef.current, {
      onFiles: (files) => { uploadFiles(files); },
      onDragState: setDragActive,
    });

    const onTouchCancel = () => { cancelLongPress(); scrollAccum = 0; longPressFired = false; };

    const el = containerRef.current;
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      cancelLongPress();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      disposeFontRefit();
      imeHandle.dispose();
      imeCommitHandle.dispose();
      uploadHandle.dispose();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
      closeViewer();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── pty_data / 上传回执 ──
  // 关键时序：先注册 listener 再发 open_terminal，否则 tmux 刚 attach 时发的终端初始化与整屏重绘会丢，
  // 终端只剩一个光标在闪。
  useEffect(() => {
    if (!ws) return undefined;
    const writer = createPtyWriteBatcher(() => termRef.current);

    function onMessage(e) {
      const msg = parseWsMessage(e);
      if (!msg) return;
      if (msg.type === 'pty_data' && msg.machineId === machineId && msg.sessionId === sessionId && msg.data) {
        writer.push(decodePtyData(msg.data));
      }
      // 只认自己发起的 uploadId —— 同一会话的其它浏览器也会收到各自的回执
      if (msg.type === 'file_uploaded' && pendingUploadsRef.current.has(msg.uploadId)) {
        const name = pendingUploadsRef.current.get(msg.uploadId);
        pendingUploadsRef.current.delete(msg.uploadId);
        if (msg.error) notify(`${name}：${msg.error}`, true);
        else if (msg.path) {
          sendText(`${quotePath(msg.path)} `);
          notify(`已插入 ${name}`);
        }
      }
    }
    ws.addEventListener('message', onMessage);

    openedRef.current = false;
    // 隐藏的面板量不到尺寸就**不开**，绝不拿猜的默认值去开 —— visible 效应会在它
    // 真正显示出来时带真实尺寸开。
    function tryOpen() {
      const size = measureSize();
      if (size) sendOpenTerminal(size);
    }
    if (ws.readyState === WebSocket.OPEN) tryOpen();
    else ws.addEventListener('open', tryOpen, { once: true });

    return () => {
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('open', tryOpen);
      writer.dispose();
    };
  }, [sessionId, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // 显示出来时把尺寸重新宣告一遍（declare 绕过 relay 的「尺寸没变就不下发」去重）
  useEffect(() => {
    if (!visible) return undefined;
    let attempts = 0;
    let timer = 0;
    const settle = () => {
      const size = measureSize();
      if (size) {
        if (!openedRef.current) sendOpenTerminal(size);
        else sendResize(size, { declare: true });
      } else if (++attempts < 3) {
        // 手机渲染慢，这一刻还量不到就再等两轮，绝不退而求其次发一个假尺寸
        timer = setTimeout(settle, 150);
      }
    };
    timer = setTimeout(settle, 100);
    return () => {
      clearTimeout(timer);
      releaseSize();
    };
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // 「⌨ 直连」：解开 / 压回 xterm 的隐藏 textarea。
  // 打开后按键直达 PTY（TUI 的 y/n、vim 这类逐键交互只能这么用），代价是输入法归 xterm 管。
  useEffect(() => {
    const textarea = containerRef.current?.querySelector('.xterm-helper-textarea');
    if (!textarea) return;
    if (directKeyboard) {
      textarea.removeAttribute('readonly');
      textarea.inputMode = 'text';
      termRef.current?.focus();
    } else {
      textarea.inputMode = 'none';
      textarea.setAttribute('readonly', '');
      textarea.blur();
    }
  }, [directKeyboard]);

  return (
    <div style={{
      flex: 1, minHeight: 0, display: visible ? 'flex' : 'none',
      flexDirection: 'column', background: '#0d1117', overflow: 'hidden',
    }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={containerRef}
          style={{
            width: '100%', height: '100%', padding: '4px',
            // 终端自己处理全部手势。不写这行的话浏览器默认是 touch-action: auto，
            // 会先花几十毫秒判断这是不是页面平移/缩放手势，再把事件给我们；
            // 加上 xterm 的 .xterm-viewport 本身是 overflow-y:scroll，iOS 还会在
            // 它身上做回弹。两者叠起来就是滑动起步发涩、中途被打断。
            touchAction: 'none',
            // 长按时不要弹 iOS 的系统放大镜/菜单，长按已被我们用来选中整行
            WebkitTouchCallout: 'none',
          }}
        />
        {dragActive && (
          <div style={{
            position: 'absolute', inset: 4, zIndex: 25,
            border: '2px dashed rgba(88,166,255,0.8)', borderRadius: '8px',
            background: 'rgba(88,166,255,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#58a6ff', fontSize: '0.9rem', fontFamily: 'monospace',
            pointerEvents: 'none',
          }}>松手上传到这台开发机</div>
        )}
        {copyFallback !== null && (
          <div
            onClick={() => setCopyFallback(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 70,
              background: 'rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: '#161b22', borderTop: '1px solid rgba(255,255,255,0.12)',
                borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
                padding: '14px 16px calc(14px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <div style={{ color: '#e6edf3', fontSize: '0.88rem', fontWeight: 600, marginBottom: '4px' }}>
                浏览器挡住了自动复制
              </div>
              <div style={{ color: '#8b949e', fontSize: '0.74rem', marginBottom: '10px' }}>
                页面走的是 HTTP，拿不到剪贴板接口。长按下面的文字选中，再点「拷贝」。
              </div>
              {/* 这里必须是真 textarea 且允许原生长按：终端容器上那两条
                  WebkitTouchCallout:none / touchAction:none 会掐掉 iOS 的选择菜单，
                  所以在这儿显式开回来。 */}
              <textarea
                readOnly
                value={copyFallback}
                aria-label="待复制的内容"
                style={{
                  width: '100%', height: '32vh', resize: 'none',
                  background: '#0d1117', color: '#e6edf3',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px',
                  padding: '10px', fontSize: '16px', fontFamily: 'monospace',
                  WebkitTouchCallout: 'default', WebkitUserSelect: 'text', userSelect: 'text',
                  touchAction: 'auto',
                }}
              />
              <button
                type="button"
                onClick={() => setCopyFallback(null)}
                style={{
                  width: '100%', minHeight: '46px', marginTop: '10px', borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.12)', background: 'transparent',
                  color: '#8b949e', fontSize: '0.88rem',
                }}
              >关闭</button>
            </div>
          </div>
        )}

        {/* 手动粘贴面板：HTTP 页面读不到剪贴板时的兜底。
            这里的 textarea 必须可编辑（复制那个是 readOnly）—— 用户要往里长按粘贴。
            同样要把 iOS 的长按菜单显式开回来：终端容器上那两条
            WebkitTouchCallout:none / touchAction:none 会把它掐掉。 */}
        {pasteFallback !== null && (
          <div
            onClick={() => setPasteFallback(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 70,
              background: 'rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: '#161b22', borderTop: '1px solid rgba(255,255,255,0.12)',
                borderTopLeftRadius: '14px', borderTopRightRadius: '14px',
                padding: '14px 16px calc(14px + env(safe-area-inset-bottom, 0px))',
              }}
            >
              <div style={{ color: '#e6edf3', fontSize: '0.88rem', fontWeight: 600, marginBottom: '4px' }}>
                浏览器不让网页读剪贴板
              </div>
              <div style={{ color: '#8b949e', fontSize: '0.74rem', marginBottom: '10px' }}>
                页面走的是 HTTP，拿不到剪贴板接口。长按下面的框粘贴，再点「发送到终端」。
              </div>
              <textarea
                value={pasteFallback}
                onChange={e => setPasteFallback(e.target.value)}
                aria-label="要粘贴到终端的内容"
                autoFocus
                style={{
                  width: '100%', height: '28vh', resize: 'none',
                  background: '#0d1117', color: '#e6edf3',
                  border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px',
                  padding: '10px', fontSize: '16px', fontFamily: 'monospace',
                  WebkitTouchCallout: 'default', WebkitUserSelect: 'text', userSelect: 'text',
                  touchAction: 'auto',
                }}
              />
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setPasteFallback(null)}
                  style={{
                    flex: 1, minHeight: '46px', borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.12)', background: 'transparent',
                    color: '#8b949e', fontSize: '0.88rem',
                  }}
                >取消</button>
                <button
                  type="button"
                  onClick={submitPaste}
                  disabled={!pasteFallback}
                  style={{
                    flex: 1, minHeight: '46px', borderRadius: '8px', border: 'none',
                    background: pasteFallback ? '#58a6ff' : 'rgba(255,255,255,0.08)',
                    color: pasteFallback ? '#fff' : '#8b949e',
                    fontSize: '0.88rem', fontWeight: 600,
                  }}
                >发送到终端</button>
              </div>
            </div>
          </div>
        )}
        {notice && (
          <div style={{
            position: 'absolute', bottom: 8, left: 8, right: 8, zIndex: 20,
            background: notice.error ? 'rgba(248,113,113,0.92)' : 'rgba(88,166,255,0.92)',
            color: '#fff', borderRadius: '6px', padding: '5px 12px',
            fontSize: '0.75rem', fontFamily: 'monospace',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>{notice.text}</div>
        )}
      </div>

      <div style={{
        display: 'flex', gap: '6px', padding: '5px 8px',
        borderTop: '1px solid rgba(255,255,255,0.08)', background: '#0d1117', flexShrink: 0,
      }}>
        <TerminalComposer
          ref={composerRef}
          onSendText={sendText}
          placeholder={directKeyboard ? '直连模式：按键直达终端' : '输入内容，回车发送'}
          inputStyle={{ padding: '10px 12px', minHeight: '42px' }}
        />
      </div>

      <MobileKeyBar
        onSendText={sendText}
        onSendLine={() => composerRef.current?.sendLine()}
        onPickImage={() => fileInputRef.current?.click()}
        onScrollToBottom={scrollToBottom}
        onPaste={paste}
        onSlashCommand={(cmd) => sendSlashCommand(sendText, cmd)}
        onCopyAll={() => {
          const term = termRef.current;
          if (!term) return;
          // 有选区（长按选的那一行）就复制它，否则复制整个终端缓冲区，与桌面版「复制」一致
          const sel = term.getSelection();
          if (sel) { copy(sel, '已复制选中内容'); term.clearSelection(); return; }
          term.selectAll();
          const all = term.getSelection();
          term.clearSelection();
          if (all) copy(all.replace(/\s+$/, ''), '已复制终端内容');
        }}
        onCopyCommand={() => {
          const term = termRef.current;
          if (!term) return;
          // 长按只能选一行，selectionAsCommand 会把这一行所在的整条命令找全再拼成一行
          const command = selectionAsCommand(term);
          if (!command) { notify('先长按命令的任意一行选中它，再点「复制命令」', true); return; }
          copy(command, '已复制命令');
          term.clearSelection();
        }}
        directKeyboard={directKeyboard}
        onToggleDirectKeyboard={() => setDirectKeyboard(v => !v)}
      />

      {/* 相册选图：手机上没有拖拽、粘贴也不顺手，这个按钮才是主入口。
          accept="image/*" 在 iOS 上会同时给出「照片图库 / 拍照 / 浏览文件」。 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          // 清空 value，否则连续选同一张图不会再触发 change
          e.target.value = '';
          if (files.length) uploadFiles(files);
        }}
      />
    </div>
  );
}
