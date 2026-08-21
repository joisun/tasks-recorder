import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { discoverGitContext, normalizeGitRemote } from '../mcp/src/git-context.mjs'
import { createProjectStore } from '../mcp/src/project-store.mjs'
import { createSchemaV3 } from '../mcp/src/schema-v3.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createSchemaV3(db)
  const store = createProjectStore({
    db,
    clock: () => new Date('2026-08-19T01:00:00.000Z'),
  })
  store.create({ id: 'project-a', name: 'Project A' })
  store.create({ id: 'project-b', name: 'Project B' })
  store.registerLocation({
    project_id: 'project-a', kind: 'git_common_dir', value: '/repo/a/.git',
  })
  store.registerLocation({
    project_id: 'project-a', kind: 'workspace', value: '/repo/a/.worktree/feature-a',
  })
  store.registerLocation({
    project_id: 'project-a', kind: 'git_remote', value: 'https://github.com/example/shared',
  })
  store.registerLocation({
    project_id: 'project-b', kind: 'git_common_dir', value: '/repo/b/.git',
  })
  store.registerLocation({
    project_id: 'project-b', kind: 'git_remote', value: 'https://github.com/example/shared',
  })
  return { db, store }
}

test('project resolution accepts explicit and exact local evidence but never branch alone', () => {
  const { db, store } = fixture()
  try {
    assert.deepEqual(store.resolve({ explicit_project_id: 'project-b', branch: 'main' }), {
      status: 'resolved',
      project: store.show('project-b').project,
      reason: 'explicit_project_id',
      candidates: [],
    })
    assert.equal(store.resolve({ git_common_dir: '/repo/a/.git/' }).project.id, 'project-a')
    assert.equal(
      store.resolve({ workfolder: '/repo/a/.worktree/feature-a' }).project.id,
      'project-a',
    )
    assert.deepEqual(store.resolve({ branch: 'main' }), {
      status: 'unresolved',
      project: null,
      reason: 'insufficient_evidence',
      candidates: [],
    })
  } finally {
    db.close()
  }
})

test('matching remote produces suggestions and never silently merges projects', () => {
  const { db, store } = fixture()
  try {
    const result = store.resolve({ git_remote: 'git@github.com:example/shared.git' })
    assert.equal(result.status, 'suggested')
    assert.equal(result.project, null)
    assert.equal(result.reason, 'git_remote')
    assert.deepEqual(result.candidates.map(({ id }) => id), ['project-a', 'project-b'])
  } finally {
    db.close()
  }
})

test('Git context exposes common dir and credential-free normalized remote', async () => {
  const outputs = new Map([
    ['rev-parse --show-toplevel', '/repo/worktree\n'],
    ['rev-parse --git-common-dir', '/repo/.git\n'],
    ['branch --show-current', 'feature/a\n'],
    ['remote get-url origin', 'https://user:secret@GitHub.com/Example/Repo.git\n'],
  ])
  const execFile = async (_command, args) => ({ stdout: outputs.get(args.slice(2).join(' ')) })

  assert.equal(
    normalizeGitRemote('https://user:secret@GitHub.com/Example/Repo.git'),
    'github.com/Example/Repo',
  )
  assert.equal(
    normalizeGitRemote('git@github.com:Example/Repo.git'),
    'github.com/Example/Repo',
  )
  assert.deepEqual(await discoverGitContext('/repo/worktree', {
    execFile,
    realpath: async (value) => value,
  }), {
    gitRoot: '/repo',
    gitCommonDir: '/repo/.git',
    gitRemote: 'github.com/Example/Repo',
    worktree: '/repo/worktree',
    branch: 'feature/a',
  })
})
