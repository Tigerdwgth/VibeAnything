// 画布上的状态色。
//
// DOM 那边（名牌、会话列表）用的是 pixel-theme.js 里的 CSS 变量，而 canvas 读不到
// CSS 变量，只能拿到具体的色值。为了让「工作中」在画布上的描边和名牌、侧栏的黄灯
// 是同一个黄（深浅色主题下各不相同，见 theme.js 的 T.working），由集成层 PixelView
// 在主题变化时把色值推到这里，渲染层每帧来取。

export interface StatusPalette {
  /** 工作中（与侧栏黄灯同源：T.working） */
  working: string
}

let palette: StatusPalette = { working: '#facc15' }

export function setStatusPalette(next: StatusPalette): void {
  palette = next
}

export function getStatusPalette(): StatusPalette {
  return palette
}
