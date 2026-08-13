# Dashboard Context, Timeline, and Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **执行状态（2026-08-13）：** Tasks 1–9 已实现并通过 automated、isolated browser 与 live read-only verification；项目尚无可用 Git `HEAD`，未创建 commit。

**Goal:** 为 standalone Tasks Recorder Dashboard 增加工作目录、worktree、branch 三列、可折叠 Timeline，以及具备并发和父子一致性保护的人工状态修改，并彻底移除 token/Bearer contract。

**Architecture:** SQLite 仍由 taskd 单独持有；Dashboard 通过 snapshot 读取 absolute context，通过窄 `PATCH /api/v1/tasks/:id/status` 修改 status，并由 SSE revision 触发 authoritative refresh。DHTMLX Gantt 继续全局 readonly，Grid 与 Timeline 使用两个 custom layout 切换，状态编辑由应用自己的 Pill/listbox 完成。

**Tech Stack:** Node.js 24、`node:sqlite`、原生 HTTP/REST + SSE、DHTMLX Gantt Standard 9.1、vanilla JavaScript/CSS、Node test runner、esbuild。

## Global Constraints

- 设计真源：`docs/superpowers/specs/2026-08-12-dashboard-context-timeline-status-design.md`。
- 只监听 `127.0.0.1`；Host 必须匹配实际 loopback origin；有 `Origin` 时必须 same-origin；不返回 CORS headers。
- 只开放 status mutation；不得开放标题、层级、日期、说明、Agent、Git context 或 Timeline drag/resize。
- `gantt.config.readonly = true` 保持不变；不得启用 DHTMLX inline editor、lightbox、drag/drop 或 PRO-only resizer。
- 每项 status mutation 必须在一个 SQLite transaction 内完成，使用 `expected_updated_at` optimistic concurrency，并最多发布一次 SSE `changed`。
- 最近 context 的 `workfolder`、`worktree`、`branch`、`last_activity` 必须来自同一条有效 session。
- Timeline 首次默认展开；折叠后 Grid 占满宽度；preference 使用 `dashboard-show-timeline`。
- 项目当前不是 Git repository；不得创建 commit、branch 或 worktree。每个任务以 focused tests 和变更清单作为 review gate。
- 不新增 production dependency，不升级 DHTMLX，不修改 schema version。
- 修改代码后扫描完整 Markdown 文档树；历史 standalone migration spec/plan 保留原始事实，不回写。

---

### Task 1: 扩展 authoritative Dashboard snapshot

**Files:**

- Modify: `mcp/src/dashboard-data.mjs:1-103`
- Modify: `test/dashboard-data.test.mjs:1-78`

**Interfaces:**

- Consumes: `createDashboardSnapshot(snapshot, options)`，其中 `snapshot` 来自 `store.snapshot()`。
- Produces: `createDashboardSnapshot(snapshot, { now, homeDirectory })`；顶层返回 `home_directory`，每个 task 返回 `workfolder | worktree | branch | updated_at`。

- [ ] **Step 1: 写 context 同源 session 与 optimistic version 的失败测试**

在 `test/dashboard-data.test.mjs` 中把第一个 snapshot 断言扩展为完整 contract，并增加“最近 session 字段为空时不得拼旧值”的测试：

```js
test('dashboard snapshot takes context from one newest valid session', () => {
  const result = createDashboardSnapshot({
    tasks: [baseTask],
    sessions: [
      {
        task_id: 'task-a', session_id: 'old', workfolder: '/Users/me/old',
        worktree: '/Users/me/old', branch: 'old', agent: 'Claude',
        last_seen_at: '2026-08-12T09:20:00.000Z',
      },
      {
        task_id: 'task-a', session_id: 'new', workfolder: '/Users/me/new',
        worktree: null, branch: null, agent: null,
        last_seen_at: '2026-08-12T09:30:00.000Z',
      },
      {
        task_id: 'task-a', session_id: 'invalid', workfolder: '/invalid',
        worktree: '/invalid', branch: 'invalid', agent: 'Invalid', last_seen_at: 'not-an-instant',
      },
    ],
  }, {
    now: new Date('2026-08-12T09:47:00.000Z'),
    homeDirectory: '/Users/me',
  })

  assert.equal(result.home_directory, '/Users/me')
  assert.deepEqual(result.tasks[0], {
    id: 'task-a', parent_id: null, title: 'Task A', status: 'active', agent: 'Claude',
    start: '2026-08-10T08:00:00.000Z', end: null,
    last_activity: '2026-08-12T09:30:00.000Z', next_action: 'Continue',
    workfolder: '/Users/me/new', worktree: null, branch: null,
    updated_at: '2026-08-10T08:00:00.000Z',
  })
})
```

在 invalid-data test 中再加入 `{ ...baseTask, id: 'invalid-version', updated_at: 'not-an-instant' }`，期望 warning `TASK_DATE_INVALID`。

- [ ] **Step 2: 运行测试，确认 RED**

Run: `node --test test/dashboard-data.test.mjs`

Expected: FAIL，因为 `home_directory` 和四个 task 字段尚未返回，invalid `updated_at` 尚未过滤。

- [ ] **Step 3: 实现 snapshot contract**

在 `mcp/src/dashboard-data.mjs` 引入 `homedir`，并保持 session 先规范化、后排序：

```js
import { homedir } from 'node:os'

export function createDashboardSnapshot(snapshot, {
  now = new Date(),
  homeDirectory = homedir(),
} = {}) {
  // existing generatedAt/tasks/sessions setup

  // invalid task predicate must also require validInstant(task.updated_at)

  const taskSessions = sessionsByTask.get(task.id) ?? []
  const recent = [...taskSessions]
    .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))[0]
  const recentAgent = [...taskSessions]
    .filter(({ agent }) => typeof agent === 'string' && agent.trim() !== '')
    .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))[0]

  return {
    id: task.id,
    parent_id: task.parent_id,
    title: task.title,
    status: task.status,
    agent: recentAgent?.agent || 'Unknown',
    start: taskStart(task),
    end: taskEnd(task),
    last_activity: recent?.last_seen_at ?? validInstant(task.updated_at),
    next_action: task.next_action,
    workfolder: typeof recent?.workfolder === 'string' ? recent.workfolder : null,
    worktree: typeof recent?.worktree === 'string' ? recent.worktree : null,
    branch: typeof recent?.branch === 'string' ? recent.branch : null,
    updated_at: validInstant(task.updated_at),
  }
}

return {
  generated_at: generatedAt,
  home_directory: homeDirectory,
  tasks: outputTasks,
  warnings,
}
```

