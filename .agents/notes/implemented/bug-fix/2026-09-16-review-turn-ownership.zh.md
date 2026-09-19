# 分离 review 完成标识与原生取消标识

Status: implemented
Translation: current

[English](2026-09-16-review-turn-ownership.md)

## 摘要

Codex review 返回的完成轮次 ID 与取消操作使用的原生轮次 ID 可能不同。
混淆两者会让 review 在 Stop 后继续执行。适配器从提交时起保留 prompt，
中断观测到的原生轮次，并等待响应轮次的终态通知。这也覆盖原生启动前的
请求 Abort；中断确认不能释放 prompt。Lody 宿主已有的取消等待逻辑继续负责
超时后的进程终止。

## 决策

`review/start` 返回 review 的逻辑完成轮次。`turn/started` 通知可能提供
接收 `turn/interrupt` 的原生轮次，两种 ID 不是别名。`CodexAppServerClient`
缓存启动通知，直到 review 响应确定所属线程，再将原生 ID 交给取消路径。
review 只通过响应轮次对应的 `turn/completed` 完成。

prompt 在提交 `/review`、`/review-branch`、`/review-commit` 或 `/compact`
前标记原生命令正在执行。该标记扩展已有的 compaction 保护，不预造轮次 ID。
Stop 和请求 Abort 在启动窗口内记录取消意图；原生启动到达后发送
`turn/interrupt`，中断确认后仍保留执行占用。完成或请求失败时由 `finally`
清理标记，连接关闭则使原生完成等待失败。

缺少此标记时，取消路径不再采用响应 ID，会使响应 A 与原生启动 B 之间的
`currentTurn` 为空。请求 Abort 因而将已接受的 review 误判成尚未提交的
prompt，在原生终止前返回 `cancelled`。这一边界必须由适配器保证，因为
ACP 请求已经返回后，宿主无法得知背后仍有原生执行。

review 是独立命令，其权威完成通知不交给 `GoalPromptLifecycle` 继续等待
Goal 轮次。Goal 与 prompt 生命周期仍各自只保留一个当前轮次标识，review
的关联逻辑不改变通用当前轮次的含义。

## 证据与限制

确定性测试覆盖 Stop 和请求 Abort 在响应前、响应后、原生启动后，以及
原生启动先于响应时的行为。测试分别控制中断确认与终态，验证取消等待期间
拒绝新 prompt、忽略 B 的终态、收到 A 后才释放并允许恢复 prompt。
启动拒绝和连接关闭也能结束命令。响应后、启动前的 Abort 回归用例在
`676c1f9` 上失败。尚无受支持的原生事件证明 B 可以作为完成别名。

Codex 0.153.4 和 0.154.0 的 `delivery: inline` 实测均覆盖 Stop 和请求
Abort 在响应前、响应后、原生启动后的行为，每个版本六种场景。每次都中断
B，并先观测到 A 以 `interrupted` 完成，ACP 才返回 `cancelled`，随后恢复
prompt 成功完成。没有观测到 B 终态序列。原生验证使用独立合成仓库，
捕获的事件不作为仓库测试夹具提交。

适配器全部 649 项已启用测试、类型检查和构建通过；27 项已有测试仍按环境
条件跳过。这不等于完整的 Lody 桌面端测试。

## 宿主集成

[Lody #618](https://github.com/LodyAI/Lody/pull/618) 已让普通 Stop 保留当前
ACP 请求，并共享五秒超时终止兜底。宿主需要更新适配器引用并重新构建，
无需维护自己的 review ID 映射。进程终止失败时继续保留执行占用。

实现：[适配器 #46](https://github.com/LodyAI/acp-extension-codex/pull/46)。
关联问题：[Lody #196](https://github.com/LodyAI/Lody/issues/196)。
协议参考：[Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)。
