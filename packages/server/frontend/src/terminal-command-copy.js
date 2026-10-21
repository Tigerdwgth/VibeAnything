// 「复制为命令」：把终端里被折成多行的 shell 命令拼回一行，粘贴即可执行。
//
// ── 背景：为什么普通复制得到的是断行 ──
// 用户在 Dashboard 里看 Claude Code 的输出，选中一条 `mkdir … >>` 开头的长命令复制，
// 粘到 shell 里变成两行、每行带前导空格，在 `>>` 处断开 → 语法错误（2026-10-20）。
// 真机复现（tmux 3.7c + node-pty + 真 xterm，见 tests/terminal-command-copy.test.js）查清有两种成因：
//
//  (b) 硬换行 + 缩进。Claude Code（ink）自己按宽度在**词边界**折行，并给每行补 2 空格
//      缩进（「⏺ 」标记占的两列）。xterm 收到的是真换行，续行 isWrapped=false，
//      行首还有缩进 —— 这是用户那条命令的真实成因（断点在 `>>` 之后而非恰好第 N 列，
//      续行带 2 空格缩进，两条都是软换行不可能有的特征）。xterm 的选区拼接帮不上忙。
//  (a) 软换行的标记丢失。tmux 在**实时视图**里会保留 isWrapped（实测 3.7c），但 **copy-mode
//      （往上滚历史时 tmux 进的就是它）和左右分屏的 pane 里**，tmux 逐行用光标定位重绘，
//      每一行都 isWrapped=false，且 copy-mode 还会把每行补空格到满宽。被折开的行于是被
//      当成独立的几行复制。
//
// 普通复制（拖选即复制、Ctrl+C、「复制」按钮）保持 xterm 原样，**不偷偷改用户的选区**；
// 这里是一个明确的另起入口（桌面「复制命令」按钮、手机键盘条同名按钮），规则保守：
// 只在能确定「这几行本是一条命令」时才拼，拿不准的一律保留换行。
//
// 分两层：
//  · 纯函数 continuationEdges / joinCommandRows —— 输入是行描述 {text, wrapped, full}，可单测；
//  · selectionAsCommand —— 从 xterm 的 buffer 读行描述，并把选区向上下扩到完整命令。

/** 向选区上下最多扩展多少行（防止一整屏都被当成一条命令）。 */
export const MAX_EXPAND_ROWS = 40;
/** 引号没闭合时，最多往后看几行找闭合处；找不到就不拼（散文里的撇号不该把整页拼起来）。 */
const MAX_QUOTE_SPAN_ROWS = 6;

// 一行以这些结尾，shell 语法上必然还没完：续行符、管道、&&、||、重定向。
// 管道/重定向要求前面是空白，免得把 `<div>` 之类当成重定向。
const TAIL_OPERATOR = /(?:\\|(?:^|\s)(?:\|\||\||&&|>>|>|<))$/;
// 一行以这些开头，必然是上一行的延续。单个 `|` 另判（见 startsWithOperator）。
const HEAD_OPERATOR = /^(?:&&|\|\||>>)(?:\s|$)/;
const HEAD_PIPE = /^\|(?!\|)\s/;

/**
 * @typedef {object} RowInfo
 * @property {string}  text    这一行的原文：只去掉「从没写过」的空单元格，**写过的空格保留**
 *                          （软换行拼接要保留恰好落在行尾的那个空格）
 * @property {boolean} wrapped xterm 的 isWrapped：终端确认这一行是上一行的软换行续行
 * @property {boolean} full    最后一列上有非空白字符（行被写满了，下一行可能是软换行的续行）
 */

const isBlank = (s) => s.trim() === '';
const indentOf = (s) => s.length - s.trimStart().length;

/**
 * 扫描 text，返回扫完时仍未闭合的引号（`'` / `"`），没有则 null。
 * shell 规则：单引号内没有转义；双引号内与引号外 `\` 转义下一个字符。
 */
