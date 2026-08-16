import { constants } from 'node:fs'
import { access as fsAccess, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'

import { TaskRecorderError } from './errors.mjs'
import { createDashboardSnapshot } from './dashboard-data.mjs'

export function createTaskService({
  store,
  gitResolver,
  renderer,
  outputDir,
  dashboardPath,
  access = fsAccess,
  stat = fsStat,
  dashboardAdapter = createDashboardSnapshot,
  onChange = () => undefined,
}) {
  async function preflightOutput() {
    try {
      await access(outputDir, constants.W_OK)
    } catch (error) {
      throw new TaskRecorderError(
        'OUTPUT_DIR_UNAVAILABLE',
        `projection output directory is not writable: ${outputDir}`,
        { outputDir, cause: error.message },
      )
    }
  }

  async function enrichContext(input) {
    const gitContext = await gitResolver(input.workfolder)
    return {
      ...input,
      git_root: gitContext.gitRoot,
      worktree: gitContext.worktree,
      branch: gitContext.branch,
    }
  }

  async function context(input) {
    const enriched = await enrichContext(input)
    return {
      ...store.context(enriched),
      git_context: {
        gitRoot: enriched.git_root,
        worktree: enriched.worktree,
        branch: enriched.branch,
      },
    }
  }

  async function updateProjection() {
    return renderer({
      loadSnapshot: () => store.snapshot(),
      outputDir,
    })
  }

  async function write(operation, input) {
    const enriched = await enrichContext(input)
    const persisted = store[operation](enriched)
    const change = onChange({
      type: 'tasks.changed',
      operation,
      task_id: persisted.task.id,
    })
    return {
      ok: true,
      persisted: true,
      ...persisted,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function render() {
    await preflightOutput()
    const projection = await updateProjection()
    return {
      ok: true,
      persisted: false,
      projection_updated: true,
      projection_stale: false,
      projection,
    }
  }

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

  async function mutateTask(operation, input) {
    const result = store[operation](input)
    if (!result.changed) {
      return { ok: true, persisted: false, ...result }
    }
    const change = onChange({
      type: 'tasks.changed',
      operation,
      task_id: result.task.id,
      affected_parent_id: result.affected_parent?.id ?? null,
    })
    return {
      ok: true,
      persisted: true,
      ...result,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function syncTree(input) {
    const enriched = await enrichContext(input)
    const result = store.syncTree(enriched)
    if (!result.changed) return { ok: true, persisted: false, ...result }
    const change = onChange({
      type: 'tasks.changed',
      operation: 'syncTree',
      task_id: result.root.id,
      focus_task_id: result.focused_task?.id ?? null,
    })
    return {
      ok: true,
      persisted: true,
      ...result,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function lifecycle(operation, input, { enrichGit = false } = {}) {
    const payload = enrichGit ? await enrichContext(input) : input
    const result = store[operation](payload)
    if (!result.changed) return { ok: true, persisted: false, ...result }
    const change = onChange({
      type: 'executions.changed',
      operation,
      execution_id: result.execution?.id ?? null,
      root_session_id: result.execution?.root_session_id
        ?? result.executions?.[0]?.root_session_id
        ?? input.root_session_id
        ?? null,
    })
    return {
      ok: true,
      persisted: true,
      ...result,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function mutateExecution(operation, input) {
    const result = store[operation](input)
    if (!result.changed) return { ok: true, persisted: false, ...result }
    const change = onChange({
      type: 'executions.changed',
      operation,
      execution_id: result.execution.id,
      task_id: result.execution.task_id,
    })
    return {
      ok: true,
      persisted: true,
      ...result,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function mutateExecutionBatch(input) {
    const result = store.updateExecutionAssignments(input)
    if (!result.changed) return { ok: true, persisted: false, ...result }
    const change = onChange({
      type: 'executions.changed',
      operation: 'updateExecutionAssignments',
      execution_ids: result.executions.map(({ id }) => id),
    })
    return {
      ok: true,
      persisted: true,
      ...result,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function importExecutions(input) {
    const warnings = Array.isArray(input?.warnings) ? input.warnings : []
    const result = store.importExecutions(input)
    if (!result.changed) {
      return { ok: true, persisted: false, ...result, warnings }
    }
    const change = onChange({
      type: 'executions.changed',
      operation: 'importExecutions',
      root_session_id: result.session_id,
      created: result.created,
      updated: result.updated,
    })
    return {
      ok: true,
      persisted: true,
      ...result,
      warnings,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function projectionStatus() {
    const tasksPath = join(outputDir, 'Tasks.md')
    const historyPath = join(outputDir, 'History.md')
    const snapshot = store.snapshot()
    try {
      const [tasksStat, historyStat] = await Promise.all([stat(tasksPath), stat(historyPath)])
      const latestUpdate = snapshot.tasks.reduce(
        (latest, task) => Math.max(latest, Date.parse(task.updated_at) || 0),
        0,
      )
      const projectionModified = Math.min(tasksStat.mtimeMs, historyStat.mtimeMs)
      return {
        fresh: projectionModified >= latestUpdate,
        tasksPath,
        historyPath,
        latest_task_update: latestUpdate === 0 ? null : new Date(latestUpdate).toISOString(),
        projection_modified_at: new Date(projectionModified).toISOString(),
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return {
        fresh: false,
        tasksPath,
        historyPath,
        latest_task_update: null,
        projection_modified_at: null,
      }
    }
  }

  async function dashboardSnapshot() {
    return dashboardAdapter(store.snapshot())
  }

  async function dashboardStatus() {
    if (!dashboardPath) return { available: false, build_path: null, built_at: null }
    try {
      const dashboardStat = await stat(dashboardPath)
      return {
        available: true,
        build_path: dashboardPath,
        built_at: new Date(dashboardStat.mtimeMs).toISOString(),
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { available: false, build_path: dashboardPath, built_at: null }
    }
  }

  return {
    context,
    list: (filters) => store.list(filters),
    show: (id) => store.show(id),
    upsert: (input) => write('upsert', input),
    complete: (input) => write('complete', input),
    syncTree,
    updateTask: (input) => mutateTask('updateTask', input),
    archiveTask: (input) => mutateTask('archiveTask', input),
    deleteTask: (input) => mutateTask('deleteTask', input),
    restoreTask: (input) => mutateTask('restoreTask', input),
    taskEvents: (filters) => store.taskEvents(filters),
    sessionStart: (input) => lifecycle('sessionStart', input),
    turnStart: (input) => lifecycle('turnStart', input, { enrichGit: true }),
    toolUse: (input) => lifecycle('toolUse', input),
    subagentStart: (input) => lifecycle('subagentStart', input, { enrichGit: true }),
    subagentStop: (input) => lifecycle('subagentStop', input),
    sessionEnd: (input) => lifecycle('sessionEnd', input),
    sessionContext: (id) => store.sessionContext(id),
    listExecutions: (filters) => store.listExecutions(filters),
    assignExecution: (input) => mutateExecution('assignExecution', input),
    classifyExecution: (input) => mutateExecution('classifyExecution', input),
    updateExecutionAssignments: mutateExecutionBatch,
    importExecutions,
    updateStatus,
    render,
    dashboardSnapshot,
    check: async () => ({
      ...store.check(),
      projection: await projectionStatus(),
      dashboard: await dashboardStatus(),
    }),
  }
}
