# task-03-project-domain

## 目标

实现 Project/ProjectLocation 的稳定 identity、revision concurrency 与精确 local evidence resolver。

## 文件

- Create: `mcp/src/project-store.mjs`
- Create: `test/project-store.test.mjs`
- Create: `test/project-resolution.test.mjs`
- Modify: `mcp/src/git-context.mjs`

## Contract

```js
projectStore.create/update/archive/list/show
projectStore.registerLocation
projectStore.resolve({ explicit_project_id, git_common_dir, workfolder, git_remote, branch })
```

resolution 只允许 explicit ID、exact registered git common dir、exact registered workspace 自动确定；remote 只返回 suggestion；branch 被忽略。

## TDD steps

- [ ] 写 create/update/revision/location uniqueness failing tests。
- [ ] 验证 RED 后实现最小 store。
- [ ] 写两个 repo 同为 `main`、同 remote 不自动 merge、multi-worktree single Project failing tests。
- [ ] 实现 resolver 与 credential-free Git context normalization。
- [ ] 跑 focused tests和 schema invariant regression。

## 验收

- Project 改名/移动目录不换 ID。
- branch-only resolution 返回 unresolved。
- URL userinfo/credential 不进入 database/report。
