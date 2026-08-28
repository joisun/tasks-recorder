import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import test from 'node:test'

import { buildCodexInvocation } from '../server/src/scheduler/codex-run-spec.mjs'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-run-spec-'))
  const workspace = join(directory, 'workspace')
  const codexPath = join(directory, 'codex')
  await mkdir(workspace)
  await writeFile(codexPath, '#!/bin/sh\n')
  await chmod(codexPath, 0o700)
  return {
    workspace,
    codexPath,
    spec: {
      job_id: '11111111-1111-4111-8111-111111111111', definition_etag: 'a'.repeat(64), title: 'Real immutable snapshot',
      prompt: 'private prompt: never put me in argv', workspace, cadence: { kind: 'daily', hour: 9, minute: 5, timezone_mode: 'system' },
      timezone_mode: 'system', thread_mode: 'new', sandbox_mode: 'read-only', model: 'gpt-5.6-sol', reasoning_effort: 'ultra', timeout_seconds: 600,
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

test('builds the exact shell-free Codex invocation and keeps Prompt exclusively on stdin', async () => {
  const current = await fixture()
  try {
    const invocation = await buildCodexInvocation(current.spec, { codexPath: current.codexPath })
    assert.equal(invocation.command, await realpath(current.codexPath))
    assert.equal(invocation.cwd, await realpath(current.workspace))
    assert.equal(invocation.stdin, current.spec.prompt)
    assert.deepEqual(invocation.args, [
      'exec', '--json', '--color', 'never', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--cd', await realpath(current.workspace),
      '-c', 'approval_policy="never"', '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="ultra"', '-',
    ])
    assert.equal(invocation.args.includes(current.spec.prompt), false)
    assert.equal(invocation.args.some((argument) => argument.includes('dangerously-bypass')), false)
  } finally { await current.cleanup() }
})

test('accepts only the exact Task2 snapshot shape and keeps Codex machine configuration out of it', async () => {
  const current = await fixture()
  try {
    for (const spec of [
      { ...current.spec, workspace: join(current.workspace, 'missing') },
      { ...current.spec, sandbox_mode: 'unsafe' },
      { ...current.spec, model: '../unsafe-model' },
      { ...current.spec, reasoning_effort: 'HIGH!' },
      { ...current.spec, thread_mode: 'resume' },
      { ...current.spec, timezone_mode: 'utc' },
      { ...current.spec, cadence: { kind: 'daily', hour: 9 } },
      { ...current.spec, codex_path: current.codexPath },
      { ...current.spec, command: ['sh', '-c', 'evil'] },
      { ...current.spec, environment: { PATH: '/attacker' } },
    ]) {
      await assert.rejects(buildCodexInvocation(spec, { codexPath: current.codexPath }), { code: 'CODEX_INVOCATION_INVALID' })
    }
    await assert.rejects(buildCodexInvocation(current.spec, { codexPath: 'codex' }), { code: 'CODEX_INVOCATION_INVALID' })
  } finally { await current.cleanup() }
})