不要为三个 context 字段分别寻找最新非空 session。

- [ ] **Step 4: 运行 focused tests，确认 GREEN**

Run: `node --test test/dashboard-data.test.mjs test/task-service.test.mjs`

Expected: PASS；`dashboardSnapshot` 仍不触发 Git discovery 或 Markdown render。

- [ ] **Step 5: Review gate**

检查 `git diff --name-only HEAD`；预期项目非 Git，命令失败。改用本任务 change ledger：`mcp/src/dashboard-data.mjs`、`test/dashboard-data.test.mjs`。确认没有 schema 或 session write 变化。

---

### Task 2: 实现事务化 status Store mutation

**Files:**

- Modify: `mcp/src/task-store.mjs:1-520`
- Modify: `test/task-store.test.mjs:1-110`

**Interfaces:**

- Consumes: `{ id, status, expected_updated_at }`，status 必须属于 `TASK_STATUSES`。
- Produces: `store.updateStatus(input) -> { task, affected_parent, changed }`。

- [ ] **Step 1: 写 transition、no-op 与 concurrency 的失败测试**

追加测试，使用可推进 clock：

```js
test('status mutation enforces optimistic concurrency and completion timestamps', async () => {
  let current = new Date('2026-08-12T08:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    const created = fixture.store.upsert(taskInput()).task
    current = new Date('2026-08-12T08:10:00.000Z')
    const done = fixture.store.updateStatus({
      id: created.id, status: 'done', expected_updated_at: created.updated_at,
    })
    assert.equal(done.changed, true)
    assert.equal(done.task.completed_at, '2026-08-12T08:10:00.000Z')

    const noop = fixture.store.updateStatus({
      id: created.id, status: 'done', expected_updated_at: done.task.updated_at,
    })
    assert.equal(noop.changed, false)
    assert.equal(noop.task.updated_at, done.task.updated_at)

    assert.throws(
      () => fixture.store.updateStatus({
        id: created.id, status: 'active', expected_updated_at: created.updated_at,
      }),
      (error) => error.code === 'TASK_VERSION_CONFLICT'
        && error.details.actual_updated_at === done.task.updated_at,
    )
  } finally {
    await fixture.cleanup()
  }
})
```

- [ ] **Step 2: 写父子一致性的失败测试**

```js
test('status mutation blocks incomplete parent and reopens a done parent with its child', async () => {
  let current = new Date('2026-08-12T08:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    const parent = fixture.store.upsert(taskInput({ id: 'parent', title: 'Parent' })).task
    const child = fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'parent', title: 'Child', status: 'active',
    })).task

    assert.throws(
      () => fixture.store.updateStatus({
        id: 'parent', status: 'done', expected_updated_at: parent.updated_at,
      }),
      (error) => error.code === 'CHILD_TASKS_INCOMPLETE'
        && error.details.child_ids[0] === 'child',
    )

    current = new Date('2026-08-12T08:10:00.000Z')
    const childDone = fixture.store.updateStatus({
      id: 'child', status: 'done', expected_updated_at: child.updated_at,
    }).task
    const parentDone = fixture.store.updateStatus({
      id: 'parent', status: 'done', expected_updated_at: parent.updated_at,
    }).task

    current = new Date('2026-08-12T08:20:00.000Z')
    const reopened = fixture.store.updateStatus({
      id: 'child', status: 'blocked', expected_updated_at: childDone.updated_at,
    })
    assert.equal(reopened.task.status, 'blocked')
    assert.equal(reopened.task.completed_at, null)
    assert.equal(reopened.affected_parent.status, 'active')
    assert.equal(reopened.affected_parent.completed_at, null)
    assert.notEqual(reopened.affected_parent.updated_at, parentDone.updated_at)
  } finally {
    await fixture.cleanup()
  }
})
```

- [ ] **Step 3: 运行测试，确认 RED**

Run: `node --test test/task-store.test.mjs`

Expected: FAIL with `fixture.store.updateStatus is not a function`。

- [ ] **Step 4: 增加最小 SQL statements 与 validation**

在 `createTaskStore` 内增加：

```js
const updateTaskStatus = db.prepare(`
  UPDATE tasks
  SET status = ?, completed_at = ?, updated_at = ?
  WHERE id = ?
`)

function normalizeExpectedUpdatedAt(value) {
  const expected = requiredString(value, 'expected_updated_at')
  if (Number.isNaN(Date.parse(expected))) {
    fail('TASK_INPUT_INVALID', 'expected_updated_at must be a valid instant', {
      field: 'expected_updated_at',
    })
  }
  return expected
}
```

- [ ] **Step 5: 实现一个 transaction 中的父子规则**

```js
function updateStatus(input) {
  const id = normalizeId(input.id)
  const status = normalizeStatus(input.status)
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expected_updated_at)

  return runTransaction(db, () => {
    const existing = selectTask.get(id)
    if (!existing) fail('TASK_NOT_FOUND', `task ${id} does not exist`, { id })
    if (existing.updated_at !== expectedUpdatedAt) {
      fail('TASK_VERSION_CONFLICT', `task ${id} was updated`, {
        id,
        expected_updated_at: expectedUpdatedAt,
        actual_updated_at: existing.updated_at,
      })
    }
    if (existing.status === status) {
      return { task: existing, affected_parent: null, changed: false }
    }

    const children = selectChildren.all(id)
    if (status === 'done') {
      const incomplete = children.filter((child) => child.status !== 'done')
      if (incomplete.length > 0) {
        fail('CHILD_TASKS_INCOMPLETE', 'all child tasks must be done first', {
          id,
          child_ids: incomplete.map((child) => child.id),
        })
      }
    }

    const timestamp = nowIso(clock)
    updateTaskStatus.run(
      status,
      status === 'done' ? existing.completed_at ?? timestamp : null,
      timestamp,
      id,
    )

    let affectedParent = null
    if (existing.status === 'done' && status !== 'done' && existing.parent_id !== null) {
      const parent = selectTask.get(existing.parent_id)
      if (parent?.status === 'done') {
        updateTaskStatus.run('active', null, timestamp, parent.id)
        affectedParent = selectTask.get(parent.id)
      }
    }
    return { task: selectTask.get(id), affected_parent: affectedParent, changed: true }
  })
}
```

