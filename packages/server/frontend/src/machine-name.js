// 开发机名字的显示形态。桌面版会话列表、机器下拉、开发机面板共用这一份。
//
// machineId 是台账里的真名（日志、归属、WS 握手都用它），但它常常很长：
//   · 主机名默认带域：`macair.tailnet-example.ts.net`
//   · 容器/集群里带一串随机后缀：`aibox-r061c3847202-cdb678b8b-h5jjf`
// 这些名字塞进侧栏会被截断成一排省略号，一眼分不出是哪台。所以**显示**用短名，
// 完整名放 title（鼠标悬停看得到），真名本身绝不改 —— 改了就对不上台账。

/**
 * 列表里显示的短名。
 * @param {string} mid 台账里的 machineId
 * @returns {string} 短名；mid 为空时回 'local'（会话可能来自没报名字的本地连接）
 */
export function shortMachineId(mid) {
  if (!mid || mid === 'local') return 'local';
  // 只剥掉 DNS 域名：`macair.tailnet-example.ts.net` → `macair`。
  //
  // 这里**故意不**按 `-` 截断。原来 SessionTabs 里那份实现是「超过两段就只留前两段」，
  // 本意是对付 k8s 的随机后缀（`aibox-r061c3847202-cdb678b8b-h5jjf`），但它会把
  // `gpu-4090-05` 砍成 `gpu-4090` —— 同一批机器的编号正好在被砍掉的那一段，
  // 两台机器在列表里看起来一模一样。宁可让长名字靠 CSS 省略号 + title 处理，
  // 也不能把有意义的部分丢掉：名字是用来区分机器的。
  return String(mid).split('.')[0] || String(mid);
}

/** 短名与真名不一致时才需要 title —— 一致时加了反而是多余的悬停提示。 */
export function machineTitle(mid) {
  const short = shortMachineId(mid);
  return short === mid ? undefined : mid;
}
