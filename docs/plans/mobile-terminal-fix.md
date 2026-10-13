# 手机端终端花屏 + 滑动修复方案

## 问题定义
### P0: 花屏
- 现象：手机端终端有新内容时显示花乱
- 根因：ResizeObserver 无节流 + 高频写入 + 隐藏终端消耗资源
- 影响：手机端完全不可用

### P0: 无法滑动
- 现象：手机端无法上下滑动终端内容
- 根因：touchmove preventDefault 阻止了滚动
- 影响：无法查看历史输出

## 修复方案

### Fix 1: ResizeObserver 节流（防花屏核心）
- 用 requestAnimationFrame + 防抖（150ms）包裹 ResizeObserver 回调
- 记录上次 cols/rows，只在实际变化时发送 pty_resize

### Fix 2: 隐藏终端跳过写入
- visible=false 时不调用 term.write()，改为缓冲到数组
- visible 变为 true 时批量回放缓冲

### Fix 3: pty_data 写入批量化
- 使用 requestAnimationFrame 合并同一帧内的多次 write 为一次

### Fix 4: 触摸滚动修复
- 移除 touchmove 的 e.preventDefault()（改为条件调用）
- 只在 alternate screen 模式下 prevent default
- normal screen 模式允许 xterm 自身滚动

## 验收标准
1. 手机 Chrome/Safari 打开终端，连续输出时无花屏
2. 手机端可以正常上下滑动查看历史
3. 多终端切换无数据丢失
4. 桌面端无回归
