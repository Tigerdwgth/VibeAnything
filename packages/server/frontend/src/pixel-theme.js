// 像素小镇的设计令牌。
//
// 这个子系统是从 VS Code 扩展（pixel-agents）移植过来的，它的样式分两处来源：
//   · VS Code 注入的 `--vscode-*` 主题变量（扩展里白给）
//   · 它自己样式表里的 `--pixel-*` 变量
// 移植进这个浏览器应用时**两套都没带过来**，于是整棵子树里 34 个 `var(--...)`
// 全部解析失败。CSS 的行为是「值无效 → 整条声明作废」，所以症状是一堆看起来
// 毫无关联的毛病，而且一个报错都没有：
//   · 按钮没有背景色、文字颜色靠继承（`var(--pixel-btn-bg)` / `var(--vscode-foreground)`）
//   · `zIndex: 'var(--pixel-controls-z)'` 作废 → z-index 变 auto → 缩放按钮/底部工具条
//     的层级靠 DOM 顺序，会被后面的覆盖层压住，点不着
//   · 暗角（vignette）、提示条背景、工具气泡的状态色全部不生效
//   · 禁用态按钮的 opacity 作废 → 看不出禁用
//
// 所以这里把令牌补齐，值取自本应用的主题对象（theme.js），顺带让小镇跟着
// 深色/浅色主题一起变 —— 原来那套 VS Code 变量是跟编辑器主题走的，在这里无主可跟。
//
// 作用域：只挂在小镇容器那一层（不污染全局），由 PixelView 注入。

export const PIXEL_SCOPE_CLASS = 'pixel-town-scope';

/**
 * 生成作用域内的 CSS 变量定义。
 * @param {object} T theme.js 的主题对象（DARK / LIGHT）
 * @returns {string} 可直接塞进 <style> 的 CSS
 */
export function pixelThemeCss(T) {
  return `
.${PIXEL_SCOPE_CLASS} {
  /* 面板与按钮 */
  --pixel-bg: ${T.bgPanel};
  --pixel-btn-bg: ${T.bgCard};
  --pixel-btn-hover-bg: ${T.bgHover};
  --pixel-active-bg: ${T.accentDim};
  --pixel-border: ${T.border};
  --pixel-border-light: ${T.borderAccent};
  --pixel-shadow: 0 4px 16px rgba(0,0,0,0.4);
  --pixel-accent: ${T.accent};
  --pixel-text: ${T.textPrimary};
  --pixel-text-dim: ${T.textSecondary};
  --pixel-btn-disabled-opacity: 0.35;

  /* 关闭 / 重置这类次要动作 */
  --pixel-close-text: ${T.textMuted};
  --pixel-close-hover: ${T.textPrimary};
  --pixel-reset-text: ${T.danger};
  --pixel-danger-bg: ${T.danger};

  /* 小人与工具气泡 */
  --pixel-agent-bg: ${T.bgCard};
  --pixel-agent-hover-bg: ${T.bgHover};
  --pixel-agent-border: ${T.border};
  --pixel-agent-text: ${T.textPrimary};
  --pixel-hint-bg: rgba(0,0,0,0.65);
  --pixel-status-active: ${T.danger};        /* 正在跑（与侧栏红绿灯同义） */
  --pixel-status-permission: ${T.warning};   /* 等你确认 */

  /* 画布上的暗角：四角压暗一点，让中间的小镇更聚焦 */
  --pixel-vignette: radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.35) 100%);

  /* 层级。覆盖层(40) < 工具气泡 < 控件，否则按钮会被暗角和气泡压住点不着 */
  --pixel-overlay-z: 45;
  --pixel-overlay-selected-z: 46;
  --pixel-controls-z: 50;

  /* 子系统里残留的 VS Code 主题变量：在这里没有编辑器可跟，映到本应用主题 */
  --vscode-foreground: ${T.textPrimary};
  --vscode-editor-background: ${T.bgBase};
  --vscode-widget-border: ${T.border};
  --vscode-list-activeSelectionBackground: ${T.accentDim};
  --vscode-charts-red: ${T.danger};
  --vscode-charts-green: ${T.success};
  --vscode-charts-yellow: ${T.warning};
  --vscode-charts-blue: ${T.accent};
}
`;
}
