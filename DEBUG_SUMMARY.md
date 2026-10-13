# 系统化调试总结：PTY 测试失败

## Phase 1: Root Cause Investigation

### 错误信息
```
AssertionError [ERR_ASSERTION]: true == false
  at tests/pty-manager.test.js:16:14
```

测试在调用 `mgr.destroy('sess1')` 后，期望 `mgr.has('sess1')` 返回 `false`，但实际返回 `true`。

### 根本原因

通过阅读 `lib/pty-manager.js` 源码发现：

1. **`destroy()` 方法**（第 139-146 行）：
   - 只删除内存中的 `_sessions` Map 条目
   - Kill pty 进程
   - **不 kill tmux session**（设计如此，让 claude 继续运行）

2. **`has()` 方法**（第 163-167 行）：
   - 不仅检查内存中的 `_sessions`
   - **还检查 tmux session 是否存在**
   - 即使 pty 断了，只要 tmux session 还在就返回 `true`

3. **设计意图**：
   - `destroy()` - 断开 pty 但保留 tmux session（Web Dashboard 场景）
   - `destroyWithTmux()` - 彻底终止 tmux session
   - `has()` - 检查 tmux session 是否存在（即使 pty 断了）

## Phase 2: Pattern Analysis

这是一个**测试与实现不匹配**的问题，而不是实现的 bug。

实现的设计是合理的：
- 在 Web Dashboard 场景下，浏览器关闭时只断开 pty
- Claude 进程继续在 tmux 中运行
- 下次连接时可以 attach 到同一个 tmux session

## Phase 3: Hypothesis

**假设：** 测试应该使用 `destroyWithTmux()` 来彻底清理 tmux session，以匹配测试的期望。

**验证：**
```bash
# 创建测试脚本验证行为
mgr.destroy('test-sess')
→ has() 返回 true（tmux session 还在）

mgr.destroyWithTmux('test-sess')
→ has() 返回 false（tmux session 被 kill）
```

验证成功！

## Phase 4: Implementation

### 修复方案

将测试中的 `destroy()` 改为 `destroyWithTmux()`：

```diff
- mgr.destroy('sess1');
+ mgr.destroyWithTmux('sess1');

- mgr.destroy('sess2');
+ mgr.destroyWithTmux('sess2');
```

### 测试结果

修复后所有 87 个测试全部通过：
```
✔ create and destroy PTY (517.940985ms)
✔ resize PTY (13.706357ms)
✔ create reuses existing PTY if alive (10.164452ms)
ℹ tests 87
ℹ pass 87
ℹ fail 0
```

## 经验教训

1. **阅读完整的实现代码**：不要只看方法名，要理解设计意图
2. **注意注释**：代码注释明确说明了 `destroy()` 不 kill tmux session
3. **验证假设**：创建最小测试脚本验证行为差异
4. **测试应该匹配设计**：测试的期望应该与实现的设计意图一致

## 修改文件

- `tests/pty-manager.test.js` - 将 `destroy()` 改为 `destroyWithTmux()`
