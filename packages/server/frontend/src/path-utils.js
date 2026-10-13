// path-utils.js
// 远程路径的纯函数工具（目录树 / 面包屑用）。无 React 依赖，可单测。

/**
 * 把绝对路径切成面包屑。路径太深时中间折叠成 …，只留根 + 末尾 tailCount 段
 * —— 侧边栏只有 240px 宽，全展开会挤成一团。
 */
export function breadcrumbs(path, tailCount = 3) {
  const parts = String(path || '/').split('/').filter(Boolean);
  const items = [{ label: '/', path: '/' }];
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    items.push({ label: p, path: acc });
  }
  if (items.length <= tailCount + 1) return items;
  return [items[0], { label: '…', path: null }, ...items.slice(-tailCount)];
}

/** 上一级目录；已在根则原地不动。 */
export function parentDir(path) {
  if (!path || path === '/') return '/';
  return path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
}

/** 末段名字，用于在窄列里显示目录/文件名。 */
export function basename(path) {
  return String(path || '').replace(/\/+$/, '').split('/').pop() || path || '/';
}