function openQuoteAfter(text, quote = null) {
  let q = quote;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q === "'") {
      if (ch === "'") q = null;
    } else if (ch === '\\') {
      i++;
    } else if (q === '"') {
      if (ch === '"') q = null;
    } else if (ch === "'" || ch === '"') {
      q = ch;
    }
  }
  return q;
}

/** 行 prev 之后接 cur，在语法上是否「必然未完」：尾部运算符 / 头部运算符。 */
function operatorBridges(prev, cur) {
  if (isBlank(cur.text)) return false;
  const prevText = prev.text.trimEnd();
  const curText = cur.text.trimStart();
  // markdown 表格行（`| a | b |`）首尾都是 `|`，但不是管道命令
  const isTableRow = prevText.trimStart().startsWith('|');
  if (!isTableRow && TAIL_OPERATOR.test(prevText)) return true;
  if (HEAD_OPERATOR.test(curText)) return true;
  return HEAD_PIPE.test(curText) && !isTableRow;
}

/**
 * 逐对判断相邻两行之间是否应当拼接。
 * @param {RowInfo[]} rows
 * @returns {Array<null|'soft'|'space'>} edges[i] 描述 rows[i] → rows[i+1]：
 *   'soft'  软换行，原样首尾相接（折行处本来没有字符）；
 *   'space' 硬换行，折行吃掉了一个空格，拼回时补一个空格；
 *   null    不拼，保留换行。
 */
export function continuationEdges(rows) {
  const edges = new Array(Math.max(0, rows.length - 1)).fill(null);

  for (let i = 0; i + 1 < rows.length; i++) {
    const prev = rows[i];
    const cur = rows[i + 1];
    if (isBlank(cur.text) || isBlank(prev.text)) continue;
    if (cur.wrapped) {
      edges[i] = 'soft';
    } else if (prev.full && !/^\s/.test(cur.text)) {
      // tmux 丢了 isWrapped：上一行写满到最后一列、下一行顶格起笔，只能是被折开的同一行
      edges[i] = 'soft';
    } else if (operatorBridges(prev, cur)) {
      edges[i] = 'space';
    }
  }

  // 引号没闭合的行：ink 在词边界折行，把一个空格换成了换行。只有往后几行内能把引号闭合才拼。
  for (let i = 0; i + 1 < rows.length; i++) {
    let q = openQuoteAfter(rows[i].text);
    if (!q) continue;
    let closedAt = -1;
    for (let j = i + 1; j < rows.length && j <= i + MAX_QUOTE_SPAN_ROWS; j++) {
      if (isBlank(rows[j].text)) break;
      q = openQuoteAfter(rows[j].text, q);
      if (!q) { closedAt = j; break; }
    }
    for (let k = i; k < closedAt; k++) edges[k] ||= 'space';
  }
  return edges;
}

/** 'space' 拼接：去掉续行符，上一行去尾空白，下一行去缩进，中间一个空格。 */
function spaceJoin(prevText, curText) {
  const head = prevText.replace(/\s+$/, '').replace(/\\$/, '').replace(/\s+$/, '');
  return `${head} ${curText.trimStart()}`;
}

/**
 * 把若干行拼成可直接执行的文本：折行拼回一行，去掉公共缩进，其余换行保留。
 * 空行是分隔：不会跨空行拼接，也会去掉首尾空行。
 * @param {RowInfo[]} rows
 * @returns {string}
 */
export function joinCommandRows(rows) {
  const edges = continuationEdges(rows);
  /** @type {{indent:number, text:string}[]} */
  const lines = [];
  rows.forEach((row, i) => {
    if (i > 0 && edges[i - 1]) {
      const last = lines[lines.length - 1];
      last.text = edges[i - 1] === 'soft'
        ? last.text + row.text
        : spaceJoin(last.text, row.text);
    } else {
      lines.push({ indent: indentOf(row.text), text: row.text.trimStart() });
    }
  });

  while (lines.length && isBlank(lines[0].text)) lines.shift();
  while (lines.length && isBlank(lines[lines.length - 1].text)) lines.pop();
  const common = Math.min(...lines.filter((l) => !isBlank(l.text)).map((l) => l.indent));
  return lines
    .map((l) => (isBlank(l.text) ? '' : ' '.repeat(l.indent - common) + l.text.trimEnd()))
    .join('\n');
}