把 `updateStatus` 加入 store return object。不要写 `task_sessions`，不要修改 sibling，不自动完成 parent。

- [ ] **Step 6: 扩展 validation 边界测试并确认 GREEN**

补充 `TASK_NOT_FOUND`、`TASK_STATUS_INVALID`、invalid `expected_updated_at` 的断言，然后运行：

Run: `node --test test/task-store.test.mjs`

Expected: PASS；失败 mutation 后原 task/parent 数据不变。

- [ ] **Step 7: Review gate**

检查本任务 change ledger 仅为 `mcp/src/task-store.mjs`、`test/task-store.test.mjs`；确认 schema version 仍为 `1`，每个 true change 只有一次 `COMMIT`。

---

### Task 3: 在 Service 层发布一次 status change

**Files:**

- Modify: `mcp/src/task-service.mjs:1-145`
- Modify: `test/task-service.test.mjs:1-110`

**Interfaces:**

- Consumes: Task 2 的 `store.updateStatus(input)`。
- Produces: `service.updateStatus(input)`；true change 返回 `{ ok:true, persisted:true, changed:true, task, affected_parent, change }`，no-op 返回 `persisted:false, changed:false` 且不含 `change`。

- [ ] **Step 1: 写一次发布与 no-op 不发布的失败测试**

```js
test('status service publishes exactly once only for a committed change', async () => {
  const notifications = []
  const store = {
    updateStatus: ({ status }) => ({
      task: { id: 'task-a', status },
      affected_parent: status === 'blocked' ? { id: 'parent', status: 'active' } : null,
      changed: status !== 'planned',
    }),
  }
  const service = createTaskService({
    store,
    gitResolver: async () => { throw new Error('must not resolve Git') },
    renderer: async () => { throw new Error('must not render') },
    outputDir: '/unused',
    onChange: (event) => {
      notifications.push(event)
      return { server_instance_id: 'server-a', revision: notifications.length }
    },
  })

  const changed = await service.updateStatus({ id: 'task-a', status: 'blocked' })
  assert.equal(changed.persisted, true)
  assert.equal(changed.changed, true)
  assert.equal(changed.change.revision, 1)
  assert.equal(notifications.length, 1)

  const noop = await service.updateStatus({ id: 'task-a', status: 'planned' })
  assert.equal(noop.persisted, false)
  assert.equal(noop.changed, false)
  assert.equal('change' in noop, false)
  assert.equal(notifications.length, 1)
})
```

- [ ] **Step 2: 运行测试，确认 RED**

Run: `node --test test/task-service.test.mjs`

Expected: FAIL because `service.updateStatus` is undefined。

- [ ] **Step 3: 实现独立于 Git enrichment 的 status service method**

```js
async function updateStatus(input) {
  const result = store.updateStatus(input)
  if (!result.changed) {
    return { ok: true, persisted: false, changed: false, ...result }
  }
  const change = onChange({
    type: 'tasks.changed',
    operation: 'updateStatus',
    task_id: result.task.id,
    affected_parent_id: result.affected_parent?.id ?? null,
  })
  return {
    ok: true,
    persisted: true,
    changed: true,
    ...result,
    ...(change === undefined ? {} : { change }),
  }
}
```

把 `updateStatus` 加入 service return object。不得复用会调用 `enrichContext()` 的 `write()`。

- [ ] **Step 4: 运行 focused tests，确认 GREEN**

Run: `node --test test/task-service.test.mjs test/task-store.test.mjs`

Expected: PASS；no-op、Store error 都不调用 `onChange`。

- [ ] **Step 5: Review gate**

确认 notification payload 中 operation 固定为 `updateStatus`，child + parent mutation 仍只有一个 publish。

---

### Task 4: 增加 status HTTP contract 并移除 Bearer gate

**Files:**

- Modify: `server/src/api-server.mjs:1-170`
- Modify: `mcp/src/task-client.mjs:1-75`
- Modify: `test/api-server.test.mjs:1-206`
- Modify: `test/task-client.test.mjs:1-87`
- Modify: `test/helpers.mjs:37-69`

**Interfaces:**

- Consumes: Task 3 的 `service.updateStatus({ id, status, expected_updated_at })`。
- Produces: `PATCH /api/v1/tasks/:id/status` 与 `client.updateStatus(input)`；所有 local Agent routes 不再需要 `Authorization`。

- [ ] **Step 1: 把 HTTP tests 改成无 token contract，并写 PATCH 失败测试**

从 API fixture 删除 `token` 与 `authenticated()`。所有 existing requests 直接发送；原 auth test 改名为 `local routes require loopback Host and same Origin without CORS`，并断言无 header 的 `GET /api/v1/tasks` 返回 `200`。

追加：

