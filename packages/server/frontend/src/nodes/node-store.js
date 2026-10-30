export const NODES_KEY = 'vibeanything.nodes';

export function normalizeNodeUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整节点地址，例如 http://node-a:3000'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('节点地址须为 HTTP 或 HTTPS 地址，不包含账号、查询参数或片段');
  }
  // 节点配置使用服务根地址；页面入口不是 API 前缀。
  url.pathname = url.pathname.replace(/\/(nodes(?:\.html)?|index\.html|m|mobile\.html)\/?$/, '').replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}

export function nodeEndpoint(base, path) {
  return `${base}/${path.replace(/^\/+/, '')}`;
}

export function loadNodes(storage = localStorage, origin = location.origin) {
  try {
    const raw = storage.getItem(NODES_KEY);
    if (raw !== null) {
      const nodes = JSON.parse(raw);
      // 当前入口的登录由原看板与总览共用；改密码后原看板保存的新票优先生效。
      return nodes.map(node => node.url === origin ? { ...node, token: storage.getItem('token') || '' } : node);
    }
  } catch { /* 无法读取保存的配置时使用当前节点 */ }
  return [{ url: origin, name: '当前节点', token: storage.getItem('token') || '', username: '' }];
}

// 三段身份都参与区分：不同节点上的 machineId 和 tmux 名可以完全相同。
export function sessionKey(nodeUrl, session) {
  return JSON.stringify([nodeUrl, session.machineId, session.sessionId]);
}

export function exportNodes(nodes) {
  return JSON.stringify(nodes.map(({ name, url }) => ({ name, url })), null, 2);
}

export function importNodes(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('节点文件应为名称和地址组成的数组');
  return data.map(item => {
    if (typeof item?.url !== 'string') throw new Error('每个节点都需要 url 地址');
    const url = normalizeNodeUrl(item.url);
    return { url, name: String(item.name || new URL(url).host), token: '', username: '' };
  });
}
