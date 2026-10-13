// 会话/文件夹拖拽的「激活条件」——鼠标与触屏必须分开配置，否则手机端列表滑不动。
//
// 背景（2026-08-23 手机端「无法滚动」的根因）：原来只挂了一个 PointerSensor
// (activationConstraint: { distance: 5 })。dnd-kit 的 AbstractPointerSensor 在手指
// 移动超过 5px 时立刻 handleStart() 激活拖拽，此后每个 pointermove 都执行
// event.preventDefault()（监听器是 passive: false，preventDefault 真的生效）——
// 于是手指在任意一行会话上竖划都变成「拖动这个会话」，浏览器的原生滚动被吃掉，
// 整个会话列表在手机上完全滑不动。桌面端用滚轮滚动，所以只有手机中招。
//
// dnd-kit 官方对「可滚动列表里的拖拽」的说法：Pointer sensor 只能靠
// `touch-action: none` 来阻止滚动，这会牺牲移动端体验；这种场景推荐改用
// Mouse + Touch 两个 sensor（见 dndkit.com/api-documentation/sensors/pointer）。
// Touch sensor 用延时激活：长按 delay 毫秒才开始拖，在这之前手指位移超过
// tolerance 像素就直接取消拖拽、把手势还给浏览器滚动。
//
// 取值：触屏用官方示例的 250ms / 5px；鼠标沿用本项目原有的 5px（官方示例是 10px，
// 这里保持原桌面手感不变）。
export const MOUSE_DRAG_ACTIVATION = { distance: 5 };
export const TOUCH_DRAG_ACTIVATION = { delay: 250, tolerance: 5 };

// 官方对 Touch sensor 的建议：可拖拽元素设 touch-action: manipulation
// （禁掉双击缩放，但保留平移/滚动）。
export const DRAGGABLE_TOUCH_ACTION = 'manipulation';
