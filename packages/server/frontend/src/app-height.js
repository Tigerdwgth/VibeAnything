// 可视高度校准：把真实可视高度写进 CSS 变量 --app-height。
//
// 平板/手机浏览器的地址栏、底部工具栏会实时改变真实可视高度，100vh 量的是「布局视口」、
// 100dvh 在部分内核里也跟不上工具栏的收放，页面会比可视区域矮一截，底部露白条。
// visualViewport.height 是唯一跟手的量法（软键盘弹出时它也会缩，终端布局因此不会被键盘盖住）。
//
// 桌面版入口（src/main.jsx）与手机版入口（src/mobile/main.jsx）共用这一份，
// 两个页面的 html/body/#root 都按 var(--app-height) 撑高（见各自的 html）。

/**
 * 装上校准并立即执行一次。
 * @param {Window} [win] 注入用；默认当前窗口。
 * @returns {() => void} 卸载函数（摘掉全部监听）
 */
export function installAppHeightSync(win = window) {
  const doc = win.document;
  const sync = () => {
    const h = win.visualViewport?.height || win.innerHeight;
    doc.documentElement.style.setProperty('--app-height', `${h}px`);
  };
  // 旋转屏幕时 resize 先到、尺寸还是旧的，隔一帧再量一次才是转完之后的值
  const onOrientationChange = () => win.setTimeout(sync, 100);

  sync();
  win.addEventListener('resize', sync);
  win.addEventListener('orientationchange', onOrientationChange);
  win.visualViewport?.addEventListener('resize', sync);
  // 软键盘弹出后页面会被上推，visualViewport 只发 scroll 不发 resize
  win.visualViewport?.addEventListener('scroll', sync);

  return () => {
    win.removeEventListener('resize', sync);
    win.removeEventListener('orientationchange', onOrientationChange);
    win.visualViewport?.removeEventListener('resize', sync);
    win.visualViewport?.removeEventListener('scroll', sync);
  };
}
