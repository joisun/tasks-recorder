import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve(new URL('..', import.meta.url).pathname)

async function source(path) {
  return readFile(join(projectRoot, path), 'utf8')
}

async function json(path) {
  return JSON.parse(await source(path))
}

test('public package and native adapter metadata share version, license, and repository', async () => {
  const packageManifest = await json('package.json')
  const codexManifest = await json('adapters/codex/tasks-recorder/.codex-plugin/plugin.json')
  const claudeManifest = await json('adapters/claude/tasks-recorder/.claude-plugin/plugin.json')
  const claudeMarketplace = await json('.claude-plugin/marketplace.json')

  assert.equal(packageManifest.version, '0.7.3')
  assert.equal(packageManifest.license, 'GPL-2.0-only')
  assert.equal(packageManifest.repository.url, 'git+https://github.com/joisun/tasks-recorder.git')
  for (const manifest of [codexManifest, claudeManifest]) {
    assert.equal(manifest.version, packageManifest.version)
    assert.equal(manifest.license, packageManifest.license)
    assert.equal(manifest.repository, 'https://github.com/joisun/tasks-recorder')
  }
  assert.equal(claudeMarketplace.plugins[0].version, packageManifest.version)
})

test('README installation commands target published service and separate native adapters', async () => {
  const readme = await source('README.md')
  assert.match(readme, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/joisun\/tasks-recorder\/main\/install\.sh \| bash/)
  assert.match(readme, /codex plugin marketplace add joisun\/tasks-recorder/)
  assert.match(readme, /codex plugin add tasks-recorder@tasks-recorder/)
  assert.match(readme, /claude plugin marketplace add joisun\/tasks-recorder/)
  assert.match(readme, /claude plugin install tasks-recorder@tasks-recorder/)
  assert.match(readme, /^## How it works$/m)
  assert.match(readme, /^## Migrate a schema v2 database$/m)
  assert.match(readme, /tasks-recorder migrate --dry-run/)
  assert.match(readme, /tasks-recorder migrate --apply/)
  assert.match(readme, /version=v0\.7\.3/)
  assert.match(readme, /`0\.7\.x` release line/)
  assert.match(readme, /`0\.8\.0`/)
  assert.match(readme, /~\/\.config\/tasks-recorder\/tasks\.sqlite/)
  assert.match(readme, /GPL-2\.0-only/)
  assert.match(readme, /SVAR React Gantt/)
  assert.doesNotMatch(readme, /DHTMLX/)
})

test('CI and release workflows use pinned actions and the installer artifact contract', async () => {
  const ci = await source('.github/workflows/ci.yml')
  const release = await source('.github/workflows/release.yml')

  for (const workflow of [ci, release]) {
    assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
    assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
    assert.match(workflow, /node-version: 24/)
    assert.match(workflow, /npm ci/)
    assert.match(workflow, /npm test/)
  }
  assert.match(ci, /permissions:\s+contents: read/)
  assert.match(release, /permissions:\s+contents: write/)
  assert.match(release, /tasks-recorder-macos\.tar\.gz/)
  assert.match(release, /tasks-recorder-codex-adapter\.tar\.gz/)
  assert.match(release, /tasks-recorder-claude-adapter\.tar\.gz/)
  assert.match(release, /SHA256SUMS/)
  assert.match(release, /gh release create/)
})

test('root license contains the complete GNU GPL version 2 terms', async () => {
  const license = await source('LICENSE')
  assert.match(license, /GNU GENERAL PUBLIC LICENSE/)
  assert.match(license, /Version 2, June 1991/)
  assert.match(license, /END OF TERMS AND CONDITIONS/)
  assert.ok(license.length > 15_000)
})
