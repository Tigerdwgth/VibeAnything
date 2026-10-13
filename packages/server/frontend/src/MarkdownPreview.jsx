import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTheme } from './theme';

export default function MarkdownPreview({ path, content, onClose }) {
  const T = useTheme();

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      overflow: 'hidden', background: T.bgBase,
    }}>
      {/* 顶栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 16px',
        borderBottom: `1px solid ${T.border}`,
        background: T.bgPanel, flexShrink: 0,
      }}>
        <span style={{
          fontFamily: T.fontMono, fontSize: '0.78rem',
          color: T.textMuted, flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {path}
        </span>
        <button
          onClick={onClose}
          style={{
            background: T.bgCard, border: `1px solid ${T.border}`,
            color: T.textMuted, borderRadius: T.radiusSm,
            cursor: 'pointer', padding: '3px 10px', fontSize: '0.75rem',
            fontFamily: T.fontSans, transition: 'all 0.15s',
          }}
        >
          关闭
        </button>
      </div>

      {/* 内容区 */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '1.5rem 2rem',
        color: T.textPrimary, fontFamily: T.fontSans, fontSize: '0.9rem', lineHeight: 1.7,
      }}>
        <style>{`
          .md-body h1,h2,h3,h4,h5,h6 { color: ${T.textPrimary}; margin: 1.2em 0 0.4em; font-weight: 600; }
          .md-body h1 { font-size: 1.6em; border-bottom: 1px solid ${T.border}; padding-bottom: 0.3em; }
          .md-body h2 { font-size: 1.3em; border-bottom: 1px solid ${T.border}; padding-bottom: 0.2em; }
          .md-body p { margin: 0.6em 0; }
          .md-body a { color: ${T.accent}; text-decoration: none; }
          .md-body a:hover { text-decoration: underline; }
          .md-body code { font-family: ${T.fontMono}; font-size: 0.85em; background: ${T.bgCard}; padding: 0.15em 0.4em; border-radius: 3px; }
          .md-body pre { background: ${T.bgCard}; border: 1px solid ${T.border}; border-radius: 6px; padding: 1em; overflow-x: auto; }
          .md-body pre code { background: none; padding: 0; font-size: 0.82em; }
          .md-body blockquote { border-left: 3px solid ${T.border}; margin: 0.8em 0; padding: 0.4em 1em; color: ${T.textMuted}; }
          .md-body ul,ol { padding-left: 1.5em; margin: 0.6em 0; }
          .md-body li { margin: 0.2em 0; }
          .md-body table { border-collapse: collapse; width: 100%; margin: 1em 0; }
          .md-body th,td { border: 1px solid ${T.border}; padding: 0.4em 0.8em; text-align: left; }
          .md-body th { background: ${T.bgPanel}; font-weight: 600; }
          .md-body tr:nth-child(even) { background: ${T.bgCard}; }
          .md-body hr { border: none; border-top: 1px solid ${T.border}; margin: 1.5em 0; }
          .md-body img { max-width: 100%; border-radius: 4px; }
        `}</style>
        <div className="md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
