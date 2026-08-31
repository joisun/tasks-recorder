import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

import { createRuntimeEnvironment } from './runtime-environment.mjs'

const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const MAX_MCP_SERVERS = 256
const MAX_SKILLS = 2_048

export function createCodexCapabilityPolicyResolver({
  execFileImpl = execFile,
  runtimeEnvironment = createRuntimeEnvironment({ env: process.env }),
  timeoutMs = 5_000,
  maximumBytes = 512 * 1024,
} = {}) {
  if (typeof execFileImpl !== 'function'
    || typeof runtimeEnvironment?.childEnvironment !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('Codex capability policy resolver options are invalid')
  }

  return Object.freeze({
    async resolveLaunch({ executable, cwd, capabilities } = {}) {
      if (typeof executable !== 'string' || executable.length === 0
        || typeof cwd !== 'string' || cwd.length === 0) {
        throw new TypeError('Codex capability launch options are invalid')
      }
      if (capabilities?.integrations !== 'disabled') {
        return { disabledFeatures: [], configOverrides: [] }
      }
      const stdout = await listMcpServers({
        execFileImpl, executable, cwd, runtimeEnvironment, timeoutMs, maximumBytes,
      })
      const names = parseMcpServers(stdout)
      return {
        disabledFeatures: ['plugins'],
        configOverrides: [
          'apps._default.enabled=false',
          ...names.map((name) => `mcp_servers.${name}.enabled=false`),
        ],
      }
    },
  })
}

export function skillsThreadConfig(response, { cwd } = {}) {
  if (!response || typeof response !== 'object' || !Array.isArray(response.data)
    || response.data.length > 16 || typeof cwd !== 'string' || cwd.length === 0) {
    throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  }
  const matches = response.data.filter((entry) => entry?.cwd === cwd)
  if (matches.length !== 1) throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  const entry = matches[0]
  if (!Array.isArray(entry.errors) || entry.errors.length > 0
    || !Array.isArray(entry.skills) || entry.skills.length > MAX_SKILLS) {
    throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  }
  const paths = []
  const seen = new Set()
  for (const skill of entry.skills) {
    const path = skill?.path
    if (typeof path !== 'string' || path.length === 0 || path.length > 4_096
      || !isAbsolute(path) || path.includes('\0')) {
      throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
    }
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return {
    skills: { config: paths.map((path) => ({ path, enabled: false })) },
    features: {
      skill_search: false,
      skill_mcp_dependency_install: false,
    },
  }
}

function listMcpServers({
  execFileImpl, executable, cwd, runtimeEnvironment, timeoutMs, maximumBytes,
}) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, [
      'mcp', 'list', '--json',
      '--disable', 'plugins',
      '-c', 'apps._default.enabled=false',
    ], {
      cwd,
      encoding: 'utf8',
      env: runtimeEnvironment.childEnvironment({}),
      maxBuffer: maximumBytes,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(capabilityError(
          error.killed || error.signal || error.code === 'ETIMEDOUT'
            ? 'RUNTIME_CAPABILITY_DISCOVERY_TIMEOUT'
            : 'RUNTIME_CAPABILITY_DISCOVERY_FAILED',
        ))
        return
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''))
    })
  })
}

function parseMcpServers(source) {
  let value
  try { value = JSON.parse(source) } catch {
    throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  }
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) {
    throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
  }
  const names = []
  const seen = new Set()
  for (const server of value) {
    const name = server?.name
    if (typeof name !== 'string' || !MCP_NAME.test(name)) {
      throw capabilityError('RUNTIME_CAPABILITY_DISCOVERY_INVALID')
    }
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function capabilityError(code) {
  return Object.assign(new Error(code), { code })
}
