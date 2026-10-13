const crypto = require('node:crypto');
const https = require('node:https');

function generateSign(secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto
    .createHmac('sha256', stringToSign)
    .update('')
    .digest();
  const sign = hmac.toString('base64');
  return { timestamp, sign };
}

function buildCardPayload({ type, cwd, fields = [] }) {
  const now = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai'
  });
  const templates = {
    task_complete: {
      title: '\u2705 Claude Code \u4efb\u52a1\u5b8c\u6210',
      template: 'green'
    },
    permission_request: {
      title: '\u26a0\ufe0f Claude Code \u9700\u8981\u786e\u8ba4',
      template: 'yellow'
    },
    tool_failure: {
      title: '\u274c Claude Code \u5de5\u5177\u6267\u884c\u5931\u8d25',
      template: 'orange'
    },
    danger_blocked: {
      title: '\ud83d\udea8 \u5371\u9669\u547d\u4ee4\u5df2\u62e6\u622a',
      template: 'red'
    }
  };
  const t = templates[type] || templates.task_complete;

  const lines = [
    `**\u9879\u76ee\u76ee\u5f55**: ${cwd}`,
    `**\u65f6\u95f4**: ${now}`
  ];
  for (const f of fields) {
    lines.push(`**${f.label}**: ${f.value}`);
  }

  return {
    msg_type: 'interactive',
    card: {
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
    }
  };
}

function sendWebhook(url, payload, secret) {
  return new Promise((resolve, reject) => {
    const body = { ...payload };
    if (secret) {
      const { timestamp, sign } = generateSign(secret);
      body.timestamp = timestamp;
      body.sign = sign;
    }
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let respBody = '';
      res.on('data', (chunk) => respBody += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(respBody));
        } catch {
          resolve({ raw: respBody });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = { generateSign, buildCardPayload, sendWebhook };