/**
 * 把 [a, b] 这段行向上下扩到完整的逻辑命令。
 * @param {RowInfo[]} rows 一个窗口内的全部行
 * @param {number} a 起始行（窗口内下标）
 * @param {number} b 结束行
 * @param {{up:boolean, down:boolean}} can 选区边界行是否允许向外扩
 * @returns {[number, number]}
 */
export function expandToCommand(rows, a, b, can = { up: true, down: true }) {
  const edges = continuationEdges(rows);
  let top = a;
  let bottom = b;
  // 选区内部不管有没有边，都算在内；只看选区外沿能不能继续往外连
  while (can.up && top > 0 && top > a - MAX_EXPAND_ROWS && edges[top - 1]) top--;
  while (can.down && bottom < rows.length - 1 && bottom < b + MAX_EXPAND_ROWS && edges[bottom]) bottom++;
  return [top, bottom];
}

// ── xterm 适配层 ──

/** 读 buffer 第 y 行的行描述。cols 是终端列数。 */
function readRow(buffer, y, cols) {
  const line = buffer.getLine(y);
  const cell = line.getCell(cols - 1);
  const chars = cell ? cell.getChars() : '';
  // 宽字符占两格，后一格 chars 为空且 width=0 —— 说明这一行也写到了最后一列
  const full = chars.trim() !== '' || (cell && chars === '' && cell.getWidth() === 0);
  return { text: line.translateToString(true), wrapped: line.isWrapped, full: !!full };
}

/** 按「列」（不是字符下标，宽字符占两列）截取第 y 行。 */
const sliceRow = (buffer, y, from, to) => buffer.getLine(y).translateToString(true, from, to);

/**
 * 以当前 xterm 选区为种子，取出「完整命令」文本；没有选区返回空串。
 * 选区的首/尾行如果被切掉的部分只有空白（缩进、行尾填充），视为整行选中，允许向外扩；
 * 切掉了实质内容就按用户划的范围来，不扩。
 * @param {import('@xterm/xterm').Terminal} term
 * @returns {string}
 */
export function selectionAsCommand(term) {
  const pos = term.getSelectionPosition();
  if (!pos) return '';
  const buffer = term.buffer.active;
  const cols = term.cols;
  const y1 = pos.start.y;
  const y2 = pos.end.y;
  const x1 = pos.start.x;
  // end.x 是独占的列；选区在行尾时它等于 cols
  const x2 = pos.end.x;

  const w0 = Math.max(0, y1 - MAX_EXPAND_ROWS);
  const w1 = Math.min(buffer.length - 1, y2 + MAX_EXPAND_ROWS);
  const rows = [];
  for (let y = w0; y <= w1; y++) rows.push(readRow(buffer, y, cols));

  const a = y1 - w0;
  const b = y2 - w0;
  const topRow = rows[a];
  const bottomRow = rows[b];
  const topBlankBefore = isBlank(sliceRow(buffer, y1, 0, x1));
  const bottomBlankAfter = isBlank(sliceRow(buffer, y2, x2, cols));

  const [top, bottom] = expandToCommand(rows, a, b, { up: topBlankBefore, down: bottomBlankAfter });
  const picked = rows.slice(top, bottom + 1);
  // 选区边界行：切掉的只是空白就取整行（上面已允许向外扩），切掉了实质内容就只取用户划的那一段
  const from = topBlankBefore ? 0 : x1;
  const to = bottomBlankAfter ? undefined : x2;
  if (a === b) {
    picked[a - top] = { ...topRow, text: sliceRow(buffer, y1, from, to) };
  } else {
    picked[a - top] = { ...topRow, text: sliceRow(buffer, y1, from) };
    picked[b - top] = { ...bottomRow, text: sliceRow(buffer, y2, 0, to) };
  }
  return joinCommandRows(picked);
}