```js
test('status PATCH validates version, parent rules, and publishes one revision', async () => {
  const current = await fixture()
  try {
    const created = await fetch(`${current.url}/api/v1/tasks/example-task`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskInput()),
    }).then((response) => response.json())

    const response = await fetch(`${current.url}/api/v1/tasks/example-task/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Origin: current.url,
      },
      body: JSON.stringify({
        status: 'blocked',
        expected_updated_at: created.task.updated_at,
      }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.task.status, 'blocked')
    assert.equal(body.changed, true)
    assert.equal(body.change.revision, 2)

    const stale = await fetch(`${current.url}/api/v1/tasks/example-task/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: current.url },
      body: JSON.stringify({ status: 'done', expected_updated_at: created.task.updated_at }),
    })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).error.code, 'TASK_VERSION_CONFLICT')
    assert.equal(current.hub.current().revision, 2)
  } finally {
    await current.cleanup()
  }
})
```

同一文件增加 missing/wrong `Content-Type`、invalid JSON、invalid status、missing task、wrong Origin、`CHILD_TASKS_INCOMPLETE` 的 400/404/409/415 assertions。

- [ ] **Step 2: 改 client test，先确认无 Authorization 与新 PATCH 映射**

`recordingServer()` 继续记录 `authorization`，但 client 构造变成：

```js
const client = createTaskClient({ baseUrl: recorder.url, timeoutMs: 1_000 })
await client.updateStatus({
  id: 'task-a', status: 'blocked', expected_updated_at: '2026-08-12T08:00:00.000Z',
})
assert.ok(recorder.requests.every(({ authorization }) => authorization === undefined))
assert.deepEqual(recorder.requests.at(-1), {
  method: 'PATCH',
  url: '/api/v1/tasks/task-a/status',
  authorization: undefined,
  body: {
    status: 'blocked', expected_updated_at: '2026-08-12T08:00:00.000Z',
  },
})
```

- [ ] **Step 3: 运行 tests，确认 RED**

Run: `node --test test/api-server.test.mjs test/task-client.test.mjs`

Expected: FAIL because Bearer gate still returns 401 and PATCH/client method do not exist。

- [ ] **Step 4: 移除 Bearer code 并增加 409 mapping**

从 `server/src/api-server.mjs` 删除 `timingSafeEqual` import、`bearerMatches`、`token` parameter 以及 auth gate。更新 status mapping：

```js
function statusFor(error) {
  if (error.statusCode) return error.statusCode
  if (error.code === 'TASK_NOT_FOUND' || error.code === 'PARENT_NOT_FOUND') return 404
  if (error.code === 'TASK_VERSION_CONFLICT' || error.code === 'CHILD_TASKS_INCOMPLETE') return 409
  if (error instanceof TaskRecorderError) return 400
  return 500
}
```

- [ ] **Step 5: 增加 PATCH route**

把 status route 放在 general task route 之前：

```js
const taskStatus = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/status$/)
if (request.method === 'PATCH' && taskStatus) {
  requireJson(request)
  const input = await readJson(request)
  sendJson(response, 200, await service.updateStatus({
    ...input,
    id: decodeURIComponent(taskStatus[1]),
  }))
  return
}
```

不要增加 `OPTIONS` route 或 CORS header。

- [ ] **Step 6: 移除 client token 并实现 `updateStatus`**

`createTaskClient` signature 只保留 `{ baseUrl, fetchImpl, timeoutMs }`；headers 只含 `Accept` 与可选 `Content-Type`：

```js
updateStatus: ({ id, status, expected_updated_at }) => request(
  `/api/v1/tasks/${encodeURIComponent(id)}/status`,
  { method: 'PATCH', body: { status, expected_updated_at } },
),
```

- [ ] **Step 7: 运行 focused tests，确认 GREEN**

Run: `node --test test/api-server.test.mjs test/task-client.test.mjs test/task-service.test.mjs test/task-store.test.mjs`

Expected: PASS；wrong Host/Origin 仍为 403，无 CORS，status conflict 不增加 revision。

- [ ] **Step 8: Review gate**

运行 `rg -n "timingSafeEqual|AUTH_REQUIRED|Authorization:.*Bearer" server/src/api-server.mjs mcp/src/task-client.mjs test/api-server.test.mjs test/task-client.test.mjs`。

Expected: no matches。

---

### Task 5: 删除 token lifecycle 的全部 production contract

**Files:**

- Delete: `server/src/auth-token.mjs`
- Delete: `test/auth-token.test.mjs`
- Modify: `mcp/src/config.mjs:1-100`
- Modify: `mcp/server.mjs:1-25`
- Modify: `hooks/src/taskd-client.mjs:1-15`
- Modify: `server/src/taskd-runtime.mjs:1-60`
- Modify: `server/taskd.mjs:1-35`
- Modify: `server/control.mjs:1-192`
- Modify: `test/config.test.mjs:1-65`
- Modify: `test/control.test.mjs:1-96`
- Modify: `test/taskd-runtime.test.mjs:1-83`
- Modify: `test/hook.test.mjs:1-103`
- Modify: `test/server-integration.test.mjs:1-72`
- Modify: `test/helpers.mjs:1-70`

**Interfaces:**

- Consumes: Task 4 的 token-free `createTaskClient` / `createApiServer`。
- Produces: config/runtime/controller/MCP/Hook 均不读取、生成、传递或保留 auth token。

- [ ] **Step 1: 先改 token lifecycle tests 为目标 contract**

具体断言：

```js
assert.equal('tokenPath' in config, false)
```

Controller test 删除 `ensureToken` fake、counter 与 token file writes；install 只断言 build + plist + launchctl，uninstall 的 `preserved` 只含 stdout/stderr logs。Runtime tests 和 `temporaryApi` 删除 `token` argument。Hook/MCP integration fixtures 只创建 `config.json`，环境不再传 `AGENT_TASKS_TOKEN_PATH`。

- [ ] **Step 2: 运行受影响 tests，确认 RED**

Run: `node --test test/config.test.mjs test/control.test.mjs test/taskd-runtime.test.mjs test/hook.test.mjs test/server-integration.test.mjs`

Expected: FAIL on existing `tokenPath`、auth-token import 或 Bearer startup behavior。

- [ ] **Step 3: 删除 config token resolution**

从 `mcp/src/config.mjs` 删除 `AGENT_TASKS_TOKEN_PATH` validation、`tokenPath` calculation 与 return field。保留 database/output/server URL validation 不变。

- [ ] **Step 4: 删除 MCP、Hook 与 taskd runtime token wiring**

目标构造形式：

```js
// mcp/server.mjs
const service = createTaskClient({ baseUrl: config.serverBaseUrl })

// hooks/src/taskd-client.mjs
const client = createTaskClient({ baseUrl: config.serverBaseUrl, timeoutMs: 1_000 })

// server/taskd.mjs
const dashboardHtml = await readFile(dashboardPath, 'utf8')
const runtime = await startTaskd({ config, dashboardPath, dashboardHtml })

// server/src/taskd-runtime.mjs
export async function startTaskd({ config, dashboardPath, dashboardHtml, createStore, ...rest }) {
  // createApiServer receives no token
}
```

- [ ] **Step 5: 删除 controller token lifecycle 与文件**

从 `server/control.mjs` 删除 auth-token import、`ensureToken` injection、`paths.tokenPath`、install ensure call、uninstall token preservation。用 delete patch 删除 `server/src/auth-token.mjs` 和 `test/auth-token.test.mjs`。

- [ ] **Step 6: 运行 focused tests，确认 GREEN**

Run: `node --test test/config.test.mjs test/control.test.mjs test/taskd-runtime.test.mjs test/hook.test.mjs test/server-integration.test.mjs test/api-server.test.mjs test/task-client.test.mjs`

Expected: PASS；MCP stdio 与 heartbeat 均可在无 token 文件时访问 temporary taskd。

- [ ] **Step 7: 扫描 source contract**

Run:

```bash
rg -n "auth-token|AUTH_REQUIRED|Bearer|AGENT_TASKS_TOKEN|tokenPath|ensureAuthToken|readAuthToken" \
  README.md hooks mcp server skills test package.json \
  -g '!docs/superpowers/**'
```

Expected: 此阶段只允许 `README.md` / `skills/task-manager/SKILL.md` 的待更新文档命中；production/test code 无命中。

- [ ] **Step 8: Review gate**

确认删除范围只有两个 obsolete auth files；`config.json` 与 `tasks.sqlite` 仍位于 `~/.config/tasks-recorder`，LaunchAgent label/paths 未改变。

---

### Task 6: 增加 Grid context columns 与安全路径显示

**Files:**

- Modify: `ui/src/dashboard-state.mjs:1-120`
- Modify: `ui/src/dashboard.mjs:1-295`
- Modify: `ui/src/dashboard.css:1-40`
- Modify: `test/dashboard-ui-state.test.mjs:1-83`
- Modify: `test/dashboard-build.test.mjs:1-18`

**Interfaces:**

- Consumes: Task 1 snapshot 的 `home_directory` 与 task context fields。
- Produces: `formatHomePath(value, homeDirectory)`、`pathCell(task, field)`，Grid 顺序为 `任务 | 状态 | 工作目录 | Worktree | Branch | 说明 | Agent | 活动`。

- [ ] **Step 1: 写路径格式与 escaping 的失败测试**

```js
test('formats only the configured home prefix and preserves absolute tooltip data', () => {
  assert.equal(formatHomePath('/Users/me/project', '/Users/me'), '~/project')
  assert.equal(formatHomePath('/Users/me', '/Users/me'), '~')
  assert.equal(formatHomePath('/Users/other/project', '/Users/me'), '/Users/other/project')
  assert.equal(formatHomePath(null, '/Users/me'), '—')
  assert.equal(formatHomePath('/Users/me-too/project', '/Users/me'), '/Users/me-too/project')
})
```

列是否真实渲染、顺序是否正确由 Task 8 的 browser test 覆盖；不要新增只 grep bundle 文字的 change-detector assertion。

- [ ] **Step 2: 运行 tests，确认 RED**

Run: `node --test test/dashboard-ui-state.test.mjs test/dashboard-build.test.mjs`

Expected: unit test import 失败；build 还没有新列。

- [ ] **Step 3: 实现 segment-safe home shortening**

```js
export function formatHomePath(value, homeDirectory) {
  if (typeof value !== 'string' || value === '') return '—'
  if (typeof homeDirectory !== 'string' || homeDirectory === '') return value
  const home = homeDirectory.replace(/\/+$/, '')
  if (value === home) return '~'
  return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value
}
```

- [ ] **Step 4: 把 snapshot home/context 映射到 Gantt rows**

在 `dashboard.mjs` 增加 `homeDirectory` module state；`renderSnapshot` 设置 `homeDirectory = snapshot.home_directory || ''`。`ganttData()` 增加：

```js
workfolder: task.workfolder,
worktree: task.worktree,
branch: task.branch,
updated_at: task.updated_at,
```

路径 template 必须同时 escape visible text 与 title：

```js
function pathCell(field) {
  return (task) => {
    const absolute = task[field]
    if (!absolute) return '<span class="context-path is-empty">—</span>'
    return `<span class="context-path" title="${escapeHtml(absolute)}">${escapeHtml(formatHomePath(absolute, homeDirectory))}</span>`
  }
}
```

- [ ] **Step 5: 按固定顺序配置 8 列**

```js
gantt.config.columns = [
  { name: 'text', label: '任务', tree: true, width: 240, min_width: 180, template: taskLabel },
  { name: 'status', label: '状态', width: 72, align: 'center', template: statusPill },
  { name: 'workfolder', label: '工作目录', width: 180, min_width: 140, template: pathCell('workfolder') },
  { name: 'worktree', label: 'Worktree', width: 180, min_width: 140, template: pathCell('worktree') },
  { name: 'branch', label: 'Branch', width: 160, min_width: 120, template: pathCell('branch') },
  { name: 'note', label: '说明', width: 160, min_width: 120, template: noteCell },
  { name: 'agent', label: 'Agent', width: 78, align: 'center', template: agentChip },
  { name: 'activity', label: '活动', width: 56, align: 'right', template: activityCell },
]
```

更新 task-column resize bounds，让它只改变第一列，maximum 固定不超过 `520`，不要再用全部 fixed columns 反推 viewport maximum。

- [ ] **Step 6: 增加 context CSS 并构建**

```css
.context-path{display:block;overflow:hidden;color:var(--muted);font:10.5px var(--font-mono);text-align:left;text-overflow:ellipsis;white-space:nowrap}
.context-path.is-empty{color:var(--meta)}
```

Run: `npm run build && node --test test/dashboard-ui-state.test.mjs test/dashboard-build.test.mjs`

Expected: PASS；`ui/dist/index.html` 含三列 label，不含 fixture absolute paths。

- [ ] **Step 7: Review gate**

人工检查 templates：task-controlled title、path、branch、note、agent 全部经过 `escapeHtml`；绝对路径只进入 escaped `title`。

---

### Task 7: 实现可折叠 Timeline custom layouts

**Files:**

- Modify: `ui/src/dashboard-state.mjs:1-150`
- Modify: `ui/src/dashboard.mjs:1-360`
- Modify: `ui/src/dashboard.css:1-45`
- Modify: `test/dashboard-ui-state.test.mjs:1-120`
- Modify: `test/dashboard-build.test.mjs:1-25`

**Interfaces:**

- Consumes: DHTMLX `gantt.config.layout`、`gantt.resetLayout()`、`gantt.scrollLayoutCell()`。
- Produces: `createGanttLayout({ showTimeline, gridWidth })` 与 `dashboard-show-timeline` preference；expanded 有 independent X scrollbars + shared Y，collapsed 只有 full-width Grid。

- [ ] **Step 1: 写 layout factory 的失败测试**

```js
test('creates expanded and grid-only layouts without PRO resizers', () => {
  const expanded = createGanttLayout({ showTimeline: true, gridWidth: 640 })
  assert.equal(expanded.cols[0].width, 640)
  assert.equal(expanded.cols[0].rows[0].scrollX, 'gridScroll')
  assert.equal(expanded.cols[1].rows[0].view, 'timeline')
  assert.equal(expanded.cols[1].rows[0].scrollX, 'timelineScroll')
  assert.equal(expanded.cols[0].rows[0].scrollY, 'sharedScroll')
  assert.equal(expanded.cols[1].rows[0].scrollY, 'sharedScroll')
  assert.equal(JSON.stringify(expanded).includes('resizer'), false)

  const collapsed = createGanttLayout({ showTimeline: false, gridWidth: 640 })
  assert.equal(collapsed.cols.some((cell) => JSON.stringify(cell).includes('timeline')), false)
  assert.equal('width' in collapsed.cols[0], false)
})
```

Timeline 的真实 DOM、scroll 与 persistence 由本任务 browser spike 覆盖；不要新增只检查 bundle source text 的 assertion。

- [ ] **Step 2: 运行 tests，确认 RED**

Run: `node --test test/dashboard-ui-state.test.mjs test/dashboard-build.test.mjs`

Expected: FAIL because layout factory/toggle do not exist。

- [ ] **Step 3: 实现无 PRO resizer 的 layout factory**

```js
export function createGanttLayout({ showTimeline, gridWidth }) {
  const grid = {
    ...(showTimeline ? { width: gridWidth } : {}),
    rows: [
      { view: 'grid', id: 'grid', scrollable: true, scrollX: 'gridScroll', scrollY: 'sharedScroll' },
      { view: 'scrollbar', id: 'gridScroll', scroll: 'x', group: 'horizontal' },
    ],
  }
  const vertical = { view: 'scrollbar', id: 'sharedScroll', scroll: 'y' }
  if (!showTimeline) return { css: 'gantt_container', cols: [grid, vertical] }
  return {
    css: 'gantt_container',
    cols: [
      grid,
      {
        rows: [
          { view: 'timeline', id: 'timeline', scrollX: 'timelineScroll', scrollY: 'sharedScroll' },
          { view: 'scrollbar', id: 'timelineScroll', scroll: 'x', group: 'horizontal' },
        ],
      },
      vertical,
    ],
  }
}
```

- [ ] **Step 4: 增加 toggle 与 state capture/restore**

初始化：

```js
const TIMELINE_PANEL_KEY = 'dashboard-show-timeline'
let showTimeline = readBooleanPreference(resolvePreferenceStorage(), TIMELINE_PANEL_KEY, true)
let rememberedTimelineX = 0
```

实现 defensive state helpers；读取 layout view 的 `$state` 仅作为 DHTMLX 9.1 compatibility adapter，恢复使用 public API：

```js
function viewScroll(viewName) {
  const state = gantt.getLayoutView?.(viewName)?.$state
  return { x: Number(state?.scrollLeft) || 0, y: Number(state?.scrollTop) || 0 }
}

function applyLayout(nextShowTimeline) {
  const state = captureState()
  if (showTimeline) rememberedTimelineX = viewScroll('timeline').x
  showTimeline = nextShowTimeline
  gantt.config.layout = createGanttLayout({
    showTimeline,
    gridWidth: Math.min(680, Math.max(240, Math.round(document.getElementById('gantt_here').clientWidth * 0.56))),
  })
  gantt.resetLayout()
  gantt.scrollLayoutCell('grid', state.gridX, state.verticalY)
  if (showTimeline) gantt.scrollLayoutCell('timeline', rememberedTimelineX, state.verticalY)
  if (state.taskWidth) setTaskColumnWidth(state.taskWidth)
  renderTabs()
}
```

扩展 `captureState()` 返回 `gridX`、`timelineX`、`verticalY`，保留 `activeFilter` module state、open IDs、task width 和 label preference。Snapshot refresh 也用这些独立 scroll fields 恢复，不再假定 `gantt.getScrollState().x` 同时代表 Grid。

- [ ] **Step 5: 更新 toolbar 行为**

加入 Timeline toggle；`aria-pressed` 与 state 一致。collapsed 时 label toggle `disabled`；Locate handler：

```js
if (!showTimeline) {
  writeBooleanPreference(resolvePreferenceStorage(), TIMELINE_PANEL_KEY, true)
  applyLayout(true)
}
gantt.showDate(new Date())
```

普通 toggle 写入 localStorage 后调用 `applyLayout`。首次 `gantt.init` 前设置 factory layout，避免二次初始化。

- [ ] **Step 6: 更新 CSS 并运行 automated tests**

为 active toggle、disabled label control、两条 scrollbar 和 mobile toolbar 添加 styles；不得给 `body` 增加横向滚动。

Run: `npm run build && node --test test/dashboard-ui-state.test.mjs test/dashboard-build.test.mjs`

Expected: PASS。

- [ ] **Step 7: 用现有 Playwright MCP 做 focused layout spike**

启动 isolated taskd 后使用 `playwright-headless`，在 1440px viewport 验证：

1. expanded 同时存在 `.gantt_grid`、`.gantt_task` 和两条 horizontal scrollbar；
2. Grid 与 Timeline 分别横向滚动时互不改变对方 X；
3. vertical scroll 后 row alignment 不变；
4. collapse 后 `.gantt_task` 不存在且 Grid width 接近 container width；
5. 再展开后 tree open state、Grid X、Timeline X、Y、task width 与 label preference 恢复。

若 DHTMLX Standard 9.1 的实际 layout state 与 adapter 不同，只调整 `viewScroll/applyLayout` compatibility code，不改变公开设计。

- [ ] **Step 8: Review gate**

记录 browser evidence（viewport、DOM counts、scroll positions）；确认未出现 PRO license warning、page-level horizontal overflow 或 snapshot refetch caused by layout toggle。

---

### Task 8: 实现 Status Pill listbox 与 authoritative recovery

**Files:**

- Modify: `ui/src/dashboard-state.mjs:1-180`
- Modify: `ui/src/dashboard.mjs:1-460`
- Modify: `ui/src/dashboard.css:1-70`
- Modify: `test/dashboard-ui-state.test.mjs:1-150`
- Modify: `test/dashboard-build.test.mjs:1-35`

**Interfaces:**

- Consumes: Task 4 status PATCH、Task 1 `task.updated_at`、existing snapshot coordinator。
- Produces: keyboard/mouse accessible Pill listbox、per-task pending lock、server error mapping、success/SSE authoritative refresh。

- [ ] **Step 1: 写 status message 与 build contract 的失败测试**

```js
test('maps status mutation errors to actionable Chinese messages', () => {
  assert.equal(statusMutationMessage({ code: 'TASK_VERSION_CONFLICT' }), '任务已被其他 Agent 或页面更新，已刷新最新状态')
  assert.equal(statusMutationMessage({
    code: 'CHILD_TASKS_INCOMPLETE', details: { child_ids: ['child-a', 'child-b'] },
  }), '请先完成子任务：child-a、child-b')
  assert.equal(statusMutationMessage({ code: 'TASK_NOT_FOUND' }), '任务已不存在，已刷新列表')
  assert.equal(statusMutationMessage({ code: 'ORIGIN_REJECTED' }), '状态修改被本机安全策略拒绝')
})
```

PATCH payload、ARIA 与 keyboard interaction 分别由 API integration 和 real browser test 覆盖；不要新增只检查 bundle source text 的 assertion。

- [ ] **Step 2: 运行 tests，确认 RED**

Run: `node --test test/dashboard-ui-state.test.mjs test/dashboard-build.test.mjs`

Expected: FAIL on missing mapper and interactive status contract。

- [ ] **Step 3: 实现纯 error mapper**

```js
export function statusMutationMessage(error) {
  switch (error?.code) {
    case 'TASK_VERSION_CONFLICT': return '任务已被其他 Agent 或页面更新，已刷新最新状态'
    case 'CHILD_TASKS_INCOMPLETE': {
      const ids = Array.isArray(error.details?.child_ids) ? error.details.child_ids : []
      return ids.length ? `请先完成子任务：${ids.join('、')}` : '请先完成所有子任务'
    }
    case 'TASK_NOT_FOUND': return '任务已不存在，已刷新列表'
    case 'HOST_REJECTED':
    case 'ORIGIN_REJECTED': return '状态修改被本机安全策略拒绝'
    case 'TASK_STATUS_INVALID': return '状态请求无效'
    default: return '状态修改失败，仍显示最后一次成功数据'
  }
}
```

- [ ] **Step 4: 把 Pill 改成 button 并建立单一 floating listbox**

维护：

```js
const STATUS_ORDER = ['planned', 'active', 'waiting', 'blocked', 'done']
const pendingStatus = new Set()
let openStatusTaskId = null
let coordinator = null
```

Pill template 输出 escaped id、`aria-haspopup="listbox"`、`aria-expanded`、pending disabled/busy。点击时在 `.app` 下创建一个 `position:fixed` menu；options 使用 `role="option"` 与 `aria-selected`。Menu event delegation 必须支持：Enter/Space 打开、ArrowUp/ArrowDown、Home/End、Enter 选择、Escape/外部 click 关闭，并把 focus 还给 trigger。把当前启动分支中的 `const coordinator = createSnapshotCoordinator(...)` 改为对 module-level `coordinator` 赋值，确保 mutation handler 与 SSE handler 使用同一 coordinator。

- [ ] **Step 5: 实现 PATCH 与 pending/error recovery**

```js
async function updateTaskStatus(taskId, status) {
  const task = raw.find((item) => item.id === taskId)
  if (!task || pendingStatus.has(taskId) || task.status === status) return
  pendingStatus.add(taskId)
  gantt.refreshTask(taskId)
  try {
    const response = await fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}/status`, {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, expected_updated_at: task.updated_at }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      const error = result?.error ?? { code: 'SERVICE_RESPONSE_INVALID' }
      announceMutation(statusMutationMessage(error))
      if (['TASK_VERSION_CONFLICT', 'TASK_NOT_FOUND'].includes(error.code)) coordinator.invalidate()
      return
    }
    coordinator.invalidate()
  } catch {
    announceMutation('状态修改失败，仍显示最后一次成功数据')
  } finally {
    pendingStatus.delete(taskId)
    if (gantt.isTaskExists(taskId)) gantt.refreshTask(taskId)
  }
}
```

不要客户端改写 `raw` status。把 connection 与 mutation message 分开存储，统一渲染到现有 `#refresh-state[aria-live]`，防止 SSE reconnect 状态误清 mutation error。

