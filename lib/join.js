// lib/join.js
// 装机：拿一个一次性邀请码，从 dashboard 换回这台机器自己的长期 token，写进配置。
//
// 这替掉的是「照抄 40 行 config.json + 让管理员去改 dashboard 的 systemd unit 加一条
// MACHINE_TOKENS 再重启服务」那套流程。装一台机器现在只要两样东西：服务器地址 + 邀请码。
//
// 写配置只写三个字段（machineId / centralServer.url / centralServer.machineToken），
// 其余全部吃 lib/config.js 的默认值 —— 配置文件越短，下一台机器越不容易抄错
// （见 config.js 里关于逐层合并的那段）。

const os = require('node:os');
const { patchConfigFile, getConfigPath } = require('./config');

/**
 * 把用户给的服务器地址解析成「HTTP 接口前缀」和「WS 地址」两份。
 *
 * 这两份必须从同一个输入推出来，否则装机时写进配置的 ws 地址和实际换 token 的
 * 那台服务器可能不是一台。接受的写法（都是实际会被贴进来的形态）：
 *   ws://host:3000/ws · wss://host/ws · http://host:3000 · https://host/proxy/3000/ws · host:3000
 *
 * @param {string} input
 * @returns {{httpBase: string, wsUrl: string}}
 */
function resolveServerUrls(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('服务器地址不能为空');
  // 没写协议时按 http 处理：内网 dashboard 现在就是 http
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`服务器地址无法解析: ${input}`);
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`不支持的协议: ${url.protocol}（用 http/https/ws/wss）`);
  }

  // 路径里的 /ws 是 WS 端点，不属于 HTTP 接口前缀；其余路径（反代前缀）要保留
  const pathname = url.pathname.replace(/\/+$/, '');
  const prefix = pathname.endsWith('/ws') ? pathname.slice(0, -3).replace(/\/+$/, '') : pathname;

  const host = url.host;
  return {
    httpBase: `${secure ? 'https' : 'http'}://${host}${prefix}`,
    wsUrl: `${secure ? 'wss' : 'ws'}://${host}${prefix}/ws`,
  };
}

/**
 * 这台机器的默认名字：主机名的第一段。
 * 完整主机名常带域（`mac-mini.tailnet-example.ts.net`），而 machineId 会出现在机器列表、
 * 日志和归属台账里，短名才读得懂。要别的名字用 --machine-id 指定。
 */
function defaultMachineId() {
  return String(os.hostname() || '').split('.')[0] || 'unknown';
}

/**
 * 用邀请码完成装机。
 *
 * @param {object} opts
 * @param {string} opts.server    dashboard 地址（见 resolveServerUrls 支持的写法）
 * @param {string} opts.code      一次性邀请码
 * @param {string} [opts.machineId] 这台机器的名字，默认取主机名第一段
 * @param {string} [opts.label]   备注，只显示在管理员的机器列表里
 * @param {Function} [opts.fetchImpl] 注入点，单测不必起真服务器
 * @returns {Promise<{machineId: string, wsUrl: string, configPath: string}>}
 */
async function join({ server, code, machineId, label, fetchImpl = globalThis.fetch } = {}) {
  if (!code) throw new Error('缺少邀请码（--code），找管理员在 Dashboard 上签发一个');
  const { httpBase, wsUrl } = resolveServerUrls(server);
  const id = String(machineId || '').trim() || defaultMachineId();

  let res;
  try {
    res = await fetchImpl(`${httpBase}/api/machines/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: String(code).trim(), machineId: id, label: label || null }),
    });
  } catch (e) {
    throw new Error(`连不上 ${httpBase}：${e.message}`);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 服务端的 error 文案是给装机的人看的（码过期 / 机器已登记要怎么办），原样透出
    throw new Error(body?.error || `换取 token 失败（HTTP ${res.status}）`);
  }
  if (!body?.machineToken || !body?.machineId) {
    throw new Error('服务端没有返回 machineToken，确认它已升级到支持邀请码装机的版本');
  }

  patchConfigFile({
    machineId: body.machineId,
    centralServer: { enabled: true, url: wsUrl, machineToken: body.machineToken },
  });

  return { machineId: body.machineId, wsUrl, configPath: getConfigPath() };
}

/**
 * 让 dashboard 签发一个一次性邀请码（管理员操作）。
 *
 * 走 HTTP 而不是直接读 users.db：dashboard 跑着的时候，sql.js 是「整库导出 + 覆写文件」，
 * 另一个进程同时写同一个库，谁后保存谁的改动留下 —— 刚签发的码会无声消失。
 * 走接口还顺带让这条命令能从任何一台机器上执行，不必 ssh 到服务器。
 *
 * @param {object} opts
 * @param {string} opts.server dashboard 地址
 * @param {string} opts.username 管理员用户名
 * @param {string} opts.password 管理员密码
 * @param {string} [opts.machineId] 指名给某台机器（也是给已有机器换 token 的唯一途径）
 * @param {string} [opts.label] 备注
 * @param {number} [opts.ttlMinutes] 有效期，默认由服务端定（30 分钟）
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{code: string, expiresAt: number, machineId: string|null, httpBase: string, wsUrl: string}>}
 */
async function requestInvite({ server, username, password, machineId, label, ttlMinutes, fetchImpl = globalThis.fetch } = {}) {
  const { httpBase, wsUrl } = resolveServerUrls(server);
  if (!username || !password) throw new Error('需要管理员用户名和密码');

  const post = async (pathname, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchImpl(`${httpBase}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(`连不上 ${httpBase}：${e.message}`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `${pathname} 失败（HTTP ${res.status}）`);
    return json;
  };

  const { token } = await post('/api/login', { username, password });
  if (!token) throw new Error('登录没有返回 token');
  const invite = await post('/api/machines/invite', {
    machineId: machineId || null, label: label || null, ttlMinutes: ttlMinutes || undefined,
  }, token);
  return { ...invite, httpBase, wsUrl };
}

module.exports = { join, requestInvite, resolveServerUrls, defaultMachineId };
