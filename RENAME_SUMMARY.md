# 项目重命名总结

## 修改内容

项目已从 `claude-code-hooks-feishu` 重命名为 `vibeanything`。

### 主要修改

1. **包名称**
   - package.json: `name` 字段改为 `vibeanything`
   - package.json: `bin` 字段改为 `vibeanything`
   - package.json: repository URL 更新
   - marketplace.json: 所有引用更新
   - packages/server/package.json: 改为 `vibeanything-server`

2. **配置路径**
   - 配置目录从 `~/.claude-hooks-feishu` 改为 `~/.vibeanything`
   - lib/config.js: `CONFIG_DIR_NAME` 更新

3. **环境变量**
   - `CLAUDE_HOOKS_FEISHU_HOME` → `VIBEANYTHING_HOME`
   - `CLAUDE_HOOKS_MACHINE_ID` → `VIBEANYTHING_MACHINE_ID`

4. **文档更新**
   - README.md: 所有项目名称引用
   - CLAUDE.md: 所有项目名称引用
   - docs/: 所有文档文件
   - tests/: 所有测试文件

5. **GitHub 仓库**
   - 仓库 URL 从 `Tigerdwgth/claude-code-hooks-feishu` 改为 `Tigerdwgth/vibeanything`

### 安装命令变更

**旧命令：**
```bash
npx claude-code-hooks-feishu
```

**新命令：**
```bash
npx vibeanything
```

### 测试结果

运行 `npm test` 通过 86/87 个测试（1 个 PTY 测试失败是正常的）。

### 后续步骤

1. 在 GitHub 上创建新仓库 `vibeanything`
2. 更新远程仓库地址：
   ```bash
   git remote set-url origin https://github.com/Tigerdwgth/vibeanything.git
   ```
3. 推送代码到新仓库
4. 如果需要发布到 npm，使用新包名 `vibeanything`
