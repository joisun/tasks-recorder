class TaskRecorderError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'TaskRecorderError'
    this.code = code
    this.details = details
  }
}

function normalizeGitRemote(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const source = value.trim()
  const canonical = source.match(/^([a-zA-Z0-9.-]+(?::[0-9]+)?)\/(.+)$/)
  if (canonical) {
    const host = canonical[1].toLowerCase()
    const path = canonical[2].replace(/\/+$/, '').replace(/\.git$/i, '')
    return path ? `${host}/${path}` : null
  }
  const scp = source.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
  if (scp && !source.includes('://')) {
    const host = scp[1].toLowerCase()
    const path = scp[2].replace(/\/+$/, '').replace(/\.git$/i, '')
    return path ? `${host}/${path}` : null
  }
  try {
    const remote = new URL(source)
    if (!['http:', 'https:', 'ssh:'].includes(remote.protocol)) return null
    remote.username = ''
    remote.password = ''
    remote.search = ''
    remote.hash = ''
    const path = remote.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!path || path === '/') return null
    const port = remote.port ? `:${remote.port}` : ''
    return `${remote.hostname.toLowerCase()}${port}${path}`
  } catch {
    return null
  }
}

const SOURCES = new Set(['codex', 'claude', 'dashboard', 'importer'])
const EVENT_TYPES = new Set([
  'session.started',
  'session.ended',
  'execution.started',
  'execution.heartbeat',
  'execution.stop',
])
const TOP_LEVEL_FIELDS = new Set([
  'source',
  'event_type',
  'external_event_id',
  'observed_at',
  'source_session_key',
  'root_session_key',
  'source_turn_key',
  'source_agent_key',
  'project_id',
  'workfolder',
  'git_root',
  'git_common_dir',
  'git_remote',
  'worktree',
  'branch',
  'payload',
])
const EXECUTION_KINDS = new Set(['main', 'subagent'])
const ACTIVITIES = new Set(['host_event', 'tool_use'])
const END_REASONS = new Set(['completed', 'stopped', 'interrupted', 'error', 'canceled'])

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function requireObject(value, field, code = 'EVENT_ENVELOPE_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${field} must be an object`, { field })
  }
  return value
}

function boundedString(value, field, { required = false, maxLength = 1024 } = {}) {
  if (value === null || value === undefined) {
    if (required) fail('EVENT_ENVELOPE_INVALID', `${field} is required`, { field })
    return null
  }
  if (typeof value !== 'string' || value.trim() === '') {
    fail('EVENT_ENVELOPE_INVALID', `${field} must be a non-empty string`, { field })
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    fail('EVENT_ENVELOPE_INVALID', `${field} exceeds ${maxLength} characters`, {
      field,
      max_length: maxLength,
    })
  }
  return normalized
}

function normalizedInstant(value) {
  const source = boundedString(value, 'observed_at', { required: true, maxLength: 64 })
  const date = new Date(source)
  if (Number.isNaN(date.valueOf())) {
    fail('EVENT_ENVELOPE_INVALID', 'observed_at must be a valid instant', {
      field: 'observed_at',
    })
  }
  return date.toISOString()
}

function rejectUnknownFields(value, allowed, code, message) {
  const fields = Object.keys(value).filter((field) => !allowed.has(field))
  if (fields.length > 0) fail(code, message, { fields: fields.sort() })
}

function payloadString(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    fail('EVENT_PAYLOAD_INVALID', `${field} has an unsupported value`, { field })
  }
  return value
}

