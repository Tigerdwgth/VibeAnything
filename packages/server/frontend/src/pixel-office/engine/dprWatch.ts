/**
 * 盯住 devicePixelRatio 的变化（把窗口在 Retina 屏与外接 1× 屏之间拖、或者系统缩放变了）。
 *
 * 纯 dpr 变化不改元素的 CSS 尺寸，ResizeObserver 不会触发，只能靠
 * `matchMedia('(resolution: Ndppx)')`。但这条查询只认**注册时**那一个分辨率：
 * 从它变走、或者变回它时才响，变成第三个值时一声不吭（2× → 1× → 1.5×，
 * 第二次变化就漏了）。所以每次响过之后都按新的 dpr 重新注册一条。
 *
 * @returns 停止监听
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  let query: MediaQueryList | null = null
  const listen = () => {
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    query.addEventListener('change', handle, { once: true })
  }
  function handle() {
    onChange()
    listen()
  }
  listen()
  return () => {
    query?.removeEventListener('change', handle)
    query = null
  }
}
