# 定时任务可靠性修复与验证

## 根因与改动

- ai_news 实际会话为 workspace-write，但 network_access=false、approval_policy=never。新增独立 network_access 配置，显式传入原生 Codex thread 配置，不修改全局权限。
- 约 1.2 MiB 的工具记录超过旧 256 KiB 协议限制。改为 16 MiB 上限、分片累积；历史优先原生分页，旧 CLI 保留受限回退。
- Scheduled SSE 未刷新 schedules/runs。现在刷新列表、历史和元数据，重连补读状态；避免反复启动 CLI 加载终态对话。
- Session 原来只在终态保存，超时/取消分支丢失身份。现在创建时持久化，所有结束路径保留已知信息；运行结束前禁止并发 Terminal Resume。
- Live Session 增加手动重连、草稿保护、有限消息缓存、长指令折叠、历史读取重试和明确错误；手机抽屉宽度、正文与输入区域重新检查。
- 一次性任务到期后不能变为无效定义；手动运行计入最近运行时间；无效 cadence 返回输入错误；无效定义展示文件与原因。
- 事件连接保活、预览代理立即发送响应头；CI 与发布加入前端测试。

## 已完成验证

- 548 项后端测试、78 项前端测试，语法和类型检查通过；三份发布包构建成功。
- 真实 Codex workspace-write 联网：HTTP 200，生成 delivery.json；会话策略确认 network_access=true。
- 真实 Live steer 被接受，生成内容为 accepted 的 steer-proof.txt，Run succeeded。
- 真实自动到点触发：origin=scheduled，生成 scheduled-proof.txt，Run succeeded。
- 真实 60 秒超时：timed_out，保留 Session、说明与文件变更；重启恢复测试保留 Session 并显示 interrupted。
- 完整 ai_news：约 19 分钟后 succeeded；交付 12 版面、29 篇稿件、31 项模型记录及三张 Top 10。数据校验通过，桌面/手机深浅主题检查完成。产物、publication 和 review 的 SHA256 一致；来源未披露日期等限制保留于报纸档案。
- 服务重启复核：已到期一次性定义正常显示，invalid 列表为空；完整 ai_news 历史返回 14 条消息且未截断。
- 浏览器断网重连保留草稿；历史 503 后“重新读取”恢复；1920×1080 与 390×844 页面检查。视觉报告位于本工作区 .vdr-log/2026-09-14-scheduled-reliability/。
- 隔离验证计划已全部暂停，不影响正式计划。主 checkout 的其他未提交改动未纳入本次修改。

## 交付

本次版本 v0.8.5。发布与本地安装执行结果在最终交付回复中记录。
