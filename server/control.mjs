#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAppConfig } from '../mcp/src/config.mjs'

export const LAUNCH_AGENT_LABEL = 'com.joi.tasks-recorder.taskd'

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character])
}

export function renderLaunchAgentPlist({
  label,
  nodePath,
  taskdPath,
  workingDirectory,
  stdoutPath,
  stderrPath,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(taskdPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`
}

async function runCommand(command, args, { allowFailure = false } = {}) {
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolveResult({ code, stdout, stderr }))
  })
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.code}`}`)
  }
  return result
}

async function defaultProbeHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(500) })
    const result = await response.json().catch(() => ({}))
    return { ...result, reachable: true }
  } catch {
    return null
  }
}

export function createTaskdController({
  projectRoot,
  config,
  homeDirectory = homedir(),
  nodePath = process.execPath,
  nodeVersion = process.versions.node,
  uid = process.getuid(),
  run = runCommand,
  build = () => run(nodePath, [join(projectRoot, 'ui', 'build.mjs')]),
  probeHealth = defaultProbeHealth,
}) {
  const launchAgentsDirectory = join(homeDirectory, 'Library', 'LaunchAgents')
  const logDirectory = join(homeDirectory, 'Library', 'Logs', 'tasks-recorder')
  const paths = {
    plistPath: join(launchAgentsDirectory, `${LAUNCH_AGENT_LABEL}.plist`),
    stdoutPath: join(logDirectory, 'taskd.stdout.log'),
    stderrPath: join(logDirectory, 'taskd.stderr.log'),
    taskdPath: join(projectRoot, 'server', 'taskd.mjs'),
  }
  const domain = `gui/${uid}`
  const serviceTarget = `${domain}/${LAUNCH_AGENT_LABEL}`

  async function writePlist() {
    await Promise.all([
      mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(logDirectory, { recursive: true, mode: 0o700 }),
    ])
    const plist = renderLaunchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      nodePath,
      taskdPath: paths.taskdPath,
      workingDirectory: projectRoot,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
    })
    const temporaryPath = `${paths.plistPath}.${process.pid}.tmp`
    await writeFile(temporaryPath, plist, { mode: 0o600 })
    await rename(temporaryPath, paths.plistPath)
  }

  async function install() {
    if (Number(nodeVersion.split('.')[0]) < 24) {
      throw new Error('tasks-recorder taskd requires Node.js 24 or newer')
    }
    const health = await probeHealth(config.serverBaseUrl)
    if (health && health.service !== 'tasks-recorder') {
      throw new Error(`${config.serverBaseUrl} is occupied by another service`)
    }
    await build()
    await writePlist()
    await run('launchctl', ['bootout', domain, paths.plistPath], { allowFailure: true })
    await run('launchctl', ['bootstrap', domain, paths.plistPath])
    return { label: LAUNCH_AGENT_LABEL, plistPath: paths.plistPath, url: config.serverBaseUrl }
  }

  async function start() {
    await access(paths.plistPath)
    const loaded = await run('launchctl', ['print', serviceTarget], { allowFailure: true })
    if (loaded.code === 0) await run('launchctl', ['kickstart', '-k', serviceTarget])
    else await run('launchctl', ['bootstrap', domain, paths.plistPath])
    return status()
  }

  async function stop() {
    await run('launchctl', ['bootout', domain, paths.plistPath], { allowFailure: true })
    return { stopped: true, label: LAUNCH_AGENT_LABEL }
  }

  async function status() {
    const launchd = await run('launchctl', ['print', serviceTarget], { allowFailure: true })
    const health = await probeHealth(config.serverBaseUrl)
    return {
      label: LAUNCH_AGENT_LABEL,
      loaded: launchd.code === 0,
      ready: health?.service === 'tasks-recorder' && health.ready !== false,
      url: config.serverBaseUrl,
      plistPath: paths.plistPath,
    }
  }

  async function uninstall() {
    await run('launchctl', ['bootout', domain, paths.plistPath], { allowFailure: true })
    await rm(paths.plistPath, { force: true })
    return { uninstalled: true, preserved: [paths.stdoutPath, paths.stderrPath] }
  }

  return { install, start, stop, status, uninstall, paths }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('tasks-recorder taskd controller currently requires macOS')
  const projectRoot = fileURLToPath(new URL('..', import.meta.url))
  const config = await resolveAppConfig({ projectRoot })
  const controller = createTaskdController({ projectRoot, config })
  const command = process.argv[2] ?? 'status'
  if (!['install', 'start', 'stop', 'status', 'uninstall'].includes(command)) {
    throw new Error('usage: npm run taskd -- install|start|stop|status|uninstall')
  }
  const result = await controller[command]()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