- [ ] **Step 6: 增加 focus/pending/menu CSS 并构建**

Styles 必须包括：Pill button reset、hover/focus-visible、`aria-busy`、fixed listbox、selected option、mobile viewport clamping、`prefers-reduced-motion`。Menu 不得被 `.gantt_grid_data` overflow 裁剪。

Run: `npm run build && node --test test/dashboard-ui-state.test.mjs test/dashboard-build.test.mjs`

Expected: PASS。

- [ ] **Step 7: 使用 `visual-driven-ui-test-skill@joi` 做 broad UI validation**

按该 skill 指令使用 `playwright-headless`，覆盖 360 / 768 / 1440 viewport 与这些状态：

1. 三列 context 的 `~` display、absolute tooltip、ellipsis、空值；
2. expanded/collapsed、Locate auto-expand、localStorage reload；
3. mouse 与全 keyboard listbox；
4. pending duplicate prevention；
5. success 后 SSE/snapshot authoritative update；
6. stale version、incomplete children、network unavailable；
7. child reopen 后 parent 变 active，任务组离开 History；
8. 无 page-level horizontal overflow，focus ring 清晰，menu 不被裁剪。

- [ ] **Step 8: Review gate**

保存本轮 screenshot/DOM/console evidence 到执行记录，不写入项目根目录；确认 console 无 uncaught error，DHTMLX 仍 readonly。

