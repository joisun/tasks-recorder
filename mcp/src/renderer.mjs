import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { TaskRecorderError } from './errors.mjs'

const START_MARKER = '<!-- tasks-recorder:start -->'
const END_MARKER = '<!-- tasks-recorder:end -->'
const LOCK_RETRY_MS = 25
const LOCK_ATTEMPTS = 40

const STATUS_TAGS = Object.freeze({
  planned: '',
  active: 'active',
  waiting: 'active',
  blocked: 'crit, active',
  done: 'done',
})

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function taskDate(value, fallback) {
  const date = typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : fallback
  return date
}

function addUtcDay(dateText) {
  const date = new Date(`${dateText}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function sanitizeText(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replaceAll(':', '：')
    .replaceAll(';', '；')
    .trim()
}

function displayTitle(task) {
  const hierarchyPrefix = task.parent_id === null ? '' : '↳ '
  const statusPrefix = task.status === 'waiting'
    ? '[等待] '
    : task.status === 'blocked'
      ? '[阻塞] '
      : ''
  return sanitizeText(`${hierarchyPrefix}${statusPrefix}${task.title}`)
}

function compareTasks(left, right) {
  return left.start_date.localeCompare(right.start_date) || left.id.localeCompare(right.id)
}

function orderProjectTasks(tasks) {
  const ids = new Set(tasks.map(({ id }) => id))
  const childrenByParent = new Map()
  for (const task of tasks) {
    if (task.parent_id === null || !ids.has(task.parent_id)) continue
    const children = childrenByParent.get(task.parent_id) ?? []
    children.push(task)
    childrenByParent.set(task.parent_id, children)
  }

  const roots = tasks
    .filter((task) => task.parent_id === null || !ids.has(task.parent_id))
    .sort(compareTasks)
  const ordered = []
  for (const root of roots) {
    ordered.push(root)
    ordered.push(...(childrenByParent.get(root.id) ?? []).sort(compareTasks))
  }
  return ordered
}

function taskEndDate(task) {
  if (task.status === 'done') {
    return taskDate(task.completed_at, taskDate(task.updated_at, task.start_date))
  }
  if (task.due_date) return task.due_date
  return addUtcDay(taskDate(task.updated_at, task.start_date))
}

function mermaidLine(task) {
  const tags = STATUS_TAGS[task.status]
  if (tags === undefined) {
    throw new TaskRecorderError('TASK_STATUS_INVALID', `unsupported task status: ${task.status}`)
  }
  const metadata = tags ? `${tags}, ${task.id}` : task.id
  return `    ${displayTitle(task)} :${metadata}, ${task.start_date}, ${taskEndDate(task)}`
}

function generateMermaid(tasks, title) {
  const projects = new Map()
  for (const task of tasks) {
    const project = sanitizeText(task.project || '独立任务') || '独立任务'
    const projectTasks = projects.get(project) ?? []
    projectTasks.push(task)
    projects.set(project, projectTasks)
  }

  const lines = [
    '```mermaid',
    'gantt',
    `    title ${title}`,
    '    dateFormat YYYY-MM-DD',
    '    axisFormat %m-%d',
  ]
  for (const project of [...projects.keys()].sort((left, right) => left.localeCompare(right))) {
    lines.push('', `    section ${project}`)
    for (const task of orderProjectTasks(projects.get(project))) {
      lines.push(mermaidLine(task))
    }
  }
  if (tasks.length === 0) {
    lines.push('', '    section 暂无任务')
  }
  lines.push('```')
  return lines.join('\n')
}

function defaultDocument(heading) {
  return `# ${heading}\n\n此文件由 tasks-recorder 从 SQLite 自动生成；marker 外内容可手工维护。\n\n${START_MARKER}\n${END_MARKER}\n`
}

function markerCount(content, marker) {
  return content.split(marker).length - 1
}

function replaceGeneratedBlock(content, generated, filePath) {
  if (markerCount(content, START_MARKER) !== 1 || markerCount(content, END_MARKER) !== 1) {
    throw new TaskRecorderError(
      'PROJECTION_MARKER_INVALID',
      `${filePath} must contain exactly one tasks-recorder marker pair`,
      { filePath },
    )
  }
  const start = content.indexOf(START_MARKER)
  const end = content.indexOf(END_MARKER)
  if (start > end) {
    throw new TaskRecorderError(
      'PROJECTION_MARKER_INVALID',
      `${filePath} has reversed tasks-recorder markers`,
      { filePath },
    )
  }
  const before = content.slice(0, start + START_MARKER.length)
  const after = content.slice(end)
  return `${before}\n${generated}\n${after}`
}

async function readProjection(filePath, heading) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return defaultDocument(heading)
    throw error
  }
}

async function acquireLock(lockPath, now) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: now.toISOString() }))
      return handle
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (attempt === LOCK_ATTEMPTS - 1) {
        throw new TaskRecorderError(
          'PROJECTION_LOCKED',
          'timed out waiting for the projection render lock',
          { lockPath },
        )
      }
      await delay(LOCK_RETRY_MS)
    }
  }
  throw new TaskRecorderError('PROJECTION_LOCKED', 'could not acquire the projection render lock')
}

async function ignoreMissingUnlink(filePath) {
  try {
    await unlink(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export async function renderProjections({ loadSnapshot, outputDir, now = new Date() }) {
  const timestamp = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(timestamp.valueOf())) {
    throw new TaskRecorderError('CLOCK_INVALID', 'now must be a valid date')
  }
  await mkdir(outputDir, { recursive: true })

  const tasksPath = join(outputDir, 'Tasks.md')
  const historyPath = join(outputDir, 'History.md')
  const lockPath = join(outputDir, '.render.lock')
  const temporarySuffix = `${process.pid}.${randomUUID()}.tmp`
  const tasksTemporaryPath = `${tasksPath}.${temporarySuffix}`
  const historyTemporaryPath = `${historyPath}.${temporarySuffix}`
  let lockHandle

  try {
    lockHandle = await acquireLock(lockPath, timestamp)
    const snapshot = await loadSnapshot()
    if (!snapshot || !Array.isArray(snapshot.tasks)) {
      throw new TaskRecorderError('SNAPSHOT_INVALID', 'loadSnapshot must return a tasks array')
    }

    const currentTasks = snapshot.tasks.filter(({ status }) => status !== 'done')
    const historicalTasks = snapshot.tasks.filter(({ status }) => status === 'done')
    const currentShell = await readProjection(tasksPath, '当前 Agent 任务')
    const historyShell = await readProjection(historyPath, '历史 Agent 任务')
    const currentContent = replaceGeneratedBlock(
      currentShell,
      generateMermaid(currentTasks, 'AI Agent Tasks'),
      tasksPath,
    )
    const historyContent = replaceGeneratedBlock(
      historyShell,
      generateMermaid(historicalTasks, 'AI Agent Task History'),
      historyPath,
    )

    await writeFile(tasksTemporaryPath, currentContent, { flag: 'wx' })
    await writeFile(historyTemporaryPath, historyContent, { flag: 'wx' })
    await rename(tasksTemporaryPath, tasksPath)
    await rename(historyTemporaryPath, historyPath)

    return { tasksPath, historyPath }
  } finally {
    await ignoreMissingUnlink(tasksTemporaryPath)
    await ignoreMissingUnlink(historyTemporaryPath)
    if (lockHandle) {
      await lockHandle.close()
      await ignoreMissingUnlink(lockPath)
    }
  }
}
