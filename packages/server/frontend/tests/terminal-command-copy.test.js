// 「复制为命令」的测试。三层：
//  1. 纯函数：真实输入输出，覆盖用户报告的那条 `mkdir … >>` 命令；
//  2. 真 xterm（jsdom）：真选区 → selectionAsCommand，验列/行坐标换算与向外扩展；
//  3. 真 tmux + node-pty + 真 xterm：把 bug 在真实链路上复现出来，再验修法。
//     tmux 用私有 socket（-L），不碰用户自己的 tmux 服务；没有 tmux / node-pty 时跳过。

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from '@xterm/xterm';
import { write } from './setup-jsdom.js';
import {
  continuationEdges, joinCommandRows, expandToCommand, selectionAsCommand, MAX_EXPAND_ROWS,
} from '../src/terminal-command-copy.js';

// 用户报告的原始命令（公钥按真实长度级别写，结尾 `>>` 之后被 ink 折行）
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyKeyDummyKeyDummyKeyDummyKey gsj@macbook-pro';
const COMMAND = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${KEY}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

/** 行描述的简写：硬换行、非软换行续行、没写满。 */
const row = (text, extra = {}) => ({ text, wrapped: false, full: false, ...extra });

describe('joinCommandRows：纯函数', () => {
  it('ink 硬换行 + 2 空格缩进：在 `>>` 处断开的命令拼回一行（用户报告的原样输入）', () => {
    const rows = [
      row(`  mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${KEY}' >>`),
      row('  ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'),
    ];
    expect(joinCommandRows(rows)).toBe(COMMAND);
  });

  it('尾部续行符：去掉反斜杠，拼成一个空格', () => {
    expect(joinCommandRows([
      row('  docker run --rm \\'),
      row('    -v $PWD:/w \\'),
      row('    alpine ls'),
    ])).toBe('docker run --rm -v $PWD:/w alpine ls');
  });

  it('尾部管道 / && / || 与头部 && / || / |：都拼回', () => {
    expect(joinCommandRows([row('  cat a.log |'), row('  grep ERR')])).toBe('cat a.log | grep ERR');
    expect(joinCommandRows([row('  make build &&'), row('  make test')])).toBe('make build && make test');
    expect(joinCommandRows([row('  make build'), row('  && make test')])).toBe('make build && make test');
    expect(joinCommandRows([row('  make build'), row('  || echo failed')])).toBe('make build || echo failed');
    expect(joinCommandRows([row('  cat a.log'), row('  | grep ERR')])).toBe('cat a.log | grep ERR');
  });

  it('引号内被折行：ink 在词边界折行吃掉了一个空格，闭合后补回一个空格', () => {
    const rows = [
      row(`  echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyKey`),
      row(`  gsj@macbook-pro' >> ~/.ssh/authorized_keys`),
    ];
    expect(joinCommandRows(rows)).toBe(`echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyKey gsj@macbook-pro' >> ~/.ssh/authorized_keys`);
  });

  it('软换行（xterm isWrapped）原样首尾相接，行尾空格保留', () => {
    expect(joinCommandRows([
      row('echo hello wor', { full: true }),
      row('ld again ', { wrapped: true, full: true }),
      row('and more', { wrapped: true }),
    ])).toBe('echo hello world again and more');
  });

  it('tmux 丢了 isWrapped：上一行写满、下一行顶格起笔 → 判为软换行直接相接', () => {
    expect(joinCommandRows([
      row("mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAA", { full: true }),
      row('AC3NzaC1lZDI1NTE5AAAAIDummyKey gsj@m', { full: true }),
      row("acbook-pro' >> ~/.ssh/authorized_keys"),
    ])).toBe("mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyKey gsj@macbook-pro' >> ~/.ssh/authorized_keys");
  });

  it('写满的行后面接缩进行：拿不准是不是同一条，不拼', () => {
    expect(joinCommandRows([
      row('ls /very/long/path/that/fills/the/whole/line/width', { full: true }),
      row('  next-command'),
    ])).toBe('ls /very/long/path/that/fills/the/whole/line/width\n  next-command');
  });

  it('互不相干的两行保留换行，只去公共缩进，相对缩进保留', () => {
    expect(joinCommandRows([
      row('    cd /tmp'),
      row('    ls -la'),
      row('      tail -f log'),
    ])).toBe('cd /tmp\nls -la\n  tail -f log');
  });

  it('空行是分隔：不跨空行拼接，首尾空行去掉', () => {
    expect(joinCommandRows([
      row(''),
      row('  make build &&'),
      row(''),
      row('  make test'),
      row('   '),
    ])).toBe('make build &&\n\nmake test');
  });

  it('不是命令延续的形状不乱拼：<div>、markdown 表格行、散文里的撇号', () => {
    expect(joinCommandRows([row('  <div>'), row('  <span>hi</span>')])).toBe('<div>\n<span>hi</span>');
    expect(joinCommandRows([row('  | a | b |'), row('  | 1 | 2 |')])).toBe('| a | b |\n| 1 | 2 |');
    // 撇号开了引号，但 6 行内没有闭合处 → 不拼
    const prose = [row("  it's the first line"), ...Array.from({ length: 7 }, (_, i) => row(`  line ${i}`))];
    expect(continuationEdges(prose).every((e) => e === null)).toBe(true);
  });

  it('宽字符（中文）行：full 由调用方按最后一列算好，这里只管拼接', () => {
    expect(joinCommandRows([
      row('echo 你好世界你好世界你好世界', { full: true }),
      row('再见'),
    ])).toBe('echo 你好世界你好世界你好世界再见');
  });
});

