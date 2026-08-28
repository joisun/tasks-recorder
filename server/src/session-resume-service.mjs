import { isAbsolute } from 'node:path'

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

function scheduledRunTarget(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have resumable facts.')
  }
  if (
    typeof run.id !== 'string'
    || run.id.trim() === ''
    || typeof (run.schedule_id ?? run.job_id) !== 'string'
    || (run.schedule_id ?? run.job_id).trim() === ''
    || typeof (run.session_id ?? run.thread_id) !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(run.session_id ?? run.thread_id)
  ) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid Codex thread.', {
      run_id: run.id,
    })
  }

  let spec
  if (typeof run.spec_json === 'string') {
    try {
      spec = JSON.parse(run.spec_json)
    } catch {
      throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid immutable spec.', {
        run_id: run.id,
      })
    }
  } else {
    spec = { workspace: run.workspace, title: run.title }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid immutable spec.', {
      run_id: run.id,
    })
  }
  if (
    typeof spec.workspace !== 'string'
    || spec.workspace.trim() === ''
    || spec.workspace.length > 4096
    || !isAbsolute(spec.workspace)
    || typeof spec.title !== 'string'
    || spec.title.trim() === ''
    || spec.title.length > 200
  ) {
    throw resumeError('SCHEDULE_RUN_NOT_RESUMABLE', 'The Scheduled Run does not have a valid canonical Workspace and title.', {
      run_id: run.id,
    })
  }
  return {
    run_id: run.id,
    job_id: run.schedule_id ?? run.job_id,
    runtime_id: run.runtime_id ?? 'codex',
    session_id: run.session_id ?? run.thread_id,
    workspace: spec.workspace,
    title: spec.title,
  }
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
  schedulerService = null,
  runService = null,
} = {}) {
  if (!store?.snapshot) throw new TypeError('store.snapshot is required')
  if (!settings?.get) throw new TypeError('settings.get is required')
  if (!terminalLauncher?.launch) throw new TypeError('terminalLauncher.launch is required')
  if (!sessionInventory?.has) throw new TypeError('sessionInventory.has is required')
  if (schedulerService !== null && typeof schedulerService?.getRun !== 'function') {
    throw new TypeError('schedulerService.getRun is required when schedulerService is provided')
  }
  if (runService !== null && typeof runService?.resumeTarget !== 'function') {
    throw new TypeError('runService.resumeTarget is required when runService is provided')
  }

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

  async function resumeScheduledRun(runId) {
    const run = runService !== null
      ? runService.resumeTarget(runId)
      : (await schedulerService.getRun(runId)).run
    const target = scheduledRunTarget(run)
    if (target.runtime_id !== 'codex') {
      throw resumeError('RUNTIME_RESUME_UNSUPPORTED', 'This runtime cannot currently be resumed.', {
        run_id: target.run_id,
        runtime_id: target.runtime_id,
      })
    }
    if (!await sessionInventory.has(target.session_id)) {
      throw resumeError(
        'CODEX_SESSION_NOT_FOUND',
        'The Codex session transcript is not available on this Mac.',
        { run_id: target.run_id, session_id: target.session_id },
      )
    }
    const currentSettings = await settings.get()
    const launch = await terminalLauncher.launch({
      terminal: currentSettings.settings.resume_terminal,
      sessionId: target.session_id,
      workspace: target.workspace,
      title: target.title,
    })
    return {
      ok: true,
      run_id: target.run_id,
      job_id: target.job_id,
      terminal: launch.terminal,
      terminal_label: launch.terminal_label,
    }
  }

  return schedulerService === null && runService === null
    ? { resumeTask }
    : { resumeTask, resumeScheduledRun }
}
