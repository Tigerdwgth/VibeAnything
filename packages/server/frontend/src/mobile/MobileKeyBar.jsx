import { KEY_SEQUENCES } from './key-sequences';
import { SLASH_COMMANDS } from '../slash-commands';

// 手机版终端的常用按键工具条。
//
// 单行 + 横向滚动：小屏上多行堆叠会被视口截断，用户根本够不着下面那排（2026-03-18 踩过）。
// 每个按钮 onPointerDown 里 preventDefault —— 不这么做，按下时焦点会从输入框跑掉，
// 手机上表现为「点一下方向键，键盘就收了」。

const btnBase = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.18)',
  color: '#e6edf3',
  borderRadius: '8px',
  cursor: 'pointer',
  padding: '0 10px',
  fontSize: '1rem',
  fontFamily: 'monospace',
  // 44px 是 Apple HIG 的最小可点区域，再小手指点不准
  minHeight: '44px',
  minWidth: '44px',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  userSelect: 'none', WebkitUserSelect: 'none',
  flexShrink: 0,
};

function KeyButton({ label, title, onClick, tone }) {
  return (
    <button
      type="button"
      title={title || label}
      aria-label={title || label}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{ ...btnBase, ...(tone || {}) }}
    >{label}</button>
  );
}

const TONE_ENTER = { color: '#58a6ff', borderColor: 'rgba(88,166,255,0.45)', background: 'rgba(88,166,255,0.12)' };
const TONE_RESUME = { color: '#3fb950', borderColor: 'rgba(63,185,80,0.45)', background: 'rgba(63,185,80,0.12)', fontSize: '0.8rem' };
const TONE_DANGER = { color: '#f87171', borderColor: 'rgba(248,113,113,0.45)' };
const TONE_TEXT = { fontSize: '0.78rem' };
const TONE_ACTIVE = { color: '#f0b72f', borderColor: 'rgba(240,183,47,0.6)', background: 'rgba(240,183,47,0.12)' };

const Divider = () => (
  <div style={{ width: '1px', background: 'rgba(255,255,255,0.12)', alignSelf: 'stretch', margin: '4px 2px', flexShrink: 0 }} />
);

/**
 * @param {(text: string) => void} props.onSendText 直接发字节给 PTY
 * @param {() => void} props.onSendLine    发送输入框内容 + 回车（空框 = 只发回车）
 * @param {() => void} props.onPickImage   打开相册选图
 * @param {() => void} props.onScrollToBottom 回到最新输出（退出 tmux copy-mode）
 * @param {() => void} props.onCopyAll     复制选中内容，无选中则复制整个终端缓冲
 * @param {() => void} props.onCopyCommand 把选中行所在的命令拼成一行再复制（去缩进、拼回折断的行）
 * @param {() => void} props.onPaste       把剪贴板内容敲进终端（读不到剪贴板时弹手动粘贴面板）
 * @param {(cmd: string) => void} props.onSlashCommand 发一条斜杠命令（/clear、/compact）
 * @param {boolean} props.directKeyboard   当前是否处于「按键直达终端」模式
 * @param {() => void} props.onToggleDirectKeyboard
 */
export default function MobileKeyBar({
  onSendText, onSendLine, onPickImage, onCopyAll, onCopyCommand, onPaste, onSlashCommand, onScrollToBottom,
  directKeyboard, onToggleDirectKeyboard,
}) {
  const send = (seq) => () => onSendText(seq);
  return (
    <div
      style={{
        display: 'flex', gap: '6px',
        padding: '6px 8px',
        // 底部横条（iPhone 的 home indicator）不能压住工具条
        paddingBottom: 'calc(6px + var(--safe-bottom))',
        paddingLeft: 'calc(8px + var(--safe-left))',
        paddingRight: 'calc(8px + var(--safe-right))',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        background: '#0d1117',
        flexShrink: 0,
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <KeyButton label="Esc" title="Escape" onClick={send(KEY_SEQUENCES.esc)} tone={TONE_TEXT} />
      <KeyButton label="⇥" title="Tab" onClick={send(KEY_SEQUENCES.tab)} />
      <KeyButton label="↑" title="上方向键" onClick={send(KEY_SEQUENCES.up)} />
      <KeyButton label="↓" title="下方向键" onClick={send(KEY_SEQUENCES.down)} />
      <KeyButton label="←" title="左方向键" onClick={send(KEY_SEQUENCES.left)} />
      <KeyButton label="→" title="右方向键" onClick={send(KEY_SEQUENCES.right)} />
      {/* 手指往上滑看历史之后，tmux 停在 copy-mode 就不跟新输出了；方向键是发给程序的
          按键，回不到底部。这个按钮走 tmux 控制通路，一步跳回最新。 */}
      <KeyButton label="⤓" title="回到最新输出（退出 tmux 复制模式，跳到最底部）" onClick={onScrollToBottom} tone={TONE_ENTER} />
      <KeyButton label="^C" title="Ctrl+C（中断当前命令）" onClick={send(KEY_SEQUENCES.ctrlC)} tone={TONE_DANGER} />
      <KeyButton label="⏎" title="回车：发送输入框内容（空框 = 发一个回车）" onClick={onSendLine} tone={TONE_ENTER} />
      <KeyButton label="继续" title="向终端发送「继续」+ 回车" onClick={send(KEY_SEQUENCES.resume)} tone={TONE_RESUME} />
      <Divider />
      {/* 斜杠命令与桌面版同一份实现（slash-commands.js）：先 Ctrl+C 打断再发，
          否则 Claude Code 停在补全菜单上时会把这行字当普通输入吃掉。 */}
      {SLASH_COMMANDS.map(cmd => (
        <KeyButton
          key={cmd}
          label={cmd}
          title={`先 Ctrl+C 打断，再发送 ${cmd}`}
          onClick={() => onSlashCommand(cmd)}
          tone={TONE_TEXT}
        />
      ))}
      <Divider />
      <KeyButton label="＋图片" title="从相册选图上传到这台开发机，并把路径敲进终端" onClick={onPickImage} tone={TONE_TEXT} />
      <KeyButton label="复制" title="复制选中内容；没有选中则复制整个终端缓冲（长按终端某行可选中该行）" onClick={onCopyAll} tone={TONE_TEXT} />
      <KeyButton label="复制命令" title="先长按终端里命令的任意一行选中，再点这里：把整条命令拼成一行复制（去缩进、拼回被折断的行）" onClick={onCopyCommand} tone={TONE_TEXT} />
      <KeyButton label="粘贴" title="把剪贴板内容敲进终端（HTTP 页面读不到剪贴板时会弹出手动粘贴框）" onClick={onPaste} tone={TONE_TEXT} />
      <KeyButton
        label="⌨直连"
        title={directKeyboard
          ? '当前：按键直达终端（TUI 的 y/n、vim 用这个）。点此切回输入框模式'
          : '当前：输入框模式（打整行再发）。点此让按键直达终端'}
        onClick={onToggleDirectKeyboard}
        tone={directKeyboard ? { ...TONE_TEXT, ...TONE_ACTIVE } : TONE_TEXT}
      />
    </div>
  );
}
