const assert = require('node:assert');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const {
  PtyManager, buildSplitWindowArgs, buildSelectPaneArgs, buildKillPaneArgs,
  buildScrollToBottomArgs, buildLoginShellCommand,
  tmuxName, tmuxPaneCount, sanitizeTmuxName,
} = require('../lib/pty-manager');

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

test('sanitizeTmuxName 清洗 tmux 非法字符（. : 空白 → -）', () => {
  assert.strictEqual(sanitizeTmuxName('my.proj:a b'), 'my-proj-a-b');
  assert.strictEqual(sanitizeTmuxName('  trim  '), 'trim');
  assert.strictEqual(sanitizeTmuxName('中文项目'), '中文项目');
  assert.strictEqual(sanitizeTmuxName(':::'), '');
});

test('renameTmuxSession 真改 tmux 名；旧名消失、新名存在', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const old = `vibe-rn-${process.pid}`;
  const neo = `vibe-rn2-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', old], { stdio: 'ignore' });
  spawnSync('tmux', ['kill-session', '-t', neo], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', old, 'sleep 600'], { stdio: 'ignore' });
  const pm = new PtyManager();
  try {
    const r = pm.renameTmuxSession(old, neo);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.newTmuxName, neo);
    assert.strictEqual(spawnSync('tmux', ['has-session', '-t', neo], { stdio: 'ignore' }).status, 0);
    assert.notStrictEqual(spawnSync('tmux', ['has-session', '-t', old], { stdio: 'ignore' }).status, 0);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', old], { stdio: 'ignore' });
    spawnSync('tmux', ['kill-session', '-t', neo], { stdio: 'ignore' });
  }
});

test('renameTmuxSession 重名被拒绝', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const a = `vibe-rnA-${process.pid}`;
  const b = `vibe-rnB-${process.pid}`;
  for (const n of [a, b]) {
    spawnSync('tmux', ['kill-session', '-t', n], { stdio: 'ignore' });
    spawnSync('tmux', ['new-session', '-d', '-s', n, 'sleep 600'], { stdio: 'ignore' });
  }
  const pm = new PtyManager();
  try {
    const r = pm.renameTmuxSession(a, b); // b 已存在
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /已存在/);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', a], { stdio: 'ignore' });
    spawnSync('tmux', ['kill-session', '-t', b], { stdio: 'ignore' });
  }
});

test('renameTmuxSession 会话不存在返回错误', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const pm = new PtyManager();
  const r = pm.renameTmuxSession(`vibe-nonexistent-${process.pid}`, 'whatever');
  assert.strictEqual(r.ok, false);
});

test('tmuxPaneCount 随分屏增减', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-split-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 600'], { stdio: 'ignore' });
  try {
    assert.strictEqual(tmuxPaneCount(name), 1);
    // 纵向分屏 → 2 个 pane
    spawnSync('tmux', ['split-window', '-v', '-t', name, 'sleep 600'], { stdio: 'ignore' });
    assert.strictEqual(tmuxPaneCount(name), 2);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('tmuxName 对不存在的 sessionId 套 cc- 前缀并清洗非法字符', () => {
  assert.strictEqual(tmuxName('new-claude-123'), 'cc-new-claude-123');
});

test('tmuxName 保留非 ASCII —— 中文前缀不再和同名 ASCII 会话撞进同一个 tmux 窗口', () => {
  const uniq = `vibe-name-${process.pid}`;
  assert.strictEqual(tmuxName(`多${uniq}`), `cc-多${uniq}`);
  assert.notStrictEqual(tmuxName(`多${uniq}`), tmuxName(uniq),
    '剥掉非 ASCII 会让两个 sessionId 落到同一个窗口，尺寸互相拽');
});

test('同一个 tmux 窗口的两个 sessionId 共用一条 PTY', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const base = `vibe-alias-${process.pid}`;
  const alias = `cc-${base}`;          // tmuxName(base) 的结果；反过来 tmuxName(alias) 命中已存在会话也是它
  spawnSync('tmux', ['kill-session', '-t', alias], { stdio: 'ignore' });
  const mgr = new PtyManager();
  try {
    const first = mgr.create(base, { cols: 100, rows: 30, command: ['sleep', '600'], onData: () => {} });
    assert.strictEqual(first.isNew, true);

    const second = mgr.create(alias, { cols: 100, rows: 30, command: ['sleep', '600'], onData: () => {} });
    assert.strictEqual(second.isNew, false, '第二个 sessionId 必须复用，不能再 attach 一个客户端');
    assert.strictEqual(mgr._sessions.get(base), mgr._sessions.get(alias), '两个 sessionId 指向同一个 state');
    assert.strictEqual(mgr._sessions.get(base).onDataCallbacks.size, 2,
      '别名接入是新增回调，不能把对方的回调清掉');

    // 关掉其中一个别名：另一个还在看，PTY 不能断
    const shared = mgr._sessions.get(alias);
    mgr.destroy(base);
    assert.strictEqual(mgr._sessions.get(alias), shared, '还有引用就不能摘掉');
    assert.strictEqual(shared.onDataCallbacks.size, 1);

    mgr.destroy(alias);
    assert.strictEqual(mgr._sessions.size, 0);
    assert.strictEqual(mgr._byTmuxName.size, 0);
  } finally {
    mgr.destroyAll();
    spawnSync('tmux', ['kill-session', '-t', alias], { stdio: 'ignore' });
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

// 半路加入的观众必须拿到 tmux 的终端初始化（进 alternate screen）。拿不到时 xterm 停在
// 普通缓冲区，滚轮翻的是 xterm 自己的 scrollback，看到的是错行的内容而不是 tmux 的历史。
test('第二个观众接入已开着的 PTY：换新 attach 客户端，两个观众都收到 alternate screen 初始化', { skip: hasTmux ? false : 'tmux 不可用' }, async () => {
  const id = `vibe-join-${process.pid}`;
  const name = `cc-${id}`;
  const SMCUP = '\x1b[?1049h';
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  const mgr = new PtyManager();
  const clients = () => spawnSync('tmux', ['list-clients', '-t', name, '-F', '#{client_pid}'], { encoding: 'utf8' })
    .stdout.trim().split('\n').filter(Boolean);
  let firstOut = '';
  let secondOut = '';
  let exits = 0;
  try {
    mgr.create(id, {
      cols: 100, rows: 30, command: ['sleep', '600'],
      onData: (d) => { firstOut += d; }, onExit: () => { exits++; },
    });
    assert.ok(await waitFor(() => firstOut.includes(SMCUP)), '首个观众没收到 attach 初始化');
    const firstClients = clients();
    assert.strictEqual(firstClients.length, 1);
    firstOut = '';

    // 同一个 tmux 窗口的别名接入（另一个浏览器 / 另一个 sessionId 指向同一窗口）
    const r = mgr.create(name, { cols: 100, rows: 30, onData: (d) => { secondOut += d; } });
    assert.strictEqual(r.isNew, false);
    assert.ok(await waitFor(() => secondOut.includes(SMCUP)), '后加入的观众没收到 alternate screen 初始化');
    assert.ok(firstOut.includes(SMCUP), '原观众也要拿到同一份重新初始化，两边画面一致');

    // 旧客户端退场：tmux 上始终只有一个 dashboard 客户端，旧客户端的退出不能把 state 摘掉
    assert.ok(await waitFor(() => {
      const now = clients();
      return now.length === 1 && now[0] !== firstClients[0];
    }), `旧 attach 客户端没退出：${clients().join(',')}`);
    await sleep(200);
    assert.ok(mgr._sessions.has(id) && mgr._sessions.has(name), '旧客户端退出把共享的 state 摘掉了');
    assert.strictEqual(exits, 0, '旧客户端退出不能当成会话断开通知出去');

    // 新客户端仍然是活的输出通道
    secondOut = '';
    mgr.resize(id, 90, 30);              // 改尺寸逼 tmux 整屏重绘
    assert.ok(await waitFor(() => secondOut.length > 0), '换客户端后收不到输出');
  } finally {
    mgr.destroyAll();
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('窗口高度扣掉 tmux 状态栏 —— 与 tmux 自己的计算一致', { skip: hasTmux ? false : 'tmux 不可用' }, async () => {
  const id = `vibe-status-${process.pid}`;
  const name = `cc-${id}`;
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  const mgr = new PtyManager();
  const winHeight = () =>
    Number(spawnSync('tmux', ['display', '-p', '-t', name, '#{window_height}'], { encoding: 'utf8' }).stdout.trim());
  try {
    mgr.create(id, { cols: 100, rows: 30, command: ['sleep', '600'], onData: () => {} });
    const attached = await waitFor(() =>
      spawnSync('tmux', ['list-clients', '-t', name, '-F', 'x'], { encoding: 'utf8' }).stdout.trim() !== '');
    assert.ok(attached, 'attach 客户端没起来，本用例失去意义');

    mgr.resize(id, 100, 30);            // 生产路径：pty 30 行 + resize-window
    const ours = winHeight();

    // tmux 按同一个客户端自己算一遍（它会扣掉状态栏）——两者必须相等
    spawnSync('tmux', ['resize-window', '-A', '-t', name]);
    await sleep(300);
    const tmuxAuto = winHeight();

    assert.strictEqual(ours, tmuxAuto,
      `窗口高度与 tmux 的计算不一致（ours=${ours} tmux=${tmuxAuto}）：` +
      '窗口比客户端能显示的区域高一截时，往上翻会整屏错位');
    assert.ok(ours < 30, '客户端 30 行、状态栏占 1 行，窗口不可能还是 30 行');
  } finally {
    mgr.destroyAll();
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('tmuxName 复用已存在的手动 tmux 会话名（不加 cc- 前缀）', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-ptyname-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 600'], { stdio: 'ignore' });
  try {
    assert.strictEqual(tmuxName(name), name);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('buildSplitWindowArgs maps split directions to tmux flags', () => {
  const cases = [
    { direction: 'up', expected: ['split-window', '-v', '-b'] },
    { direction: 'down', expected: ['split-window', '-v'] },
    { direction: 'left', expected: ['split-window', '-h', '-b'] },
    { direction: 'right', expected: ['split-window', '-h'] },
  ];

  for (const { direction, expected } of cases) {
    const args = buildSplitWindowArgs('sess-1', {
      direction,
      cwd: '/workspace/app',
    });

    assert.deepStrictEqual(
      args.slice(0, expected.length),
      expected,
      `unexpected tmux flags for ${direction}`
    );
    assert.strictEqual(args[args.indexOf('-t') + 1], tmuxName('sess-1'));
    assert.strictEqual(args[args.indexOf('-c') + 1], '/workspace/app');
  }
});

test('buildSplitWindowArgs includes command context when provided', () => {
  const args = buildSplitWindowArgs('sess-1', {
    direction: 'right',
    cwd: '/workspace/app',
    command: ['claude', '--resume', 'abc123'],
    defaultShell: '/bin/zsh',
  });

  const shellCommand = args.at(-1);
  // 外层固定 bash：正文是 POSIX 语法，用户的 $SHELL 可能是 fish 之类解析不了的
  assert.match(shellCommand, /^bash -l -c /);
  assert.match(shellCommand, /claude/);
  assert.match(shellCommand, /--resume/);
  assert.match(shellCommand, /abc123/);
  // 命令退出后必须落到交互式登录 shell（而非 exec 替换掉直接消失），且落的是用户自己的 shell。
  // 整段脚本外面还包了一层引号，所以先让真 shell 还原出 bash 实际收到的正文再断言。
  assert.match(argvSeenByBash(shellCommand)[0], /exec '\/bin\/zsh' -l$/, '命令退出后应 exec 到用户的登录 shell');
});

// ── 启动命令的引号组装 ──
// 旧写法把已经加过引号的参数直接拼进一对外层单引号里，靠相邻引号段首尾粘连才碰巧成立；
// 只要任何一个参数或 cwd 里带空格，粘连就断在那个空格上，后面的 `;` 从字面量变成真正的
// 命令分隔符，整条命令被腰斩（实测：cwd 带空格时 `cd` 报错、`&&` 短路，用户点的命令
// 根本没启动，人直接掉进一个 login shell）。下面这几条钉的就是
// 「整段脚本必须是 bash 收到的**唯一一个** argv 词」。

/** 把 `bash -l -c <script>` 交给真 shell 分词，返回 bash 实际会拿到的 argv（不含 bash 自己）。 */
function argvSeenByBash(shellCommand) {
  const probe = shellCommand.replace(/^bash -l -c /, "printf '%s@@' -- ");
  const r = spawnSync('/bin/sh', ['-c', probe], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `真 shell 解析失败: ${r.stderr}`);
  return r.stdout.split('@@').slice(1, -1);   // 去掉哨兵 '--' 与尾部空串
}

test('buildLoginShellCommand：cwd 带空格时整段脚本仍只是一个 argv 词', () => {
  const cmd = buildLoginShellCommand(['zsh'], { cwd: '/tmp/带 空格 目录', defaultShell: '/bin/zsh' });
  const argv = argvSeenByBash(cmd);
  assert.strictEqual(argv.length, 1, `脚本被拆成了 ${argv.length} 个词：${JSON.stringify(argv)}`);
  // cd 的目标必须整体带引号，否则 `cd /tmp/带` 失败、&& 短路掉用户真正要跑的命令
  assert.match(argv[0], /cd '\/tmp\/带 空格 目录' && /);
});

test('buildLoginShellCommand：参数带空格不许把命令腰斩', () => {
  const cmd = buildLoginShellCommand(
    ['claude', '--append-system-prompt', 'be nice; echo PWNED'],
    { cwd: '/tmp/x', defaultShell: '/bin/zsh' }
  );
  const argv = argvSeenByBash(cmd);
  assert.strictEqual(argv.length, 1, `脚本被拆成了 ${argv.length} 个词：${JSON.stringify(argv)}`);
  assert.match(argv[0], /'be nice; echo PWNED'/, '带空格的参数应整体留在一个引号段里');
});

test('buildLoginShellCommand：参数带单引号也能原样还原', () => {
  const cmd = buildLoginShellCommand(['codex', '-c', "model='o3'"], { cwd: '/tmp/y', defaultShell: '/bin/zsh' });
  const argv = argvSeenByBash(cmd);
  assert.strictEqual(argv.length, 1);
  // 再让 shell 把内层脚本分一次词，确认 codex 会拿到原样的第三个参数
  const inner = spawnSync('/bin/sh', ['-c',
    argv[0].replace(/^.*&& /, "printf '%s@@' ").replace(/; exec .*$/, '')
  ], { encoding: 'utf8' });
  assert.strictEqual(inner.status, 0, inner.stderr);
  assert.deepStrictEqual(inner.stdout.split('@@').slice(0, 3), ['codex', '-c', "model='o3'"]);
});

test('buildLoginShellCommand：claude 自动补 --dangerously-skip-permissions，且不重复补', () => {
  assert.match(buildLoginShellCommand(['claude'], {}), /--dangerously-skip-permissions/);
  const once = buildLoginShellCommand(['claude', '--dangerously-skip-permissions'], {});
  assert.strictEqual(once.match(/--dangerously-skip-permissions/g).length, 1);
});

test('buildLoginShellCommand：没有命令时返回 null（不生成半截脚本）', () => {
  assert.strictEqual(buildLoginShellCommand(undefined, { cwd: '/tmp' }), null);
  assert.strictEqual(buildLoginShellCommand([], { cwd: '/tmp' }), null);
});

test('新建会话与分屏共用同一个构造器：同样的 command/cwd 生成同样的脚本', () => {
  const fromSplit = buildSplitWindowArgs('sess-x', {
    direction: 'right',
    cwd: '/workspace/app',
    command: ['codex'],
    defaultShell: '/bin/zsh',
  }).at(-1);
  const direct = buildLoginShellCommand(['codex'], { cwd: '/workspace/app', defaultShell: '/bin/zsh' });
  assert.strictEqual(fromSplit, direct, 'split 与新建会话必须共用同一份命令构造逻辑');
});

test('含空格的工作目录：真 tmux 起会话后确实落在那个目录里', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const dir = `/tmp/vibe space dir ${process.pid}`;
  const name = `vibe-space-${process.pid}`;
  spawnSync('mkdir', ['-p', dir]);
  // macOS 的 /tmp 是指向 /private/tmp 的软链，tmux 报的是 realpath，比对前先归一
  const realDir = require('node:fs').realpathSync(dir);
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  try {
    const script = buildLoginShellCommand(['zsh'], { cwd: dir, defaultShell: '/bin/zsh' });
    const r = spawnSync('tmux', ['new-session', '-d', '-s', name, '-x', '100', '-y', '20', script], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    // pane 的 cwd 由里面那层 shell 决定，起会话后要等它真的 cd 过去，所以轮询而不是读一次
    let cur = '';
    for (let i = 0; i < 60; i++) {
      cur = spawnSync('tmux', ['display-message', '-p', '-t', name, '#{pane_current_path}'], { encoding: 'utf8' }).stdout.trim();
      if (cur === realDir) break;
      spawnSync('sleep', ['0.25']);
    }
    assert.strictEqual(cur, realDir, 'pane 应落在含空格的目标目录，而不是被 cd 截断后掉回别处');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
    spawnSync('rmdir', [dir]);
  }
});

// ── 分屏工具条：切换焦点 / 删除当前分屏 ──
// 顶栏那五个按钮（↑↓←→ 切焦点 + ✕ 删分屏）打到的就是这两个方法。

test('buildSelectPaneArgs 四个方向映射到 tmux 的 -U/-D/-L/-R', () => {
  assert.deepStrictEqual(buildSelectPaneArgs('s1', 'up'), ['select-pane', '-t', tmuxName('s1'), '-U']);
  assert.deepStrictEqual(buildSelectPaneArgs('s1', 'down'), ['select-pane', '-t', tmuxName('s1'), '-D']);
  assert.deepStrictEqual(buildSelectPaneArgs('s1', 'left'), ['select-pane', '-t', tmuxName('s1'), '-L']);
  assert.deepStrictEqual(buildSelectPaneArgs('s1', 'right'), ['select-pane', '-t', tmuxName('s1'), '-R']);
});

test('buildSelectPaneArgs 拒绝未知方向（别把 split 的标志混进来）', () => {
  assert.throws(() => buildSelectPaneArgs('s1', 'sideways'), /Unsupported select direction/);
  assert.throws(() => buildSelectPaneArgs('s1', undefined), /Unsupported select direction/);
  // split 用 -v/-h，select 用 -U/-D/-L/-R，两套不能互换
  assert.notDeepStrictEqual(buildSelectPaneArgs('s1', 'down'), buildSplitWindowArgs('s1', { direction: 'down' }));
});

test('buildKillPaneArgs 打到当前活动 pane', () => {
  assert.deepStrictEqual(buildKillPaneArgs('s1'), ['kill-pane', '-t', tmuxName('s1')]);
});

test('killPane 在只剩一个窗格时拒绝（否则等于把整个会话连同进程一起杀掉）', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-kp1-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 600'], { stdio: 'ignore' });
  const pm = new PtyManager();
  try {
    assert.strictEqual(tmuxPaneCount(name), 1);
    assert.throws(() => pm.killPane(name), /只有一个窗格/);
    // 关键：拒绝之后会话必须还活着
    assert.strictEqual(spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status, 0);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('selectPane 真的挪动焦点；killPane 删掉分屏后窗格数回到 1', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-sp-${process.pid}`;
  const activeIndex = () => spawnSync(
    'tmux', ['display-message', '-p', '-t', name, '#{pane_index}'], { encoding: 'utf8' },
  ).stdout.trim();

  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 600'], { stdio: 'ignore' });
  const pm = new PtyManager();
  try {
    pm.split(name, { direction: 'down', cwd: process.cwd(), command: 'sleep 600' });
    assert.strictEqual(tmuxPaneCount(name), 2);
    // 新切出来的窗格成为活动窗格
    const afterSplit = activeIndex();
    assert.strictEqual(afterSplit, '1');

    pm.selectPane(name, { direction: 'up' });
    assert.strictEqual(activeIndex(), '0', '向上切换应回到原窗格');

    pm.selectPane(name, { direction: 'down' });
    assert.strictEqual(activeIndex(), '1', '再向下切换应回到新窗格');

    // tmux 的 select-pane 到边界是**回绕**的，不是停住 —— 一路按 ↓ 能轮着看完所有窗格。
    // （这条断言原本按「原地不动」写，被真 tmux 打脸，故记录真实行为。）
    pm.selectPane(name, { direction: 'down' });
    assert.strictEqual(activeIndex(), '0', '已在最下方，继续向下回绕到第一个窗格');

    pm.killPane(name);
    assert.strictEqual(tmuxPaneCount(name), 1, '删掉分屏后只剩一个窗格');
    assert.strictEqual(spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status, 0,
      '删的是分屏不是会话，会话必须还在');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('selectPane / killPane 对不存在的会话报错', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const pm = new PtyManager();
  const missing = `vibe-nope-${process.pid}`;
  assert.throws(() => pm.selectPane(missing, { direction: 'up' }), /tmux session not found/);
  assert.throws(() => pm.killPane(missing), /tmux session not found/);
});

// ── 回到最新输出（跳到最底部）──
//
// 终端里跑的是 tmux attach，往上滚历史时 tmux 进 copy-mode，视图从此钉在历史上。
// 浏览器那边 term.scrollToBottom() 对它无效（内容在 alternate screen，xterm 自己的
// scrollback 是空的），只有让 tmux 退出 copy-mode 才回得来 —— 这组用例守的就是这条路。
//
// 下面几条全部打在**真 tmux** 上：copy-mode 的状态（pane_in_mode）没法用替身伪造，
// 而这个功能的全部价值就在于「那个状态真的被清掉了」。

test('buildScrollToBottomArgs 用 copy-mode -q 打到当前活动 pane', () => {
  assert.deepStrictEqual(buildScrollToBottomArgs('s1'), ['copy-mode', '-q', '-t', tmuxName('s1')]);
  // -q 是 cancel（退出模式）。漏掉它就变成「进入 copy-mode」，效果正好相反。
  assert.ok(buildScrollToBottomArgs('s1').includes('-q'), '缺 -q 会变成进入复制模式');
});

test('scrollToBottom 把滚到顶的窗格拉回最新输出', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-sb-${process.pid}`;
  const inMode = () => spawnSync(
    'tmux', ['display-message', '-p', '-t', name, '#{pane_in_mode}'], { encoding: 'utf8' },
  ).stdout.trim();

  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', name, '-x', '80', '-y', '24', 'sleep 600'], { stdio: 'ignore' });
  const pm = new PtyManager();
  try {
    // 造出「用户滚上去了」的真实状态：进 copy-mode 并跳到历史最顶端
    spawnSync('tmux', ['copy-mode', '-t', name], { stdio: 'ignore' });
    spawnSync('tmux', ['send-keys', '-X', '-t', name, 'history-top'], { stdio: 'ignore' });
    assert.strictEqual(inMode(), '1', '前置条件：窗格应处于 copy-mode');

    pm.scrollToBottom(name);
    assert.strictEqual(inMode(), '0', 'copy-mode 没退出 = 用户仍然回不到底部');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('已经在底部时 scrollToBottom 是空操作，不报错', { skip: hasTmux ? false : 'tmux 不可用' }, () => {
  const name = `vibe-sb2-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 600'], { stdio: 'ignore' });
  const pm = new PtyManager();
  try {
    // 没进过 copy-mode。按钮是常驻的，这条路每次点都会走到，绝不能报错
    assert.doesNotThrow(() => pm.scrollToBottom(name));
    assert.doesNotThrow(() => pm.scrollToBottom(name), '连点两次同样要无害');
    // 会话必须还活着 —— 这个操作只动视图，不碰进程
    assert.strictEqual(spawnSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' }).status, 0);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
  }
});

test('scrollToBottom 对不存在的会话明确报错，而不是静默成功', () => {
  const pm = new PtyManager();
  assert.throws(() => pm.scrollToBottom(`vibe-nope-${process.pid}`), /tmux session not found/);
});