function parsePayload(eventType, input) {
  const payload = requireObject(input, 'payload', 'EVENT_PAYLOAD_INVALID')
  if (eventType === 'session.started') {
    rejectUnknownFields(
      payload,
      new Set(),
      'EVENT_PAYLOAD_INVALID',
      'session.started payload contains unsupported fields',
    )
    return {}
  }
  if (eventType === 'session.ended') {
    rejectUnknownFields(
      payload,
      new Set(['end_reason']),
      'EVENT_PAYLOAD_INVALID',
      'session.ended payload contains unsupported fields',
    )
    return { end_reason: payloadString(payload.end_reason, 'end_reason', END_REASONS) }
  }
  if (eventType === 'execution.started') {
    rejectUnknownFields(
      payload,
      new Set(['kind', 'parent_execution_id']),
      'EVENT_PAYLOAD_INVALID',
      'execution.started payload contains unsupported fields',
    )
    const result = { kind: payloadString(payload.kind, 'kind', EXECUTION_KINDS) }
    if (payload.parent_execution_id !== undefined && payload.parent_execution_id !== null) {
      if (typeof payload.parent_execution_id !== 'string' || payload.parent_execution_id.trim() === '') {
        fail('EVENT_PAYLOAD_INVALID', 'parent_execution_id must be a non-empty string', {
          field: 'parent_execution_id',
        })
      }
      if (payload.parent_execution_id.trim().length > 1024) {
        fail('EVENT_PAYLOAD_INVALID', 'parent_execution_id exceeds 1024 characters', {
          field: 'parent_execution_id',
        })
      }
      result.parent_execution_id = payload.parent_execution_id.trim()
    }
    return result
  }
  if (eventType === 'execution.heartbeat') {
    rejectUnknownFields(
      payload,
      new Set(['activity', 'coalesced_count']),
      'EVENT_PAYLOAD_INVALID',
      'execution.heartbeat payload contains unsupported fields',
    )
    const result = {}
    if (payload.activity !== undefined) {
      result.activity = payloadString(payload.activity, 'activity', ACTIVITIES)
    }
    if (payload.coalesced_count !== undefined) {
      if (
        !Number.isInteger(payload.coalesced_count)
        || payload.coalesced_count < 1
        || payload.coalesced_count > 1_000_000
      ) {
        fail('EVENT_PAYLOAD_INVALID', 'coalesced_count must be an integer from 1 to 1000000', {
          field: 'coalesced_count',
        })
      }
      result.coalesced_count = payload.coalesced_count
    }
    return result
  }
  rejectUnknownFields(
    payload,
    new Set(['end_reason']),
    'EVENT_PAYLOAD_INVALID',
    'execution.stop payload contains unsupported fields',
  )
  return { end_reason: payloadString(payload.end_reason, 'end_reason', END_REASONS) }
}

export function parseEventEnvelope(input) {
  const envelope = requireObject(input, 'event')
  rejectUnknownFields(
    envelope,
    TOP_LEVEL_FIELDS,
    'EVENT_ENVELOPE_INVALID',
    'event contains unsupported fields',
  )

  const source = boundedString(envelope.source, 'source', { required: true, maxLength: 32 })
  if (!SOURCES.has(source)) {
    fail('EVENT_SOURCE_UNSUPPORTED', `event source ${source} is unsupported`, { source })
  }
  const eventType = boundedString(envelope.event_type, 'event_type', {
    required: true,
    maxLength: 64,
  })
  if (!EVENT_TYPES.has(eventType)) {
    fail('EVENT_TYPE_UNSUPPORTED', `event type ${eventType} is unsupported`, {
      event_type: eventType,
    })
  }

  const sourceSessionKey = boundedString(envelope.source_session_key, 'source_session_key', {
    required: true,
  })
  const sourceTurnKey = boundedString(envelope.source_turn_key, 'source_turn_key')
  const sourceAgentKey = boundedString(envelope.source_agent_key, 'source_agent_key')
  if (eventType.startsWith('execution.') && sourceTurnKey === null) {
    fail('EVENT_ENVELOPE_INVALID', 'source_turn_key is required for execution events', {
      field: 'source_turn_key',
    })
  }

  const payload = parsePayload(eventType, envelope.payload)
  if (eventType === 'execution.started' && payload.kind === 'subagent' && sourceAgentKey === null) {
    fail('EVENT_ENVELOPE_INVALID', 'source_agent_key is required for subagent execution', {
      field: 'source_agent_key',
    })
  }

  let gitRemote = boundedString(envelope.git_remote, 'git_remote', { maxLength: 4096 })
  if (gitRemote !== null) {
    gitRemote = normalizeGitRemote(gitRemote)
    if (gitRemote === null) {
      fail('EVENT_ENVELOPE_INVALID', 'git_remote must be a supported Git remote', {
        field: 'git_remote',
      })
    }
  }

  return {
    source,
    event_type: eventType,
    external_event_id: boundedString(envelope.external_event_id, 'external_event_id', {
      required: true,
    }),
    observed_at: normalizedInstant(envelope.observed_at),
    source_session_key: sourceSessionKey,
    root_session_key: boundedString(envelope.root_session_key, 'root_session_key'),
    source_turn_key: sourceTurnKey,
    source_agent_key: sourceAgentKey,
    project_id: boundedString(envelope.project_id, 'project_id'),
    workfolder: boundedString(envelope.workfolder, 'workfolder', { maxLength: 4096 }),
    git_root: boundedString(envelope.git_root, 'git_root', { maxLength: 4096 }),
    git_common_dir: boundedString(envelope.git_common_dir, 'git_common_dir', { maxLength: 4096 }),
    git_remote: gitRemote,
    worktree: boundedString(envelope.worktree, 'worktree', { maxLength: 4096 }),
    branch: boundedString(envelope.branch, 'branch'),
    payload,
  }
}

