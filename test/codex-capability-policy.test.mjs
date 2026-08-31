import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCodexCapabilityPolicyResolver,
  skillsThreadConfig,
} from '../server/src/runtime/codex-capability-policy.mjs'

const CHILD_ENVIRONMENT = Object.freeze({
  childEnvironment: (env) => ({ PATH: '/opt/tasks/bin', ...env }),
})

test('integration isolation resolves every configured MCP identity without shell execution', async () => {
  const calls = []
  const resolver = createCodexCapabilityPolicyResolver({
    runtimeEnvironment: CHILD_ENVIRONMENT,
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options })
      callback(null, JSON.stringify([
        { name: 'plain-server', enabled: true },
        { name: 'plugin-server', enabled: true },
        { name: 'plain-server', enabled: true },
      ]), '')
    },
  })

  const result = await resolver.resolveLaunch({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    capabilities: { skills: 'inherit', integrations: 'disabled' },
  })

  assert.deepEqual(calls, [{
    command: '/opt/tasks/bin/codex',
    args: [
      'mcp', 'list', '--json',
      '--disable', 'plugins',
      '-c', 'apps._default.enabled=false',
    ],
    options: {
      cwd: '/tmp/project',
      encoding: 'utf8',
      env: { PATH: '/opt/tasks/bin' },
      maxBuffer: 524_288,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
    },
  }])
  assert.deepEqual(result, {
    disabledFeatures: ['plugins'],
    configOverrides: [
      'apps._default.enabled=false',
      'mcp_servers.plain-server.enabled=false',
      'mcp_servers.plugin-server.enabled=false',
    ],
  })
})

test('inherited integrations perform no discovery or launch override', async () => {
  let calls = 0
  const resolver = createCodexCapabilityPolicyResolver({
    runtimeEnvironment: CHILD_ENVIRONMENT,
    execFileImpl() { calls += 1 },
  })
  assert.deepEqual(await resolver.resolveLaunch({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    capabilities: { skills: 'disabled', integrations: 'inherit' },
  }), { disabledFeatures: [], configOverrides: [] })
  assert.equal(calls, 0)
})

test('integration discovery fails closed on timeout, malformed output, and unsafe names', async () => {
  const cases = [
    [Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '', 'RUNTIME_CAPABILITY_DISCOVERY_TIMEOUT'],
    [null, '{broken', 'RUNTIME_CAPABILITY_DISCOVERY_INVALID'],
    [null, JSON.stringify([{ name: 'line\nbreak' }]), 'RUNTIME_CAPABILITY_DISCOVERY_INVALID'],
    [null, JSON.stringify([{ name: 'ambiguous.name' }]), 'RUNTIME_CAPABILITY_DISCOVERY_INVALID'],
  ]
  for (const [failure, stdout, code] of cases) {
    const resolver = createCodexCapabilityPolicyResolver({
      runtimeEnvironment: CHILD_ENVIRONMENT,
      execFileImpl(command, args, options, callback) { callback(failure, stdout, '') },
    })
    await assert.rejects(resolver.resolveLaunch({
      executable: '/opt/tasks/bin/codex',
      cwd: '/tmp/project',
      capabilities: { skills: 'inherit', integrations: 'disabled' },
    }), { code })
  }
})

test('skill isolation converts only the requested workspace discovery into thread config', () => {
  assert.deepEqual(skillsThreadConfig({
    data: [{
      cwd: '/tmp/project',
      errors: [],
      skills: [
        { name: 'beta', path: '/skills/beta/SKILL.md', enabled: true, description: 'beta', scope: 'user' },
        { name: 'alpha', path: '/skills/alpha/SKILL.md', enabled: true, description: 'alpha', scope: 'repo' },
        { name: 'beta-copy', path: '/skills/beta/SKILL.md', enabled: true, description: 'beta', scope: 'user' },
      ],
    }],
  }, { cwd: '/tmp/project' }), {
    skills: {
      config: [
        { path: '/skills/beta/SKILL.md', enabled: false },
        { path: '/skills/alpha/SKILL.md', enabled: false },
      ],
    },
    features: {
      skill_search: false,
      skill_mcp_dependency_install: false,
    },
  })
})

test('skill isolation rejects incomplete discovery instead of creating a partially isolated Thread', () => {
  assert.throws(() => skillsThreadConfig({ data: [{
    cwd: '/tmp/project',
    errors: [{ path: '/broken/SKILL.md', message: 'bad metadata' }],
    skills: [],
  }] }, { cwd: '/tmp/project' }), { code: 'RUNTIME_CAPABILITY_DISCOVERY_INVALID' })
  assert.throws(() => skillsThreadConfig({ data: [] }, { cwd: '/tmp/project' }), {
    code: 'RUNTIME_CAPABILITY_DISCOVERY_INVALID',
  })
})
