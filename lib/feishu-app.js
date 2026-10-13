const https = require('node:https');

function buildTokenRequestBody(appId, appSecret) {
  return { app_id: appId, app_secret: appSecret };
}

function buildAppCardContent({ type, cwd, fields = [] }) {
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai'
  });
  const templates = {
    task_complete: {
      title: '✅ Claude Code 任务完成', template: 'green'
    },
    permission_request: {
      title: '⚠️ Claude Code 需要确认', template: 'yellow'
    },
    tool_failure: {
      title: '❌ Claude Code 工具执行失败', template: 'orange'
    },
    danger_blocked: {
      title: '🚨 危险命令已拦截', template: 'red'
    }
  };
  const t = templates[type] || templates.task_complete;
  const lines = [
    `**项目目录**: ${cwd}`,
    `**时间**: ${now}`
  ];
  for (const f of fields) {
    lines.push(`**${f.label}**: ${f.value}`);
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t.title },
      template: t.template
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') }
      }
    ]
  });
}

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getTenantAccessToken(appId, appSecret) {
  const url =
    'https://open.feishu.cn/open-apis/auth/v3/' +
    'tenant_access_token/internal';
  const res = await httpsPost(
    url, {}, buildTokenRequestBody(appId, appSecret)
  );
  if (res.code !== 0) {
    throw new Error(`获取 token 失败: ${JSON.stringify(res)}`);
  }
  return res.tenant_access_token;
}

async function sendAppMessage(
  appId, appSecret, receiverId, receiverType, cardContent
) {
  const token = await getTenantAccessToken(appId, appSecret);
  const url =
    'https://open.feishu.cn/open-apis/im/v1/messages' +
    `?receive_id_type=${receiverType}`;
  return httpsPost(
    url,
    { Authorization: `Bearer ${token}` },
    {
      receive_id: receiverId,
      msg_type: 'interactive',
      content: cardContent
    }
  );
}

module.exports = {
  buildTokenRequestBody,
  buildAppCardContent,
  getTenantAccessToken,
  sendAppMessage
};
