// 多节点页直接向各节点登录/续期；只给这些接口声明允许的浏览器来源。
// 账号与权限仍由节点自己的 auth.js/relay.js 判定。
function nodeCors(allowedOrigins = process.env.DASHBOARD_ORIGINS || '') {
  const origins = new Set(allowedOrigins.split(',').map(s => s.trim()).filter(Boolean));
  const paths = new Set(['/api/login', '/api/session/refresh']);
  return (req, res, next) => {
    if (!paths.has(req.path)) return next();
    res.vary('Origin');
    if (!origins.has(req.headers.origin)) return next();
    res.set('Access-Control-Allow-Origin', req.headers.origin);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}
module.exports = { nodeCors };