---

### Task 9: 同步文档、迁移本机 runtime 并完成验收

**Files:**

- Modify: `README.md`
- Modify: `skills/task-manager/SKILL.md`
- Modify: `ui/dist/index.html`（由 `npm run build` 生成）
- Runtime delete: `/Users/joi-com/.config/tasks-recorder/auth-token`
- Runtime replace: `/Users/joi-com/Library/LaunchAgents/com.joi.tasks-recorder.taskd.plist`（由 controller install 原子写入）

**Interfaces:**

- Consumes: Tasks 1-8 的完整 code/runtime contract。
- Produces: 可开源理解的安装/访问/安全说明，运行中的 token-free taskd，以及完整验证证据。

- [ ] **Step 1: 先做全量 Markdown scan**

Run:

```bash
git diff --name-only HEAD || true
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"
rg -n "auth-token|Bearer|Authorization|Dashboard|Timeline|worktree|branch|状态" \
  --glob '*.md' --glob '!node_modules/**'
```

记录项目不是 Git repo，因此用 Tasks 1-9 的 file ledger 代替 `git diff`。`docs/superpowers/specs/2026-08-12-standalone-migration-design.md` 与 `docs/superpowers/plans/2026-08-12-standalone-migration.md` 是历史记录，不修改。

- [ ] **Step 2: 更新 README public contract**

