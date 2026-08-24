import { TaskRecorderError } from '../../mcp/src/errors.mjs'

function resumeError(code, message, details) {
  return new TaskRecorderError(code, message, details)
}

function recentExecution(executions) {
  return [...executions].sort((left, right) => (
    String(right.last_seen_at).localeCompare(String(left.last_seen_at))
    || String(right.id).localeCompare(String(left.id))
  ))[0] ?? null
}

export function resolveTaskResumeTarget(snapshot, taskId) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  const task = tasks.find(({ id }) => id === taskId)
  if (!task || task.deleted_at) {
    throw resumeError('TASK_NOT_FOUND', `Task ${taskId} was not found.`, { task_id: taskId })
  }
  const scopeIds = new Set([task.id])
  if (task.parent_id === null) {
    for (const child of tasks.filter(({ parent_id: parentId }) => parentId === task.id)) {
      scopeIds.add(child.id)
    }
  }
  const executionIds = new Set(
    (Array.isArray(snapshot?.segments) ? snapshot.segments : [])
      .filter((segment) => segment.attribution_id && scopeIds.has(segment.task_id))
      .map(({ execution_id: executionId }) => executionId),
  )
  const execution = recentExecution(
    (Array.isArray(snapshot?.executions) ? snapshot.executions : [])
      .filter(({ id }) => executionIds.has(id)),
  )
  if (!execution) {
    throw resumeError('TASK_NOT_RESUMABLE', 'This task has no recorded session to resume.', {
      task_id: taskId,
    })
  }
  const sourceSession = (Array.isArray(snapshot?.source_sessions) ? snapshot.source_sessions : [])
    .find(({ id }) => id === execution.source_session_id)
  if (!sourceSession) {
    throw resumeError('SESSION_NOT_FOUND', 'The recorded source session no longer exists.', {
      task_id: taskId,
    })
  }
  const sessionSource = String(sourceSession.source).toLowerCase()
  if (!['codex', 'legacy'].includes(sessionSource)) {
    throw resumeError('SESSION_SOURCE_UNSUPPORTED', 'Only Codex sessions can currently be resumed.', {
      task_id: taskId,
      source: sourceSession.source,
    })
  }
  const workspace = execution.workfolder ?? execution.worktree
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw resumeError('WORKSPACE_INVALID', 'The recorded session does not have a Workspace.', {
      task_id: taskId,
    })
  }
  return {
    task_id: taskId,
    task_title: task.title,
    session_id: sourceSession.external_session_id,
    session_source: sessionSource,
    workspace,
  }
}

export function createSessionResumeService({
  store,
  settings,
  terminalLauncher,
  sessionInventory,
} = {}) {
  if (!store?.snapshot) throw new TypeError('store.snapshot is required')
  if (!settings?.get) throw new TypeError('settings.get is required')
  if (!terminalLauncher?.launch) throw new TypeError('terminalLauncher.launch is required')
  if (!sessionInventory?.has) throw new TypeError('sessionInventory.has is required')

  async function resumeTask(taskId) {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw resumeError('TASK_ID_INVALID', 'Task ID is required.')
    }
    const target = resolveTaskResumeTarget(store.snapshot(), taskId)
    if (!await sessionInventory.has(target.session_id)) {
      throw resumeError(
        'CODEX_SESSION_NOT_FOUND',
        'The Codex session transcript is not available on this Mac.',
        { task_id: taskId, session_id: target.session_id },
      )
    }
    const currentSettings = await settings.get()
    const launch = await terminalLauncher.launch({
      terminal: currentSettings.settings.resume_terminal,
      sessionId: target.session_id,
      workspace: target.workspace,
      title: target.task_title,
    })
    return { ok: true, ...target, ...launch }
  }

  return { resumeTask }
}
