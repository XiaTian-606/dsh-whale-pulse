# 贡献指南

感谢你愿意帮上忙。这个插件很小，规则也简单：**改动聚焦、验证过再提**。

## 先聊再写

- 新功能或行为变更，先开 issue 说清楚「要解决什么」，避免写完才发现方向不对；
- 纯 bug 修复可以直接提 PR，但请附上复现步骤。

## 环境

- Windows 10/11（process loopback 需要 2004 / Build 19041+）；
- DSH 桌面版，`DSH_HOME` 指向你的 `.dsh` 目录；
- Node 20+、PowerShell 5.1。

## 本地开发

```powershell
# 语法自检
node --check lib/index.js
node --check lib/client.js
node --check runtime/pulse.js

# 采集器单独跑
powershell -File runtime/probe.ps1
powershell -File runtime/probe.ps1 -TargetPid <pid>

# 应用列表
powershell -File runtime/sessions.ps1
```

改完之后：

- 改 `lib/index.js`、`runtime/*` → **重启 DSH**；
- 只改 `lib/client.js` → 刷新页面即可（客户端模块会重载）。

诊断日志：`<DSH_HOME>/whale-pulse-host.log`。

## 代码风格

- 不引入构建工具：`lib/client.js` 是手写的 `__ModuleLoader__` bundle；
- 中文注释写「为什么」，不写「是什么」；
- 不要用 `Set-Content` / `Get-Content -Raw` 改 `.ps1`：PowerShell 5.1 读无 BOM 的 UTF-8
  中文脚本会乱码。改完用工具写回，并确认文件带 UTF-8 BOM；
- 不要碰 `runtime/NAudio.dll`、`runtime/ApplicationLoopback.dll` 的二进制内容。

## 提交 PR

- 一个 PR 只做一件事；
- 说明「改了什么、为什么、怎么验证的」；
- 涉及界面或律动效果的，附一张截图或 GIF；
- 不要顺手格式化无关文件。

## 发布

维护者负责：

1. 更新 `CHANGELOG.md` 与 `package.json` 的版本号；
2. 确认 `node --check` 与采集器自测通过；
3. 打 tag 并发布。

## 许可

提交的代码默认以 MIT 许可发布。
