import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { packageRelease } from '../scripts/package-release.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(new URL('..', import.meta.url).pathname)

function runInstaller({ homeDirectory, releaseDirectory, args = [], env = {} }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', [join(projectRoot, 'install.sh'), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        HOME: homeDirectory,
        TASKS_RECORDER_RELEASE_BASE_URL: `file://${releaseDirectory}`,
        TASKS_RECORDER_TEST_PLATFORM: 'Darwin',
        ...env,
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
      homeDirectory, releaseDirectory, args: ['--version', 'v0.6.1', '--no-start'],
    })
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /Installed Tasks Recorder 0\.6\.1/)
    assert.match(first.stdout, /Dashboard: http:\/\/127\.0\.0\.1:43210/)

    const installRoot = join(homeDirectory, '.local', 'share', 'tasks-recorder')
    const currentTarget = await readlink(join(installRoot, 'current'))
    assert.equal(currentTarget, join(installRoot, 'releases', '0.6.1'))
    assert.match(
      await readFile(join(currentTarget, 'ui', 'dist', 'index.html'), 'utf8'),
      /<title>Agent Control<\/title>/,
    )
    assert.equal(await readFile(join(dataDirectory, 'config.json'), 'utf8'), existingConfig)
    assert.equal(await readFile(join(dataDirectory, 'tasks.sqlite'), 'utf8'), 'existing-database')

    const wrapper = join(homeDirectory, '.local', 'bin', 'tasks-recorder')
    const wrapperSource = await readFile(wrapper, 'utf8')
    assert.match(wrapperSource, /TASKS_RECORDER_PREBUILT=1/)
    assert.match(wrapperSource, /server\/cli\.mjs/)
    assert.match(wrapperSource, /"\$@"/)

    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync(wrapper, ['status'], {
        env: { ...process.env, HOME: homeDirectory },
      })
      const status = JSON.parse(stdout)
      assert.equal(
        status.plistPath,
        join(homeDirectory, 'Library', 'LaunchAgents', 'com.joi.tasks-recorder.taskd.plist'),
      )
    } else {
      await assert.rejects(
        execFileAsync(wrapper, ['status'], { env: { ...process.env, HOME: homeDirectory } }),
        (error) => {
          assert.match(error.stderr, /currently requires macOS/)
          return true
        },
      )
    }

    const second = await runInstaller({
      homeDirectory, releaseDirectory, args: ['--version', 'v0.6.1', '--no-start'],
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
      homeDirectory, releaseDirectory, args: ['--version', 'v0.6.1', '--no-start'],
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /checksum/i)
    assert.equal(await readlink(join(installRoot, 'current')), join(installRoot, 'releases', 'existing'))
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
    await rm(releaseDirectory, { recursive: true, force: true })
  }
})

test('installer replaces an existing current symlink instead of nesting it in the old release', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-home-'))
  const releaseDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-release-'))
  try {
    await createReleaseFixture(releaseDirectory)
    const installRoot = join(homeDirectory, '.local', 'share', 'tasks-recorder')
    const oldRelease = join(installRoot, 'releases', '0.3.0')
    await mkdir(oldRelease, { recursive: true })
    await execFileAsync('ln', ['-s', oldRelease, join(installRoot, 'current')])

    const result = await runInstaller({
      homeDirectory, releaseDirectory, args: ['--version', 'v0.6.1', '--no-start'],
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(
      await readlink(join(installRoot, 'current')),
      join(installRoot, 'releases', '0.6.1'),
    )
    assert.deepEqual(await readdir(oldRelease), [])
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
    await rm(releaseDirectory, { recursive: true, force: true })
  }
})

test('installer bounds every service readiness probe', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-home-'))
  const releaseDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-release-'))
  const commandDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-commands-'))
  const probeLog = join(commandDirectory, 'curl.log')
  try {
    await createReleaseFixture(releaseDirectory)
    const dataDirectory = join(homeDirectory, '.config', 'tasks-recorder')
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(join(dataDirectory, 'config.json'), JSON.stringify({
      output_dir: '.', server_host: '127.0.0.1', server_port: 43211,
    }))

    const fakeCurl = join(commandDirectory, 'curl')
    await writeFile(fakeCurl, `#!/usr/bin/env bash
case "\${!#}" in
  */health/ready)
    printf '%s\\n' "$*" >> "$TASKS_RECORDER_PROBE_LOG"
    exit 1
    ;;
esac
exec "$TASKS_RECORDER_REAL_CURL" "$@"
`)
    await writeFile(join(commandDirectory, 'launchctl'), '#!/usr/bin/env sh\nexit 0\n')
    await writeFile(join(commandDirectory, 'sleep'), '#!/usr/bin/env sh\nexit 0\n')
    await Promise.all([
      chmod(fakeCurl, 0o755),
      chmod(join(commandDirectory, 'launchctl'), 0o755),
      chmod(join(commandDirectory, 'sleep'), 0o755),
    ])

    const result = await runInstaller({
      homeDirectory,
      releaseDirectory,
      args: ['--version', 'v0.6.1'],
      env: {
        PATH: `${commandDirectory}:${process.env.PATH}`,
        TASKS_RECORDER_PROBE_LOG: probeLog,
        TASKS_RECORDER_REAL_CURL: (await execFileAsync('which', ['curl'])).stdout.trim(),
      },
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /service did not become ready/)
    const probes = (await readFile(probeLog, 'utf8')).trim().split('\n')
    assert.equal(probes.length, 30)
    for (const probe of probes) assert.match(probe, /--max-time [1-9][0-9]*/)
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
    await rm(releaseDirectory, { recursive: true, force: true })
    await rm(commandDirectory, { recursive: true, force: true })
  }
})
