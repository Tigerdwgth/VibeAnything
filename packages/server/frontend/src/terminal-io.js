// 终端与 relay 之间的字节搬运：编码、解码、尺寸测量、写入合批。
// 桌面版（TerminalPanel.jsx）与手机版（src/mobile/MobileTerminal.jsx）共用。

// 尺寸下限，与 relay 的 sanitizeSize 保持一致。容器还没布局好时 fit 出来的
// 假尺寸（线上实测发出过 10x6）一旦进到 tmux，会把整个窗口压成 10 列 ——
// 该会话的所有观众（包括本机真实终端）当场错位，而且不会自愈。
export const MIN_COLS = 20;
export const MIN_ROWS = 5;

/**
 * 要发给 PTY 的文本 → relay 协议里的 base64。
 * 终端是字节管道，中文必须先按 UTF-8 编码再 base64，直接 btoa 会抛 InvalidCharacterError。
 */
export function encodeInput(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** relay 下行的 pty_data(base64) → 可直接交给 term.write 的字节。 */
export function decodePtyData(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/**
 * 量一次当前容器能容纳的终端尺寸。
 * 容器还没布局好（display:none / 宽高为 0）、或算出荒唐的小尺寸时返回 null
 * —— 宁可这一轮不报尺寸，也不能把假尺寸发出去（原因见 MIN_COLS 的注释）。
 *
 * @param {HTMLElement} container term.open() 的宿主
 * @param {import('@xterm/xterm').Terminal} term
 * @param {{fit: () => void}} fitAddon
 */
export function measureTerminalSize(container, term, fitAddon) {
  if (!container || !term || container.offsetWidth === 0 || container.offsetHeight === 0) return null;
  try { fitAddon?.fit(); } catch { /* 容器尚未布局好，本轮不报尺寸 */ }
  const { cols, rows } = term;
  return (cols >= MIN_COLS && rows >= MIN_ROWS) ? { cols, rows } : null;
}

// 字体栈末尾追加的哨兵：一个不存在的字体名。它唯一的作用是让 fontFamily 的
// **值**变掉；排版实际选中的字体不受影响（实测带不带哨兵，measureText 完全一致）。
const REMEASURE_SENTINEL = ', "xterm-remeasure"';

/**
 * 逼 xterm 重量一次字符尺寸（一个格子的宽高）。
 *
 * xterm 的 CharSizeService 只在三种时候量：`term.open()`、devicePixelRatio 变化、
 * cols/rows 真的变了。公共 API 里唯一能主动触发的是「fontFamily 的值真的变了」——
 * 同值赋值会被 OptionsService 原样丢掉（Chrome + xterm 6.0.0 实测如此）。
 * 所以这里靠哨兵来回切：值变了，字体没变，赋值后同一个同步块里就能读到新格子。
 *
 * @param {{options: {fontFamily: string}}} term
 */
export function remeasureCharSize(term) {
  const ff = term?.options?.fontFamily;
  if (typeof ff !== 'string') return;
  term.options.fontFamily = ff.endsWith(REMEASURE_SENTINEL)
    ? ff.slice(0, -REMEASURE_SENTINEL.length)
    : ff + REMEASURE_SENTINEL;
}

/**
 * 网页字体晚到的自愈：字体一到就重量字符尺寸，并回调上报新尺寸。
 *
 * 为什么必须有这一条：界面用的 JetBrains Mono 是网页字体，**异步**到达；
 * 而 xterm 只在 `term.open()` 的那一刻量一次格子。冷缓存下（新登录、或 Google Fonts
 * 的 CSS 过了一天缓存要重新验证）字体稳定晚于终端创建，于是留下
 * 「按回退字体量出来的格子」去排「JetBrains Mono 的字」：实测 14px 下行高
 * 16px → 18px（+12.5%），面板里塞进 50 行而实际只放得下 44 行，底部被切掉，
 * 整块终端的比例因此不对；而且**不会自愈** —— 既没有 dpr 变化也没有 cols/rows
 * 变化，谁都不会再去量第二次。
 * 用户过去靠浏览器缩放（Command 加减）救回来，正是因为缩放改了 devicePixelRatio，
 * 顺带触发了 xterm 的重量。
 *
 * 判据为什么不用 `document.fonts.check()`：按规范，匹配不到任何 @font-face 规则的
 * 字体名算「系统字体」，一律视为可用 —— 冷缓存下字体的 CSS 还没到，check() 返回的
 * 恰恰是 true（实测），拿它当判据等于永远认为「字体已经到了」。
 * 所以这里不问「到了没」，只在每次 loadingdone 之后重量一遍：尺寸没变的话
 * CharSizeService 自己就不会发变更事件，白跑一次 measureText 而已。
 *
 * @param {object} term xterm 实例
 * @param {() => void} onRemeasured 重量之后调一次（调用方在这里重新 fit 并宣告尺寸）
 * @param {{fonts?: FontFaceSet}} [deps] 注入用；默认当前文档的字体集
 * @returns {() => void} 卸载函数
 */
export function installWebFontRefit(term, onRemeasured, { fonts = globalThis.document?.fonts } = {}) {
  // FontFaceSet 不是到处都有（jsdom、老 Safari）。没有就谈不上「字体晚到」这件事。
  if (!fonts?.addEventListener) return () => {};
  const onLoadingDone = () => {
    remeasureCharSize(term);
    onRemeasured();
  };
  fonts.addEventListener('loadingdone', onLoadingDone);
  return () => fonts.removeEventListener('loadingdone', onLoadingDone);
}

/**
 * pty_data 写入合批：同一帧内到达的多条消息合成一个 Uint8Array 一次性 write。
 * 每条消息各调一次 term.write 在移动端低端设备上渲染不过来，表现为帧间撕裂（花屏），
 * 2026-03-17 实测过。
 *
 * @param {() => import('@xterm/xterm').Terminal|null} getTerm 取当前终端（组件里是 ref）
 * @returns {{push:(bytes:Uint8Array)=>void, flush:()=>void, dispose:()=>void}}
 */
export function createPtyWriteBatcher(getTerm) {
  let buf = [];
  let raf = 0;

  const flush = () => {
    raf = 0;
    const term = getTerm();
    if (!term || buf.length === 0) return;
    const total = buf.reduce((sum, b) => sum + b.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const b of buf) { merged.set(b, offset); offset += b.length; }
    buf = [];
    term.write(merged);
  };

  return {
    push(bytes) {
      buf.push(bytes);
      if (!raf) raf = requestAnimationFrame(flush);
    },
    flush,
    dispose() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      // 卸载前把残留数据写完，否则最后一帧的输出会丢
      if (buf.length > 0) flush();
    },
  };
}
