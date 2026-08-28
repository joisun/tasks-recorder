import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function createRuntimeEnvironment({
  env = process.env,
  platform = process.platform,
  homeDirectory = env.HOME || homedir(),
  readDirectory = readdirSync,
} = {}) {
  const baseEnvironment = { ...env }

  function searchDirectories(environment = baseEnvironment) {
    const activeHome = environment.HOME || homeDirectory
    const directories = String(environment.PATH ?? '').split(delimiter).filter(Boolean)
    const npmPrefix = String(
      environment.NPM_CONFIG_PREFIX ?? environment.npm_config_prefix ?? '',
    ).trim()
    if (npmPrefix) directories.push(join(npmPrefix, platform === 'win32' ? '' : 'bin'))

    directories.push(
      join(activeHome, '.local', 'bin'),
      join(activeHome, '.bun', 'bin'),
      join(activeHome, '.volta', 'bin'),
      join(activeHome, '.asdf', 'shims'),
      join(activeHome, 'Library', 'pnpm'),
      join(activeHome, '.cargo', 'bin'),
      join(activeHome, '.npm-global', 'bin'),
      join(activeHome, '.npm-packages', 'bin'),
      join(activeHome, '.deno', 'bin'),
      join(activeHome, 'go', 'bin'),
      join(activeHome, '.pyenv', 'shims'),
      join(activeHome, '.local', 'share', 'mise', 'shims'),
      join(activeHome, '.mise', 'shims'),
      join(activeHome, '.nix-profile', 'bin'),
      ...installedNodeToolchainDirectories(activeHome, readDirectory),
    )
    if (platform !== 'win32') {
      directories.push(
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/run/current-system/sw/bin',
        '/nix/var/nix/profiles/default/bin',
      )
    }

    return [...new Set(directories.filter(Boolean))]
  }

  function executableCandidates(definition) {
    const names = Array.isArray(definition?.launch?.executableNames)
      ? definition.launch.executableNames
      : []
    const candidates = []

    for (const packaged of definition?.launch?.packagedCandidates ?? []) {
      if (typeof packaged === 'string' && packaged.trim()) candidates.push(packaged.trim())
    }
    for (const directory of searchDirectories()) {
      for (const name of names) candidates.push(join(directory, name))
    }
    if (definition?.id === 'codex' && platform === 'darwin') {
      candidates.push(
        '/Applications/Codex.app/Contents/Resources/codex',
        join(activeHomeDirectory(baseEnvironment, homeDirectory),
          'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
      )
    }
    return [...new Set(candidates)]
  }

  function childEnvironment(overrides = {}) {
    const environment = { ...baseEnvironment, ...overrides }
    environment.PATH = searchDirectories(environment).join(delimiter)
    return environment
  }

  return Object.freeze({ searchDirectories, executableCandidates, childEnvironment })
}

function installedNodeToolchainDirectories(homeDirectory, readDirectory) {
  return [
    ...versionDirectories(
      join(homeDirectory, '.nvm', 'versions', 'node'),
      (root, version) => join(root, version, 'bin'),
      readDirectory,
    ),
    ...versionDirectories(
      join(homeDirectory, '.local', 'share', 'fnm', 'node-versions'),
      (root, version) => join(root, version, 'installation', 'bin'),
      readDirectory,
    ),
    ...versionDirectories(
      join(homeDirectory, '.fnm', 'node-versions'),
      (root, version) => join(root, version, 'installation', 'bin'),
      readDirectory,
    ),
    ...versionDirectories(
      join(homeDirectory, '.local', 'share', 'mise', 'installs', 'node'),
      (root, version) => join(root, version, 'bin'),
      readDirectory,
    ),
    ...versionDirectories(
      join(homeDirectory, '.mise', 'installs', 'node'),
      (root, version) => join(root, version, 'bin'),
      readDirectory,
    ),
  ]
}

function versionDirectories(root, buildDirectory, readDirectory) {
  let entries
  try {
    entries = readDirectory(root, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => typeof entry === 'string' || entry?.isDirectory?.())
    .map((entry) => typeof entry === 'string' ? entry : entry.name)
    .filter((name) => typeof name === 'string' && name.length > 0)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((version) => buildDirectory(root, version))
}

function activeHomeDirectory(environment, fallback) {
  return environment.HOME || fallback
}
