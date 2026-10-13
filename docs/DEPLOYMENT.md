# 部署命令使用指南

## 快速开始

### Dashboard 服务器部署

在中央服务器上运行：

```bash
# 1. 克隆项目
git clone https://github.com/Tigerdwgth/vibeanything.git
cd vibeanything

# 2. 安装依赖
npm install

# 3. 配置（设置 server.machineTokens）
node bin/cli.js

# 4. 部署为 systemd 服务
sudo node bin/cli.js --deploy dashboard
```

### 客户端（开发机）部署

在开发机上运行：

```bash
# 1. 克隆项目
git clone https://github.com/Tigerdwgth/vibeanything.git
cd vibeanything

# 2. 安装依赖
npm install

# 3. 配置（设置飞书应用和中央服务器地址）
node bin/cli.js

# 4. 部署为 systemd 服务
sudo node bin/cli.js --deploy client
```

## 服务管理

### Dashboard 服务器

```bash
# 查看状态
sudo systemctl status claude-dashboard

# 查看日志
sudo journalctl -u claude-dashboard -f

# 重启服务
sudo systemctl restart claude-dashboard

# 停止服务
sudo systemctl stop claude-dashboard

# 禁用自启动
sudo systemctl disable claude-dashboard
```

### 客户端 daemon

```bash
# 查看状态
sudo systemctl status claude-hooks-daemon

# 查看日志
sudo journalctl -u claude-hooks-daemon -f

# 重启服务
sudo systemctl restart claude-hooks-daemon

# 停止服务
sudo systemctl stop claude-hooks-daemon

# 禁用自启动
sudo systemctl disable claude-hooks-daemon
```

## 配置要求

### Dashboard 服务器

必需配置项：
- `server.machineTokens`: 允许连接的开发机 token 列表（至少一个）
- `server.port`: 监听端口（默认 3000）
- `server.host`: 绑定地址（默认 0.0.0.0，推荐使用 Tailscale IP）

可选配置：
- Tailscale IP 自动检测（部署时会提示）

### 客户端

必需配置项（二选一）：
1. 飞书应用配置：
   - `app.appId`
   - `app.appSecret`

2. 中央服务器配置：
   - `centralServer.enabled`: true
   - `centralServer.url`: WebSocket 地址（如 ws://your-server:3000/ws）
   - `centralServer.machineToken`: 在服务器 machineTokens 中配置的 token

## 安全建议

1. **使用 Tailscale 内网部署**
   - Dashboard 绑定到 Tailscale IP
   - 只有 Tailscale 网络内设备可访问
   - 通信走 WireGuard 加密隧道

2. **定期更新 machineTokens**
   - 使用强随机 UUID
   - 定期轮换 token

3. **监控日志**
   - 定期检查 journalctl 日志
   - 关注异常连接和错误

## 故障排查

### Dashboard 无法启动

```bash
# 检查配置
cat ~/.vibeanything/config.json | grep -A 5 server

# 检查端口占用
sudo netstat -tlnp | grep 3000

# 查看详细日志
sudo journalctl -u claude-dashboard -n 100
```

### 客户端无法连接

```bash
# 检查配置
cat ~/.vibeanything/config.json | grep -A 5 centralServer

# 测试网络连接
curl -v ws://your-server:3000/ws

# 查看详细日志
sudo journalctl -u claude-hooks-daemon -n 100
```

## 卸载

```bash
# 停止并禁用服务
sudo systemctl stop claude-dashboard
sudo systemctl disable claude-dashboard
sudo rm /etc/systemd/system/claude-dashboard.service

# 或者客户端
sudo systemctl stop claude-hooks-daemon
sudo systemctl disable claude-hooks-daemon
sudo rm /etc/systemd/system/claude-hooks-daemon.service

# 重载 systemd
sudo systemctl daemon-reload
```
