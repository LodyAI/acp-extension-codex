# 模糊 steer 投递的正面证据补查

Status: implemented
Translation: current

[English](2026-09-15-steer-history-reconciliation.md)

## 摘要

原 turn 结束时，丢失的 steer 响应可能被误报为可安全重放，重复执行 Codex 已消费的输入。
adapter 现在将提交身份保留到 prompt 结束之后；收到模糊失败响应后，先处理已收到的通知，
再读取一次原 turn 历史。匹配的用户消息身份可以确认 applied，未找到或读不到仍为 unknown。
这是限时的正面证据补查，不是 exactly-once 或跨重启协议。

## 决策

[#43](https://github.com/LodyAI/acp-extension-codex/pull/43) 的外层错误修复未覆盖内层 catch：
它既在 drain 通知前删除身份，又从本地 turn 结束推断拒绝。请求现在保留原 thread id、
turn id 和 `clientUserMessageId`。对应的实时 user item 与持久化 `userMessage.clientId`
共用一次 applied acknowledgement，并在失败提交的结果返回前发出。Stop 不会使正面投递证据失效。

通知 drain 与一次 `thread/read(includeTurns: true)` 共用五秒预算。历史读取未结束时，实时
证据也可先结束补查；晚到的历史结果没有副作用。只有明确拒绝或提交前拒绝才能安全重放。
本地队列和持久化历史都不提供负面证明屏障，因此未找到、读取失败、超时和 turn 结束仍为 unknown。

不重试 `turn/steer`，因为文档未保证身份字段是幂等键。新的通用 ACP status API 和持久化 host
映射不在范围内。成功响应保留原有实时通知路径；本次不保证恢复成功 ACK 后丢失的每一条通知。

## 证据与边界

确定性测试在可控 app-server 响应周围运行真实 adapter prompt cleanup 与通知路由，覆盖
响应失败前 prompt 已结束、排队或晚到实时证据、thread/turn/client 精确匹配、缺失或失败的
历史、超时后晚到的正面结果，以及补查中的 Stop。不宣称持久化 flush 保证，也不模拟重启。

恢复旧 catch 与 prompt cleanup 后，选定的三个回归全部失败：持久化 applied、排队通知，
以及 turn 结束后的 unknown。修复版通过 630 个测试，保留 27 个既有 gated skip，并通过
类型检查和构建。真实 Codex 0.153.4 prompt smoke 返回 `end_turn`，但该 smoke 不注入
steer 响应丢失；首次启动超时，单独重跑通过。

协议：[Codex app-server](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)。
