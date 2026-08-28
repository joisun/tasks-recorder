import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeFileChanges } from '../server/src/runs/workspace-change-tracker.mjs'

test('Workspace change evidence stays bounded to the Run ledger contract', () => {
  const observed = Array.from({ length: 130 }, (_, index) => ({
    path: `file-${String(index).padStart(3, '0')}.md`,
    kind: 'update',
  }))

  const merged = mergeFileChanges([], observed)

  assert.equal(merged.length, 128)
  assert.deepEqual(merged.at(-1), { path: 'file-127.md', kind: 'update' })
})