describe('expandToCommand', () => {
  const rows = [
    row('prompt $'),
    row('  mkdir -p a &&'),
    row('  cd a &&'),
    row('  ls'),
    row('done'),
  ];

  it('选区落在中间一行，向上下扩到完整命令', () => {
    expect(expandToCommand(rows, 2, 2)).toEqual([1, 3]);
  });

  it('can 关掉的方向不扩', () => {
    expect(expandToCommand(rows, 2, 2, { up: false, down: true })).toEqual([2, 3]);
    expect(expandToCommand(rows, 2, 2, { up: true, down: false })).toEqual([1, 2]);
  });

  it('向外扩展有上限，不会把一整屏当成一条命令', () => {
    const many = Array.from({ length: MAX_EXPAND_ROWS * 3 }, (_, i) => row(`step ${i} &&`));
    const [top, bottom] = expandToCommand(many, 60, 60);
    expect(60 - top).toBe(MAX_EXPAND_ROWS);
    expect(bottom - 60).toBe(MAX_EXPAND_ROWS);
  });
});

describe('selectionAsCommand：真 xterm 选区', () => {
  let term;
  afterEach(() => { term = null; });

  async function setup(text, cols = 60, rows = 12) {
    term = new Terminal({ cols, rows, allowProposedApi: true });
    term.open(document.createElement('div'));
    await write(term, text);
    return term;
  }

  const inkText = [
    `  mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${KEY}' >>`,
    '  ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
  ].join('\r\n');

  it('没有选区返回空串', async () => {
    await setup(inkText);
    expect(selectionAsCommand(term)).toBe('');
  });

  it('基线（bug 复现）：普通选区复制出来是两行、带缩进 —— 这是我们不动它的原因', async () => {
    await setup(inkText, 200);
    term.selectLines(0, 1);
    expect(term.getSelection()).toContain('>>\n  ~/.ssh/authorized_keys');
  });

  it('选中两行 → 一行可执行命令', async () => {
    await setup(inkText, 200);
    term.selectLines(0, 1);
    expect(selectionAsCommand(term)).toBe(COMMAND);
  });

  it('只选了第一行 / 只选了第二行（手机长按只能选一行）→ 向外扩到完整命令', async () => {
    await setup(inkText, 200);
    term.selectLines(0, 0);
    expect(selectionAsCommand(term)).toBe(COMMAND);
    term.selectLines(1, 1);
    expect(selectionAsCommand(term)).toBe(COMMAND);
  });

  it('桌面拖选：从 `mkdir` 的 m 拖到 authorized_keys 末尾（切掉的只有缩进）→ 仍扩成完整命令', async () => {
    await setup(inkText, 200);
    // 第 0 行从列 2（m）起，第 1 行选到行尾
    term.select(2, 0, (200 - 2) + '  ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'.length);
    expect(selectionAsCommand(term)).toBe(COMMAND);
  });

  it('桌面拖选只划了一段实质内容 → 就是那一段，不向外扩', async () => {
    await setup(inkText, 200);
    const start = inkText.indexOf('chmod 700');
    term.select(start, 0, 'chmod 700 ~/.ssh'.length);
    expect(selectionAsCommand(term)).toBe('chmod 700 ~/.ssh');
  });

  it('选区下一行是别的命令：不乱扩', async () => {
    await setup('  cd /tmp\r\n  ls -la\r\n', 60);
    term.selectLines(0, 0);
    expect(selectionAsCommand(term)).toBe('cd /tmp');
  });

  it('终端自己折行（isWrapped）的长命令，拼回一行', async () => {
    await setup(COMMAND, 50);
    term.selectLines(0, 2);
    expect(selectionAsCommand(term)).toBe(COMMAND);
  });

  it('宽字符：中文命令在最后一列折行', async () => {
    const cmd = `echo ${'你好世界'.repeat(10)} done`;
    await setup(cmd, 30);
    term.selectLines(0, 2);
    expect(selectionAsCommand(term)).toBe(cmd);
  });
});

