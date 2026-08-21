# task-02-bounded-spool

## 目标

为 taskd 暂时不可达的 adapter 事件提供有界、可恢复且权限收紧的本地 spool，并保证 replay 幂等。

## Contract

- spool 采用 NDJSON，目录与文件权限最小化；写入使用原子 rename。
- 按文件数、总字节数和事件年龄设硬上限，超限有可诊断丢弃计数。
- replay 成功后才删除记录；部分失败保留未确认事件；损坏记录隔离而不阻塞后续事件。
- spool 仅保存已通过 Event Envelope allowlist 的内容。

## 验收

- taskd 停止、重启、重复 replay、损坏文件与容量超限测试全部通过。
