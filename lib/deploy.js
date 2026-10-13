const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { loadConfig, getBaseDir } = require('./config');

function isRoot() {
  return process.getuid && process.getuid() === 0;
}

function getTailscaleIP() {
  try {
    const output = execSync('tailscale ip -4', { encoding: 'utf-8' }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function getNodePath() {
  try {
    return execSync('which node', { encoding: 'utf-8' }).trim();
  } catch {
    return '/usr/bin/node';
  }
}

function getCurrentUser() {
  return process.env.SUDO_USER || process.env.USER || 'root';
}

function getDashboardServiceContent(config) {
  const nodePath = getNodePath();
  const projectRoot = path.resolve(__dirname, '..');
  const user = getCurrentUser();
  const port = config.server?.port || 3000;
  const host = config.server?.host || '0.0.0.0';
  const tokens = (config.server?.machineTokens || []).join(',');

  return `[Unit]
Description=Claude Code Hooks Feishu - Web Dashboard Server
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${projectRoot}
Environment="NODE_ENV=production"
Environment="MACHINE_TOKENS=${tokens}"
Environment="PORT=${port}"
Environment="HOST=${host}"
ExecStart=${nodePath} ${projectRoot}/packages/server/index.js --port ${port}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

function getClientServiceContent(config) {
  const nodePath = getNodePath();
  const projectRoot = path.resolve(__dirname, '..');
  const user = getCurrentUser();
  const appId = config.app?.appId || '';
  const appSecret = config.app?.appSecret || '';

  return `[Unit]
Description=Claude Code Hooks Feishu - Daemon (Feishu + WS Client)
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${projectRoot}
Environment="NODE_ENV=production"
Environment="FEISHU_APP_ID=${appId}"
Environment="FEISHU_APP_SECRET=${appSecret}"
ExecStart=${nodePath} ${projectRoot}/bin/cli.js --daemon start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}

async function deployDashboard() {
  console.log('\n🚀 部署 Dashboard 服务器模式\n');

  if (!isRoot()) {
    console.error('❌ 需要 root 权限，请使用 sudo 运行');
    process.exit(1);
  }

  const config = loadConfig();

  // 检查配置
  if (!config.server?.machineTokens || config.server.machineTokens.length === 0) {
    console.error('❌ 未配置 server.machineTokens');
    console.error('请在配置文件中添加允许连接的开发机 token');
    console.error(`配置文件: ${path.join(getBaseDir(), 'config.json')}`);
    process.exit(1);
  }

  // 检测 Tailscale IP
  const tailscaleIP = getTailscaleIP();
  if (tailscaleIP) {
    console.log(`✅ 检测到 Tailscale IP: ${tailscaleIP}`);
    const useTS = await askYesNo(`是否绑定到 Tailscale IP (${tailscaleIP})? [Y/n]: `);
    if (useTS) {
      config.server.host = tailscaleIP;
      const { saveConfig } = require('./config');
      saveConfig(config);
      console.log(`✅ 已更新配置，绑定地址: ${tailscaleIP}`);
    }
  } else {
    console.log('⚠️  未检测到 Tailscale，将绑定到 0.0.0.0');
  }

  // 生成 systemd service 文件
  const serviceContent = getDashboardServiceContent(config);
  const servicePath = '/etc/systemd/system/claude-dashboard.service';

  console.log(`\n📝 创建 systemd service: ${servicePath}`);
  fs.writeFileSync(servicePath, serviceContent, 'utf-8');

  // 重载 systemd
  console.log('🔄 重载 systemd...');
  execSync('systemctl daemon-reload', { stdio: 'inherit' });

  // 启用并启动服务
  console.log('🔄 启用服务...');
  execSync('systemctl enable claude-dashboard.service', { stdio: 'inherit' });

  console.log('🔄 启动服务...');
  execSync('systemctl start claude-dashboard.service', { stdio: 'inherit' });

  // 检查状态
  console.log('\n✅ Dashboard 服务已部署并启动');
  console.log('\n查看状态:');
  console.log('  sudo systemctl status claude-dashboard');
  console.log('  sudo journalctl -u claude-dashboard -f');
  console.log(`\n访问地址: http://${config.server.host}:${config.server.port || 3000}`);
  console.log(`Machine Tokens: ${config.server.machineTokens.length} 个\n`);
}

async function deployClient() {
  console.log('\n🚀 部署客户端（开发机）模式\n');

  if (!isRoot()) {
    console.error('❌ 需要 root 权限，请使用 sudo 运行');
    process.exit(1);
  }

  const config = loadConfig();

  // 检查配置
  if (!config.app?.appId || !config.app?.appSecret) {
    if (!config.centralServer?.enabled || !config.centralServer?.url) {
      console.error('❌ 未配置飞书应用或中央服务器');
      console.error('请先运行配置向导: node bin/cli.js');
      process.exit(1);
    }
  }

  // 生成 systemd service 文件
  const serviceContent = getClientServiceContent(config);
  const servicePath = '/etc/systemd/system/claude-hooks-daemon.service';

  console.log(`\n📝 创建 systemd service: ${servicePath}`);
  fs.writeFileSync(servicePath, serviceContent, 'utf-8');

  // 重载 systemd
  console.log('🔄 重载 systemd...');
  execSync('systemctl daemon-reload', { stdio: 'inherit' });

  // 启用并启动服务
  console.log('🔄 启用服务...');
  execSync('systemctl enable claude-hooks-daemon.service', { stdio: 'inherit' });

  console.log('🔄 启动服务...');
  execSync('systemctl start claude-hooks-daemon.service', { stdio: 'inherit' });

  // 检查状态
  console.log('\n✅ Daemon 服务已部署并启动');
  console.log('\n查看状态:');
  console.log('  sudo systemctl status claude-hooks-daemon');
  console.log('  sudo journalctl -u claude-hooks-daemon -f');

  if (config.centralServer?.enabled) {
    console.log(`\n中央服务器: ${config.centralServer.url}`);
  }
  console.log();
}

function askYesNo(question) {
  return new Promise((resolve) => {
    const readline = require('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() !== 'n');
    });
  });
}

module.exports = {
  deployDashboard,
  deployClient,
  isRoot,
  getTailscaleIP
};

