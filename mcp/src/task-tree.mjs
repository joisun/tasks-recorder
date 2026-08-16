export const TASK_STATUSES = Object.freeze([
  'planned',
  'active',
  'waiting',
  'blocked',
  'done',
  'canceled',
])

const TASK_METADATA_FIELDS = Object.freeze([
  'parent_id',
  'project',
  'title',
  'description',
  'status',
  'start_date',
  'due_date',
  'next_action',
  'agent_key',
  'sort_order',
  'completed_at',
  'archived_at',
  'deleted_at',
])

export function taskMetadata(task) {
  return Object.fromEntries(TASK_METADATA_FIELDS.map((field) => [field, task?.[field] ?? null]))
}

export function taskDiff(before, after) {
  const previous = taskMetadata(before)
  const next = taskMetadata(after)
  return Object.fromEntries(TASK_METADATA_FIELDS
    .filter((field) => previous[field] !== next[field])
    .map((field) => [field, { before: previous[field], after: next[field] }]))
}

function eventTypeFor(field, change, after) {
  if (field === 'title') return 'renamed'
  if (field === 'description') return 'description_changed'
  if (field === 'status') return change.after === 'canceled' ? 'canceled' : 'status_changed'
  if (field === 'completed_at') return after?.status === 'canceled' ? 'canceled' : 'status_changed'
  if (field === 'parent_id' || field === 'project') return 'moved'
  if (field === 'sort_order') return 'reordered'
  if (field === 'archived_at') return change.after === null ? 'restored' : 'archived'
  if (field === 'deleted_at') return change.after === null ? 'restored' : 'deleted'
  return 'updated'
}

export function taskEventChanges(before, after) {
  const grouped = new Map()
  for (const [field, change] of Object.entries(taskDiff(before, after))) {
    const eventType = eventTypeFor(field, change, after)
    const entry = grouped.get(eventType) ?? { event_type: eventType, before: {}, after: {} }
    entry.before[field] = change.before
    entry.after[field] = change.after
    grouped.set(eventType, entry)
  }
  return [...grouped.values()]
}

export function taskProgress(root, children) {
  if (root?.parent_id !== null || !Array.isArray(children)) return null
  const included = children.filter((task) => task.deleted_at === null && task.status !== 'canceled')
  if (included.length === 0) return null
  const completed = included.filter((task) => task.status === 'done').length
  const total = included.length
  return {
    total,
    remaining: total - completed,
    completed,
    ratio: completed / total,
  }
}
