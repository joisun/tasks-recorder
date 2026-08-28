# task-13-real-visual-docs

**所属 phase**：phase-5-validation-rollout
**前置依赖**：task-12 automated E2E 全绿。

## 目标

以真实 macOS launchd/Codex、Visual Driven Review、文档树与 package/install audit 证明功能达到可交付标准。

## 涉及范围

- 修改：`README.md`、authoritative journalist spec、workflow test docs。
- 修改：文档全扫描命中的其他 Markdown。
- 不执行：commit、push、Release、正式本机安装更新，除非用户另行授权。

## 验收标准

- [ ] test plan/cases/report 覆盖 spec 全部风险且 P0 全绿；仅真实 OS gate 尚缺直接 evidence。
- [x] Playwright MCP/VDR 覆盖 desktop/narrow 与 Scheduled 多状态、keyboard/focus/overflow。
- [ ] 真实 2–3 分钟 read-only launchd Run 产生 thread、Hook fact、Review 与 Resume。
- [ ] sleep/wake 真实验证；若无法执行，test report 明确未验证，不夸大结论。
- [x] README How it works/permissions/timezone/missed run/logs/diagnostics/uninstall 与架构 docs 同步。
- [x] full docs scan、release archive、installed-runtime fake smoke、privacy audit 通过。
- [ ] requirement-by-requirement completion audit 无缺口；真实 OS evidence 是唯一剩余 gate。

## 备注

对外 Git/release/local update 是后续独立授权 checkpoint。
