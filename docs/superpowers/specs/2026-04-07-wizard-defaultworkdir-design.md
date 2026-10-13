# 安装向导增加 defaultWorkDir 配置

## 背景

安装向导已有 Dashboard 配置步骤，但缺少 `defaultWorkDir` 字段的交互式配置。

## 改动

在 `bin/cli.js` Dashboard 配置块（启用后）追加一问：

```
默认工作目录 (文件浏览器起始路径，留空用 home 目录): 
```

用户输入写入 `config.defaultWorkDir`，留空则存 `''`，运行时由 `os.homedir()` 填充。

## 改动范围

- 仅修改 `bin/cli.js`，在现有 Dashboard URL + Token 两问之后追加一问
- 不影响其他配置步骤
