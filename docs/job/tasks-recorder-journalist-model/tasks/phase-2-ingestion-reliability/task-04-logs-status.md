# task-04-logs-status

## 目标

建立可运维的 structured logs、retention 与 status diagnostics，使“服务不可用、事件被拒绝、spool 堆积、恢复发生”都能直接定位。

## Contract

- 日志为结构化 NDJSON，默认不包含 prompt、reasoning、raw tool payload 或凭据。
- 日志按大小/时间轮转并有 retention 上限；状态命令报告服务、schema、spool、最近 ingest 与 recovery 摘要。
- diagnostics 区分 live、ready、degraded，并输出稳定 machine-readable code。

## 验收

- 权限、redaction、rotation、retention 与 degraded status tests 全部通过。
