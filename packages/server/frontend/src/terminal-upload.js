// 把「浏览器这一侧的文件」送进「终端那一侧的机器」。
//
// ── 为什么需要这一层 ──
// dashboard 里的终端只是一根字节管道：xterm 把按键编码成字节经 ws 发给开发机的 PTY。
// 剪贴板里的截图、Finder 里拖来的文件都活在**浏览器这台机器**上，而 claude 跑在
// **开发机**上，它只会读自己本地的路径 —— 把图片字节直接塞进 PTY 没有任何意义
// （终端会把它当控制字符乱解释）。所以「粘贴一张图给 claude 看」实际是三步：
//   ① 浏览器侧把文件读成 base64；② 送到开发机落盘；③ 把落盘后的**绝对路径**当文本敲进终端。
// 本模块负责 ① 与事件接线，② 在 lib/ws-client.js（_saveUpload），③ 由 TerminalPanel
// 收到 file_uploaded 回执后 sendText。
//
// ── 为什么读剪贴板必须走事件，不能走 API ──
// dashboard 走 HTTP（非 secure context），`navigator.clipboard` 整个是 undefined
// （见 2026-07-13 的复制事故）。但 **paste 事件上的 clipboardData 不受此限**：它是用户
// 手势的产物，HTTP 页面照样能从里面拿到图片 blob。所以能力差异在这里是反直觉的 ——
// 「点按钮读剪贴板」做不到，「用户按 Cmd+V」反而做得到。
//
// ── 与 xterm 原生粘贴的分工 ──
// 监听挂在容器的 **capture 阶段**，早于 xterm 挂在 helper textarea 上的 paste 处理：
// 剪贴板里有文件就 preventDefault + stopPropagation 自己接管（不让 xterm 再去取
// text/plain，否则 macOS 复制文件时会把文件名当文本敲进去）；纯文本则原样放行，
// 保持 xterm 的原生粘贴（含 bracketed paste）不受影响。

/** 单个文件大小上限，与开发机侧 _saveUpload 的默认上限保持一致。 */
export const DEFAULT_MAX_UPLOAD_MB = 20;

/**
 * 从 clipboardData / dataTransfer 里取出真正的文件。
 *
 * **两个数据源只能取一个，不能合并**（2026-09-22 修：粘一张图会传两份）。
 * 按规范 `dt.files` 就是 `dt.items` 里 kind==='file' 那批的镜像，两边都取必然重复；
 * 原来靠「名字+大小+时间」去重挡不住，因为 `item.getAsFile()` **每次调用都现造一个新
 * File 对象**，剪贴板里的截图不是真实文件，它的 `lastModified` 取的是造对象那一刻的
 * 时间戳 —— 和 `dt.files` 里那个差几毫秒，键就不一样，于是同一张图上传两遍、
 * 终端里被敲进两条路径。
 *
 * 所以改成：**`files` 有内容就以它为准，空了才退回 `items`**。退路不能删 —— Safari
 * 粘贴截图时 `clipboardData.files` 是空的，只有 `items` 里有。
 *
 * 目录要挡掉（它给出的 File size=0、读取必失败，别等上传时才报错）：判定只能靠
 * `items` 的 `webkitGetAsEntry()`，所以先从 items 收集目录名，再拿它过滤选定的那一批。
 */
export function filesFromDataTransfer(dt) {
  if (!dt) return [];

  const fileItems = (dt.items ? Array.from(dt.items) : []).filter(i => i.kind === 'file');

  const dirNames = new Set();
  for (const item of fileItems) {
    if (typeof item.webkitGetAsEntry !== 'function') continue;
    let entry = null;
    try { entry = item.webkitGetAsEntry(); } catch { entry = null; }
    if (entry && entry.isDirectory) {
      const f = item.getAsFile?.();
      if (f) dirNames.add(f.name);
    }
  }

  const fromFiles = dt.files ? Array.from(dt.files) : [];
  const source = fromFiles.length
    ? fromFiles
    : fileItems.map(i => i.getAsFile?.()).filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const file of source) {
    if (!file || dirNames.has(file.name)) continue;
    // 保险：万一哪个浏览器在同一个来源里把同一份东西列了两次。
    // 键里**不能**放 lastModified —— 见上面，剪贴板文件的这个值每次读都不一样。
    const key = `${file.name}|${file.size}|${file.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

/** 剪贴板里有没有文件 —— 决定这次 paste 是我们接管还是放行给 xterm。 */
export function hasFiles(dt) {
  return filesFromDataTransfer(dt).length > 0;
}

/**
 * 截图这类剪贴板文件在多数浏览器里叫 "image.png"，一次贴多张会互相覆盖不好认。
 * 给它按内容类型补一个带时间戳的名字；用户自己的文件保留原名。
 */
export function inferFileName(file, now = new Date()) {
  const raw = (file?.name || '').trim();
  const generic = !raw || raw === 'image.png' || raw === 'blob';
  if (!generic) return raw;
  const ext = (file?.type?.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `pasted-${stamp}.${ext}`;
}

/**
 * 读成 base64。走 FileReader 而不是 arrayBuffer()+btoa：后者对几 MB 的截图要在主线程上
 * 逐字节拼字符串，会明显卡顿，而 readAsDataURL 是浏览器内部实现的。
 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      if (comma < 0) { reject(new Error('读取文件失败')); return; }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 敲进终端前给路径加引号。
 * 落盘路径由开发机生成（时间戳 + 清洗过的文件名），正常不会有空格，但用户原名里可能有；
 * 不加引号的话 claude 只会看到路径的前半截。单引号包裹 + 内部单引号做 '\'' 转义，
 * 这是 POSIX shell 唯一不需要考虑其它元字符的写法。
 */
export function quotePath(p) {
  const s = String(p ?? '');
  if (!s) return '';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 接上「粘贴 / 拖入文件」两条入口。
 *
 * @param {HTMLElement} container            term.open() 的宿主元素
 * @param {object}   handlers
 * @param {(files: File[]) => void} handlers.onFiles    收到文件（已过滤掉目录）
 * @param {(active: boolean) => void} [handlers.onDragState] 拖拽悬停态，用于画高亮边框
 * @returns {{ dispose: () => void }}
 */
export function attachUploadHandlers(container, { onFiles, onDragState } = {}) {
  if (!container || typeof onFiles !== 'function') return { dispose() {} };

  // 拖拽进/出会在子元素边界上反复触发 enter/leave，用计数器才不会闪
  let dragDepth = 0;
  const setDrag = (active) => { onDragState?.(active); };

  const onPaste = (e) => {
    const dt = e.clipboardData;
    const files = filesFromDataTransfer(dt);
    if (!files.length) return;          // 纯文本：放行给 xterm 的原生粘贴
    e.preventDefault();
    e.stopPropagation();                // 别让 xterm 再把 text/plain 敲一遍
    onFiles(files);
  };

  // 不 preventDefault 的话 drop 根本不会触发（HTML5 拖放的默认行为是「不接受」）
  const onDragOver = (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragEnter = (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dragDepth += 1;
    if (dragDepth === 1) setDrag(true);
  };
  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDrag(false);
  };
  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    setDrag(false);
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) onFiles(files);
  };

  container.addEventListener('paste', onPaste, true);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragenter', onDragEnter);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);

  return {
    dispose() {
      container.removeEventListener('paste', onPaste, true);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('dragenter', onDragEnter);
      container.removeEventListener('dragleave', onDragLeave);
      container.removeEventListener('drop', onDrop);
    },
  };
}
