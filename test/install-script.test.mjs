import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, cp, mkdtemp, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { packageRelease } from '../scripts/package-release.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(new URL('..', import.meta.url).pathname)

function runInstaller({ homeDirectory, releaseDirectory, args = [] }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', [join(projectRoot, 'install.sh'), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeDirectory,
        TASKS_RECORDER_RELEASE_BASE_URL: `file://${releaseDirectory}`,
        TASKS_RECORDER_TEST_PLATFORM: 'Darwin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolveResult({ code, stdout, stderr }))
  })
}

async function createReleaseFixture(directory) {
  await packageRelease({ projectRoot, outputDirectory: directory })
  await cp(join(projectRoot, 'install.sh'), join(directory, 'install.sh'))
  await chmod(join(directory, 'install.sh'), 0o755)
  const { stdout } = await execFileAsync('shasum', [
    '-a', '256',
    'tasks-recorder-macos.tar.gz',
  ], { cwd: directory })
  await writeFile(join(directory, 'SHA256SUMS'), stdout)
}

test('installer creates versioned runtime and preserves existing config/database on reinstall', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-home-'))
  const releaseDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-release-'))
  try {
    await createReleaseFixture(releaseDirectory)
    const dataDirectory = join(homeDirectory, '.config', 'tasks-recorder')
    await mkdir(dataDirectory, { recursive: true })
    const existingConfig = JSON.stringify({
      output_dir: './legacy', server_host: '127.0.0.1', server_port: 43210,
    })
    await writeFile(join(dataDirectory, 'config.json'), existingConfig)
    await writeFile(join(dataDirectory, 'tasks.sqlite'), 'existing-database')

    const first = await runInstaller({
      homeDirectory, releaseDirectory, args: ['--version', 'v0.3.0', '--no-start'],
    })
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /Installed Tasks Recorder 0\.3\.0/)
    assert.match(first.stdout, /Dashboard: http:\/\/127\.0\.0\.1:43210/)

    const installRoot = join(homeDirectory, '.local', 'share', 'tasks-recorder')
    const currentTarget = await readlink(join(installRoot, 'current'))
    assert.equal(currentTarget, join(installRoot, 'releases', '0.3.0'))
    assert.match(
      await readFile(join(currentTarget, 'ui', 'dist', 'index.html'), 'utf8'),
      /<title>Agent Control<\/title>/,
    )
    assert.equal(await readFile(join(dataDirectory, 'config.json'), 'utf8'), existingConfig)
    assert.equal(await readFile(join(dataDirectory, 'tasks.sqlite'), 'utf8'), 'existing-database')

    const wrapper = join(homeDirectory, '.local', 'bin', 'tasks-recorder')
    const wrapperSource = await readFile(wrapper, 'utf8')
    assert.match(wrapperSource, /TASKS_RECORDER_PREBUILT=1/)
    assert.match(wrapperSource, /server\/control\.mjs/)

    const second = await runInstaller({
      homeDirectory, releaseDirectory, args: ['--version', 'v0.3.0', '--no-start'],
    })
    assert.equal(second.code, 0, second.stderr)
    assert.equal(await readFile(join(dataDirectory, 'tasks.sqlite'), 'utf8'), 'existing-database')
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
    await rm(releaseDirectory, { recursive: true, force: true })
  }
})

test('installer rejects a tampered archive before switching current release', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-home-'))
  const releaseDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-release-'))
  try {
    await createReleaseFixture(releaseDirectory)
    const installRoot = join(homeDirectory, '.local', 'share', 'tasks-recorder')
    await mkdir(join(installRoot, 'releases', 'existing'), { recursive: true })
    await execFileAsync('ln', ['-s', join(installRoot, 'releases', 'existing'), join(installRoot, 'current')])
    await writeFile(join(releaseDirectory, 'tasks-recorder-macos.tar.gz'), 'tampered archive')

    const result = await runInstaller({
      homeDirectory, releaseDirectory, args: ['--version', 'v0.3.0', '--no-start'],
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /checksum/i)
    assert.equal(await readlink(join(installRoot, 'current')), join(installRoot, 'releases', 'existing'))
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
    await rm(releaseDirectory, { recursive: true, force: true })
  }
})