README 必须明确：

- 用户状态目录只有 `config.json` 与 `tasks.sqlite`；
- `npm run taskd -- install|start|stop|status|uninstall` 与访问 URL；
- Dashboard 三个 context 列、Timeline toggle、status correction；
- status PATCH request/response 与 `expected_updated_at` conflict；
- Server 只信任同用户 local processes，限制为 `127.0.0.1` + Host + Origin + no CORS；不声称隔离同用户进程；
- 不再生成或需要 token/Bearer/`AGENT_TASKS_TOKEN_PATH`。

- [ ] **Step 3: 更新 task-manager skill**

删除 token 假设；继续要求 Agent 通过 MCP/taskd 做 semantic maintenance。补充一句：Dashboard status correction 只用于 Hook/lifecycle 漏更新，不替代 `agent_tasks_context`、`agent_tasks_upsert`、`agent_tasks_complete`。

- [ ] **Step 4: 构建并运行完整 automated suite**

Run: `npm run build && npm test && npm run check`

Expected: all tests PASS；syntax check PASS；built Dashboard 小于 2 MiB。

- [ ] **Step 5: 扫描 token 与 forbidden UI capabilities**

Run:

```bash
rg -n "auth-token|AUTH_REQUIRED|Bearer|AGENT_TASKS_TOKEN|tokenPath|ensureAuthToken|readAuthToken" \
  README.md hooks mcp server skills test package.json ui/src ui/dist
rg -n "inline_edit|lightbox|drag_move\s*=\s*true|drag_resize\s*=\s*true" ui/src
```

