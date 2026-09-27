# 宿主拥有的原生启动与进程使用证明

Status: proposed
Translation: current

[English](2026-09-26-managed-profile-process-usage.md)

## 摘要

托管账户需要在 app-server 初始化前固定认证存储和模型供应商，也需要原生进程退出
证明来延迟删除凭据，同时保留同账户多会话并发。此 adapter 改动仅支持这些边界，
不实现宿主账户界面、凭据库、端点转发器或凭据刷新。

## 决策

`LODY_CODEX_PROFILE_CONFIG` 在 `app-server` 前传入非秘密原生 `-c` 设置。顶层键
校验后不加 TOML 引号；嵌套表键和值使用兼容 TOML 的编码。托管 Windows 启动直接
传 argv，原有 Windows shell 启动保持不变。

可选的宿主生成 UUID `LODY_CODEX_PROCESS_TOKEN` 指向 CODEX_HOME 旁已有的
`processes/<token>.json`。adapter 校验归属，从原生子进程环境移除 token，仅写自身
对应 PID/退出证明。同一目录的多个 token 可共存。未知原生状态只能延迟宿主清理，
不能阻止其他会话。此前未发布的独占写入设计已移除：未经验证的刷新竞争不足以改变
并发行为。宿主拥有登记、墓碑、协调和清理；token 不是秘密或调用方选择的文件路径，
也不是针对同用户代码的沙箱。

## 证据与限制

连接测试启动真实合成 JSON-RPC 子进程，观察启动参数、保留的目录、移除的 token、
独立的存活和退出证明，以及第一个进程退出后第二个继续响应。还覆盖无效归属和旧版
Windows 命令构造；平台参数断言不代表真实 Windows 执行验证。不宣称修复原生刷新竞争。

复现命令为 `pnpm exec vitest run src/__tests__/CodexJsonRpcConnection.test.ts`、
`pnpm typecheck` 和 `pnpm build`。独立 Lody 桌面验收使用真实 Codex 0.156.0 与合成
外部服务协议，以双请求到达屏障验证同账户重叠，不使用真实账户凭据。

环境契约：[开发 README](../../../../readme-dev.md)。
