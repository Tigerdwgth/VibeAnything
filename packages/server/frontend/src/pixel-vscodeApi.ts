// Shim: 替换 VS Code API，用 window CustomEvent 代替
// pixel-agents 组件通过 vscode.postMessage 发消息（如 focusAgent）
// 我们把它转发为 window 自定义事件，由 PixelView 监听处理
export const vscode = {
  postMessage: (msg: unknown) => {
    window.dispatchEvent(new CustomEvent('pixel:postMessage', { detail: msg }));
  },
};