Expected: no token matches；无新 inline/lightbox/drag enablement；历史 docs 不在该 scan 范围。

- [ ] **Step 6: 安全替换本机 taskd 并删除 obsolete token**

先解析 exact targets，不使用 `$HOME`、`~` 或 glob：

```bash
npm run taskd -- stop
ls -ld /Users/joi-com/.config/tasks-recorder
if [ -e /Users/joi-com/.config/tasks-recorder/auth-token ]; then ls -l /Users/joi-com/.config/tasks-recorder/auth-token; fi
```

确认目录与文件精确匹配后只删除 obsolete token，再运行：

```bash
node --input-type=module -e "import { unlink } from 'node:fs/promises'; await unlink('/Users/joi-com/.config/tasks-recorder/auth-token').catch((error) => { if (error.code !== 'ENOENT') throw error })"
npm run taskd -- install
npm run taskd -- status
```

Expected: status `loaded:true`、`ready:true`；token path 不存在。不得删除 `config.json`、`tasks.sqlite`、WAL/SHM 或日志。

- [ ] **Step 7: 运行 live API/runtime smoke tests**

Run:

```bash
curl --fail --silent http://127.0.0.1:43127/health/ready
curl --fail --silent http://127.0.0.1:43127/api/v1/snapshot
test ! -e /Users/joi-com/.config/tasks-recorder/auth-token
```

Live runtime 只做 read-only health/snapshot smoke，不修改用户数据库。Status write、revision 与 SQLite 一致性已经在 temporary database 的 Store/API/browser tests 中验证；不要为了 smoke test 创建或改写用户 task。

- [ ] **Step 8: 最终 browser regression**

用 Task 8 相同的 `visual-driven-ui-test-skill@joi` + `playwright-headless` 流程连接 live taskd，read-only 复验 360 / 768 / 1440、Timeline state persistence 与 context columns；status success/error 继续使用 isolated temporary taskd，避免触碰用户任务。

- [ ] **Step 9: 最终 Johari 与 First Principles completion check**

- Open Area：用 automated + live + browser evidence 证明三列、toggle、status mutation、无 token。
- Hidden Area：确认没有修改用户真实任务状态或历史 migration 文档。
- Blind Spot：确认 same-user local process trust risk 已写入 README，History/parent-child 行为有测试。
- Unknown Area：若 DHTMLX scroll restore 仍有版本特例，记录精确 viewport/DOM/state evidence，不把未验证行为描述为完成。

- [ ] **Step 10: 交付 review gate**

列出本次所有 changed/deleted/generated files、完整命令结果、live taskd 状态、obsolete token 已删除与 browser evidence。不要 commit；如用户之后要求 Git history，先初始化/确认 repository 策略。

---

## Plan Self-Review

- **Spec coverage:** Task 1 覆盖 context/updated_at；Tasks 2-4 覆盖 status transaction/service/API；Task 5 覆盖 token removal；Tasks 6-8 覆盖三列、Timeline、Pill 与 responsive/a11y；Task 9 覆盖 docs/runtime/full verification。
- **File boundaries:** Store 不依赖 HTTP；Service 只发布 change；API 负责 transport/status code；Dashboard state 保持 pure helpers；`dashboard.mjs` 只做 DHTMLX/DOM orchestration。
- **Type consistency:** 全链路统一使用 `expected_updated_at`、`affected_parent`、`changed`；snapshot 统一使用 `home_directory`、`workfolder`、`worktree`、`branch`、`updated_at`。
- **Concurrency:** no-op 先校验 version；true change 一次 transaction、一次 publish；409 不 publish；client 不 optimistic overwrite。
- **Security:** 没有 token 后仍保留 loopback bind、Host/Origin、no CORS、JSON/body limit；文档明确 same-user-process trust boundary。
- **Execution completeness:** 每项行为都有具体 file、signature、test、command 与 expected result，没有模糊的延后实现步骤。
- **Repository constraint:** 项目无 Git，因此刻意不包含 commit steps，符合用户“不自动 commit”的 workspace policy。