// ── 真 tmux 链路 ──
const require = createRequire(import.meta.url);
const SOCKET = `vacopy${process.pid}`;
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haveTmuxAndPty() {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); require.resolve('node-pty'); return true; } catch { return false; }
}

describe.skipIf(!haveTmuxAndPty())('真 tmux + node-pty + xterm：复现并验证修法', () => {
  const COLS = 60;
  const ROWS = 14;
  let pty;
  let proc;
  let t;
  let dir;
  let dataSub;

  /**
   * 起一个 tmux 会话，让它原样输出 text（经文件 cat，避开 shell 引号），再接 tail 命令；
   * 用 pty attach，把 tmux 画出来的字节喂给真 xterm。
   */
  async function attach(text, tail = '') {
    pty = require('node-pty');
    dir = mkdtempSync(join(tmpdir(), 'va-cmdcopy-'));
    const file = join(dir, 'out.txt');
    writeFileSync(file, text);
    tmux('new-session', '-d', '-s', 's', '-x', String(COLS), '-y', String(ROWS),
      `cat ${file}; ${tail}; sleep 60`);
    proc = pty.spawn('tmux', ['-L', SOCKET, 'attach-session', '-t', 's'], {
      cols: COLS, rows: ROWS, env: { ...process.env, TERM: 'xterm-256color' },
    });
    t = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    t.open(document.createElement('div'));
    dataSub = proc.onData((d) => t.write(d));
    await sleep(1200);
  }

  const rowText = (y) => t.buffer.active.getLine(y).translateToString(true);
  const findRow = (needle) => {
    for (let y = 0; y < ROWS; y++) if (rowText(y).includes(needle)) return y;
    throw new Error(`屏幕上找不到 ${needle}：\n${Array.from({ length: ROWS }, (_, y) => rowText(y)).join('\n')}`);
  };

  afterEach(() => {
    dataSub?.dispose();
    try { proc?.kill(); } catch { /* 已退出 */ }
    try { tmux('kill-server'); } catch { /* 没起来 */ }
    proc = t = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('(b) ink 硬换行+缩进：实时视图下 isWrapped 为 false、续行带缩进；复制命令得到一行', async () => {
    // ink 折好的输出：每行都不超过窗口宽度、词边界断开、2 空格缩进、真换行
    const l1 = "  echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyKey";
    const l2 = "  gsj@macbook-pro' >> ~/.ssh/authorized_keys &&";
    const l3 = '  chmod 600 ~/.ssh/authorized_keys';
    await attach(`${l1}\n${l2}\n${l3}\n`);
    const y = findRow('echo');
    expect(t.buffer.active.getLine(y + 1).isWrapped).toBe(false);
    expect(rowText(y + 1).startsWith('  gsj@')).toBe(true);

    t.selectLines(y, y + 2);
    expect(t.getSelection()).toContain("\n  gsj@macbook-pro'");   // 普通复制：断行 + 缩进（bug）
    expect(selectionAsCommand(t)).toBe(
      "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyKey gsj@macbook-pro' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
    );
  });

  it('(a) 实时视图：tmux 保留 isWrapped，普通复制本来就是一行', async () => {
    await attach(`${COMMAND}\n`);
    const y = findRow('mkdir');
    expect(t.buffer.active.getLine(y + 1).isWrapped).toBe(true);
    t.selectLines(y, y + 3);
    expect(t.getSelection()).toBe(COMMAND);
    expect(selectionAsCommand(t)).toBe(COMMAND);
  });

  it('(a) copy-mode（往上滚历史）：tmux 重绘丢了 isWrapped，普通复制断成多行带填充；复制命令拼回一行', async () => {
    await attach(`head1\nhead2\n${COMMAND}\n`, 'seq 1 40');
    tmux('copy-mode', '-t', 's');
    tmux('send-keys', '-t', 's', '-X', '-N', '100', 'scroll-up');
    await sleep(800);
    // copy-mode 在视图第一行右上角盖了位置指示（如 `[44/44]`），所以命令前垫两行，让它不落在第一行
    const y = findRow('mkdir');
    expect(y).toBeGreaterThan(0);
    for (let k = 0; k < 3; k++) {
      expect(t.buffer.active.getLine(y + k).isWrapped).toBe(false);   // 标记确实丢了
    }
    t.selectLines(y, y + 3);
    expect(t.getSelection().split('\n').length).toBeGreaterThanOrEqual(4);   // 普通复制：断成多行（bug）
    expect(selectionAsCommand(t)).toBe(COMMAND);
    // 只选中间一行也能向两边扩出完整命令
    t.selectLines(y + 1, y + 1);
    expect(selectionAsCommand(t)).toBe(COMMAND);
  });
});
