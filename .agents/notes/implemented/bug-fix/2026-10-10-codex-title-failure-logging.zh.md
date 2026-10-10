# 记录 Codex 标题失败，不发送对话事件

Status: implemented
Translation: current

[English](2026-10-10-codex-title-failure-logging.md)

## 摘要

Codex 标题生成可能在原生 turn 已携带错误时仍静默结束：`runTurn` 会正常返回失败结果，标题生成器却只读取输出内容。适配器现在记录失败结果、异常和不可用标题，但不发送对话事件。原生错误字段和关联 ID 会保留。模型选择和重试行为保持不变，本次改动用于诊断，不宣称修复路由问题。

## 决策与证据

`src/TitleGenerator.ts` 使用已有 Logger：配置后写入 `APP_SERVER_LOGS/app-server.log`，否则写 stderr。失败结果包含主线程与临时线程 ID、turn ID、模型、状态及序列化的原生错误。不额外记录源提示词或生成内容。保留空 catch，或仅捕获异常，仍会遗漏正常返回的失败结果。

标题生成继续尽力完成，不增加 ACP 消息或主对话错误。

## 验证

标题生成测试覆盖文件和 stderr 诊断、原生错误保留、失败不发布标题、不写 stdout、异常及不可用输出。九项测试与适配器类型检查通过。未在受影响用户机器上复现真实服务错误；该机器需运行重新构建并安装的版本才能采集新增诊断。
