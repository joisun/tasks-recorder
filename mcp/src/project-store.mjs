import { createHash, randomUUID } from 'node:crypto'
import { normalize as normalizePath } from 'node:path'

import { TaskRecorderError } from './errors.mjs'
import { normalizeGitRemote } from './git-context.mjs'

const PROJECT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LOCATION_KINDS = new Set(['git_common_dir', 'workspace', 'git_remote', 'manual'])
const EXACT_LOCATION_KINDS = new Set(['git_common_dir', 'workspace', 'manual'])

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('PROJECT_INPUT_INVALID', `${field} must be a non-empty string`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === null || value === undefined) return null
  return requiredString(value, field)
}

function projectId(value) {
  const id = requiredString(value, 'id')
  if (!PROJECT_ID_PATTERN.test(id)) {
    fail('PROJECT_ID_INVALID', 'project id must use lowercase kebab-case', { id })
  }
  return id
}

function expectedRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    fail('PROJECT_INPUT_INVALID', 'expected_revision must be a positive integer', {
      field: 'expected_revision',
    })
  }
  return value
}

function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) fail('CLOCK_INVALID', 'clock must return a valid date')
  return date.toISOString()
}

function stableLocationId(projectId, kind, value) {
  const suffix = createHash('sha256')
    .update(`${projectId}\0${kind}\0${value}`)
    .digest('hex')
    .slice(0, 20)
  return `location-${suffix}`
}

export function normalizeProjectLocation(kind, value) {
  if (!LOCATION_KINDS.has(kind)) {
    fail('PROJECT_LOCATION_KIND_INVALID', 'unsupported project location kind', { kind })
  }
  const source = requiredString(value, 'value')
  if (kind === 'git_remote') {
    const remote = normalizeGitRemote(source)
    if (!remote) fail('PROJECT_LOCATION_INVALID', 'git remote is invalid', { kind })
    return remote
  }
  if (kind === 'manual') return source
  const normalized = normalizePath(source).replace(/\/+$/, '')
  return normalized === '' ? '/' : normalized
}

function defaultTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function createProjectStore({ db, clock = () => new Date(), transact } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('db must be a node:sqlite DatabaseSync')
  }
  const transaction = transact ?? ((operation) => defaultTransaction(db, operation))
  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?')
  const selectLocations = db.prepare(`
    SELECT * FROM project_locations
    WHERE project_id = ?
    ORDER BY kind, normalized_value, id
  `)
  const insertProject = db.prepare(`
    INSERT INTO projects (
      id, name, description, revision, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, 1, NULL, ?, ?)
  `)
  const updateProject = db.prepare(`
    UPDATE projects
    SET name = ?, description = ?, revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const archiveProject = db.prepare(`
    UPDATE projects
    SET archived_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const selectLocation = db.prepare(`
    SELECT * FROM project_locations
    WHERE project_id = ? AND kind = ? AND normalized_value = ?
  `)
  const selectExactOwner = db.prepare(`
    SELECT project_id FROM project_locations
    WHERE kind = ? AND normalized_value = ?
    ORDER BY project_id
    LIMIT 1
  `)
  const insertLocation = db.prepare(`
    INSERT INTO project_locations (
      id, project_id, kind, normalized_value, display_value, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const updateLocationSeen = db.prepare(`
    UPDATE project_locations
    SET display_value = ?, last_seen_at = ?
    WHERE id = ?
  `)
  const resolveExact = db.prepare(`
    SELECT project.* FROM project_locations location
    JOIN projects project ON project.id = location.project_id
    WHERE location.kind = ? AND location.normalized_value = ?
      AND project.archived_at IS NULL
    ORDER BY project.id
    LIMIT 1
  `)
  const resolveRemote = db.prepare(`
    SELECT DISTINCT project.* FROM project_locations location
    JOIN projects project ON project.id = location.project_id
    WHERE location.kind = 'git_remote' AND location.normalized_value = ?
      AND project.archived_at IS NULL
    ORDER BY project.name COLLATE NOCASE, project.id
  `)

  function requireProject(id) {
    const project = selectProject.get(projectId(id))
    if (!project) fail('PROJECT_NOT_FOUND', `project ${id} does not exist`, { id })
    return project
  }

  function show(id) {
    const project = requireProject(id)
    return { project, locations: selectLocations.all(project.id) }
  }

  function create(input) {
    const id = input.id === undefined ? randomUUID() : projectId(input.id)
    const name = requiredString(input.name, 'name')
    const description = optionalString(input.description, 'description')
    const timestamp = nowIso(clock)
    return transaction(() => {
      if (selectProject.get(id)) fail('PROJECT_EXISTS', `project ${id} already exists`, { id })
      insertProject.run(id, name, description, timestamp, timestamp)
      return { project: selectProject.get(id), changed: true }
    })
  }

  function update(input) {
    const id = projectId(input.id)
    const revision = expectedRevision(input.expected_revision)
    const patch = input.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      fail('PROJECT_INPUT_INVALID', 'patch must be an object', { field: 'patch' })
    }
    const unknown = Object.keys(patch).filter((key) => !['name', 'description'].includes(key))
    if (unknown.length > 0) {
      fail('PROJECT_INPUT_INVALID', 'patch contains unsupported fields', { fields: unknown })
    }
    return transaction(() => {
      const current = requireProject(id)
      if (current.revision !== revision) {
        fail('PROJECT_VERSION_CONFLICT', 'project revision does not match', {
          expected_revision: revision,
          current,
        })
      }
      const name = 'name' in patch ? requiredString(patch.name, 'name') : current.name
      const description = 'description' in patch
        ? optionalString(patch.description, 'description')
        : current.description
      if (name === current.name && description === current.description) {
        return { project: current, changed: false }
      }
      updateProject.run(name, description, nowIso(clock), id)
      return { project: selectProject.get(id), changed: true }
    })
  }

  function archive(input) {
    const id = projectId(input.id)
    const revision = expectedRevision(input.expected_revision)
    return transaction(() => {
      const current = requireProject(id)
      if (current.revision !== revision) {
        fail('PROJECT_VERSION_CONFLICT', 'project revision does not match', {
          expected_revision: revision,
          current,
        })
      }
      if (current.archived_at !== null) return { project: current, changed: false }
      const timestamp = nowIso(clock)
      archiveProject.run(timestamp, timestamp, id)
      return { project: selectProject.get(id), changed: true }
    })
  }

  function list(filters = {}) {
    const archived = filters.archived === true || filters.archived === 'true'
    return db.prepare(`
      SELECT * FROM projects
      WHERE archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
      ORDER BY name COLLATE NOCASE, id
    `).all()
  }

  function registerLocation(input) {
    const owner = requireProject(input.project_id)
    const kind = requiredString(input.kind, 'kind')
    const normalizedValue = normalizeProjectLocation(kind, input.value)
    const displayValue = kind === 'git_remote'
      ? normalizedValue
      : optionalString(input.display_value ?? input.value, 'display_value')
    const timestamp = input.observed_at === undefined
      ? nowIso(clock)
      : new Date(requiredString(input.observed_at, 'observed_at')).toISOString()
    return transaction(() => {
      const existing = selectLocation.get(owner.id, kind, normalizedValue)
      if (existing) {
        if (existing.last_seen_at === timestamp && existing.display_value === displayValue) {
          return { location: existing, changed: false }
        }
        updateLocationSeen.run(displayValue, timestamp, existing.id)
        return { location: selectLocation.get(owner.id, kind, normalizedValue), changed: true }
      }
      if (EXACT_LOCATION_KINDS.has(kind)) {
        const conflict = selectExactOwner.get(kind, normalizedValue)
        if (conflict && conflict.project_id !== owner.id) {
          fail('PROJECT_LOCATION_CONFLICT', 'exact project location already has an owner', {
            kind,
            normalized_value: normalizedValue,
            project_id: conflict.project_id,
          })
        }
      }
      insertLocation.run(
        stableLocationId(owner.id, kind, normalizedValue),
        owner.id,
        kind,
        normalizedValue,
        displayValue,
        timestamp,
        timestamp,
      )
      return { location: selectLocation.get(owner.id, kind, normalizedValue), changed: true }
    })
  }

  function resolved(project, reason) {
    return { status: 'resolved', project, reason, candidates: [] }
  }

  function resolveProject(input = {}) {
    if (input.explicit_project_id !== undefined && input.explicit_project_id !== null) {
      return resolved(requireProject(input.explicit_project_id), 'explicit_project_id')
    }
    if (optionalString(input.git_common_dir, 'git_common_dir')) {
      const value = normalizeProjectLocation('git_common_dir', input.git_common_dir)
      const project = resolveExact.get('git_common_dir', value)
      if (project) return resolved(project, 'git_common_dir')
    }
    const workspaceValues = [input.workspace, input.workfolder, input.worktree]
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => normalizeProjectLocation('workspace', value))
    for (const value of [...new Set(workspaceValues)]) {
      const project = resolveExact.get('workspace', value)
      if (project) return resolved(project, 'workspace')
    }
    if (optionalString(input.git_remote, 'git_remote')) {
      const remote = normalizeProjectLocation('git_remote', input.git_remote)
      const candidates = resolveRemote.all(remote)
      if (candidates.length > 0) {
        return {
          status: 'suggested',
          project: null,
          reason: 'git_remote',
          candidates,
        }
      }
    }
    return {
      status: 'unresolved',
      project: null,
      reason: 'insufficient_evidence',
      candidates: [],
    }
  }

  return { create, update, archive, list, show, registerLocation, resolve: resolveProject }
}
